"use client";

// Forgot-password request form (task-009). ForgotPasswordRequest { email }
// (VR-010 client mirror). The server Ack is UNIFORM — the same confirmation
// regardless of whether the email maps to an account — and renders verbatim.

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<{ message: string; details?: string[] } | null>(null);
  const [ackMessage, setAckMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!EMAIL_RE.test(email)) {
      setFieldError("Enter a valid email address.");
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    setServerError(null);
    const result = await postJson<{ message: string }>("/api/auth/forgot-password", { email });
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
        <AuthHeading title="Check your messages" />
        <SuccessBanner message={ackMessage} testId="forgot-confirmation" />
        <p className="mb-6 text-sm text-ink-soft">
          In this demo, the reset email appears on the <strong>Outbound Messages</strong>{" "}
          page (Supervisor → Outbound Messages). Follow its link to choose a new
          password.
        </p>
        <CopperLink href="/sign-in" testId="forgot-signin-link">
          ← Back to sign in
        </CopperLink>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading
        title="Forgot password"
        subtitle="Enter your account email and we'll send a reset link."
      />
      {serverError ? (
        <ErrorBanner message={serverError.message} details={serverError.details} testId="forgot-error" />
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <Field id="forgot-email" label="Email" error={fieldError}>
          <input
            id="forgot-email"
            data-testid="forgot-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(fieldError)}
            className={inputClass(Boolean(fieldError))}
          />
        </Field>
        <div className="mt-5">
          <PrimaryButton testId="forgot-submit" loading={submitting}>
            Send reset link
          </PrimaryButton>
        </div>
      </form>
      <div className="mt-4 text-center">
        <CopperLink href="/sign-in" testId="forgot-signin-link">
          ← Back to sign in
        </CopperLink>
      </div>
    </AuthCard>
  );
}
