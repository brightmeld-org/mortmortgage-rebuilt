"use client";

// Session idle warning (task-044, contracts §C AppShell: "session idle
// warning (2 min before expiry)"). Driven by SessionInfo timestamps
// (idleExpiresAt / absoluteExpiresAt from GET /api/auth/session).
//
// Design constraint (src/lib/auth.ts): EVERY authenticated request slides the
// server-side idle window (lastSeenAt, throttled to one write per 30s). A
// warning component that re-checked the session near expiry would therefore
// keep the session alive forever. Instead this component:
//   - fetches the session ONCE on mount to learn the idle-window duration
//     (idleExpiresAt - now) and the absolute expiry;
//   - models activity by observing the app's own same-origin /api fetches
//     (a patched window.fetch): each successful call slid the server window,
//     so it resets the local model too (e.g. the notification bell's poll);
//   - runs a purely LOCAL timer - no network - and opens the alertdialog when
//     the modeled expiry (min of idle model and absoluteExpiresAt) is within
//     2 minutes; at zero it returns to /sign-in;
//   - "Stay signed in" issues a real session GET (which slides the server
//     window) and re-syncs the model from the fresh SessionInfo timestamps.
//
// Mounted from src/app/(app)/layout.tsx for every authenticated page.

import { useCallback, useEffect, useRef, useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import { getSession } from "@/components/auth/api";

const WARNING_WINDOW_MS = 2 * 60_000;
const CHECK_EVERY_MS = 5_000;

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function SessionIdleWarning() {
  const [open, setOpen] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number>(WARNING_WINDOW_MS);
  const [extending, setExtending] = useState(false);
  // Model state lives in refs - it must be readable from timers without
  // re-subscribing effects.
  const idleWindowMsRef = useRef<number | null>(null);
  const absoluteExpiresAtRef = useRef<number | null>(null);
  const lastActivityAtRef = useRef<number>(Date.now());
  const leavingRef = useRef(false);

  const applySessionInfo = useCallback((idleExpiresAt: string, absoluteExpiresAt: string) => {
    const now = Date.now();
    const idleAt = Date.parse(idleExpiresAt);
    const absoluteAt = Date.parse(absoluteExpiresAt);
    if (!Number.isNaN(idleAt)) {
      // Duration, not instant: immune to client/server clock skew.
      idleWindowMsRef.current = Math.max(60_000, idleAt - now);
    }
    if (!Number.isNaN(absoluteAt)) absoluteExpiresAtRef.current = absoluteAt;
    lastActivityAtRef.current = now;
  }, []);

  const modeledExpiry = useCallback((): number | null => {
    const windowMs = idleWindowMsRef.current;
    if (windowMs === null) return null;
    const idleExpiry = lastActivityAtRef.current + windowMs;
    const absoluteAt = absoluteExpiresAtRef.current;
    return absoluteAt !== null && absoluteAt < idleExpiry ? absoluteAt : idleExpiry;
  }, []);

  useEffect(() => {
    let disposed = false;

    // Learn the window durations once. This request itself slides the server
    // window, so it doubles as the model's starting activity mark.
    void getSession().then((info) => {
      if (disposed || !info) return;
      applySessionInfo(info.idleExpiresAt, info.absoluteExpiresAt);
    });

    // Observe the app's own API traffic: any same-origin /api call that is
    // not a 401 slid the server idle window - reset the local model with it.
    const nativeFetch = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await nativeFetch(...args);
      try {
        const input = args[0];
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url && (url.startsWith("/api/") || url.includes(`${window.location.origin}/api/`))) {
          if (response.status !== 401) lastActivityAtRef.current = Date.now();
        }
      } catch {
        // observation must never break the app's fetches
      }
      return response;
    };

    const timer = setInterval(() => {
      const expiry = modeledExpiry();
      if (expiry === null) return;
      const left = expiry - Date.now();
      if (left <= 0) {
        if (!leavingRef.current) {
          leavingRef.current = true;
          window.location.assign("/sign-in");
        }
        return;
      }
      if (left <= WARNING_WINDOW_MS) {
        setRemainingMs(left);
        setOpen(true);
      } else {
        setOpen(false);
      }
    }, CHECK_EVERY_MS);

    // 1s countdown granularity while the dialog is open.
    const tick = setInterval(() => {
      const expiry = modeledExpiry();
      if (expiry === null) return;
      const left = expiry - Date.now();
      if (left <= WARNING_WINDOW_MS) setRemainingMs(Math.max(0, left));
    }, 1000);

    return () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(tick);
      window.fetch = nativeFetch;
    };
  }, [applySessionInfo, modeledExpiry]);

  async function stay() {
    setExtending(true);
    try {
      const info = await getSession(); // real request -> slides the server window
      if (!info) {
        window.location.assign("/sign-in");
        return;
      }
      applySessionInfo(info.idleExpiresAt, info.absoluteExpiresAt);
      setOpen(false);
    } finally {
      setExtending(false);
    }
  }

  async function signOutNow() {
    const info = await getSession();
    if (info) {
      try {
        await fetch("/api/auth/sign-out", {
          method: "POST",
          headers: { "x-csrf-token": info.csrfToken },
          credentials: "same-origin",
        });
      } catch {
        // best-effort - we are leaving either way
      }
    }
    window.location.assign("/sign-in");
  }

  if (!open) return null;

  return (
    <SessionIdleDialog
      remainingMs={remainingMs}
      extending={extending}
      onStay={() => void stay()}
      onSignOut={() => void signOutNow()}
    />
  );
}

// The warning surface. Extracted so `useModalFocus` can be called unconditionally
// (open == mounted): focus move-in, a real bidirectional Tab trap, Escape-to-close
// and the focusin backstop — the ONE modal focus primitive (NFR-025 / LENS-014 /
// LENS-022), replacing the hand-rolled two-control loop. Escape counts as "keep me
// signed in" (the safe default for an idle prompt), so it maps to onStay.
function SessionIdleDialog({
  remainingMs,
  extending,
  onStay,
  onSignOut,
}: {
  remainingMs: number;
  extending: boolean;
  onStay: () => void;
  onSignOut: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onStay);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-warning-title"
        aria-describedby="session-warning-desc"
        data-testid="session-warning-dialog"
        className="w-full max-w-md rounded-lg border border-line bg-card p-6 shadow-lg"
      >
        <h2 id="session-warning-title" className="font-display text-lg font-bold text-ink">
          Are you still there?
        </h2>
        <p id="session-warning-desc" className="mt-2 text-sm text-ink-soft">
          For your security, you will be signed out after a period of inactivity. Your session ends
          in <span className="font-semibold text-ink">{formatRemaining(remainingMs)}</span>.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            data-testid="session-warning-signout-btn"
            onClick={onSignOut}
            className="rounded-md border border-line bg-card px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 hover:border-navy hover:text-navy"
          >
            Sign out now
          </button>
          <button
            type="button"
            data-testid="session-stay-btn"
            onClick={onStay}
            disabled={extending}
            className="rounded-md bg-copper px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy disabled:opacity-60"
          >
            {extending ? "Extending…" : "Stay signed in"}
          </button>
        </div>
      </div>
    </div>
  );
}
