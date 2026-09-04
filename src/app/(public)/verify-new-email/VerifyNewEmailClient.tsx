"use client";

// Change-email confirmation landing (REQ-041, §4.2.12). Two modes:
//
//  WITH ?token= — POSTs /api/profile/verify-new-email once on mount
//  (VerifyEmailRequest { token }) and shows the server Ack verbatim (→ sign-in
//  CTA, because the account's sign-in identity has just changed) or the server
//  validation error verbatim (unknown/expired/used tokens AND an address that is
//  already taken all share one message by design — INV-010 / INV-013).
//  The endpoint is roleGate "public" and CSRF-exempt: the single-use token IS the
//  authorization, so this posts through plain postJson with no CSRF header.
//
//  WITHOUT token — an EXPLANATORY state, not an action. /verify-email offers a
//  resend here; this flow has no resend endpoint contracted, so a dead button
//  would be a lie. The honest recovery is to sign in and request the change
//  again, which is what the copy says.

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/components/auth/api";
import { withRedirectParam } from "@/components/auth/redirect";
import {
  AuthCard,
  AuthHeading,
  ErrorBanner,
  PrimaryButton,
  Skeleton,
  SuccessBanner,
} from "@/components/auth/ui";

type TokenState =
  | { phase: "verifying" }
  | { phase: "verified"; message: string }
  | { phase: "failed"; message: string; details?: string[] };

export function VerifyNewEmailClient({
  token,
  redirectTo,
}: {
  token: string | null;
  redirectTo: string | null;
}) {
  return token !== null ? (
    <TokenLanding token={token} redirectTo={redirectTo} />
  ) : (
    <NoTokenView redirectTo={redirectTo} />
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
      const result = await postJson<{ message: string }>("/api/profile/verify-new-email", { token });
      if (result.ok) {
        setState({ phase: "verified", message: result.data.message });
      } else {
        setState({ phase: "failed", message: result.error.message, details: result.error.details });
      }
    })();
  }, [token]);

  return (
    <AuthCard>
      <AuthHeading title="Confirm new email" />
      {state.phase === "verifying" ? (
        <div data-testid="verify-new-email-loading" aria-live="polite">
          <p className="mb-3 text-sm text-ink-soft">Confirming your new email address…</p>
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}
      {state.phase === "verified" ? (
        <>
          <SuccessBanner message={state.message} testId="verify-new-email-success" />
          <p className="mb-4 text-sm text-ink-soft">
            Use the new address the next time you sign in — your previous one no longer
            works.
          </p>
          <PrimaryButton
            testId="verify-new-email-signin-btn"
            type="button"
            onClick={() => window.location.assign(withRedirectParam("/sign-in", redirectTo))}
          >
            Continue to sign in
          </PrimaryButton>
        </>
      ) : null}
      {state.phase === "failed" ? (
        <>
          <ErrorBanner
            message={state.message}
            details={state.details}
            testId="verify-new-email-error"
          />
          <p className="mb-4 text-sm text-ink-soft">
            The link may have expired, already been used, or the change may have been
            cancelled. Your current email address is unchanged — sign in and request the
            change again from your profile.
          </p>
          <PrimaryButton
            testId="verify-new-email-signin-btn"
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

function NoTokenView({ redirectTo }: { redirectTo: string | null }) {
  return (
    <AuthCard>
      <AuthHeading
        title="Confirm new email"
        subtitle="This page opens from the confirmation link we emailed to your new address."
      />
      <div
        data-testid="verify-new-email-no-token"
        className="mb-4 rounded-md border border-line bg-info-soft px-3.5 py-2.5 text-sm text-info"
      >
        There is no confirmation token in this link. Open the message we sent to your new
        address and follow the link inside it. That link cannot be resent on its own — if
        it has expired, sign in and request the email change again from your profile. Your
        current email address keeps working until a new one is confirmed.
      </div>
      <p data-testid="verify-new-email-demo-hint" className="mb-4 text-sm text-ink-soft">
        This demo delivers email on the <strong>Outbound Messages</strong> page (Supervisor
        → Outbound Messages) instead of a real inbox.
      </p>
      <PrimaryButton
        testId="verify-new-email-signin-btn"
        type="button"
        onClick={() => window.location.assign(withRedirectParam("/sign-in", redirectTo))}
      >
        Go to sign in
      </PrimaryButton>
    </AuthCard>
  );
}
