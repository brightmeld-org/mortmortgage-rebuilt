"use client";

// Assignment / suspension dialogs for the SupervisorApplications list
// (task-031 — §4.6.2/§4.6.3, REQ-056/REQ-057, FLOW-009).
//
// Endpoints (contracts §B, paths verbatim — built increments 4–5):
//   manual    POST /api/applications/:id/assignment    { caseworkerUserId, reason? }
//   bulk      POST /api/supervisor/assignments/bulk    { applicationIds, caseworkerUserId, reason? }
//   auto      POST /api/supervisor/assignments/auto    { applicationIds? }
//   reassign  POST /api/applications/:id/reassignment  { caseworkerUserId, reason }  (reason REQUIRED)
//   suspend   POST /api/applications/:id/transition    { toState: "suspended", versionStamp, reason }
//
// Bulk and auto return BulkAssignResponse — the dialogs render one
// assign-result-{applicationId} row per application with success or the
// server's conflict message VERBATIM (NFR-025, AC "reports per-application
// success or conflict"). Assignment targets are ACTIVE caseworkers only
// (INV-019 — mirrored client-side; server stays authoritative).
//
// Selector contract (§C SupervisorApplications): assign-caseworker-select,
// assign-reason, assign-result-{id}, suspend-reason (+ dialog-namespace
// confirm/cancel extensions).

import { useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import { ApiErrorBanner, btnDanger, btnOutline, btnPrimary } from "@/components/borrower/ui";
import type {
  AssignmentInfo,
  AssignmentResult,
  BulkAssignResponse,
  StaffAccountRow,
  SupervisorQueueRow,
} from "./list-types";

const inputClass =
  "mt-1.5 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25";

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

function ModalShell({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // NFR-025 / LENS-014: focus move-in, focus trap, Escape-to-close.
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
        aria-label={label}
        data-testid="assignment-dialog"
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-line bg-card p-6 shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

function CaseworkerSelect({
  caseworkers,
  value,
  onChange,
}: {
  caseworkers: StaffAccountRow[];
  value: string;
  onChange: (id: string) => void;
}) {
  // INV-019 mirror: assignment targets are active CASEWORKER users only.
  const targets = caseworkers.filter((c) => c.role === "CASEWORKER" && c.status === "active");
  return (
    <label className="block text-sm font-medium text-ink">
      Caseworker
      <select
        data-testid="assign-caseworker-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      >
        <option value="">Select a caseworker…</option>
        {targets.map((c) => (
          <option key={c.id} value={c.id}>
            {c.firstName} {c.lastName}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Per-application success/conflict rows (bulk + auto — AC-31 verification target). */
function ResultsList({
  results,
  numberById,
}: {
  results: AssignmentResult[];
  numberById: Map<string, string>;
}) {
  const succeeded = results.filter((r) => r.success).length;
  return (
    <div className="mt-4" data-testid="assign-results">
      <p className="text-sm font-semibold text-ink">
        {succeeded} of {results.length} assigned
      </p>
      <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
        {results.map((result) => (
          <li
            key={result.applicationId}
            data-testid={`assign-result-${result.applicationId}`}
            className={`rounded-md border px-3 py-2 text-sm ${
              result.success
                ? "border-success/40 bg-success-soft text-success"
                : "border-danger/40 bg-danger-soft text-danger"
            }`}
          >
            <span className="font-semibold">
              {numberById.get(result.applicationId) ?? result.applicationId}
            </span>
            {" — "}
            {result.success ? "assigned" : result.error ?? "conflict"}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual assign / reassign (single application)
// ---------------------------------------------------------------------------

export function AssignDialog({
  app,
  mode,
  caseworkers,
  onClose,
  onDone,
}: {
  app: SupervisorQueueRow;
  /** manual = unassigned application; reassign = move with REQUIRED reason. */
  mode: "manual" | "reassign";
  caseworkers: StaffAccountRow[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [caseworkerUserId, setCaseworkerUserId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);

  const reassign = mode === "reassign";
  const canSubmit = caseworkerUserId !== "" && (!reassign || reason.trim().length > 0) && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    const path = reassign
      ? `/api/applications/${app.applicationId}/reassignment`
      : `/api/applications/${app.applicationId}/assignment`;
    const body: Record<string, unknown> = { caseworkerUserId };
    if (reassign) body.reason = reason.trim();
    else if (reason.trim()) body.reason = reason.trim();
    const result = await postWithCsrf<AssignmentInfo>(path, body);
    setBusy(false);
    if (result.ok) {
      onDone(
        `${app.applicationNumber} ${reassign ? "reassigned" : "assigned"} to ${result.data.caseworkerName}.`,
      );
    } else {
      // Conflict/validation bodies VERBATIM (e.g. "Already assigned to [name]").
      setError(result.error);
    }
  }

  return (
    <ModalShell label={reassign ? "Reassign application" : "Assign application"} onClose={onClose}>
      <h2 className="font-display text-lg font-bold text-ink">
        {reassign ? "Reassign" : "Assign"} {app.applicationNumber}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        {reassign
          ? `Currently assigned to ${app.assignedCaseworkerName ?? "—"}. The previous assignment is closed and both caseworkers are notified. A reason is required.`
          : "Choose an active caseworker. The assignment is atomic and audited."}
      </p>
      {error ? (
        <div className="mt-3">
          <ApiErrorBanner message={error.message} details={error.details} testId="assign-error-banner" />
        </div>
      ) : null}
      <div className="mt-4 space-y-4">
        <CaseworkerSelect caseworkers={caseworkers} value={caseworkerUserId} onChange={setCaseworkerUserId} />
        <label className="block text-sm font-medium text-ink">
          Reason {reassign ? "(required)" : "(optional)"}
          <textarea
            data-testid="assign-reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" data-testid="assign-cancel-btn" onClick={onClose} className={btnOutline} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="assign-confirm-btn"
          onClick={submit}
          disabled={!canSubmit}
          className={btnPrimary}
        >
          {busy ? "Working…" : reassign ? "Reassign" : "Assign"}
        </button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Bulk assign (selected rows → one caseworker, one confirmation)
// ---------------------------------------------------------------------------

export function BulkAssignDialog({
  applicationIds,
  numberById,
  caseworkers,
  onClose,
}: {
  applicationIds: string[];
  numberById: Map<string, string>;
  caseworkers: StaffAccountRow[];
  /** didAssign: whether any operation ran (parent reloads the list). */
  onClose: (didAssign: boolean) => void;
}) {
  const [caseworkerUserId, setCaseworkerUserId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  const [results, setResults] = useState<AssignmentResult[] | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { applicationIds, caseworkerUserId };
    if (reason.trim()) body.reason = reason.trim();
    const result = await postWithCsrf<BulkAssignResponse>("/api/supervisor/assignments/bulk", body);
    setBusy(false);
    if (result.ok) setResults(result.data.results);
    else setError(result.error);
  }

  return (
    <ModalShell label="Bulk assign" onClose={() => onClose(results !== null)}>
      <h2 className="font-display text-lg font-bold text-ink">
        Bulk assign {applicationIds.length} application{applicationIds.length === 1 ? "" : "s"}
      </h2>
      {results === null ? (
        <>
          <p className="mt-1 text-sm text-ink-soft">
            One confirmation assigns every selected application to the chosen caseworker. Results
            are reported per application — a conflict on one never blocks the rest.
          </p>
          {error ? (
            <div className="mt-3">
              <ApiErrorBanner message={error.message} details={error.details} testId="bulk-assign-error-banner" />
            </div>
          ) : null}
          <div className="mt-4 space-y-4">
            <CaseworkerSelect caseworkers={caseworkers} value={caseworkerUserId} onChange={setCaseworkerUserId} />
            <label className="block text-sm font-medium text-ink">
              Reason (optional)
              <textarea
                data-testid="assign-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" data-testid="bulk-cancel-btn" onClick={() => onClose(false)} className={btnOutline} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              data-testid="bulk-confirm-btn"
              onClick={submit}
              disabled={caseworkerUserId === "" || busy}
              className={btnPrimary}
            >
              {busy ? "Assigning…" : "Assign all"}
            </button>
          </div>
        </>
      ) : (
        <>
          <ResultsList results={results} numberById={numberById} />
          <div className="mt-5 flex justify-end">
            <button type="button" data-testid="bulk-close-btn" onClick={() => onClose(true)} className={btnPrimary}>
              Close
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Auto-assign (workload balancing — selected ids, or ALL unassigned)
// ---------------------------------------------------------------------------

export function AutoAssignDialog({
  applicationIds,
  numberById,
  onClose,
}: {
  /** Selected ids, or null → every unassigned application in a claimable state. */
  applicationIds: string[] | null;
  numberById: Map<string, string>;
  onClose: (didAssign: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  const [results, setResults] = useState<AssignmentResult[] | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> =
      applicationIds !== null ? { applicationIds } : {};
    const result = await postWithCsrf<BulkAssignResponse>("/api/supervisor/assignments/auto", body);
    setBusy(false);
    if (result.ok) setResults(result.data.results);
    else setError(result.error);
  }

  return (
    <ModalShell label="Auto-assign" onClose={() => onClose(results !== null)}>
      <h2 className="font-display text-lg font-bold text-ink">Auto-assign — workload balanced</h2>
      {results === null ? (
        <>
          <p className="mt-1 text-sm text-ink-soft">
            {applicationIds !== null
              ? `Assigns the ${applicationIds.length} selected application${applicationIds.length === 1 ? "" : "s"}`
              : "Assigns every unassigned application in a claimable state"}{" "}
            to the active caseworker with the fewest active assignments at the moment of each
            assignment (ties broken by least-recently-assigned). Results are reported per
            application.
          </p>
          {error ? (
            <div className="mt-3">
              <ApiErrorBanner message={error.message} details={error.details} testId="auto-assign-error-banner" />
            </div>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" data-testid="auto-cancel-btn" onClick={() => onClose(false)} className={btnOutline} disabled={busy}>
              Cancel
            </button>
            <button type="button" data-testid="auto-confirm-btn" onClick={submit} disabled={busy} className={btnPrimary}>
              {busy ? "Assigning…" : "Auto-assign"}
            </button>
          </div>
        </>
      ) : (
        <>
          <ResultsList results={results} numberById={numberById} />
          <div className="mt-5 flex justify-end">
            <button type="button" data-testid="auto-close-btn" onClick={() => onClose(true)} className={btnPrimary}>
              Close
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Suspend with reason (§4.6.3 — through the transition engine, XBR-023)
// ---------------------------------------------------------------------------

interface ApplicationSlice {
  versionStamp: number;
}

export function SuspendDialog({
  app,
  onClose,
  onDone,
}: {
  app: SupervisorQueueRow;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    // §A optimistic concurrency: stamp from the MOST RECENT GET.
    const current = await getJson<ApplicationSlice>(`/api/applications/${app.applicationId}`);
    if (!current.ok) {
      setBusy(false);
      setError(current.error);
      return;
    }
    const result = await postWithCsrf<ApplicationSlice>(
      `/api/applications/${app.applicationId}/transition`,
      { toState: "suspended", versionStamp: current.data.versionStamp, reason: reason.trim() },
    );
    setBusy(false);
    if (result.ok) onDone(`${app.applicationNumber} suspended. The SLA clock is paused.`);
    else setError(result.error);
  }

  return (
    <ModalShell label="Suspend application" onClose={onClose}>
      <h2 className="font-display text-lg font-bold text-ink">Suspend {app.applicationNumber}</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Suspension pauses the SLA clock and notifies the assigned caseworker. Resume returns the
        application exactly to its current state. A reason is required and audited.
      </p>
      {error ? (
        <div className="mt-3">
          <ApiErrorBanner message={error.message} details={error.details} testId="suspend-error-banner" />
        </div>
      ) : null}
      <label className="mt-4 block text-sm font-medium text-ink">
        Reason (required)
        <textarea
          data-testid="suspend-reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={inputClass}
        />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" data-testid="suspend-cancel-btn" onClick={onClose} className={btnOutline} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="suspend-confirm-btn"
          onClick={submit}
          disabled={busy || reason.trim().length === 0}
          className={btnDanger}
        >
          {busy ? "Working…" : "Suspend"}
        </button>
      </div>
    </ModalShell>
  );
}
