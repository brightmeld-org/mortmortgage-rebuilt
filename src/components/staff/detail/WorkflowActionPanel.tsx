"use client";

// Workflow action panel (task-029 — §4.4.3/§4.4.8, REQ-049/REQ-054).
//
// The panel renders EXACTLY Application.availableTransitions (the serializer's
// per-role list) — the client NEVER re-derives the state machine. Each entry
// carries an optional note and a CONFIRMATION step; failures surface the API
// error body VERBATIM (workflow-error-banner). Per the §B transition-endpoint
// semantics, decision transitions (T19–T26b, T31, T40) execute exclusively
// through the approval gate, so those toStates render as informational entries
// pointing at the Approval panel (task-032 mount) instead of posting a
// transition that the server would 409. Resume from Suspended must return
// exactly to previousStateForSuspend (INV-032) — other listed resume targets
// render disabled with that explanation.
//
// Cross-field requirements mirrored from TransitionRequest (server stays
// authoritative): revision → note required; suspend → reason required; T15 →
// recommendation + formal-note draft required.
//
// "Clear conditions" (§4.4.8): in Conditional Approval the panel lists the
// approval conditions (GET /api/applications/:id/approvals) with per-condition
// Clear actions (POST /api/conditions/:id/clear) ahead of the T30 completion
// transition.
//
// Selector contract (§C): workflow-action-{toState}, workflow-confirm-btn,
// workflow-note-input, workflow-error-banner, condition-clear-{id} (+
// workflow-reason-input / workflow-recommendation-select / workflow-cancel-btn
// namespace extensions).

import { useCallback, useEffect, useState } from "react";
import { humanizeEnum } from "@/components/borrower/format";
import type { ApplicationWire, WorkflowState } from "@/components/borrower/types";
import { ApiErrorBanner, btnDanger, btnOutline, btnPrimary } from "@/components/borrower/ui";
import { WORKFLOW_TRANSITIONS, workflowStateLabel } from "@/lib/pure/workflow";
import { getJson, postWithCsrf, type ErrorResponseBody, type WorkflowErrorBody } from "./api";
import {
  DECISION_GATE_TRANSITION_IDS,
  RECOMMENDATION_VALUES,
  type ApprovalList,
  type ConditionInfo,
  type RecommendationValue,
} from "./types";

// ---------------------------------------------------------------------------
// Action labels (§4.4.8 caseworker action names + frame phrasing)
// ---------------------------------------------------------------------------

const ACTION_LABELS: Partial<Record<WorkflowState, string>> = {
  completeness_validated: "Validate completeness",
  documents_received: "Confirm documents received",
  aus_executed: "Run AUS",
  preliminary_decision: "Record preliminary decision",
  revision_requested: "Request revision from borrower",
  suspended: "Suspend application",
  approved: "Complete conditional approval",
};

function actionLabel(toState: WorkflowState, currentState: WorkflowState): string {
  if (currentState === "suspended" && toState !== "denied") {
    return `Resume to ${workflowStateLabel(toState)}`;
  }
  return ACTION_LABELS[toState] ?? `Move to ${workflowStateLabel(toState)}`;
}

/** Transition id for a (from, to) pair from the shared §A table. */
function transitionIdFor(from: WorkflowState, to: WorkflowState): string | undefined {
  return WORKFLOW_TRANSITIONS.find((t) => t.from === from && t.to === to)?.id;
}

interface PanelProps {
  app: ApplicationWire;
  role: "CASEWORKER" | "SUPERVISOR";
  /** Called with the updated Application after a successful transition. */
  onApplicationChange: (app: ApplicationWire) => void;
  /** Refresh callback when the server may have advanced past our snapshot. */
  onRefresh: () => void;
}

export function WorkflowActionPanel({ app, role, onApplicationChange, onRefresh }: PanelProps) {
  const [pendingToState, setPendingToState] = useState<WorkflowState | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [recommendation, setRecommendation] = useState<RecommendationValue | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorkflowErrorBody | null>(null);

  const transitions = (app.availableTransitions ?? []) as WorkflowState[];

  function beginAction(toState: WorkflowState) {
    setPendingToState(toState);
    setNote("");
    setReason("");
    setRecommendation("");
    setError(null);
  }

  function cancelAction() {
    setPendingToState(null);
    setError(null);
  }

  async function confirmAction() {
    if (!pendingToState) return;
    setBusy(true);
    setError(null);
    // §A optimistic concurrency: the stamp must come from the MOST RECENT GET
    // (same pattern as the borrower transition helper) — side-effecting reads
    // like condition clears may have advanced it since the page loaded.
    const current = await getJson<ApplicationWire>(`/api/applications/${app.id}`);
    const body: Record<string, unknown> = {
      toState: pendingToState,
      versionStamp: current.ok ? current.data.versionStamp : app.versionStamp,
    };
    if (note.trim()) body.note = note.trim();
    if (reason.trim()) body.reason = reason.trim();
    if (recommendation) body.recommendation = recommendation;
    const result = await postWithCsrf<ApplicationWire>(`/api/applications/${app.id}/transition`, body);
    setBusy(false);
    if (result.ok) {
      setPendingToState(null);
      onApplicationChange(result.data);
    } else {
      // API error body VERBATIM (NFR-025) — message + details; workflow 409s
      // also carry currentState/allowedTransitions which we render as-is.
      setError(result.error);
    }
  }

  const currentState = app.workflowState;
  const isSuspendTarget = pendingToState === "suspended";
  const isRevisionTarget = pendingToState === "revision_requested";
  const isRecommendationTarget =
    pendingToState === "preliminary_decision" && currentState === "aus_executed";
  const noteRequired = isRevisionTarget || isRecommendationTarget;

  return (
    <section
      data-testid="workflow-panel"
      className="rounded-lg border-t-4 border-copper bg-card p-5 shadow-sm ring-1 ring-line"
    >
      <h2 className="text-xs font-bold uppercase tracking-wider text-ink">
        Workflow actions — valid from {app.workflowStateLabel}
      </h2>

      {error ? (
        <div className="mt-3">
          <ApiErrorBanner
            message={error.message}
            details={[
              ...(error.details ?? []),
              ...(error.currentState ? [`Current state: ${error.currentState}`] : []),
              ...(error.allowedTransitions && error.allowedTransitions.length > 0
                ? [`Allowed transitions: ${error.allowedTransitions.join(", ")}`]
                : []),
            ]}
            testId="workflow-error-banner"
          />
        </div>
      ) : null}

      {transitions.length === 0 ? (
        <p data-testid="workflow-no-actions" className="mt-3 text-sm text-muted">
          No workflow actions are available to you in this state.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {transitions.map((toState) => {
            const transitionId = transitionIdFor(currentState, toState);
            const decisionGated = transitionId !== undefined && DECISION_GATE_TRANSITION_IDS.has(transitionId);
            const wrongResume =
              currentState === "suspended" &&
              !decisionGated &&
              app.previousStateForSuspend !== undefined &&
              toState !== app.previousStateForSuspend;
            const destructive = toState === "suspended" || toState === "revision_requested";
            return (
              <li key={toState}>
                <button
                  type="button"
                  data-testid={`workflow-action-${toState}`}
                  disabled={decisionGated || wrongResume || busy}
                  aria-expanded={pendingToState === toState}
                  onClick={() => beginAction(toState)}
                  className={`w-full ${destructive ? btnDanger : pendingToState === toState ? btnPrimary : btnOutline}`}
                >
                  {actionLabel(toState, currentState)}
                </button>
                {decisionGated ? (
                  <p className="mt-1 text-xs text-muted">
                    Recorded through the approval decision gate — see the Approval panel.
                  </p>
                ) : null}
                {wrongResume && app.previousStateForSuspend ? (
                  <p className="mt-1 text-xs text-muted">
                    Resume returns exactly to {workflowStateLabel(app.previousStateForSuspend)} (INV-032).
                  </p>
                ) : null}
                {pendingToState === toState && !decisionGated && !wrongResume ? (
                  <div className="mt-2 rounded-md border border-line bg-paper p-3">
                    {isRecommendationTarget ? (
                      <div className="mb-3">
                        <label
                          htmlFor="workflow-recommendation-select"
                          className="mb-1 block text-xs font-semibold text-ink"
                        >
                          Preliminary recommendation (required)
                        </label>
                        <select
                          id="workflow-recommendation-select"
                          data-testid="workflow-recommendation-select"
                          value={recommendation}
                          onChange={(event) => setRecommendation(event.target.value as RecommendationValue | "")}
                          className="w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
                        >
                          <option value="">Select…</option>
                          {RECOMMENDATION_VALUES.map((value) => (
                            <option key={value} value={value}>
                              {humanizeEnum(value)}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    {isSuspendTarget ? (
                      <div className="mb-3">
                        <label htmlFor="workflow-reason-input" className="mb-1 block text-xs font-semibold text-ink">
                          Reason (required)
                        </label>
                        <textarea
                          id="workflow-reason-input"
                          data-testid="workflow-reason-input"
                          rows={2}
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          className="w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
                        />
                      </div>
                    ) : null}
                    <label htmlFor="workflow-note-input" className="mb-1 block text-xs font-semibold text-ink">
                      {isRevisionTarget
                        ? "Formal note to borrower (required)"
                        : isRecommendationTarget
                          ? "Formal note draft (required)"
                          : "Note (optional)"}
                    </label>
                    <textarea
                      id="workflow-note-input"
                      data-testid="workflow-note-input"
                      rows={2}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      className="w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
                    />
                    <p className="mt-2 text-xs text-ink-soft">
                      Confirm: {actionLabel(toState, currentState)} — {app.workflowStateLabel} →{" "}
                      {workflowStateLabel(toState)}.
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        data-testid="workflow-cancel-btn"
                        onClick={cancelAction}
                        disabled={busy}
                        className={btnOutline}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        data-testid="workflow-confirm-btn"
                        onClick={confirmAction}
                        disabled={busy || (noteRequired && !note.trim()) || (isSuspendTarget && !reason.trim()) || (isRecommendationTarget && !recommendation)}
                        className={btnPrimary}
                      >
                        {busy ? "Working…" : "Confirm"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-xs text-muted">
        Each action takes an optional note and a confirmation. Invalid transitions are rejected
        server-side (409) listing allowed moves.
      </p>

      {currentState === "conditional_approval" ? (
        <ConditionsChecklist applicationId={app.id} role={role} onCleared={onRefresh} />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Conditions checklist ("Clear conditions" — §4.4.8 / WF-036 / T30)
// ---------------------------------------------------------------------------

function ConditionsChecklist({
  applicationId,
  role,
  onCleared,
}: {
  applicationId: string;
  role: "CASEWORKER" | "SUPERVISOR";
  onCleared: () => void;
}) {
  const [conditions, setConditions] = useState<ConditionInfo[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<ErrorResponseBody | null>(null);

  const load = useCallback(async () => {
    const result = await getJson<ApprovalList>(`/api/applications/${applicationId}/approvals`);
    if (result.ok) {
      const rows = result.data.rows.flatMap((record) => record.conditions ?? []);
      // Latest approval records first — dedupe by condition id.
      const seen = new Set<string>();
      setConditions(
        rows.filter((condition) => {
          if (seen.has(condition.id)) return false;
          seen.add(condition.id);
          return true;
        }),
      );
    } else {
      setError(result.error);
      setConditions([]);
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function clearCondition(id: string) {
    setBusyId(id);
    setError(null);
    const result = await postWithCsrf<ConditionInfo>(`/api/conditions/${id}/clear`);
    setBusyId(null);
    setConfirmId(null);
    if (result.ok) {
      await load();
      onCleared();
    } else {
      setError(result.error);
    }
  }

  return (
    <div data-testid="conditions-checklist" className="mt-4 border-t border-line pt-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-ink">Clear conditions</h3>
      <p className="mt-1 text-xs text-muted">
        Every condition must be cleared before completing the conditional approval.
        {role === "CASEWORKER" ? " Conditions you clear are audited." : ""}
      </p>
      {error ? (
        <div className="mt-2">
          <ApiErrorBanner message={error.message} details={error.details} testId="condition-error-banner" />
        </div>
      ) : null}
      {conditions === null ? (
        <p className="mt-2 text-sm text-muted">Loading conditions…</p>
      ) : conditions.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No conditions recorded.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {conditions.map((condition) => (
            <li
              key={condition.id}
              data-testid={`condition-row-${condition.id}`}
              className="rounded-md border border-line/70 p-2.5 text-sm"
            >
              <p className="text-ink">{condition.text}</p>
              {condition.status === "cleared" ? (
                <p className="mt-1 text-xs font-semibold text-success">
                  Cleared{condition.clearedByName ? ` by ${condition.clearedByName}` : ""}
                </p>
              ) : confirmId === condition.id ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-xs text-ink-soft">Clear this condition?</span>
                  <button
                    type="button"
                    data-testid={`condition-clear-${condition.id}`}
                    onClick={() => clearCondition(condition.id)}
                    disabled={busyId === condition.id}
                    className={btnPrimary}
                  >
                    {busyId === condition.id ? "Working…" : "Confirm clear"}
                  </button>
                  <button type="button" onClick={() => setConfirmId(null)} className={btnOutline}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid={`condition-clear-request-${condition.id}`}
                  onClick={() => setConfirmId(condition.id)}
                  className={`mt-1.5 ${btnOutline}`}
                >
                  Clear condition
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
