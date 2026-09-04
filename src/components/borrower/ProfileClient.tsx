"use client";

// /profile — ProfilePage (task-017, contracts §C; REQ-041, §4.2.12). Frame:
// gui-spec "profile" — sectioned cards: Personal info, Email change (current
// password + re-verify notice), Password change, MFA (re-enroll + recovery
// code regeneration), Notification preferences (Borrower only, SMS verify).
//
// Every mutation calls its §B endpoint and surfaces the server's ErrorResponse
// or Ack message VERBATIM (NFR-025). Email change: the OLD address stays
// active until the new one is verified — UserProfile.pendingEmail drives the
// notice. SMS: a channel of sms/both requires a VERIFIED mobile number
// (VR-030); the number is saved first (channel unchanged/email), verified via
// the simulated code, then the channel can be switched.

import { useCallback, useEffect, useState } from "react";
import { deleteWithCsrf, getJson, postWithCsrf, putWithCsrf } from "./api";
import type { MfaEnrollInit, NotificationChannelPreference, UserProfile } from "./types";
import {
  ApiErrorBanner,
  Badge,
  btnOutline,
  btnPrimary,
  Card,
  CardHeading,
  InfoBanner,
  SkeletonBlock,
} from "./ui";

type Feedback =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; details?: string[] }
  | null;

const INPUT_CLASS =
  "w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted transition-colors duration-200 focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25";

function FeedbackBanner({ feedback, testId }: { feedback: Feedback; testId: string }) {
  if (!feedback) return null;
  if (feedback.kind === "error") {
    return <ApiErrorBanner message={feedback.message} details={feedback.details} testId={`${testId}-error`} />;
  }
  return (
    <div
      role="status"
      data-testid={`${testId}-success`}
      className="mb-4 rounded-md border border-success/30 bg-success-soft px-3.5 py-2.5 text-sm text-success"
    >
      {feedback.message}
    </div>
  );
}

export function ProfileClient() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; details?: string[] } | null>(null);

  const load = useCallback(async () => {
    const result = await getJson<UserProfile>("/api/profile");
    if (!result.ok) {
      setLoadError({ message: result.error.message, details: result.error.details });
      return;
    }
    setLoadError(null);
    setProfile(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return <ApiErrorBanner message={loadError.message} details={loadError.details} testId="profile-load-error" />;
  }
  if (!profile) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <SkeletonBlock className="h-10 w-48" />
        <SkeletonBlock className="h-48 w-full" />
        <SkeletonBlock className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold text-ink">Your profile</h1>
      <div className="mt-6 space-y-5">
        <PersonalInfoCard profile={profile} onSaved={() => void load()} />
        <EmailChangeCard profile={profile} onChanged={() => void load()} />
        <PasswordChangeCard />
        <MfaCard />
        {profile.role === "BORROWER" ? (
          <NotificationPreferencesCard profile={profile} onChanged={() => void load()} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Personal info (PUT /api/profile — UpdateProfileRequest)
// ---------------------------------------------------------------------------

function PersonalInfoCard({ profile, onSaved }: { profile: UserProfile; onSaved: () => void }) {
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    const body: Record<string, unknown> = { firstName: firstName.trim(), lastName: lastName.trim() };
    if (phone.trim()) body.phone = phone.trim();
    const result = await putWithCsrf<UserProfile>("/api/profile", body);
    setBusy(false);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setFeedback({ kind: "success", message: "Your personal information has been saved." });
    onSaved();
  }

  return (
    <Card testId="profile-personal-card">
      <CardHeading>Personal information</CardHeading>
      <form className="mt-4" onSubmit={onSubmit} noValidate>
        <FeedbackBanner feedback={feedback} testId="profile-personal" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-first-name" className="mb-1.5 block text-sm font-medium text-ink">
              First name
            </label>
            <input
              id="profile-first-name"
              data-testid="profile-first-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor="profile-last-name" className="mb-1.5 block text-sm font-medium text-ink">
              Last name
            </label>
            <input
              id="profile-last-name"
              data-testid="profile-last-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
        </div>
        <div className="mt-4">
          <label htmlFor="profile-phone" className="mb-1.5 block text-sm font-medium text-ink">
            Phone
          </label>
          <input
            id="profile-phone"
            data-testid="profile-phone"
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            className={INPUT_CLASS}
          />
          <p className="mt-1 text-xs text-muted">
            Changing your phone number resets SMS verification and switches external notifications
            back to email until the new number is verified.
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="submit" data-testid="profile-save-btn" disabled={busy} className={btnPrimary}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Email change (POST /api/profile/change-email — ChangeEmailRequest)
// ---------------------------------------------------------------------------

function EmailChangeCard({ profile, onChanged }: { profile: UserProfile; onChanged: () => void }) {
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    const result = await postWithCsrf<{ message: string }>("/api/profile/change-email", {
      newEmail: newEmail.trim(),
      currentPassword,
    });
    setBusy(false);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setFeedback({ kind: "success", message: result.data.message });
    setNewEmail("");
    setCurrentPassword("");
    onChanged();
  }

  // DELETE /api/profile/change-email (CH-017) — abandon the pending change. The
  // endpoint returns the refreshed UserProfile, but the card re-reads through
  // onChanged() like every other mutation here so one load path owns the state.
  // No confirm dialog: this is reversible (request the change again) and clears
  // nothing the user still has — ConfirmDialog is reserved for the irreversible
  // borrower actions (withdraw / decline / delete draft).
  async function onCancelPending() {
    setCancelBusy(true);
    setFeedback(null);
    const result = await deleteWithCsrf<UserProfile>("/api/profile/change-email");
    setCancelBusy(false);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    // The 200 body carries no Ack message (it is a UserProfile), so this string is
    // the client's own — not a rewritten server message.
    setFeedback({
      kind: "success",
      message: "The pending email change was cancelled. Your current email address is unchanged.",
    });
    onChanged();
  }

  return (
    <Card testId="profile-email-card">
      <CardHeading>Email address</CardHeading>
      <p className="mt-2 text-sm text-ink-soft">
        Signed in as <span className="font-semibold text-ink" data-testid="profile-current-email">{profile.email}</span>
      </p>
      {profile.pendingEmail ? (
        <div className="mt-3">
          <InfoBanner testId="pending-email-notice">
            A change to <strong>{profile.pendingEmail}</strong> is awaiting verification. Your old
            email address stays active until the new one is verified from the link we sent.
            <div className="mt-2.5">
              <button
                type="button"
                data-testid="email-change-cancel-btn"
                onClick={onCancelPending}
                disabled={cancelBusy}
                className={btnOutline}
              >
                {cancelBusy ? "Cancelling…" : "Cancel this email change"}
              </button>
            </div>
          </InfoBanner>
        </div>
      ) : null}
      <form className="mt-4" onSubmit={onSubmit} noValidate data-testid="email-change-form">
        <FeedbackBanner feedback={feedback} testId="email-change" />
        <div>
          <label htmlFor="email-change-new-email" className="mb-1.5 block text-sm font-medium text-ink">
            New email address
          </label>
          <input
            id="email-change-new-email"
            data-testid="email-change-new-email"
            type="email"
            autoComplete="email"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="mt-4">
          <label htmlFor="email-change-password" className="mb-1.5 block text-sm font-medium text-ink">
            Current password
          </label>
          <input
            id="email-change-password"
            data-testid="email-change-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className={INPUT_CLASS}
          />
          <p className="mt-1 text-xs text-muted">
            We will email a verification link to the new address. Your current email keeps working
            until that link is used.
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            data-testid="email-change-submit"
            disabled={busy || !newEmail.trim() || !currentPassword}
            className={btnPrimary}
          >
            {busy ? "Submitting…" : "Change email"}
          </button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Password change (POST /api/auth/change-password — ChangePasswordRequest)
// ---------------------------------------------------------------------------

function PasswordChangeCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setBusy(true);
    setFeedback(null);
    const result = await postWithCsrf<{ message: string }>("/api/auth/change-password", {
      currentPassword,
      newPassword,
    });
    setBusy(false);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setFeedback({ kind: "success", message: result.data.message });
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  return (
    <Card testId="profile-password-card">
      <CardHeading>Password</CardHeading>
      <form className="mt-4" onSubmit={onSubmit} noValidate data-testid="password-change-form">
        <FeedbackBanner feedback={feedback} testId="password-change" />
        <div>
          <label htmlFor="password-change-current" className="mb-1.5 block text-sm font-medium text-ink">
            Current password
          </label>
          <input
            id="password-change-current"
            data-testid="password-change-current"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="password-change-new" className="mb-1.5 block text-sm font-medium text-ink">
              New password
            </label>
            <input
              id="password-change-new"
              data-testid="password-change-new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor="password-change-confirm" className="mb-1.5 block text-sm font-medium text-ink">
              Confirm new password
            </label>
            <input
              id="password-change-confirm"
              data-testid="password-change-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className={INPUT_CLASS}
              aria-invalid={mismatch}
            />
            {mismatch ? (
              <p className="mt-1 text-xs text-danger" role="alert">
                The new passwords do not match.
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            data-testid="password-change-submit"
            disabled={busy || !currentPassword || !newPassword || !confirmPassword}
            className={btnPrimary}
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MFA — re-enroll + recovery-code regeneration (REQ-013/REQ-041)
// ---------------------------------------------------------------------------

type MfaFlow =
  | { phase: "idle" }
  | { phase: "credentials"; action: "reenroll" | "regenerate" }
  | { phase: "verify-new-secret"; init: MfaEnrollInit }
  | { phase: "recovery-codes"; codes: string[] };

function MfaCard() {
  const [flow, setFlow] = useState<MfaFlow>({ phase: "idle" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [copied, setCopied] = useState(false);

  function startFlow(action: "reenroll" | "regenerate") {
    setCurrentPassword("");
    setCode("");
    setVerifyCode("");
    setUseRecovery(false);
    setFeedback(null);
    setFlow({ phase: "credentials", action });
  }

  async function onCredentialsSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (flow.phase !== "credentials") return;
    setBusy(true);
    setFeedback(null);
    // contracts §A MfaReenrollRequest: currentPassword + code | recoveryCode.
    const body: Record<string, unknown> = { currentPassword };
    if (useRecovery) body.recoveryCode = code.trim();
    else body.code = code.trim();

    if (flow.action === "reenroll") {
      const result = await postWithCsrf<MfaEnrollInit>("/api/auth/mfa/reenroll", body);
      setBusy(false);
      if (!result.ok) {
        setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
        return;
      }
      setFlow({ phase: "verify-new-secret", init: result.data });
    } else {
      const result = await postWithCsrf<{ recoveryCodes: string[] }>(
        "/api/auth/recovery-codes/regenerate",
        body,
      );
      setBusy(false);
      if (!result.ok) {
        setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
        return;
      }
      setFlow({ phase: "recovery-codes", codes: result.data.recoveryCodes });
    }
  }

  async function onVerifyNewSecret(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    const result = await postWithCsrf<{ recoveryCodes: string[] }>("/api/auth/mfa/enroll/verify", {
      code: verifyCode.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setFlow({ phase: "recovery-codes", codes: result.data.recoveryCodes });
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

  return (
    <Card testId="profile-mfa-card">
      <CardHeading>Multi-factor authentication</CardHeading>
      <p className="mt-2 text-sm text-ink-soft">
        Your account is protected with an authenticator app. You can enroll a new device or
        generate a fresh set of one-time recovery codes — both require your password and a current
        code.
      </p>

      {flow.phase === "idle" ? (
        <div className="mt-4 flex flex-wrap gap-2.5">
          <button
            type="button"
            data-testid="mfa-reenroll-btn"
            onClick={() => startFlow("reenroll")}
            className={btnOutline}
          >
            Re-enroll a new device
          </button>
          <button
            type="button"
            data-testid="recovery-regenerate-btn"
            onClick={() => startFlow("regenerate")}
            className={btnOutline}
          >
            Regenerate recovery codes
          </button>
        </div>
      ) : null}

      {flow.phase === "credentials" ? (
        <form className="mt-4 rounded-md border border-line bg-paper p-4" onSubmit={onCredentialsSubmit} noValidate>
          <p className="text-sm font-semibold text-ink">
            {flow.action === "reenroll" ? "Re-enroll a new device" : "Regenerate recovery codes"}
          </p>
          <div className="mt-3">
            <FeedbackBanner feedback={feedback} testId="mfa-credentials" />
          </div>
          <div>
            <label htmlFor="mfa-current-password" className="mb-1.5 block text-sm font-medium text-ink">
              Current password
            </label>
            <input
              id="mfa-current-password"
              data-testid="mfa-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          <div className="mt-3">
            <label htmlFor="mfa-credential-code" className="mb-1.5 block text-sm font-medium text-ink">
              {useRecovery ? "Recovery code" : "6-digit authenticator code"}
            </label>
            <input
              id="mfa-credential-code"
              data-testid="mfa-credential-code"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={INPUT_CLASS}
            />
            <button
              type="button"
              data-testid="mfa-toggle-recovery"
              onClick={() => setUseRecovery((value) => !value)}
              className="mt-1.5 text-xs font-medium text-copper transition-colors duration-200 hover:text-navy"
            >
              {useRecovery ? "Use an authenticator code instead" : "Use a recovery code instead"}
            </button>
          </div>
          <div className="mt-4 flex justify-end gap-2.5">
            <button
              type="button"
              data-testid="mfa-flow-cancel"
              onClick={() => setFlow({ phase: "idle" })}
              className={btnOutline}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="mfa-flow-continue"
              disabled={busy || !currentPassword || !code.trim()}
              className={btnPrimary}
            >
              {busy ? "Please wait…" : "Continue"}
            </button>
          </div>
        </form>
      ) : null}

      {flow.phase === "verify-new-secret" ? (
        <form className="mt-4 rounded-md border border-line bg-paper p-4" onSubmit={onVerifyNewSecret} noValidate>
          <p className="text-sm font-semibold text-ink">Scan with your new device</p>
          <p className="mt-1 text-xs text-muted">
            Your existing authenticator keeps working until the new one is verified.
          </p>
          <div className="mt-3">
            <FeedbackBanner feedback={feedback} testId="mfa-verify" />
          </div>
          <div className="flex justify-center rounded-md border border-line bg-white p-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URI QR from the API */}
            <img
              src={flow.init.qrCodeDataUrl}
              alt="QR code for authenticator app enrollment"
              data-testid="mfa-reenroll-qr"
              width={160}
              height={160}
              className="h-40 w-40"
            />
          </div>
          <p className="mt-2 break-all text-center font-mono text-xs text-ink-soft" data-testid="mfa-reenroll-secret">
            {flow.init.secret}
          </p>
          <div className="mt-3">
            <label htmlFor="mfa-reenroll-code" className="mb-1.5 block text-sm font-medium text-ink">
              6-digit code from the new device
            </label>
            <input
              id="mfa-reenroll-code"
              data-testid="mfa-reenroll-code"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              value={verifyCode}
              onChange={(event) => setVerifyCode(event.target.value)}
              className={`${INPUT_CLASS} text-center font-mono text-lg tracking-[0.4em]`}
            />
          </div>
          <div className="mt-4 flex justify-end gap-2.5">
            <button
              type="button"
              data-testid="mfa-verify-cancel"
              onClick={() => setFlow({ phase: "idle" })}
              className={btnOutline}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="mfa-reenroll-verify-btn"
              disabled={busy || verifyCode.trim().length !== 6}
              className={btnPrimary}
            >
              {busy ? "Verifying…" : "Verify and activate"}
            </button>
          </div>
        </form>
      ) : null}

      {flow.phase === "recovery-codes" ? (
        <div className="mt-4 rounded-md border border-line bg-paper p-4">
          <div
            role="alert"
            className="rounded-md border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-sm text-warn"
          >
            <strong>These codes are shown exactly once.</strong> Any previous recovery codes no
            longer work. Store these somewhere safe.
          </div>
          <ul
            data-testid="profile-recovery-codes-list"
            className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-line bg-card p-4 font-mono text-sm text-ink"
          >
            {flow.codes.map((recoveryCode) => (
              <li key={recoveryCode} data-testid="profile-recovery-code-item">
                {recoveryCode}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end gap-2.5">
            <button
              type="button"
              data-testid="profile-recovery-codes-copy"
              onClick={() => void onCopyCodes(flow.codes)}
              className={btnOutline}
            >
              {copied ? "Copied ✓" : "Copy all codes"}
            </button>
            <button
              type="button"
              data-testid="profile-recovery-codes-done"
              onClick={() => setFlow({ phase: "idle" })}
              className={btnPrimary}
            >
              I saved them — done
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Notification preferences (Borrower only — REQ-041, VR-030)
// ---------------------------------------------------------------------------

function NotificationPreferencesCard({
  profile,
  onChanged,
}: {
  profile: UserProfile;
  onChanged: () => void;
}) {
  const [channel, setChannel] = useState<NotificationChannelPreference>(
    profile.notificationChannel ?? "email",
  );
  const [mobileNumber, setMobileNumber] = useState(profile.phone ?? "");
  const [smsCode, setSmsCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<"number" | "send" | "confirm" | "channel" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const smsVerified = profile.smsVerified === true;

  async function onSaveNumber() {
    setBusy("number");
    setFeedback(null);
    // Saving a (possibly new) number cannot itself be verified — keep the
    // channel at email until verification completes (VR-030 server rule).
    const result = await putWithCsrf<UserProfile>("/api/profile/notification-preferences", {
      channel: "email",
      mobileNumber: mobileNumber.trim(),
    });
    setBusy(null);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setChannel("email");
    setCodeSent(false);
    setFeedback({ kind: "success", message: "Mobile number saved. Send a verification code to activate SMS." });
    onChanged();
  }

  async function onSendCode() {
    setBusy("send");
    setFeedback(null);
    const result = await postWithCsrf<{ message: string }>("/api/profile/sms-verification");
    setBusy(null);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setCodeSent(true);
    setFeedback({ kind: "success", message: result.data.message });
  }

  async function onConfirmCode() {
    setBusy("confirm");
    setFeedback(null);
    const result = await postWithCsrf<UserProfile>("/api/profile/sms-verification/confirm", {
      code: smsCode.trim(),
    });
    setBusy(null);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setSmsCode("");
    setCodeSent(false);
    setFeedback({ kind: "success", message: "Mobile number verified. You can now choose SMS notifications." });
    onChanged();
  }

  async function onSaveChannel() {
    setBusy("channel");
    setFeedback(null);
    const result = await putWithCsrf<UserProfile>("/api/profile/notification-preferences", {
      channel,
    });
    setBusy(null);
    if (!result.ok) {
      setFeedback({ kind: "error", message: result.error.message, details: result.error.details });
      return;
    }
    setFeedback({ kind: "success", message: "Notification preference saved." });
    onChanged();
  }

  const channels: { value: NotificationChannelPreference; label: string; hint: string }[] = [
    { value: "email", label: "Email", hint: "Updates by email (default)" },
    { value: "sms", label: "SMS", hint: "Text messages to your verified mobile" },
    { value: "both", label: "Both", hint: "Email and SMS" },
  ];

  return (
    <Card testId="profile-notifications-card">
      <CardHeading>Notification preferences</CardHeading>
      <p className="mt-2 text-sm text-ink-soft">
        In-app notifications are always on. Choose how we reach you outside the portal.
      </p>
      <div className="mt-3">
        <FeedbackBanner feedback={feedback} testId="notif-pref" />
      </div>

      {/* Mobile number + simulated SMS verification */}
      <div className="rounded-md border border-line bg-paper p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-ink">Mobile number</p>
          {smsVerified ? (
            <Badge tone="success" testId="sms-verified-badge">
              Verified
            </Badge>
          ) : (
            <Badge tone="warn" testId="sms-unverified-badge">
              Not verified
            </Badge>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <input
            data-testid="notif-mobile-number"
            aria-label="Mobile number"
            type="tel"
            value={mobileNumber}
            onChange={(event) => setMobileNumber(event.target.value)}
            className={`${INPUT_CLASS} max-w-xs`}
          />
          <button
            type="button"
            data-testid="notif-mobile-save"
            onClick={() => void onSaveNumber()}
            disabled={busy !== null || !mobileNumber.trim()}
            className={btnOutline}
          >
            {busy === "number" ? "Saving…" : "Save number"}
          </button>
          {!smsVerified ? (
            <button
              type="button"
              data-testid="sms-send-code-btn"
              onClick={() => void onSendCode()}
              disabled={busy !== null || !profile.phone}
              className={btnOutline}
            >
              {busy === "send" ? "Sending…" : "Send verification code"}
            </button>
          ) : null}
        </div>
        {codeSent && !smsVerified ? (
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <input
              data-testid="sms-verify-input"
              aria-label="SMS verification code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Enter the code we texted you"
              value={smsCode}
              onChange={(event) => setSmsCode(event.target.value)}
              className={`${INPUT_CLASS} max-w-xs`}
            />
            <button
              type="button"
              data-testid="sms-confirm-btn"
              onClick={() => void onConfirmCode()}
              disabled={busy !== null || !smsCode.trim()}
              className={btnPrimary}
            >
              {busy === "confirm" ? "Confirming…" : "Confirm code"}
            </button>
          </div>
        ) : null}
      </div>

      {/* Channel choice */}
      <fieldset className="mt-4">
        <legend className="text-sm font-semibold text-ink">External channel</legend>
        <div className="mt-2.5 space-y-2">
          {channels.map((option) => {
            const disabled = (option.value === "sms" || option.value === "both") && !smsVerified;
            return (
              <label
                key={option.value}
                className={`flex items-start gap-3 rounded-md border p-3 transition-colors duration-200 ${
                  disabled
                    ? "cursor-not-allowed border-line opacity-60"
                    : channel === option.value
                      ? "cursor-pointer border-navy bg-navy/5"
                      : "cursor-pointer border-line hover:border-navy/40"
                }`}
              >
                <input
                  type="radio"
                  name="notification-channel"
                  data-testid={`notif-pref-${option.value}`}
                  checked={channel === option.value}
                  disabled={disabled}
                  onChange={() => setChannel(option.value)}
                  className="mt-0.5 h-4 w-4 accent-navy"
                />
                <span>
                  <span className="block text-sm font-semibold text-ink">{option.label}</span>
                  <span className="block text-xs text-muted">
                    {option.hint}
                    {disabled ? " — verify your mobile number first" : ""}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          data-testid="notif-pref-save-btn"
          onClick={() => void onSaveChannel()}
          disabled={busy !== null}
          className={btnPrimary}
        >
          {busy === "channel" ? "Saving…" : "Save preference"}
        </button>
      </div>
    </Card>
  );
}
