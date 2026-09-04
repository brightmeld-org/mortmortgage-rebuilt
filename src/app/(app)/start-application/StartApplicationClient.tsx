"use client";

// Hand-off bridge client (task-018). One POST /api/applications with the
// browser-held token, then redirect to the new Draft's wizard route.
//
//   - The token is sent EVEN IF it might be expired/tampered — the server
//     silently ignores invalid tokens and creates a plain Draft (VR-055).
//   - Idempotent under React strict-mode double effects and refreshes: the
//     CreateApplicationRequest.requestToken (SEC-21) is persisted in
//     sessionStorage before the first POST, so a replay returns the SAME
//     application instead of creating a second Draft.
//   - The authenticated POST carries x-csrf-token from GET /api/auth/session.
//   - Non-2xx bodies surface the SERVER message verbatim (NFR-025); the
//     one-active 409 additionally links to /dashboard.

import { useEffect, useRef, useState } from "react";
import { getSession, postJsonWithCsrf } from "@/components/auth/api";
import {
  HANDOFF_REQUEST_TOKEN_STORAGE_KEY,
  HANDOFF_TOKEN_STORAGE_KEY,
} from "@/components/public-tools/handoff";

type BridgeState =
  | { phase: "working" }
  | { phase: "error"; message: string; details: string[]; showDashboardLink: boolean };

export function StartApplicationClient() {
  const [state, setState] = useState<BridgeState>({ phase: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // strict-mode double-effect guard
    started.current = true;

    (async () => {
      const session = await getSession();
      if (!session) {
        window.location.replace(`/sign-in?redirectTo=${encodeURIComponent("/start-application")}`);
        return;
      }

      let handoffToken: string | null = null;
      let requestToken: string | null = null;
      try {
        handoffToken = sessionStorage.getItem(HANDOFF_TOKEN_STORAGE_KEY);
        requestToken = sessionStorage.getItem(HANDOFF_REQUEST_TOKEN_STORAGE_KEY);
        if (!requestToken) {
          requestToken = crypto.randomUUID();
          // Persist BEFORE the POST: a refresh/replay reuses the same
          // idempotency token and lands on the same Draft (SEC-21).
          sessionStorage.setItem(HANDOFF_REQUEST_TOKEN_STORAGE_KEY, requestToken);
        }
      } catch {
        requestToken = crypto.randomUUID();
      }

      const result = await postJsonWithCsrf<{ id: string }>("/api/applications", session.csrfToken, {
        requestToken,
        ...(handoffToken ? { handoffToken } : {}),
      });

      if (result.ok) {
        try {
          sessionStorage.removeItem(HANDOFF_TOKEN_STORAGE_KEY);
          sessionStorage.removeItem(HANDOFF_REQUEST_TOKEN_STORAGE_KEY);
        } catch {
          // storage cleanup is best-effort
        }
        window.location.replace(`/applications/${result.data.id}`);
        return;
      }

      setState({
        phase: "error",
        message: result.error.message,
        details: result.error.details ?? [],
        showDashboardLink: result.status === 409,
      });
    })();
  }, []);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center px-4">
      {state.phase === "working" ? (
        <div data-testid="start-application-working" className="w-full rounded-lg border border-line bg-card p-8 text-center shadow-sm">
          <div aria-hidden className="mx-auto h-2 w-40 overflow-hidden rounded-full bg-copper-soft">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-copper" />
          </div>
          <h1 className="mt-5 font-display text-xl font-semibold text-ink">
            Setting up your application…
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            Carrying your calculator numbers into a new draft.
          </p>
        </div>
      ) : (
        <div data-testid="start-application-error" role="alert" className="w-full rounded-lg border border-danger/40 bg-card p-8 shadow-sm">
          <h1 className="font-display text-xl font-semibold text-ink">
            We couldn&rsquo;t start a new application
          </h1>
          {/* Server message verbatim (NFR-025). */}
          <p className="mt-3 text-sm text-danger">{state.message}</p>
          {state.details.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-sm text-danger">
              {state.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <a
            href="/dashboard"
            data-testid="start-application-dashboard-link"
            className="mt-5 inline-block rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep"
          >
            Go to your dashboard
          </a>
        </div>
      )}
    </div>
  );
}
