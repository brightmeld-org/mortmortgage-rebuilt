"use client";

// MFA enrollment (task-009). Frame: gui-spec mfa-enroll — centered card,
// stepper: (1) QR + text secret, (2) code entry, (3) recovery codes shown once
// with copy + "I saved them" confirm.
//
// AUTO-INIT: POSTs /api/auth/mfa/enroll on mount. That endpoint runs on the
// PRE-MFA session (10-minute enrollment window) and is CSRF-exempt pre-MFA
// (guardMfaFlow). Outcomes:
//   200 MfaEnrollInit { secret, otpauthUrl, qrCodeDataUrl } → render step 1+2
//   409 (INV-034 active enrollment)                        → this user belongs
//        on the challenge page — redirect /mfa/verify (redirectTo threaded)
//   401 (no session / window expired)                      → prompt to sign in
//
// VERIFY: POST /api/auth/mfa/enroll/verify { code } (MfaEnrollVerifyRequest) →
// MfaEnrollVerifyResponse.recoveryCodes — displayed EXACTLY ONCE with a strong
// warning; Continue resolves the destination: requested page ?? role home from
// the (now full) session.

import { useEffect, useRef, useState } from "react";
import { getSession, postJson } from "@/components/auth/api";
import { safeRedirect } from "@/components/auth/redirect";
import { ROLE_HOME } from "@/lib/role-home";
import {
  AuthCard,
  AuthHeading,
  CopperLink,
  ErrorBanner,
  Field,
  PrimaryButton,
  Skeleton,
  inputClass,
} from "@/components/auth/ui";

interface MfaEnrollInit {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

type EnrollState =
  | { phase: "initializing" }
  | { phase: "signed-out" }
  | { phase: "enter-code"; init: MfaEnrollInit }
  | { phase: "recovery-codes"; codes: string[] };

export function MfaEnrollClient({ redirectTo }: { redirectTo: string | null }) {
  const [state, setState] = useState<EnrollState>({ phase: "initializing" });
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<{ message: string; details?: string[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const initFiredRef = useRef(false);

  useEffect(() => {
    if (initFiredRef.current) return; // React strict double-mount guard
    initFiredRef.current = true;
    void (async () => {
      const result = await postJson<MfaEnrollInit>("/api/auth/mfa/enroll");
      if (result.ok) {
        setState({ phase: "enter-code", init: result.data });
        return;
      }
      if (result.status === 409) {
        // Active enrollment exists — the user should take the TOTP challenge.
        const target = redirectTo
          ? `/mfa/verify?redirectTo=${encodeURIComponent(redirectTo)}`
          : "/mfa/verify";
        window.location.replace(target);
        return;
      }
      if (result.status === 401) {
        setState({ phase: "signed-out" });
        return;
      }
      setState({ phase: "signed-out" });
      setServerError({ message: result.error.message, details: result.error.details });
    })();
  }, [redirectTo]);

  async function onVerify(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setCodeError("Enter the 6-digit code from your authenticator app."); // VR-015 mirror
      return;
    }
    setCodeError(null);
    setSubmitting(true);
    setServerError(null);
    // contracts §A MfaEnrollVerifyRequest — exact field name.
    const result = await postJson<{ recoveryCodes: string[] }>("/api/auth/mfa/enroll/verify", {
      code: code.trim(),
    });
    setSubmitting(false);
    if (!result.ok) {
      setServerError({ message: result.error.message, details: result.error.details });
      return;
    }
    setState({ phase: "recovery-codes", codes: result.data.recoveryCodes });
  }

  async function onContinue() {
    // Session is now a FULL session — resolve the role home as the fallback.
    const info = await getSession();
    const roleHome = info !== null ? ROLE_HOME[info.role] : "/";
    window.location.assign(redirectTo ?? safeRedirect(roleHome) ?? "/");
  }

  async function onCopyCodes(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (state.phase === "initializing") {
    return (
      <AuthCard>
        <AuthHeading title="Set up multi-factor authentication" />
        <div data-testid="mfa-enroll-loading" aria-live="polite">
          <p className="mb-3 text-sm text-ink-soft">Preparing your enrollment…</p>
          <Skeleton className="mx-auto mb-3 h-44 w-44" />
          <Skeleton className="h-9 w-full" />
        </div>
      </AuthCard>
    );
  }

  if (state.phase === "signed-out") {
    return (
      <AuthCard>
        <AuthHeading title="Set up multi-factor authentication" />
        {serverError ? (
          <ErrorBanner message={serverError.message} details={serverError.details} testId="mfa-enroll-error" />
        ) : null}
        <p data-testid="mfa-enroll-signed-out" className="mb-6 text-sm text-ink-soft" role="alert">
          Your enrollment window is not active. Sign in to start MFA setup — you
          will be brought back here automatically.
        </p>
        <PrimaryButton
          testId="mfa-enroll-signin-btn"
          type="button"
          onClick={() =>
            window.location.assign(
              redirectTo ? `/sign-in?redirectTo=${encodeURIComponent(redirectTo)}` : "/sign-in",
            )
          }
        >
          Go to sign in
        </PrimaryButton>
      </AuthCard>
    );
  }

  if (state.phase === "recovery-codes") {
    return (
      <AuthCard>
        <AuthHeading title="Save your recovery codes" />
        <div
          role="alert"
          className="mb-4 rounded-md border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-sm text-warn"
        >
          <strong>These codes are shown exactly once.</strong> Store them
          somewhere safe — each works one time if you lose access to your
          authenticator app. They cannot be viewed again.
        </div>
        <ul
          data-testid="recovery-codes-list"
          className="mb-4 grid grid-cols-2 gap-2 rounded-md border border-line bg-paper p-4 font-mono text-sm text-ink"
        >
          {state.codes.map((recoveryCode) => (
            <li key={recoveryCode} data-testid="recovery-code-item">
              {recoveryCode}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            data-testid="recovery-codes-copy"
            onClick={() => onCopyCodes(state.codes)}
            className="w-full rounded-md border border-navy bg-card px-4 py-2.5 text-sm font-semibold text-navy transition-colors duration-200 hover:bg-navy hover:text-white"
          >
            {copied ? "Copied to clipboard ✓" : "Copy all codes"}
          </button>
          <PrimaryButton testId="recovery-codes-continue" type="button" onClick={onContinue}>
            I saved them — continue
          </PrimaryButton>
        </div>
      </AuthCard>
    );
  }

  const { init } = state;
  return (
    <AuthCard>
      <AuthHeading
        title="Set up multi-factor authentication"
        subtitle="Scan the QR code with your authenticator app, then enter the 6-digit code it shows."
      />
      {serverError ? (
        <ErrorBanner message={serverError.message} details={serverError.details} testId="mfa-enroll-error" />
      ) : null}
      <div className="mb-4 flex justify-center rounded-md border border-line bg-white p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URI QR from the API */}
        <img
          src={init.qrCodeDataUrl}
          alt="QR code for authenticator app enrollment"
          data-testid="mfa-qr"
          width={176}
          height={176}
          className="h-44 w-44"
        />
      </div>
      <div className="mb-4 text-center">
        <button
          type="button"
          data-testid="mfa-secret-toggle"
          onClick={() => setShowSecret((value) => !value)}
          className="text-sm font-medium text-copper transition-colors duration-200 hover:text-navy"
        >
          {showSecret ? "Hide manual entry key" : "Can't scan? Enter the key manually"}
        </button>
        {showSecret ? (
          <div className="mt-2 rounded-md border border-line bg-paper p-3 text-left">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Manual key</p>
            <p data-testid="mfa-secret" className="mt-1 break-all font-mono text-sm text-ink">
              {init.secret}
            </p>
            <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-muted">otpauth URL</p>
            <p data-testid="mfa-otpauth-url" className="mt-1 break-all font-mono text-xs text-ink-soft">
              {init.otpauthUrl}
            </p>
          </div>
        ) : null}
      </div>
      <form onSubmit={onVerify} noValidate>
        <Field id="mfa-code-input" label="6-digit code" error={codeError}>
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
            aria-invalid={Boolean(codeError)}
            className={`${inputClass(Boolean(codeError))} text-center font-mono text-lg tracking-[0.4em]`}
          />
        </Field>
        <PrimaryButton testId="mfa-verify-btn" loading={submitting}>
          Verify and activate
        </PrimaryButton>
      </form>
      <div className="mt-4 text-center">
        <CopperLink href="/sign-in" testId="mfa-enroll-back-link">
          ← Back to sign in
        </CopperLink>
      </div>
    </AuthCard>
  );
}
