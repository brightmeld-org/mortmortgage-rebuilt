"use client";

// Sign-in form + demo quick logins (task-009). Frame: screen-signin.png —
// centered card, uniform error banner, Forgot password / Create account links,
// demo panel below the card (DEMO_MODE badge, three role buttons).
//
// UNIFORM ERROR: every sign-in failure renders the server's ErrorResponse
// message VERBATIM in the same banner — wrong password, unknown email, locked,
// inactive all arrive as the same 401 body by design; the client adds nothing.
//
// SignInResponse routing (§A SignInStatus literals):
//   signed-in                → requested page (validated ?redirectTo=) ?? server redirectTo
//   mfa-required             → /mfa/verify   (requested page threaded through)
//   mfa-enrollment-required  → /mfa/enroll   (requested page threaded through)
//   verification-pending     → /verify-email (requested page threaded through)

import { useState } from "react";
import { postJson, type SignInResponse } from "@/components/auth/api";
import { safeRedirect, withRedirectParam } from "@/components/auth/redirect";
import {
  AuthCard,
  AuthHeading,
  ErrorBanner,
  Field,
  PrimaryButton,
  inputClass,
} from "@/components/auth/ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignInForm({
  redirectTo,
  demoMode,
}: {
  redirectTo: string | null;
  demoMode: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [serverError, setServerError] = useState<{ message: string; details?: string[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [demoSubmitting, setDemoSubmitting] = useState<string | null>(null);

  /** Post-auth navigation — full navigation so the fresh session cookie drives SSR. */
  function navigate(target: string) {
    window.location.assign(target);
  }

  function routeForResponse(data: SignInResponse): string {
    switch (data.status) {
      case "signed-in":
        // Requested page wins; the server target is the fallback (both validated).
        return redirectTo ?? safeRedirect(data.redirectTo) ?? "/";
      case "mfa-required":
        return withRedirectParam("/mfa/verify", redirectTo);
      case "mfa-enrollment-required":
        return withRedirectParam("/mfa/enroll", redirectTo);
      case "verification-pending":
        return withRedirectParam("/verify-email", redirectTo);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Client mirrors of VR-007/VR-008 (UX only — the server is authoritative).
    const errors: { email?: string; password?: string } = {};
    if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
    if (password.length === 0) errors.password = "Enter your password.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    const result = await postJson<SignInResponse>("/api/auth/sign-in", { email, password });
    if (!result.ok) {
      setServerError({ message: result.error.message, details: result.error.details });
      setSubmitting(false);
      return;
    }
    navigate(routeForResponse(result.data));
  }

  async function onDemoLogin(role: "borrower" | "caseworker" | "supervisor") {
    setDemoSubmitting(role);
    setServerError(null);
    const result = await postJson<SignInResponse>("/api/auth/demo-login", { role });
    if (!result.ok) {
      setServerError({ message: result.error.message, details: result.error.details });
      setDemoSubmitting(null);
      return;
    }
    // Demo logins are full sessions — land on the role home the server names.
    navigate(safeRedirect(result.data.redirectTo) ?? "/");
  }

  return (
    <>
      <AuthCard>
        <AuthHeading
          title="Sign in"
          subtitle="Multi-factor authentication is required on every account."
        />
        {serverError ? (
          <ErrorBanner message={serverError.message} details={serverError.details} testId="signin-error" />
        ) : null}
        <form onSubmit={onSubmit} noValidate>
          <Field id="signin-email" label="Email" error={fieldErrors.email}>
            <input
              id="signin-email"
              data-testid="signin-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
              className={inputClass(Boolean(fieldErrors.email))}
            />
          </Field>
          <Field id="signin-password" label="Password" error={fieldErrors.password}>
            <input
              id="signin-password"
              data-testid="signin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(fieldErrors.password)}
              className={inputClass(Boolean(fieldErrors.password))}
            />
          </Field>
          <div className="mt-6">
            <PrimaryButton testId="signin-submit" loading={submitting}>
              Sign in
            </PrimaryButton>
          </div>
        </form>
        <div className="mt-4 flex items-center justify-between">
          <a
            href="/forgot-password"
            data-testid="signin-forgot-link"
            className="text-sm font-medium text-copper transition-colors duration-200 hover:text-navy"
          >
            Forgot password?
          </a>
          <a
            href={withRedirectParam("/sign-up", redirectTo)}
            data-testid="signin-signup-link"
            className="text-sm font-medium text-copper transition-colors duration-200 hover:text-navy"
          >
            Create account
          </a>
        </div>
      </AuthCard>

      {demoMode ? (
        <section className="mt-5 rounded-xl border border-line bg-copper-soft/40 p-5">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
              Demo quick logins
            </h2>
            <span className="rounded bg-copper-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-copper">
              demo_mode
            </span>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {(
              [
                ["borrower", "Borrower"],
                ["caseworker", "Caseworker"],
                ["supervisor", "Supervisor"],
              ] as const
            ).map(([role, label]) => (
              <button
                key={role}
                type="button"
                data-testid={`demo-login-${role}`}
                onClick={() => onDemoLogin(role)}
                disabled={demoSubmitting !== null}
                className="flex-1 rounded-md border border-line bg-card px-4 py-2 text-sm font-semibold text-ink transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-copper hover:text-copper disabled:cursor-not-allowed disabled:opacity-60"
              >
                {demoSubmitting === role ? "Signing in…" : label}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
