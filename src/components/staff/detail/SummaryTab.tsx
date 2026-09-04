"use client";

// Summary tab (task-029 — §4.4.3): qualification card (shared task-026
// QualificationCard fed by GET /api/applications/:id/qualification), state /
// priority / SLA / assignment / version facts, and the fraud-flag list with
// resolve / dismiss actions (frame screen-detail; flags come from task-027's
// GET /api/applications/:id/fraud-flags + POST /api/fraud-flags/:id/resolve —
// dismissal of high-severity flags is Supervisor-only SERVER-side and its 403
// is surfaced verbatim).

import { useCallback, useEffect, useState } from "react";
import { formatDate } from "@/components/borrower/format";
import type { ApplicationWire } from "@/components/borrower/types";
import { ApiErrorBanner, Badge, btnOutline, btnPrimary } from "@/components/borrower/ui";
import { QualificationCard } from "@/components/staff/underwriting/QualificationCard";
import type { QualificationSummary } from "@/components/staff/underwriting/types";
import { getJson, postWithCsrf, type ErrorResponseBody } from "./api";
import { DetailSection, FieldGrid, FieldRow } from "./ui";
import type { FraudFlagInfo, FraudFlagList, FraudFlagSeverity } from "./types";

const SEVERITY_TONES: Record<FraudFlagSeverity, "danger" | "warn" | "gray"> = {
  high: "danger",
  medium: "warn",
  low: "gray",
};

export function SummaryTab({
  app,
  onFlagsChanged,
}: {
  app: ApplicationWire;
  /** Fired after a flag resolve/dismiss so the parent can refresh if needed. */
  onFlagsChanged: () => void;
}) {
  // --- qualification card (GET /api/applications/:id/qualification) ---------
  const [qualification, setQualification] = useState<QualificationSummary | null>(null);
  const [qualificationLoading, setQualificationLoading] = useState(true);
  const [qualificationError, setQualificationError] = useState<{ message: string; details?: string[] } | null>(null);

  const loadQualification = useCallback(async () => {
    setQualificationLoading(true);
    setQualificationError(null);
    const result = await getJson<QualificationSummary>(`/api/applications/${app.id}/qualification`);
    setQualificationLoading(false);
    if (result.ok) setQualification(result.data);
    else setQualificationError({ message: result.error.message, details: result.error.details });
  }, [app.id]);

  useEffect(() => {
    void loadQualification();
  }, [loadQualification]);

  return (
    <div className="space-y-5">
      <QualificationCard
        summary={qualification}
        loading={qualificationLoading}
        error={qualificationError}
        onRetry={() => void loadQualification()}
      />

      <DetailSection title="Application facts" testId="summary-facts">
        <FieldGrid>
          <FieldRow label="State" value={app.workflowStateLabel} />
          <FieldRow label="Priority" value={<span className="capitalize">{app.priority}</span>} />
          <FieldRow label="SLA status" value={app.slaStatus ? <span className="capitalize">{app.slaStatus.replace("-", " ")}</span> : "—"} />
          <FieldRow
            label="Overall 30-day SLA"
            value={
              app.overallSlaDaysRemaining !== undefined
                ? `${app.overallSlaDaysRemaining} day${app.overallSlaDaysRemaining === 1 ? "" : "s"} remaining`
                : "—"
            }
          />
          <FieldRow label="Assigned caseworker" value={app.assignedCaseworkerName ?? "Unassigned"} />
          <FieldRow label="Current version" value={`Version ${app.currentVersionNumber}`} />
          <FieldRow label="Submitted" value={formatDate(app.submittedAt)} />
          <FieldRow label="State entered" value={formatDate(app.stateEnteredAt)} />
          <FieldRow label="Revision cycles" value={String(app.revisionCycles)} />
          <FieldRow label="DTI" value={app.dti !== undefined ? `${app.dti.toFixed(1)}%` : "—"} />
          <FieldRow label="LTV" value={app.ltv !== undefined ? `${app.ltv.toFixed(1)}%` : "—"} />
          <FieldRow label="CLTV" value={app.cltv !== undefined ? `${app.cltv.toFixed(1)}%` : "—"} />
        </FieldGrid>
      </DetailSection>

      <FraudFlagsCard applicationId={app.id} onChanged={onFlagsChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fraud flags list + resolve/dismiss (frame Summary card)
// ---------------------------------------------------------------------------

function FraudFlagsCard({ applicationId, onChanged }: { applicationId: string; onChanged: () => void }) {
  const [flags, setFlags] = useState<FraudFlagInfo[] | null>(null);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  const [action, setAction] = useState<{ id: string; status: "resolved" | "dismissed" } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ErrorResponseBody | null>(null);

  const load = useCallback(async () => {
    const result = await getJson<FraudFlagList>(`/api/applications/${applicationId}/fraud-flags`);
    if (result.ok) {
      setFlags(result.data.rows);
      setLoadError(null);
    } else {
      setFlags([]);
      setLoadError(result.error);
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitAction() {
    if (!action || !noteText.trim()) return;
    setBusy(true);
    setActionError(null);
    const result = await postWithCsrf<FraudFlagInfo>(`/api/fraud-flags/${action.id}/resolve`, {
      status: action.status,
      resolutionNote: noteText.trim(),
    });
    setBusy(false);
    if (result.ok) {
      setAction(null);
      setNoteText("");
      await load();
      onChanged();
    } else {
      setActionError(result.error);
    }
  }

  const openCount = (flags ?? []).filter((flag) => flag.status === "open").length;

  return (
    <DetailSection
      title="Fraud flags"
      testId="fraud-flags-card"
      aside={
        flags !== null ? (
          <Badge tone={openCount > 0 ? "danger" : "success"} testId="fraud-flags-open-count">
            {openCount} open
          </Badge>
        ) : undefined
      }
    >
      {loadError ? <ApiErrorBanner message={loadError.message} details={loadError.details} testId="fraud-flags-load-error" /> : null}
      {flags === null ? (
        <p className="text-sm text-muted">Loading fraud flags…</p>
      ) : flags.length === 0 ? (
        <p className="text-sm text-muted">No fraud flags on this application.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {flags.map((flag) => (
            <li key={flag.id} data-testid={`fraud-flag-${flag.id}`} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONES[flag.severity]}>
                  <span className="capitalize">{flag.severity}</span>
                </Badge>
                <span className="text-sm font-semibold text-ink">{flag.details}</span>
                <Badge tone={flag.status === "open" ? "warn" : "success"}>
                  <span className="capitalize">{flag.status}</span>
                </Badge>
              </div>
              {flag.status !== "open" ? (
                <p className="mt-1 text-xs text-ink-soft">
                  {flag.resolvedByName ? `By ${flag.resolvedByName}` : ""}
                  {flag.resolvedAt ? ` · ${formatDate(flag.resolvedAt)}` : ""}
                  {flag.resolutionNote ? ` · ${flag.resolutionNote}` : ""}
                </p>
              ) : action?.id === flag.id ? (
                <div className="mt-2 rounded-md border border-line bg-paper p-3">
                  <label htmlFor="fraud-note-input" className="mb-1 block text-xs font-semibold text-ink">
                    Resolution note (required) — {action.status === "resolved" ? "Resolve" : "Dismiss"}
                  </label>
                  <textarea
                    id="fraud-note-input"
                    data-testid="fraud-note-input"
                    rows={2}
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    className="w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
                  />
                  {actionError ? (
                    <div className="mt-2">
                      <ApiErrorBanner message={actionError.message} details={actionError.details} testId="fraud-action-error" />
                    </div>
                  ) : null}
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setAction(null);
                        setActionError(null);
                      }}
                      disabled={busy}
                      className={btnOutline}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      data-testid="fraud-confirm-btn"
                      onClick={submitAction}
                      disabled={busy || !noteText.trim()}
                      className={btnPrimary}
                    >
                      {busy ? "Working…" : "Confirm"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    data-testid={`fraud-resolve-${flag.id}`}
                    onClick={() => {
                      setAction({ id: flag.id, status: "resolved" });
                      setNoteText("");
                      setActionError(null);
                    }}
                    className={btnOutline}
                  >
                    Resolve
                  </button>
                  <button
                    type="button"
                    data-testid={`fraud-dismiss-${flag.id}`}
                    onClick={() => {
                      setAction({ id: flag.id, status: "dismissed" });
                      setNoteText("");
                      setActionError(null);
                    }}
                    className={btnOutline}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        Open high-severity flags block Preliminary Decision until resolved, or dismissed by a
        Supervisor.
      </p>
    </DetailSection>
  );
}
