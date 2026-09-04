"use client";

// Invitation set-password form (task-009). Payload is contracts §A
// AcceptInvitationRequest EXACTLY: { token, password } — the confirmation input
// is a client-side UX mirror only. On success the new staff member signs in
// (and enrolls MFA at first sign-in per REQ-063).
//
// The backend (task-033) is a LATER increment: a 404/non-JSON response here is
// expected and surfaces as the shared unavailable message rather than a crash.

import { useState } from "react";
import { postJson } from "@/components/auth/api";
import {
  AuthCard,
  AuthHeading,
  CopperLink,
  ErrorBanner,
  Field,
  PrimaryButton,
  SuccessBanner,
  inputClass,
} from "@/components/auth/ui";

export function AcceptInvitationForm({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirmation?: string }>({});
  const [serverError, setServerError] = useState<{ message: string; details?: string[] } | null>(null);
  const [ackMessage, setAckMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (token === null) {
    return (
      <AuthCard>
        <AuthHeading title="Accept invitation" />
        <p data-testid="invitation-missing-token" className="mb-6 text-sm text-ink-soft" role="alert">
          This page needs the set-password link from your invitation email. Open
          the invitation message and follow its link, or ask your supervisor to
          send a new invitation.
        </p>
        <CopperLink href="/sign-in" testId="invitation-signin-link">
          ← Back to sign in
        </CopperLink>
      </AuthCard>
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors: { password?: string; confirmation?: string } = {};
    if (password.length < 12) errors.password = "Password must be at least 12 characters.";
    if (confirmation !== password) errors.confirmation = "Passwords must match.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    // contracts §A AcceptInvitationRequest — exact field names, nothing extra.
    const result = await postJson<{ message: string }>("/api/auth/accept-invitation", {
      token,
      password,
    });
    setSubmitting(false);
    if (!result.ok) {
      setServerError({ message: result.error.message, details: result.error.details });
      return;
    }
    setAckMessage(result.data.message);
  }

  if (ackMessage !== null) {
    return (
      <AuthCard>
        <AuthHeading title="You're all set" />
        <SuccessBanner message={ackMessage} testId="invitation-success" />
        <p className="mb-4 text-sm text-ink-soft">
          Sign in with your new password — you will set up multi-factor
          authentication on first sign-in.
        </p>
        <PrimaryButton
          testId="invitation-signin-btn"
          type="button"
          onClick={() => window.location.assign("/sign-in")}
        >
          Continue to sign in
        </PrimaryButton>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading
        title="Accept invitation"
        subtitle="Choose a password to activate your staff account."
      />
      {serverError ? (
        <ErrorBanner
          message={serverError.message}
          details={serverError.details}
          testId="invitation-error"
        />
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <Field
          id="invitation-password"
          label="Password"
          error={fieldErrors.password}
          hint="At least 12 characters, using 3 of 4: uppercase, lowercase, digits, symbols."
        >
          <input
            id="invitation-password"
            data-testid="invitation-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(fieldErrors.password)}
            className={inputClass(Boolean(fieldErrors.password))}
          />
        </Field>
        <Field id="invitation-password-confirm" label="Confirm password" error={fieldErrors.confirmation}>
          <input
            id="invitation-password-confirm"
            data-testid="invitation-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            aria-invalid={Boolean(fieldErrors.confirmation)}
            className={inputClass(Boolean(fieldErrors.confirmation))}
          />
        </Field>
        <div className="mt-5">
          <PrimaryButton testId="invitation-submit" loading={submitting}>
            Set password and activate
          </PrimaryButton>
        </div>
      </form>
    </AuthCard>
  );
}
