"use client";

// Verify-email landing (task-009). Two modes:
//
//  WITH ?token= — POSTs /api/auth/verify-email once on mount (VerifyEmailRequest
//  { token }) and shows the server Ack verbatim (→ sign-in CTA) or the server
//  validation error verbatim (unknown/expired/used tokens share one message by
//  design — INV-010).
//
//  WITHOUT token — the verification-pending view (sign-in routes here when
//  status = "verification-pending"). Resend requires the authenticated session:
//  POST /api/auth/resend-verification is authenticated-any + CSRF, so the
//  csrfToken comes from GET /api/auth/session first. Signed-out visitors get a
//  graceful prompt to sign in instead of a dead button.

import { useEffect, useRef, useState } from "react";
import { getSession, postJson, postJsonWithCsrf } from "@/components/auth/api";
import { withRedirectParam } from "@/components/auth/redirect";
import {
  AuthCard,
  AuthHeading,
  CopperLink,
  ErrorBanner,
  PrimaryButton,
  Skeleton,
  SuccessBanner,
} from "@/components/auth/ui";

type TokenState =
  | { phase: "verifying" }
  | { phase: "verified"; message: string }
  | { phase: "failed"; message: string; details?: string[] };

export function VerifyEmailClient({
  token,
  redirectTo,
}: {
  token: string | null;
  redirectTo: string | null;
}) {
  return token !== null ? (
    <TokenLanding token={token} redirectTo={redirectTo} />
  ) : (
    <PendingView redirectTo={redirectTo} />
  );
}

function TokenLanding({ token, redirectTo }: { token: string; redirectTo: string | null }) {
  const [state, setState] = useState<TokenState>({ phase: "verifying" });
  const firedRef = useRef(false);

  useEffect(() => {
    // Single consumption — INV-010 tokens are one-shot; React 18 double-mount guard.
    if (firedRef.current) return;
    firedRef.current = true;
    void (async () => {
      const result = await postJson<{ message: string }>("/api/auth/verify-email", { token });
      if (result.ok) {
        setState({ phase: "verified", message: result.data.message });
      } else {
        setState({ phase: "failed", message: result.error.message, details: result.error.details });
      }
    })();
  }, [token]);

  return (
    <AuthCard>
      <AuthHeading title="Verify email" />
      {state.phase === "verifying" ? (
        <div data-testid="verify-status-loading" aria-live="polite">
          <p className="mb-3 text-sm text-ink-soft">Verifying your email address…</p>
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}
      {state.phase === "verified" ? (
        <>
          <SuccessBanner message={state.message} testId="verify-success" />
          <PrimaryButton
            testId="verify-signin-btn"
            type="button"
            onClick={() => window.location.assign(withRedirectParam("/sign-in", redirectTo))}
          >
            Continue to sign in
          </PrimaryButton>
        </>
      ) : null}
      {state.phase === "failed" ? (
        <>
          <ErrorBanner message={state.message} details={state.details} testId="verify-error" />
          <p className="mb-4 text-sm text-ink-soft">
            The link may have expired or already been used. Sign in to request a
            fresh verification email.
          </p>
          <PrimaryButton
            testId="verify-signin-btn"
            type="button"
            onClick={() => window.location.assign(withRedirectParam("/sign-in", redirectTo))}
          >
            Go to sign in
          </PrimaryButton>
        </>
      ) : null}
    </AuthCard>
  );
}

function PendingView({ redirectTo }: { redirectTo: string | null }) {
  // Session probe decides between the resend action and the sign-in prompt.
  const [session, setSession] = useState<"loading" | "signed-in" | "signed-out">("loading");
  const [resending, setResending] = useState(false);
  const [resendResult, setResendResult] = useState<
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string; details?: string[] }
    | null
  >(null);

  useEffect(() => {
    void (async () => {
      const info = await getSession();
      setSession(info !== null ? "signed-in" : "signed-out");
    })();
  }, []);

  async function onResend() {
    setResending(true);
    setResendResult(null);
    // Fresh CSRF token per attempt (session-bound synchronizer, src/lib/csrf.ts).
    const info = await getSession();
    if (info === null) {
      setSession("signed-out");
      setResending(false);
      return;
    }
    const result = await postJsonWithCsrf<{ message: string }>(
      "/api/auth/resend-verification",
      info.csrfToken,
    );
    setResending(false);
    if (result.ok) {
      setResendResult({ kind: "ok", message: result.data.message });
    } else {
      setResendResult({ kind: "error", message: result.error.message, details: result.error.details });
    }
  }

  return (
    <AuthCard>
      <AuthHeading title="Verify your email" subtitle="Your account needs a verified email before you can continue." />
      <div className="mb-4 rounded-md border border-line bg-info-soft px-3.5 py-2.5 text-sm text-info">
        This demo delivers email on the <strong>Outbound Messages</strong> page
        (Supervisor → Outbound Messages) instead of a real inbox. Open your
        verification message there and follow its link.
      </div>
      {resendResult?.kind === "ok" ? (
        <SuccessBanner message={resendResult.message} testId="verify-resend-success" />
      ) : null}
      {resendResult?.kind === "error" ? (
        <ErrorBanner
          message={resendResult.message}
          details={resendResult.details}
          testId="verify-resend-error"
        />
      ) : null}
      {session === "loading" ? <Skeleton className="h-10 w-full" /> : null}
      {session === "signed-in" ? (
        <button
          type="button"
          data-testid="verify-resend-btn"
          onClick={onResend}
          disabled={resending}
          className="w-full rounded-md border border-navy bg-card px-4 py-2.5 text-sm font-semibold text-navy transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-navy hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {resending ? "Sending…" : "Resend verification email"}
        </button>
      ) : null}
      {session === "signed-out" ? (
        <p data-testid="verify-signed-out-prompt" className="text-sm text-ink-soft">
          You are not signed in. <CopperLink href={withRedirectParam("/sign-in", redirectTo)} testId="verify-signin-link">Sign in</CopperLink>{" "}
          first to resend the verification email.
        </p>
      ) : null}
    </AuthCard>
  );
}
