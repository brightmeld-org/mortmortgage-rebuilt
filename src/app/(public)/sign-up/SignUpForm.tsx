"use client";

// Registration form (task-009). Frame: gui-spec sign-up — centered card with
// first name, last name, email, password, confirm, terms checkbox; success
// state is the "check your messages" screen.
//
// Payload mirrors contracts §A RegisterRequest EXACTLY: firstName, lastName,
// email, password, passwordConfirmation, acceptTerms. Client checks mirror §E
// VR-001..VR-006 for instant feedback only — the server remains authoritative
// (character classes + common-password list run server-side under VR-004).
//
// UNIFORM RESPONSE: the success screen renders the server Ack verbatim and
// never claims whether an email/account existed (prototype-fidelity rule in
// FLOW-002: registration must not reveal account existence).

import { useState } from "react";
import { postJson } from "@/components/auth/api";
import { withRedirectParam } from "@/components/auth/redirect";
import {
  AuthCard,
  AuthHeading,
  CopperLink,
  ErrorBanner,
  Field,
  PrimaryButton,
  inputClass,
} from "@/components/auth/ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  passwordConfirmation?: string;
  acceptTerms?: string;
}

export function SignUpForm({ redirectTo }: { redirectTo: string | null }) {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    passwordConfirmation: "",
    acceptTerms: false,
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<{ message: string; details?: string[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ackMessage, setAckMessage] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (form.firstName.trim().length === 0) errors.firstName = "First name is required."; // VR-001
    if (form.lastName.trim().length === 0) errors.lastName = "Last name is required."; // VR-002
    if (!EMAIL_RE.test(form.email)) errors.email = "Enter a valid email address."; // VR-003
    if (form.password.length < 12) errors.password = "Password must be at least 12 characters."; // VR-004
    if (form.passwordConfirmation !== form.password)
      errors.passwordConfirmation = "Passwords must match."; // VR-005
    if (!form.acceptTerms) errors.acceptTerms = "You must accept the terms to create an account."; // VR-006
    return errors;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    // contracts §A RegisterRequest — exact field names.
    const result = await postJson<{ message: string }>("/api/auth/register", {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email,
      password: form.password,
      passwordConfirmation: form.passwordConfirmation,
      acceptTerms: form.acceptTerms,
    });
    setSubmitting(false);
    if (!result.ok) {
      setServerError({ message: result.error.message, details: result.error.details });
      return;
    }
    setAckMessage(result.data.message);
  }

  if (ackMessage !== null) {
    // "Check your messages" success screen (FLOW-002 step 2).
    return (
      <AuthCard>
        <AuthHeading title="Check your messages" />
        <p data-testid="signup-success" className="text-sm text-ink-soft" role="status">
          {ackMessage}
        </p>
        <div className="mt-4 rounded-md border border-line bg-info-soft px-3.5 py-2.5 text-sm text-info">
          This demo delivers email on the <strong>Outbound Messages</strong> page
          (Supervisor → Outbound Messages) instead of a real inbox. Open your
          verification message there and follow its link to finish setting up.
        </div>
        <div className="mt-6">
          <CopperLink href={withRedirectParam("/sign-in", redirectTo)} testId="signup-signin-link">
            Go to sign in →
          </CopperLink>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading title="Create account" subtitle="Borrower self-registration — takes about a minute." />
      {serverError ? (
        <ErrorBanner message={serverError.message} details={serverError.details} testId="signup-error" />
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <Field id="signup-first-name" label="First name" error={fieldErrors.firstName}>
            <input
              id="signup-first-name"
              data-testid="signup-first-name"
              type="text"
              autoComplete="given-name"
              value={form.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              aria-invalid={Boolean(fieldErrors.firstName)}
              className={inputClass(Boolean(fieldErrors.firstName))}
            />
          </Field>
          <Field id="signup-last-name" label="Last name" error={fieldErrors.lastName}>
            <input
              id="signup-last-name"
              data-testid="signup-last-name"
              type="text"
              autoComplete="family-name"
              value={form.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              aria-invalid={Boolean(fieldErrors.lastName)}
              className={inputClass(Boolean(fieldErrors.lastName))}
            />
          </Field>
        </div>
        <Field id="signup-email" label="Email" error={fieldErrors.email}>
          <input
            id="signup-email"
            data-testid="signup-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            aria-invalid={Boolean(fieldErrors.email)}
            className={inputClass(Boolean(fieldErrors.email))}
          />
        </Field>
        <Field
          id="signup-password"
          label="Password"
          error={fieldErrors.password}
          hint="At least 12 characters, using 3 of 4: uppercase, lowercase, digits, symbols."
        >
          <input
            id="signup-password"
            data-testid="signup-password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            aria-invalid={Boolean(fieldErrors.password)}
            className={inputClass(Boolean(fieldErrors.password))}
          />
        </Field>
        <Field
          id="signup-password-confirmation"
          label="Confirm password"
          error={fieldErrors.passwordConfirmation}
        >
          <input
            id="signup-password-confirmation"
            data-testid="signup-password-confirmation"
            type="password"
            autoComplete="new-password"
            value={form.passwordConfirmation}
            onChange={(e) => set("passwordConfirmation", e.target.value)}
            aria-invalid={Boolean(fieldErrors.passwordConfirmation)}
            className={inputClass(Boolean(fieldErrors.passwordConfirmation))}
          />
        </Field>
        <div className="mb-2">
          <label className="flex items-start gap-2.5 text-sm text-ink-soft">
            <input
              type="checkbox"
              data-testid="signup-accept-terms"
              checked={form.acceptTerms}
              onChange={(e) => set("acceptTerms", e.target.checked)}
              aria-invalid={Boolean(fieldErrors.acceptTerms)}
              className="mt-0.5 h-4 w-4 rounded border-line accent-navy"
            />
            <span>
              I agree to the terms of service and consent to the processing of my
              application data.
            </span>
          </label>
          {fieldErrors.acceptTerms ? (
            <p className="mt-1 text-xs text-danger" role="alert">
              {fieldErrors.acceptTerms}
            </p>
          ) : null}
        </div>
        <div className="mt-5">
          <PrimaryButton testId="signup-submit" loading={submitting}>
            Create account
          </PrimaryButton>
        </div>
      </form>
      <div className="mt-4 text-center">
        <CopperLink href={withRedirectParam("/sign-in", redirectTo)} testId="signup-signin-link">
          Already have an account? Sign in
        </CopperLink>
      </div>
    </AuthCard>
  );
}
