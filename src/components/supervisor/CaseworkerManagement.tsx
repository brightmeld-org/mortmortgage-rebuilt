"use client";

// CaseworkerManagement (contracts §C, task-033, REQ-063) — the /supervisor/caseworkers
// staff table + Add-account invitation modal + Deactivate/Reactivate/Reset-MFA
// actions (frame §sup-caseworkers vocabulary, increment-6 design language).
//
// Reached from: (app) shell supervisor nav → "Staff" (nav-sup-staff) →
// /supervisor/caseworkers (src/app/(app)/supervisor/caseworkers/page.tsx).
//
// Every path is from the contracts §B endpoint table. Guard messaging (INV-002
// self-deactivation, INV-005 last-supervisor, no-active-MFA 409s) is surfaced
// VERBATIM from the API ErrorResponse bodies (NFR-025) — the client never
// re-words or pre-empts a server guard. The self-action guards (INV-002
// deactivate, INV-003 reset-MFA) are ALSO mirrored client-side: the buttons on
// the signed-in supervisor's own row are disabled with an explanatory tooltip —
// the server guard remains the authority.
//
// Selector contract (build-plan §C): staff-row-{id}, staff-add-btn,
// staff-invite-{field}, staff-deactivate-{id}, staff-reactivate-{id},
// staff-reset-mfa-{id} — extended within the namespace only
// (staff-invite-submit, staff-invite-error, staff-action-error, staff-invite-success).

import { useCallback, useEffect, useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import {
  ApiErrorBanner,
  Badge,
  Card,
  ConfirmDialog,
  SkeletonBlock,
  btnDanger,
  btnOutline,
  btnPrimary,
} from "@/components/borrower/ui";
import { formatDate } from "@/components/borrower/format";

// contracts.json models.StaffAccountRow — exact field names.
interface StaffAccountRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "CASEWORKER" | "SUPERVISOR"; // enums.StaffRole verbatim
  status: "active" | "inactive"; // enums.UserStatus verbatim
  mfaStatus: "enrolled" | "pending" | "reset"; // enums.MfaStatus verbatim
  activeAssignments: number;
  completedThisMonth: number;
  lastSignInAt?: string;
}

interface StaffListResponse {
  rows: StaffAccountRow[];
}

const ROLE_LABELS: Record<StaffAccountRow["role"], string> = {
  CASEWORKER: "Caseworker",
  SUPERVISOR: "Supervisor",
};

const MFA_LABELS: Record<StaffAccountRow["mfaStatus"], string> = {
  enrolled: "Enrolled",
  pending: "Pending",
  reset: "Enrollment required",
};

const MFA_TONES: Record<StaffAccountRow["mfaStatus"], "success" | "warn" | "gray"> = {
  enrolled: "success",
  pending: "warn",
  reset: "gray",
};

type ApiError = { message: string; details?: string[] };

function toApiError(error: ErrorResponseBody): ApiError {
  return { message: error.message, details: error.details };
}

// contracts §A InviteStaffRequest — exact field names.
interface InviteDraft {
  firstName: string;
  lastName: string;
  email: string;
  role: "CASEWORKER" | "SUPERVISOR";
}

const EMPTY_DRAFT: InviteDraft = { firstName: "", lastName: "", email: "", role: "CASEWORKER" };

export function CaseworkerManagement({ currentUserId }: { currentUserId: string }) {
  const [rows, setRows] = useState<StaffAccountRow[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  // Add-account modal state.
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<InviteDraft>(EMPTY_DRAFT);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<ApiError | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  // Deactivate confirm state.
  const [deactivateTarget, setDeactivateTarget] = useState<StaffAccountRow | null>(null);
  const [deactivateBusy, setDeactivateBusy] = useState(false);
  const [deactivateError, setDeactivateError] = useState<ApiError | null>(null);

  // Reset-MFA confirm state (destructive: strips the factor + revokes sessions).
  const [resetMfaTarget, setResetMfaTarget] = useState<StaffAccountRow | null>(null);
  const [resetMfaBusy, setResetMfaBusy] = useState(false);
  const [resetMfaError, setResetMfaError] = useState<ApiError | null>(null);

  // Reactivate / reset-MFA inline errors (guard messages verbatim).
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await getJson<StaffListResponse>("/api/admin/staff");
    if (result.ok) {
      setRows(result.data.rows);
      setLoadError(null);
    } else {
      setLoadError(toApiError(result.error));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function replaceRow(updated: StaffAccountRow) {
    setRows((current) =>
      current ? current.map((row) => (row.id === updated.id ? updated : row)) : current,
    );
  }

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    setInviteBusy(true);
    setInviteError(null);
    // contracts §A InviteStaffRequest — exact field names, nothing extra.
    const result = await postWithCsrf<StaffAccountRow>("/api/admin/staff", {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      email: draft.email.trim(),
      role: draft.role,
    });
    setInviteBusy(false);
    if (!result.ok) {
      setInviteError(toApiError(result.error));
      return;
    }
    setAddOpen(false);
    setDraft(EMPTY_DRAFT);
    setInviteSuccess(
      `Invitation sent to ${result.data.email}. The set-password link is viewable on the Outbound Messages page.`,
    );
    await reload();
  }

  async function confirmDeactivate() {
    if (!deactivateTarget) return;
    setDeactivateBusy(true);
    setDeactivateError(null);
    const result = await postWithCsrf<StaffAccountRow>(
      `/api/admin/staff/${deactivateTarget.id}/deactivate`,
    );
    setDeactivateBusy(false);
    if (!result.ok) {
      // Guard messaging (INV-002 / INV-005 / 409) verbatim from the API body.
      setDeactivateError(toApiError(result.error));
      return;
    }
    setDeactivateTarget(null);
    replaceRow(result.data);
  }

  async function rowAction(row: StaffAccountRow, action: "reactivate") {
    setBusyRowId(row.id);
    setActionError(null);
    const result = await postWithCsrf<StaffAccountRow>(`/api/admin/staff/${row.id}/${action}`);
    setBusyRowId(null);
    if (!result.ok) {
      setActionError(toApiError(result.error));
      return;
    }
    replaceRow(result.data);
  }

  async function confirmResetMfa() {
    if (!resetMfaTarget) return;
    setResetMfaBusy(true);
    setResetMfaError(null);
    const result = await postWithCsrf<StaffAccountRow>(
      `/api/admin/staff/${resetMfaTarget.id}/reset-mfa`,
    );
    setResetMfaBusy(false);
    if (!result.ok) {
      // Guard messaging (INV-003 self / no-active-MFA 409) verbatim from the API body.
      setResetMfaError(toApiError(result.error));
      return;
    }
    setResetMfaTarget(null);
    replaceRow(result.data);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Caseworker Management</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Staff accounts, invitations, and MFA. Accounts are deactivated, never deleted; every
            action is audited.
          </p>
        </div>
        <button
          type="button"
          data-testid="staff-add-btn"
          className={btnPrimary}
          onClick={() => {
            setInviteSuccess(null);
            setInviteError(null);
            setDraft(EMPTY_DRAFT);
            setAddOpen(true);
          }}
        >
          Add account
        </button>
      </div>

      {inviteSuccess ? (
        <div
          data-testid="staff-invite-success"
          role="status"
          className="mb-4 rounded-md border border-success/30 bg-success-soft px-3.5 py-2.5 text-sm text-success"
        >
          {inviteSuccess}
        </div>
      ) : null}
      {actionError ? (
        <ApiErrorBanner
          message={actionError.message}
          details={actionError.details}
          testId="staff-action-error"
        />
      ) : null}
      {loadError ? (
        <ApiErrorBanner message={loadError.message} details={loadError.details} testId="staff-load-error" />
      ) : null}

      <Card className="!p-0 overflow-hidden">
        {rows === null && !loadError ? (
          <div className="p-6">
            <SkeletonBlock className="h-40 w-full" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-paper text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">MFA status</th>
                  <th className="px-4 py-3 text-right">Active assignments</th>
                  <th className="px-4 py-3 text-right">Completed this month</th>
                  <th className="px-4 py-3">Last sign-in</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`staff-row-${row.id}`}
                    className="border-b border-line last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-ink">
                        {row.firstName} {row.lastName}
                      </div>
                      <div className="text-xs text-muted">{row.email}</div>
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{ROLE_LABELS[row.role]}</td>
                    <td className="px-4 py-3">
                      <Badge tone={row.status === "active" ? "success" : "gray"}>
                        {row.status === "active" ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={MFA_TONES[row.mfaStatus]}>{MFA_LABELS[row.mfaStatus]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink">{row.activeAssignments}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink">{row.completedThisMonth}</td>
                    <td className="px-4 py-3 text-ink-soft">
                      {row.lastSignInAt ? formatDate(row.lastSignInAt) : "Never"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        {row.status === "active" ? (
                          <button
                            type="button"
                            data-testid={`staff-deactivate-${row.id}`}
                            className={btnDanger}
                            // INV-002 mirrored client-side; the server guard is authoritative.
                            disabled={busyRowId === row.id || row.id === currentUserId}
                            title={
                              row.id === currentUserId
                                ? "You cannot deactivate your own account."
                                : undefined
                            }
                            onClick={() => {
                              setDeactivateError(null);
                              setDeactivateTarget(row);
                            }}
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-testid={`staff-reactivate-${row.id}`}
                            className={btnOutline}
                            disabled={busyRowId === row.id}
                            onClick={() => void rowAction(row, "reactivate")}
                          >
                            Reactivate
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid={`staff-reset-mfa-${row.id}`}
                          className={btnOutline}
                          // INV-003 mirrored client-side; own MFA changes use re-enrollment.
                          disabled={busyRowId === row.id || row.id === currentUserId}
                          title={
                            row.id === currentUserId
                              ? "You cannot reset your own MFA. Use the re-enrollment flow instead."
                              : undefined
                          }
                          onClick={() => {
                            setResetMfaError(null);
                            setResetMfaTarget(row);
                          }}
                        >
                          Reset MFA
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows !== null && rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted">
                      No staff accounts yet. Use “Add account” to invite one.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {addOpen ? (
        <AddStaffAccountDialog
          draft={draft}
          onDraftChange={setDraft}
          error={inviteError}
          busy={inviteBusy}
          onSubmit={submitInvite}
          onClose={() => setAddOpen(false)}
        />
      ) : null}

      {deactivateTarget ? (
        <ConfirmDialog
          title={`Deactivate ${deactivateTarget.firstName} ${deactivateTarget.lastName}?`}
          body={
            <>
              <p>
                Deactivating blocks sign-in and revokes all of their sessions. Their{" "}
                {deactivateTarget.activeAssignments} active assignment
                {deactivateTarget.activeAssignments === 1 ? "" : "s"} will be closed and those
                applications will <strong>return to the Unassigned queue</strong>; all supervisors
                are notified. The account is kept (never deleted) and can be reactivated later.
              </p>
            </>
          }
          confirmLabel="Deactivate"
          confirmTestId={`staff-deactivate-confirm-${deactivateTarget.id}`}
          destructive
          busy={deactivateBusy}
          error={deactivateError}
          onConfirm={() => void confirmDeactivate()}
          onCancel={() => setDeactivateTarget(null)}
        />
      ) : null}

      {resetMfaTarget ? (
        <ConfirmDialog
          title={`Reset MFA for ${resetMfaTarget.firstName} ${resetMfaTarget.lastName}?`}
          body={
            <p>
              Their current authenticator enrollment is removed and all of their sessions are
              revoked. They will re-enroll multi-factor authentication at their next sign-in.
            </p>
          }
          confirmLabel="Reset MFA"
          confirmTestId={`staff-reset-mfa-confirm-${resetMfaTarget.id}`}
          destructive
          busy={resetMfaBusy}
          error={resetMfaError}
          onConfirm={() => void confirmResetMfa()}
          onCancel={() => setResetMfaTarget(null)}
        />
      ) : null}
    </div>
  );
}

// Add-account invitation modal. Extracted from the parent's JSX so `useModalFocus`
// can be called unconditionally (open == mounted): focus move-in, a real Tab trap,
// Escape-to-close and focus restored to the invoker (NFR-025 / LENS-014 / LENS-022).
function AddStaffAccountDialog({
  draft,
  onDraftChange,
  error,
  busy,
  onSubmit,
  onClose,
}: {
  draft: InviteDraft;
  onDraftChange: (draft: InviteDraft) => void;
  error: ApiError | null;
  busy: boolean;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add staff account"
        className="w-full max-w-md rounded-lg border border-line bg-card p-6 shadow-xl"
      >
        <h2 className="font-display text-lg font-bold text-ink">Add staff account</h2>
        <p className="mt-1 text-sm text-ink-soft">
          An invitation email with a single-use set-password link is sent (simulated — view it
          on Outbound Messages). The new user enrolls MFA at first sign-in.
        </p>
        {error ? (
          <div className="mt-4">
            <ApiErrorBanner
              message={error.message}
              details={error.details}
              testId="staff-invite-error"
            />
          </div>
        ) : null}
        <form onSubmit={onSubmit} noValidate className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium text-ink">
              First name
              <input
                data-testid="staff-invite-firstName"
                type="text"
                required
                value={draft.firstName}
                onChange={(e) => onDraftChange({ ...draft, firstName: e.target.value })}
                className="mt-1.5 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
              />
            </label>
            <label className="block text-sm font-medium text-ink">
              Last name
              <input
                data-testid="staff-invite-lastName"
                type="text"
                required
                value={draft.lastName}
                onChange={(e) => onDraftChange({ ...draft, lastName: e.target.value })}
                className="mt-1.5 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
              />
            </label>
          </div>
          <label className="block text-sm font-medium text-ink">
            Email
            <input
              data-testid="staff-invite-email"
              type="email"
              required
              value={draft.email}
              onChange={(e) => onDraftChange({ ...draft, email: e.target.value })}
              className="mt-1.5 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Role
            <select
              data-testid="staff-invite-role"
              value={draft.role}
              onChange={(e) =>
                onDraftChange({ ...draft, role: e.target.value as InviteDraft["role"] })
              }
              className="mt-1.5 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
            >
              {/* contracts.json enums.StaffRole — values verbatim */}
              <option value="CASEWORKER">Caseworker</option>
              <option value="SUPERVISOR">Supervisor</option>
            </select>
          </label>
          <div className="flex justify-end gap-2.5 pt-1">
            <button type="button" className={btnOutline} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              data-testid="staff-invite-submit"
              className={btnPrimary}
              disabled={busy}
            >
              {busy ? "Sending…" : "Send invitation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
