"use client";

// StaffApplicationDetail (task-029 — contracts §C; REQ-049/050/053/054,
// DATA-004). /staff/applications/:id — the full §4.4.3 tab set with the
// workflow action panel (right rail per frame/screen-detail.png), inline
// corrections with provenance, and the §4.4.7 document review surface.
//
// Navigation path: caseworker queue / history row click → here
// (src/components/caseworker/QueueClient.tsx, HistoryClient.tsx); supervisor
// all-applications row click (task-031) and notification links also land here.
//
// Record-level scoping is SERVER-side (GET /api/applications/:id): caseworkers
// get full detail only when assigned (403 "Claim this application…"), unknown
// ids 404 — both render friendly cards with the API message VERBATIM.
//
// Sequencing seams (explicit mount containers):
//   - notes-panel-mount / versions-panel-mount  → task-030 NotesAndVersionsPanel
//     (FILLED — plus the frame's right-rail ChatterRailCard, task-030)
//   - approval-panel-mount (supervisor, preliminary_decision/escalated_review)
//                                              → task-032 ApprovalPanel
//   - ocr-panel-mount (DocumentsTab, per doc)  → task-035 OcrPanel (FILLED)
//
// Selector contract (§C StaffApplicationDetail): detail-tab-{name},
// qualification-card (rendered by the shared QualificationCard on Summary and
// inside UnderwritingPanel on Underwriting — only the active tab is mounted),
// correction-* / workflow-* / doc-* per the child components.

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import { formatCurrency, humanizeEnum } from "@/components/borrower/format";
import type { ApplicationWire } from "@/components/borrower/types";
import {
  ApiErrorBanner,
  Badge,
  Card,
  SkeletonBlock,
  StateBadge,
  WarnBanner,
  btnOutline,
} from "@/components/borrower/ui";
import { PriorityBadge, SlaBadge } from "@/components/caseworker/ui";
import type { Priority, SlaStatus } from "@/components/caseworker/types";
import { ApprovalPanel } from "@/components/staff/approval/ApprovalPanel";
import { ChatterRailCard, NotesAndVersionsPanel } from "@/components/staff/notes/NotesAndVersionsPanel";
import { UnderwritingPanel } from "@/components/staff/underwriting/UnderwritingPanel";
import { SupervisorRail } from "@/components/supervisor/SupervisorRail";
import type { SubjectMapPoint } from "@/components/staff/underwriting/types";
import { getJson, postWithCsrf, type ErrorResponseBody } from "./api";
import { CorrectionModal } from "./CorrectionModal";
import {
  AddressesTab,
  AssetsTab,
  DeclarationsTab,
  DemographicsTab,
  EmploymentTab,
  IdentityTab,
  LiabilitiesTab,
  LoanTab,
  PropertyTab,
} from "./DataTabs";
import { DocumentsTab } from "./DocumentsTab";
import { HistoryTab } from "./HistoryTab";
import { SummaryTab } from "./SummaryTab";
import { WorkflowActionPanel } from "./WorkflowActionPanel";
import {
  CHECKS_PERMITTED_STATES,
  buildCorrectionMap,
  isStaffEditableState,
  type AssignmentList,
  type CorrectableField,
  type CorrectionInfo,
  type CorrectionPage,
  type CorrectionsContext,
} from "./types";

// §4.4.3 tab list, in order, with the §C selector names.
const TABS = [
  { name: "summary", label: "Summary" },
  { name: "identity", label: "Identity" },
  { name: "addresses", label: "Addresses" },
  { name: "employment", label: "Employment & Income" },
  { name: "assets", label: "Assets & REO" },
  { name: "liabilities", label: "Liabilities" },
  { name: "property", label: "Property" },
  { name: "loan", label: "Loan" },
  { name: "declarations", label: "Declarations" },
  { name: "demographics", label: "Demographics" },
  { name: "documents", label: "Documents" },
  { name: "underwriting", label: "Underwriting" },
  { name: "notes", label: "Notes" },
  { name: "versions", label: "Versions" },
  { name: "history", label: "History" },
] as const;

type TabName = (typeof TABS)[number]["name"];

export function StaffApplicationDetailClient({
  applicationId,
  role,
  preliminaryRecommendation = null,
}: {
  applicationId: string;
  role: "CASEWORKER" | "SUPERVISOR";
  /** Application.preliminaryRecommendation, server-read for supervisors
   *  (task-032 approval panel — not a §A wire field). */
  preliminaryRecommendation?: string | null;
}) {
  const [app, setApp] = useState<ApplicationWire | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; error: ErrorResponseBody } | null>(null);
  const [correctionMap, setCorrectionMap] = useState<Map<string, CorrectionInfo>>(new Map());
  const [activeTab, setActiveTab] = useState<TabName>("summary");
  const [editorField, setEditorField] = useState<CorrectableField | null>(null);
  /** INV-039 stale-write prompt (verbatim server 409 message), mirroring the
   *  wizard's stale section-save reload prompt. */
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<ErrorResponseBody | null>(null);

  const loadCorrections = useCallback(async () => {
    const result = await getJson<CorrectionPage>(
      `/api/applications/${applicationId}/corrections?page=1&pageSize=100`,
    );
    if (result.ok) setCorrectionMap(buildCorrectionMap(result.data.rows));
  }, [applicationId]);

  const loadApp = useCallback(async () => {
    const result = await getJson<ApplicationWire>(`/api/applications/${applicationId}`);
    if (result.ok) {
      setApp(result.data);
      setLoadError(null);
    } else {
      setLoadError({ status: result.status, error: result.error });
    }
  }, [applicationId]);

  useEffect(() => {
    void loadApp();
    void loadCorrections();
  }, [loadApp, loadCorrections]);

  const refresh = useCallback(() => {
    void loadApp();
    void loadCorrections();
  }, [loadApp, loadCorrections]);

  const canCorrect = app !== null && isStaffEditableState(app.workflowState);

  const corrections: CorrectionsContext = useMemo(
    () => ({
      byField: correctionMap,
      canCorrect,
      openEditor: (field) => setEditorField(field),
    }),
    [correctionMap, canCorrect],
  );

  // ------------------------------------------------------------------
  // Access-denied / not-found states (server scoping — S-2a)
  // ------------------------------------------------------------------
  if (loadError) {
    return (
      <Card testId="detail-access-error">
        <h1 className="font-display text-xl font-bold text-ink">
          {loadError.status === 404 ? "Application not found" : "You don’t have access to this application"}
        </h1>
        <div className="mt-3">
          <ApiErrorBanner
            message={loadError.error.message}
            details={loadError.error.details}
            testId="detail-access-error-banner"
          />
        </div>
        <Link
          href={(role === "SUPERVISOR" ? "/supervisor" : "/caseworker/queue") as Route}
          data-testid="detail-back-link"
          className={btnOutline}
        >
          {role === "SUPERVISOR" ? "Back to all applications" : "Back to the queue"}
        </Link>
      </Card>
    );
  }

  if (!app) {
    return (
      <div className="space-y-4" data-testid="detail-loading">
        <SkeletonBlock className="h-24 w-full" />
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-64 w-full" />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Title bar (frame: number · names, badges, facts line)
  // ------------------------------------------------------------------
  const primary = app.borrowers.find((b) => b.ordinal === 1);
  const coBorrower = app.borrowers.find((b) => b.ordinal === 2);
  const names = [primary, coBorrower]
    .filter((b) => b !== undefined)
    .map((b) => [b?.firstName, b?.lastName].filter(Boolean).join(" "))
    .filter((n) => n.length > 0)
    .join(" & ");
  const loan = app.data?.loan;
  const loanLine = [
    loan?.requestedLoanAmount !== undefined ? formatCurrency(loan.requestedLoanAmount) : null,
    loan?.loanType ? humanizeEnum(loan.loanType) : null,
    loan?.loanPurpose ? humanizeEnum(loan.loanPurpose).toLowerCase() : null,
  ]
    .filter(Boolean)
    .join(" ");

  async function retryDecisionNotification() {
    if (!app) return;
    setRetryBusy(true);
    setRetryError(null);
    const result = await postWithCsrf<ApplicationWire>(
      `/api/applications/${app.id}/decision-notification/retry`,
    );
    setRetryBusy(false);
    if (result.ok) setApp(result.data);
    else setRetryError(result.error);
  }

  const subject: SubjectMapPoint | undefined = (() => {
    const property = app.data?.subjectProperty as
      | { geocode?: { latitude?: number; longitude?: number }; address?: { street?: string; city?: string; state?: string } }
      | undefined;
    if (property?.geocode?.latitude === undefined || property.geocode.longitude === undefined) return undefined;
    const label = [property.address?.street, property.address?.city, property.address?.state]
      .filter(Boolean)
      .join(", ");
    return { latitude: property.geocode.latitude, longitude: property.geocode.longitude, label: label || undefined };
  })();

  return (
    <div data-testid="staff-application-detail">
      {/* ---------------- Title bar ---------------- */}
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-ink">
            {app.applicationNumber}
            {names ? ` · ${names}` : ""}
          </h1>
          <StateBadge state={app.workflowState} label={app.workflowStateLabel} testId="detail-state-badge" />
          <PriorityBadge priority={app.priority as Priority} testId="detail-priority-badge" />
          {app.slaStatus ? <SlaBadge slaStatus={app.slaStatus as SlaStatus} testId="detail-sla-badge" /> : null}
        </div>
        <p className="mt-1.5 text-sm text-ink-soft">
          {app.assignedCaseworkerName ? `Assigned to ${app.assignedCaseworkerName}` : "Unassigned"} · Version{" "}
          {app.currentVersionNumber}
          {app.overallSlaDaysRemaining !== undefined
            ? ` · Overall SLA: ${app.overallSlaDaysRemaining} days remaining`
            : ""}
          {loanLine ? ` · ${loanLine}` : ""}
        </p>
        {app.decisionNotificationPending ? (
          <div className="mt-3 max-w-xl">
            <WarnBanner testId="decision-notification-pending">
              <span className="flex flex-wrap items-center gap-2">
                Decision notification pending — the borrower has not been notified yet.
                <button
                  type="button"
                  data-testid="decision-retry-btn"
                  onClick={retryDecisionNotification}
                  disabled={retryBusy}
                  className="rounded border border-warn px-2 py-0.5 text-xs font-semibold hover:bg-warn/10 disabled:opacity-50"
                >
                  {retryBusy ? "Retrying…" : "Retry now"}
                </button>
              </span>
            </WarnBanner>
            {retryError ? (
              <div className="mt-2">
                <ApiErrorBanner message={retryError.message} details={retryError.details} testId="decision-retry-error" />
              </div>
            ) : null}
          </div>
        ) : null}
        {!canCorrect ? (
          <p data-testid="read-only-banner" className="mt-3 max-w-xl rounded-md border border-line bg-gray-soft px-3.5 py-2 text-sm text-ink-soft">
            Read-only — corrections are permitted only while the application is in a staff-editable
            state (Application Received through Preliminary Decision).
          </p>
        ) : null}
      </header>

      {/* ---------------- Tabs ---------------- */}
      <div role="tablist" aria-label="Application detail tabs" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((tab) => (
          <button
            key={tab.name}
            type="button"
            role="tab"
            id={`detail-tab-${tab.name}`}
            aria-selected={activeTab === tab.name}
            aria-controls={`detail-tabpanel-${tab.name}`}
            data-testid={`detail-tab-${tab.name}`}
            onClick={() => setActiveTab(tab.name)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-200 ${
              activeTab === tab.name
                ? "border-copper text-copper"
                : "border-transparent text-ink-soft hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---------------- Body: tab panel + right rail ---------------- */}
      <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div
          role="tabpanel"
          id={`detail-tabpanel-${activeTab}`}
          aria-labelledby={`detail-tab-${activeTab}`}
          data-testid={`detail-tabpanel-${activeTab}`}
          className="min-w-0"
        >
          {activeTab === "summary" ? <SummaryTab app={app} onFlagsChanged={refresh} /> : null}
          {activeTab === "identity" ? <IdentityTab app={app} corrections={corrections} /> : null}
          {activeTab === "addresses" ? <AddressesTab app={app} corrections={corrections} /> : null}
          {activeTab === "employment" ? <EmploymentTab app={app} corrections={corrections} /> : null}
          {activeTab === "assets" ? <AssetsTab app={app} corrections={corrections} /> : null}
          {activeTab === "liabilities" ? <LiabilitiesTab app={app} corrections={corrections} /> : null}
          {activeTab === "property" ? <PropertyTab app={app} corrections={corrections} /> : null}
          {activeTab === "loan" ? <LoanTab app={app} corrections={corrections} /> : null}
          {activeTab === "declarations" ? <DeclarationsTab app={app} corrections={corrections} /> : null}
          {activeTab === "demographics" ? <DemographicsTab app={app} corrections={corrections} /> : null}
          {activeTab === "documents" ? (
            <DocumentsTab
              applicationId={app.id}
              versionStamp={app.versionStamp}
              canAct={canCorrect}
              onConflict={(message) => setConflictMessage(message)}
            />
          ) : null}
          {activeTab === "underwriting" ? (
            <UnderwritingPanel
              applicationId={app.id}
              subject={subject}
              canRunChecks={CHECKS_PERMITTED_STATES.includes(app.workflowState)}
            />
          ) : null}
          {activeTab === "notes" ? (
            <div data-testid="notes-panel-mount">
              <NotesAndVersionsPanel applicationId={app.id} view="notes" />
            </div>
          ) : null}
          {activeTab === "versions" ? (
            <div data-testid="versions-panel-mount">
              <NotesAndVersionsPanel applicationId={app.id} view="versions" />
            </div>
          ) : null}
          {activeTab === "history" ? <HistoryTab applicationId={app.id} /> : null}
        </div>

        {/* ---------------- Right rail ---------------- */}
        <aside className="space-y-5">
          <WorkflowActionPanel app={app} role={role} onApplicationChange={setApp} onRefresh={refresh} />

          {role === "SUPERVISOR" &&
          (app.workflowState === "preliminary_decision" || app.workflowState === "escalated_review") ? (
            /* task-032 ApprovalPanel (contracts §C) in the task-029 mount seam. */
            <div data-testid="approval-panel-mount">
              <ApprovalPanel
                applicationId={app.id}
                app={app}
                preliminaryRecommendation={preliminaryRecommendation}
                onApplicationChange={setApp}
              />
            </div>
          ) : null}

          <AssignmentCard app={app} role={role} />

          {role === "SUPERVISOR" ? (
            /* task-031 supervisor detail composition: priority override,
               assignment history, export actions (§4.6.4). */
            <SupervisorRail app={app} onApplicationChange={setApp} />
          ) : null}

          {/* Frame right rail (screen-detail.png): persistent chatter card,
              15 s polling — hidden while the Notes tab hosts the chatter
              stream so the §C chatter selectors stay unique (task-030). */}
          {activeTab !== "notes" ? <ChatterRailCard applicationId={app.id} /> : null}
        </aside>
      </div>

      {editorField ? (
        <CorrectionModal
          applicationId={app.id}
          versionStamp={app.versionStamp}
          field={editorField}
          onSaved={() => {
            setEditorField(null);
            refresh();
          }}
          onConflict={(message) => {
            setEditorField(null);
            setConflictMessage(message);
          }}
          onCancel={() => setEditorField(null)}
        />
      ) : null}

      {/* INV-039 stale-write reload prompt — same affordance as the wizard's
          conflicting section save. The correction was REJECTED server-side,
          so nothing in this tab was written. */}
      {conflictMessage ? <ConflictReloadPrompt message={conflictMessage} /> : null}
    </div>
  );
}

// INV-039 stale-write reload prompt. A blocking modal whose only action is
// Reload, so Escape is a deliberate no-op (nothing to cancel to). Extracted so
// `useModalFocus` can be called unconditionally (open == mounted): focus move-in
// onto Reload + a real Tab trap (NFR-025 / LENS-014 / LENS-022).
function ConflictReloadPrompt({ message }: { message: string }) {
  const dialogRef = useModalFocus<HTMLDivElement>(() => {});
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label="Save conflict"
    >
      <div
        data-testid="conflict-reload-prompt"
        className="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-2xl"
      >
        <h2 className="font-display text-lg font-semibold text-ink">
          This application changed elsewhere
        </h2>
        <p className="mt-2 text-sm text-ink-soft">{message}</p>
        <p className="mt-2 text-sm text-ink-soft">
          Your correction was not saved. Reload to pick up the latest data, then re-apply it if
          it is still needed.
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-testid="conflict-reload-btn"
            onClick={() => window.location.reload()}
            className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assignment facts card (frame right rail). Method/date come from GET
// /api/applications/:id/assignments — supervisor-gated per §B, so caseworkers
// see the display name from the Application serializer only.
// ---------------------------------------------------------------------------

function AssignmentCard({ app, role }: { app: ApplicationWire; role: "CASEWORKER" | "SUPERVISOR" }) {
  const [latest, setLatest] = useState<{ method: string; assignedAt: string; assignedByName?: string } | null>(null);

  useEffect(() => {
    if (role !== "SUPERVISOR") return;
    let cancelled = false;
    void (async () => {
      const result = await getJson<AssignmentList>(`/api/applications/${app.id}/assignments`);
      if (!cancelled && result.ok) {
        const active = result.data.rows.find((row) => !row.endedAt) ?? result.data.rows[0];
        if (active) {
          setLatest({ method: active.method, assignedAt: active.assignedAt, assignedByName: active.assignedByName });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app.id, role]);

  return (
    <section data-testid="assignment-card" className="rounded-lg border border-line bg-card p-5 shadow-sm">
      <h2 className="text-xs font-bold uppercase tracking-wider text-ink">Assignment</h2>
      <dl className="mt-2 space-y-1.5 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-soft">Assigned</dt>
          <dd className="font-semibold text-ink">{app.assignedCaseworkerName ?? "Unassigned"}</dd>
        </div>
        {latest ? (
          <div className="flex justify-between gap-2">
            <dt className="text-ink-soft">Method</dt>
            <dd className="font-semibold capitalize text-ink">
              {latest.method}
              {latest.assignedByName ? ` · by ${latest.assignedByName}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>
      {app.availableTransitions && app.availableTransitions.length === 0 && !app.assignedCaseworkerName ? (
        <p className="mt-2 text-xs text-muted">
          <Badge tone="gray">No active assignment</Badge>
        </p>
      ) : null}
    </section>
  );
}
