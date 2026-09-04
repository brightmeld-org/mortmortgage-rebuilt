"use client";

// ApprovalPanel (task-032 — contracts §C; REQ-061, WF-002, FLOW-008).
//
// Navigation path: /staff/applications/:id right rail (SUPERVISOR sessions,
// workflow state preliminary_decision or escalated_review) — rendered by
// StaffApplicationDetailClient inside the task-029 approval-panel-mount seam.
// Supervisors reach the page from /supervisor rows (task-031), the caseworker
// queue, or notification links.
//
// Shows: caseworker recommendation (Application.preliminaryRecommendation via
// the server page prop + the T15 internal draft note via GET notes),
// qualification summary + LIVE escalation evaluation (GET qualification — the
// same evaluateEscalation the gate runs, task-025), prior ApprovalRecordInfo
// rows (GET approvals), open fraud flags (GET fraud-flags).
//
// Actions: Approve with an optional conditions list (routes to Conditional
// Approval — T20/T26a — or per the gate) and Deny with the HMDA DenialReason
// list + other-with-text (VR-087/088 mirrored client-side), each with notes
// (VR-085 ≤ 4000). The request posts EXACT contract field names to
// POST /api/applications/:id/approval-decision with a freshly-read
// versionStamp; failures surface the ErrorResponse VERBATIM incl. workflow-409
// currentState/allowedTransitions (NFR-025).
//
// INV-001 client mirror: in escalated_review the panel probes the supervisor
// list (viewer-relative approvalStatus — computed server-side by the SAME
// evaluateLevel2DecisionEligibility the gate enforces) and disables both
// actions with the ineligibility explanation when the current Supervisor
// recorded Level 1 (or no Level-1 approve exists). The SERVER GATE REMAINS
// AUTHORITATIVE: an unknown/failed probe fails open and the gate's 403/409 is
// rendered verbatim.
//
// Selector contract (§C ApprovalPanel): approval-panel,
// approval-recommendation, approval-escalation, approval-prior-{id},
// approval-approve-btn, approval-deny-btn, approval-conditions-input,
// approval-condition-add, denial-reason-{reason}, denial-other-text,
// approval-notes, approval-ineligible-reason. (condition-clear-{id} lives in
// the task-029 WorkflowActionPanel conditions checklist — conditional_approval
// state, where this panel does not render.) Namespace extensions logged in
// frame-extensions.md: approval-level, approval-qualification,
// approval-open-flags, approval-routing-hint, approval-draft-note,
// approval-submit-btn, approval-cancel-btn, approval-condition-item-{i},
// approval-condition-remove-{i}, approval-eligible-note, approval-error-banner,
// approval-reload.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency, formatDate, humanizeEnum } from "@/components/borrower/format";
import type { ApplicationWire, NotePage } from "@/components/borrower/types";
import { ApiErrorBanner, Badge, SkeletonBlock, btnDanger, btnOutline, btnPrimary } from "@/components/borrower/ui";
import { ausRecommendationLabel, formatPct } from "@/components/staff/underwriting/check-bodies";
import type { QualificationSummary } from "@/components/staff/underwriting/types";
import { getJson, postWithCsrf, type ErrorResponseBody, type WorkflowErrorBody } from "@/components/staff/detail/api";
import type { ApprovalRecordInfo, ApprovalList, FraudFlagInfo, FraudFlagList, FraudFlagSeverity } from "@/components/staff/detail/types";
import {
  DENIAL_REASONS,
  INELIGIBILITY_COPY,
  MAX_DENIAL_REASONS,
  eligibilityFromApprovalStatus,
  type DenialReason,
  type Level2Eligibility,
} from "./types";

const SEVERITY_TONES: Record<FraudFlagSeverity, "danger" | "warn" | "gray"> = {
  high: "danger",
  medium: "warn",
  low: "gray",
};

const inputClass =
  "w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25";

const blockLabelClass = "text-[11px] font-semibold uppercase tracking-wider text-muted";

/** Minimal projection of the supervisor list row the eligibility probe reads. */
interface EligibilityProbeRow {
  applicationId: string;
  approvalStatus?: string;
}

export function ApprovalPanel({
  applicationId,
  app,
  preliminaryRecommendation,
  onApplicationChange,
}: {
  applicationId: string;
  app: ApplicationWire;
  /** Application.preliminaryRecommendation, read server-side (staff surface). */
  preliminaryRecommendation: string | null;
  onApplicationChange: (app: ApplicationWire) => void;
}) {
  const router = useRouter();
  const level = app.workflowState === "preliminary_decision" ? 1 : 2;

  // ------------------------------------------------------------------
  // Panel data (qualification / approvals / flags / draft note / eligibility)
  // ------------------------------------------------------------------
  const [qualification, setQualification] = useState<QualificationSummary | null>(null);
  const [qualificationError, setQualificationError] = useState<ErrorResponseBody | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecordInfo[] | null>(null);
  const [flags, setFlags] = useState<FraudFlagInfo[] | null>(null);
  const [draftNote, setDraftNote] = useState<{ content: string; createdAt: string } | null>(null);
  const [eligibility, setEligibility] = useState<Level2Eligibility>(level === 2 ? "loading" : "eligible");

  // ------------------------------------------------------------------
  // Decision form state
  // ------------------------------------------------------------------
  const [mode, setMode] = useState<"approve" | "deny" | null>(null);
  const [conditions, setConditions] = useState<string[]>([]);
  const [conditionText, setConditionText] = useState("");
  const [reasons, setReasons] = useState<DenialReason[]>([]);
  const [otherText, setOtherText] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorkflowErrorBody | null>(null);

  const loadAll = useCallback(async () => {
    const [qual, approvalList, flagList] = await Promise.all([
      getJson<QualificationSummary>(`/api/applications/${applicationId}/qualification`),
      getJson<ApprovalList>(`/api/applications/${applicationId}/approvals`),
      getJson<FraudFlagList>(`/api/applications/${applicationId}/fraud-flags`),
    ]);
    if (qual.ok) {
      setQualification(qual.data);
      setQualificationError(null);
    } else {
      setQualificationError(qual.error);
    }
    setApprovals(approvalList.ok ? approvalList.data.rows : []);
    setFlags(flagList.ok ? flagList.data.rows : []);

    // T15 formal-note DRAFT: the latest INTERNAL note attached to a transition
    // (only T15 creates internal notes with relatedTransitionId — task-019).
    const first = await getJson<NotePage>(`/api/applications/${applicationId}/notes?page=1&pageSize=100`);
    if (first.ok) {
      let rows = first.data.rows;
      const lastPage = Math.ceil(first.data.total / 100);
      if (lastPage > 1) {
        const last = await getJson<NotePage>(`/api/applications/${applicationId}/notes?page=${lastPage}&pageSize=100`);
        if (last.ok) rows = [...rows, ...last.data.rows];
      }
      // Rows arrive oldest-first — the last matching row is the latest draft.
      const draft = [...rows]
        .reverse()
        .find((note) => note.type === "internal" && note.relatedTransitionId !== undefined);
      setDraftNote(draft ? { content: draft.content, createdAt: draft.createdAt } : null);
    }
  }, [applicationId]);

  // INV-001 client mirror probe (escalated_review only) — see module header.
  const loadEligibility = useCallback(async () => {
    if (app.workflowState !== "escalated_review") {
      setEligibility("eligible");
      return;
    }
    setEligibility("loading");
    const probe = await getJson<{ rows: EligibilityProbeRow[] }>(
      `/api/supervisor/applications?states=escalated_review&search=${encodeURIComponent(app.applicationNumber)}&page=1&pageSize=100`,
    );
    if (!probe.ok) {
      setEligibility("unknown"); // fail open — the server gate decides
      return;
    }
    const row = probe.data.rows.find((r) => r.applicationId === applicationId);
    setEligibility(eligibilityFromApprovalStatus(row?.approvalStatus));
  }, [applicationId, app.workflowState, app.applicationNumber]);

  useEffect(() => {
    void loadAll();
    void loadEligibility();
    // Re-load whenever the file advances (decision recorded, condition math).
  }, [loadAll, loadEligibility, app.workflowState, app.versionStamp]);

  // The recommendation prop is server-rendered; if the file entered a decision
  // state during THIS session (live T15), refresh the server tree once so the
  // prop catches up. Ref-guarded — never loops.
  const refreshedOnce = useRef(false);
  useEffect(() => {
    if (preliminaryRecommendation === null && !refreshedOnce.current) {
      refreshedOnce.current = true;
      router.refresh();
    }
  }, [preliminaryRecommendation, router]);

  // ------------------------------------------------------------------
  // Derived facts
  // ------------------------------------------------------------------
  const openFlags = (flags ?? []).filter((flag) => flag.status === "open");
  const currentVersionL1 = [...(approvals ?? [])]
    .reverse()
    .find((row) => row.level === 1 && row.versionNumber === app.currentVersionNumber);
  const ineligible = level === 2 && (eligibility === "self-l1-approver" || eligibility === "no-l1-approve");
  const actionsDisabled = busy || (level === 2 && (eligibility === "loading" || ineligible));

  // VR-086 / XBR-026: conditions belong to the FINAL approving level. When the
  // live evaluation already shows the file escalating, a Level-1 approve
  // carrying conditions is rejected 409 before any write — so the input is
  // disabled here rather than letting the 409 be the operator's first signal.
  // (qualification === null means "still loading": never predict a route from
  // missing data, and the server remains the authority either way.)
  const escalatesAtThisLevel = level === 1 && qualification?.escalationRequired === true;

  const hasOther = reasons.includes("other");
  const denyInvalid =
    reasons.length < 1 || reasons.length > MAX_DENIAL_REASONS || (hasOther && !otherText.trim());

  function routingHint(): string {
    if (mode === "deny") return `Deny records a Level-${level} deny and routes to Denied.`;
    if (level === 1 && qualification === null) {
      // The live evaluation is still loading — never predict a route from
      // missing data; the gate evaluates escalation at the decision moment.
      return "Routing is decided by the approval gate — escalation is evaluated live at the decision moment.";
    }
    if (level === 1 && qualification?.escalationRequired) {
      return "Escalation criteria are met — an approve records Level 1 and routes to Escalated Review for a Level-2 decision by a different Supervisor.";
    }
    if (conditions.length > 0) {
      return `Approve with ${conditions.length} condition(s) routes to Conditional Approval.`;
    }
    return `Approve without conditions records Level ${level} and routes to Approved.`;
  }

  function beginMode(next: "approve" | "deny") {
    setMode(next);
    setConditions([]);
    setConditionText("");
    setReasons([]);
    setOtherText("");
    setNotes("");
    setError(null);
  }

  function toggleReason(reason: DenialReason) {
    setReasons((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason],
    );
  }

  function addCondition() {
    const text = conditionText.trim();
    if (!text) return;
    setConditions((prev) => [...prev, text]);
    setConditionText("");
  }

  async function submit() {
    if (!mode) return;
    setBusy(true);
    setError(null);
    // §A optimistic concurrency: stamp from the MOST RECENT GET (the same
    // pattern as the task-029 workflow action panel).
    const current = await getJson<ApplicationWire>(`/api/applications/${applicationId}`);
    const body: Record<string, unknown> = {
      decision: mode,
      versionStamp: current.ok ? current.data.versionStamp : app.versionStamp,
    };
    if (notes.trim()) body.notes = notes.trim();
    // VR-086: never send conditions on a file that is escalating at this level
    // (the server rejects it 409 — this keeps the client from constructing the
    // rejected request at all when the evaluation loaded after they were typed).
    if (mode === "approve" && conditions.length > 0 && !escalatesAtThisLevel) {
      body.conditions = conditions;
    }
    if (mode === "deny") {
      body.denialReasons = reasons;
      if (hasOther && otherText.trim()) body.denialReasonOtherText = otherText.trim();
    }
    const result = await postWithCsrf<ApplicationWire>(
      `/api/applications/${applicationId}/approval-decision`,
      body,
    );
    setBusy(false);
    if (result.ok) {
      setMode(null);
      onApplicationChange(result.data);
    } else {
      setError(result.error as WorkflowErrorBody);
    }
  }

  return (
    <section
      data-testid="approval-panel"
      className="rounded-lg border-t-4 border-navy bg-card p-5 shadow-sm ring-1 ring-line"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-ink">Approval decision</h2>
        <span data-testid="approval-level" data-value={String(level)}>
          <Badge tone="info">Level {level}</Badge>
        </span>
      </div>

      {/* ---------------- Caseworker recommendation ---------------- */}
      <div
        data-testid="approval-recommendation"
        data-value={preliminaryRecommendation ?? ""}
        className="mt-3"
      >
        <p className={blockLabelClass}>Caseworker recommendation</p>
        <p className="mt-0.5 font-display text-lg font-bold text-ink">
          {preliminaryRecommendation
            ? humanizeEnum(preliminaryRecommendation)
            : "No preliminary recommendation recorded"}
        </p>
        {draftNote ? (
          <blockquote
            data-testid="approval-draft-note"
            className="mt-1.5 rounded-md border-l-2 border-copper bg-paper/60 px-3 py-2 text-sm text-ink-soft"
          >
            {draftNote.content}
            <footer className="mt-1 text-xs text-muted">
              Draft decision note · {formatDate(draftNote.createdAt)}
            </footer>
          </blockquote>
        ) : null}
      </div>

      {/* ---------------- Qualification summary ---------------- */}
      <div data-testid="approval-qualification" className="mt-4 border-t border-line pt-3">
        <p className={blockLabelClass}>Qualification summary</p>
        {qualificationError ? (
          <div className="mt-2">
            <ApiErrorBanner
              message={qualificationError.message}
              details={qualificationError.details}
              testId="approval-qualification-error"
            />
            <button type="button" data-testid="approval-reload" onClick={() => void loadAll()} className={`mt-2 ${btnOutline}`}>
              Retry
            </button>
          </div>
        ) : qualification === null ? (
          <div className="mt-2">
            <SkeletonBlock className="h-16 w-full" />
          </div>
        ) : (
          <dl className="mt-1.5 space-y-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">Middle score</dt>
              <dd className="font-semibold text-ink">
                {qualification.middleCreditScore ?? "—"}
                {qualification.creditTier ? ` · ${humanizeEnum(qualification.creditTier)}` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">DTI</dt>
              <dd className="font-semibold text-ink">{formatPct(qualification.dti)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">LTV / CLTV</dt>
              <dd className="font-semibold text-ink">
                {formatPct(qualification.ltv)} / {formatPct(qualification.cltv)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">Est. monthly PITI</dt>
              <dd className="font-semibold text-ink">{formatCurrency(qualification.estimatedMonthlyPiti)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">AUS recommendation</dt>
              <dd className="font-semibold text-ink">
                {qualification.ausRecommendation
                  ? ausRecommendationLabel(qualification.ausRecommendation)
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">Overall status</dt>
              <dd className="font-semibold capitalize text-ink">
                {humanizeEnum(qualification.overallStatus)}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {/* ---------------- Escalation evaluation ---------------- */}
      <div data-testid="approval-escalation" className="mt-4 border-t border-line pt-3">
        <p className={blockLabelClass}>Escalation evaluation</p>
        {qualification === null && !qualificationError ? (
          <div className="mt-2">
            <SkeletonBlock className="h-8 w-full" />
          </div>
        ) : (
          <div
            className={`mt-1.5 rounded-md border px-3 py-2 text-sm ${
              qualification?.escalationRequired
                ? "border-warn/40 bg-warn-soft text-warn"
                : "border-line bg-paper/60 text-ink-soft"
            }`}
          >
            <p className="font-semibold">
              Escalation required: {qualification?.escalationRequired ? "Yes" : "No"}
            </p>
            {qualification && qualification.escalationCriteriaMet && qualification.escalationCriteriaMet.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {qualification.escalationCriteriaMet.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1">No escalation criteria met.</p>
            )}
          </div>
        )}
        {level === 2 && currentVersionL1?.criteriaEvaluated ? (
          <div className="mt-2 text-xs text-ink-soft">
            <p className="font-semibold">
              Evaluated at Level 1
              {currentVersionL1.dtiAtDecision !== undefined || currentVersionL1.ltvAtDecision !== undefined
                ? ` (DTI ${currentVersionL1.dtiAtDecision ?? "—"}% · LTV ${currentVersionL1.ltvAtDecision ?? "—"}%)`
                : ""}
              :
            </p>
            <ul className="mt-0.5 list-disc pl-5">
              {currentVersionL1.criteriaEvaluated.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* ---------------- Prior approval records ---------------- */}
      <div className="mt-4 border-t border-line pt-3">
        <p className={blockLabelClass}>Prior approval records</p>
        {approvals === null ? (
          <div className="mt-2">
            <SkeletonBlock className="h-8 w-full" />
          </div>
        ) : approvals.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">No approval records on this application.</p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {approvals.map((record) => (
              <li
                key={record.id}
                data-testid={`approval-prior-${record.id}`}
                className="rounded-md border border-line/70 p-2.5 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={record.decision === "approve" ? "success" : "danger"}>
                    Level {record.level} · {record.decision === "approve" ? "Approve" : "Deny"}
                  </Badge>
                  <span className="text-xs text-ink-soft">
                    by {record.approverName} · {formatDate(record.createdAt)} · v{record.versionNumber}
                  </span>
                </div>
                {record.notes ? <p className="mt-1 text-xs text-ink-soft">{record.notes}</p> : null}
                {record.denialReasons && record.denialReasons.length > 0 ? (
                  <p className="mt-1 text-xs text-danger">
                    Reasons: {record.denialReasons.map((r) => humanizeEnum(r)).join(", ")}
                    {record.denialReasonOtherText ? ` — ${record.denialReasonOtherText}` : ""}
                  </p>
                ) : null}
                {record.conditions && record.conditions.length > 0 ? (
                  <p className="mt-1 text-xs text-ink-soft">
                    Conditions: {record.conditions.filter((c) => c.status === "cleared").length} of{" "}
                    {record.conditions.length} cleared
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------------- Open fraud flags ---------------- */}
      <div data-testid="approval-open-flags" className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className={blockLabelClass}>Open fraud flags</p>
          {flags !== null ? (
            <Badge tone={openFlags.length > 0 ? "danger" : "success"}>{openFlags.length} open</Badge>
          ) : null}
        </div>
        {flags === null ? (
          <div className="mt-2">
            <SkeletonBlock className="h-8 w-full" />
          </div>
        ) : openFlags.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">No open fraud flags.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {openFlags.map((flag) => (
              <li key={flag.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={SEVERITY_TONES[flag.severity]}>
                  <span className="capitalize">{flag.severity}</span>
                </Badge>
                <span className="text-ink">{flag.details}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------------- INV-001 eligibility (Level 2) ---------------- */}
      {level === 2 ? (
        ineligible ? (
          <p
            data-testid="approval-ineligible-reason"
            className="mt-4 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm font-semibold text-warn"
          >
            {INELIGIBILITY_COPY[eligibility as "self-l1-approver" | "no-l1-approve"]}
          </p>
        ) : eligibility === "eligible" ? (
          <p data-testid="approval-eligible-note" className="mt-4 text-xs font-semibold text-success">
            You are eligible to record the Level-2 decision on this application.
          </p>
        ) : null
      ) : null}

      {/* ---------------- Errors (server body VERBATIM — NFR-025) ---------------- */}
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
            testId="approval-error-banner"
          />
        </div>
      ) : null}

      {/* ---------------- Actions ---------------- */}
      <div className="mt-4 flex gap-2 border-t border-line pt-3">
        <button
          type="button"
          data-testid="approval-approve-btn"
          disabled={actionsDisabled}
          aria-expanded={mode === "approve"}
          onClick={() => beginMode("approve")}
          className={`flex-1 ${mode === "approve" ? btnPrimary : btnOutline}`}
        >
          Approve
        </button>
        <button
          type="button"
          data-testid="approval-deny-btn"
          disabled={actionsDisabled}
          aria-expanded={mode === "deny"}
          onClick={() => beginMode("deny")}
          className={`flex-1 ${btnDanger}`}
        >
          Deny
        </button>
      </div>

      {mode !== null && !actionsDisabled ? (
        <div className="mt-3 rounded-md border border-line bg-paper p-3">
          {mode === "approve" && escalatesAtThisLevel ? (
            <p
              data-testid="approval-conditions-escalation-notice"
              className="mb-3 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-2 text-xs text-ink"
            >
              This file meets an escalation criterion, so a Level-1 approve routes to
              Escalated Review. Conditions belong to the final approving level — the
              Level-2 Supervisor attaches them. Recording conditions here is rejected.
            </p>
          ) : mode === "approve" ? (
            <div className="mb-3">
              <label htmlFor="approval-conditions-input" className="mb-1 block text-xs font-semibold text-ink">
                Conditions (optional) — each must be cleared before final approval
              </label>
              {conditions.length > 0 ? (
                <ul className="mb-2 space-y-1">
                  {conditions.map((text, index) => (
                    <li
                      key={`${index}-${text}`}
                      data-testid={`approval-condition-item-${index}`}
                      className="flex items-start justify-between gap-2 rounded-md border border-line/70 bg-card px-2.5 py-1.5 text-sm text-ink"
                    >
                      <span>{text}</span>
                      <button
                        type="button"
                        data-testid={`approval-condition-remove-${index}`}
                        onClick={() => setConditions((prev) => prev.filter((_, i) => i !== index))}
                        className="text-xs font-semibold text-danger hover:underline"
                        aria-label={`Remove condition ${index + 1}`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex gap-2">
                <input
                  id="approval-conditions-input"
                  data-testid="approval-conditions-input"
                  type="text"
                  value={conditionText}
                  onChange={(event) => setConditionText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCondition();
                    }
                  }}
                  placeholder="e.g. Provide an updated pay stub"
                  className={inputClass}
                />
                <button
                  type="button"
                  data-testid="approval-condition-add"
                  onClick={addCondition}
                  disabled={!conditionText.trim()}
                  className={btnOutline}
                >
                  Add
                </button>
              </div>
            </div>
          ) : (
            <fieldset className="mb-3">
              <legend className="mb-1 block text-xs font-semibold text-ink">
                HMDA denial reasons (select 1–{MAX_DENIAL_REASONS})
              </legend>
              <ul className="space-y-1">
                {DENIAL_REASONS.map((reason) => {
                  const checked = reasons.includes(reason.value);
                  return (
                    <li key={reason.value}>
                      <label className="flex items-center gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          data-testid={`denial-reason-${reason.value}`}
                          value={reason.value}
                          checked={checked}
                          disabled={!checked && reasons.length >= MAX_DENIAL_REASONS}
                          onChange={() => toggleReason(reason.value)}
                          className="h-4 w-4 rounded border-line text-navy focus:ring-navy/40"
                        />
                        {reason.label}
                      </label>
                    </li>
                  );
                })}
              </ul>
              {hasOther ? (
                <div className="mt-2">
                  <label htmlFor="denial-other-text" className="mb-1 block text-xs font-semibold text-ink">
                    Other reason (required)
                  </label>
                  <textarea
                    id="denial-other-text"
                    data-testid="denial-other-text"
                    rows={2}
                    value={otherText}
                    onChange={(event) => setOtherText(event.target.value)}
                    className={inputClass}
                  />
                </div>
              ) : null}
            </fieldset>
          )}

          <label htmlFor="approval-notes" className="mb-1 block text-xs font-semibold text-ink">
            Notes (optional)
          </label>
          <textarea
            id="approval-notes"
            data-testid="approval-notes"
            rows={2}
            maxLength={4000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className={inputClass}
          />

          <p data-testid="approval-routing-hint" className="mt-2 text-xs text-ink-soft">
            {routingHint()}
          </p>

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="approval-cancel-btn"
              onClick={() => {
                setMode(null);
                setError(null);
              }}
              disabled={busy}
              className={btnOutline}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="approval-submit-btn"
              onClick={submit}
              disabled={busy || (mode === "deny" && denyInvalid)}
              className={mode === "deny" ? btnDanger : btnPrimary}
            >
              {busy ? "Working…" : mode === "deny" ? "Record deny decision" : "Record approve decision"}
            </button>
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted">
        Decisions post to the approval gate. The gate enforces levels, escalation, and the
        different-approver rule server-side — conflicts are shown verbatim.
      </p>
    </section>
  );
}
