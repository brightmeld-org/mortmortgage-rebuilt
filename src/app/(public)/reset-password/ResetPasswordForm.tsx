"use client";

// Reset-password form (task-009). Payload is contracts §A ResetPasswordRequest
// EXACTLY: { token, newPassword } — the confirmation input below is a
// client-side UX mirror only (VR-011/VR-012; the API schema is strict and would
// reject unknown fields). Server policy errors (character classes,
// common-password list, expired/used token) render VERBATIM.

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

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ newPassword?: string; confirmation?: string }>({});
  const [serverError, setServerError] = useState<{ message: string; details?: string[] } | null>(null);
  const [ackMessage, setAckMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (token === null) {
    return (
      <AuthCard>
        <AuthHeading title="Reset password" />
        <p data-testid="reset-missing-token" className="mb-6 text-sm text-ink-soft" role="alert">
          This page needs the reset link from your email. Open the message on the
          Outbound Messages page and follow its link — or request a new one.
        </p>
        <CopperLink href="/forgot-password" testId="reset-forgot-link">
          Request a new reset link →
        </CopperLink>
      </AuthCard>
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors: { newPassword?: string; confirmation?: string } = {};
    if (newPassword.length < 12) errors.newPassword = "Password must be at least 12 characters."; // VR-012
    if (confirmation !== newPassword) errors.confirmation = "Passwords must match.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    // contracts §A ResetPasswordRequest — exact field names, nothing extra.
    const result = await postJson<{ message: string }>("/api/auth/reset-password", {
      token,
      newPassword,
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
        <AuthHeading title="Password updated" />
        <SuccessBanner message={ackMessage} testId="reset-success" />
        <PrimaryButton
          testId="reset-signin-btn"
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
      <AuthHeading title="Reset password" subtitle="Choose a new password for your account." />
      {serverError ? (
        <ErrorBanner message={serverError.message} details={serverError.details} testId="reset-error" />
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <Field
          id="reset-password-input"
          label="New password"
          error={fieldErrors.newPassword}
          hint="At least 12 characters, using 3 of 4: uppercase, lowercase, digits, symbols."
        >
          <input
            id="reset-password-input"
            data-testid="reset-password-input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            aria-invalid={Boolean(fieldErrors.newPassword)}
            className={inputClass(Boolean(fieldErrors.newPassword))}
          />
        </Field>
        <Field id="reset-password-confirm" label="Confirm new password" error={fieldErrors.confirmation}>
          <input
            id="reset-password-confirm"
            data-testid="reset-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            aria-invalid={Boolean(fieldErrors.confirmation)}
            className={inputClass(Boolean(fieldErrors.confirmation))}
          />
        </Field>
        <div className="mt-5">
          <PrimaryButton testId="reset-password-submit" loading={submitting}>
            Set new password
          </PrimaryButton>
        </div>
      </form>
      <div className="mt-4 text-center">
        <CopperLink href="/sign-in" testId="reset-signin-link">
          ← Back to sign in
        </CopperLink>
      </div>
    </AuthCard>
  );
}
