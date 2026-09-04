"use client";

// MFA challenge (task-009). Frame: gui-spec mfa-verify — centered card, 6-digit
// TOTP input, link "use a recovery code" swaps the input mode.
//
// Payload is contracts §A MfaVerifyRequest with EXACTLY ONE of code |
// recoveryCode present (VR-016/VR-017) — the mode toggle guarantees the other
// key is never sent. Failures are the server's uniform 401 body, rendered
// VERBATIM (wrong code, replayed step, consumed/unknown recovery code — one
// message by design).
//
// Success is SignInResponse { status: "signed-in", redirectTo }:
//   - recovery-code sign-ins arrive with redirectTo "/profile?mfaReenroll=1"
//     (INV-010 re-enrollment prompt) — the client FOLLOWS it, even over a
//     requested page (the prompt is a security step);
//   - otherwise the requested page (?redirectTo=) wins, falling back to the
//     server's role home.

import { useState } from "react";
import { postJson, type SignInResponse } from "@/components/auth/api";
import { safeRedirect } from "@/components/auth/redirect";
import {
  AuthCard,
  AuthHeading,
  CopperLink,
  ErrorBanner,
  Field,
  PrimaryButton,
  inputClass,
} from "@/components/auth/ui";

const REENROLL_PROMPT_PREFIX = "/profile?mfaReenroll=1";
// LENS-018 / REQ-014: an expired-password sign-in is routed to the change-password
// prompt and, like the re-enrollment prompt, MUST win over any requested page — the
// credential has to be rotated first.
const PASSWORD_EXPIRED_PREFIX = "/profile?passwordExpired=1";

export function MfaVerifyClient({ redirectTo }: { redirectTo: string | null }) {
  const [mode, setMode] = useState<"code" | "recoveryCode">("code");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<{ message: string; details?: string[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggleMode() {
    setMode((current) => (current === "code" ? "recoveryCode" : "code"));
    setFieldError(null);
    setServerError(null);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // VR-016/VR-017 client mirror: exactly one of code | recoveryCode.
    let payload: { code: string } | { recoveryCode: string };
    if (mode === "code") {
      if (!/^\d{6}$/.test(code.trim())) {
        setFieldError("Enter the 6-digit code from your authenticator app.");
        return;
      }
      payload = { code: code.trim() };
    } else {
      if (recoveryCode.trim().length === 0) {
        setFieldError("Enter one of your recovery codes.");
        return;
      }
      payload = { recoveryCode: recoveryCode.trim() };
    }
    setFieldError(null);
    setSubmitting(true);
    setServerError(null);
    const result = await postJson<SignInResponse>("/api/auth/mfa/verify", payload);
    if (!result.ok) {
      setServerError({ message: result.error.message, details: result.error.details });
      setSubmitting(false);
      return;
    }
    const serverTarget = safeRedirect(result.data.redirectTo);
    // Security prompts always win over a requested page: the re-enrollment prompt
    // (recovery-code consumption) and the password-expired prompt (LENS-018).
    const isForcedPrompt =
      serverTarget !== null &&
      (serverTarget.startsWith(REENROLL_PROMPT_PREFIX) ||
        serverTarget.startsWith(PASSWORD_EXPIRED_PREFIX));
    const target = isForcedPrompt ? serverTarget : (redirectTo ?? serverTarget ?? "/");
    window.location.assign(target);
  }

  return (
    <AuthCard>
      <AuthHeading
        title="Two-factor check"
        subtitle={
          mode === "code"
            ? "Enter the 6-digit code from your authenticator app."
            : "Enter one of your single-use recovery codes."
        }
      />
      {serverError ? (
        <ErrorBanner message={serverError.message} details={serverError.details} testId="mfa-verify-error" />
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        {mode === "code" ? (
          <Field id="mfa-code-input" label="Authenticator code" error={fieldError}>
            <input
              id="mfa-code-input"
              data-testid="mfa-code-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={Boolean(fieldError)}
              className={`${inputClass(Boolean(fieldError))} text-center font-mono text-lg tracking-[0.4em]`}
            />
          </Field>
        ) : (
          <Field id="mfa-recovery-input" label="Recovery code" error={fieldError}>
            <input
              id="mfa-recovery-input"
              data-testid="mfa-recovery-input"
              type="text"
              autoComplete="off"
              placeholder="e.g. a1b2c3d4e5"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              aria-invalid={Boolean(fieldError)}
              className={`${inputClass(Boolean(fieldError))} font-mono`}
            />
          </Field>
        )}
        <PrimaryButton testId="mfa-verify-btn" loading={submitting}>
          Verify
        </PrimaryButton>
      </form>
      <div className="mt-4 text-center">
        <button
          type="button"
          data-testid="mfa-recovery-toggle"
          onClick={toggleMode}
          className="text-sm font-medium text-copper transition-colors duration-200 hover:text-navy"
        >
          {mode === "code" ? "Use a recovery code instead" : "Use your authenticator code instead"}
        </button>
      </div>
      <div className="mt-2 text-center">
        <CopperLink href="/sign-in" testId="mfa-verify-back-link">
          ← Back to sign in
        </CopperLink>
      </div>
    </AuthCard>
  );
}
