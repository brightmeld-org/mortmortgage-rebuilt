"use client";

// /applications/:id/view — BorrowerApplicationView (task-017, contracts §C;
// REQ-020/REQ-042/REQ-052, FLOW-004/005). Frame authority:
// frame/screen-appview.png + gui-spec "application-view".
//
// Read-only view of a submitted application: status strip, workflow timeline
// (GET workflow-history), formal notes, section summaries, versions + two-
// version diff (GET versions, GET versions/diff), documents with
// request-gated uploads (ASM-004 mirrored as UI affordance — the server
// enforces the gate), and state-scoped Withdraw / Decline / Continue actions
// driven by the server's Application.availableTransitions.
//
// Formal notes come from the contracted source, GET /api/applications/:id/notes
// (live since task-030; the server serves borrowers ONLY formal notes — S-7 is
// enforced in the query, and this view renders nothing but type "formal"
// regardless). The pre-increment-7 workflow-history fallback was removed when
// the endpoint went live.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getJson, postMultipartWithCsrf } from "./api";
import { ApplicationActions } from "./ApplicationActions";
import { formatCurrency, formatDate, humanizeEnum } from "./format";
import type {
  ApplicationNote,
  ApplicationWire,
  BorrowerRecordWire,
  DocumentListResponse,
  DocumentRequestInfo,
  DocumentRequestList,
  DocumentWire,
  NotePage,
  VersionPage,
  WorkflowHistoryPage,
} from "./types";
import { sectionLabel } from "./types";
import { VersionsCard } from "./VersionsCard";
import {
  ApiErrorBanner,
  Badge,
  btnPrimary,
  Card,
  CardHeading,
  CardLabel,
  SkeletonBlock,
  StateBadge,
} from "./ui";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface ViewData {
  application: ApplicationWire;
  history: WorkflowHistoryPage | null;
  versions: VersionPage | null;
  documents: DocumentListResponse | null;
  requests: DocumentRequestInfo[];
  /** Formal notes from GET /api/applications/:id/notes (S-7: formal only). */
  formalNotes: ApplicationNote[];
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string; details?: string[] }
  | { phase: "ready"; data: ViewData };

async function loadAll(applicationId: string): Promise<LoadState> {
  const application = await getJson<ApplicationWire>(`/api/applications/${applicationId}`);
  if (!application.ok) {
    return { phase: "error", message: application.error.message, details: application.error.details };
  }
  const [history, versions, documents, requests, notes] = await Promise.all([
    getJson<WorkflowHistoryPage>(`/api/applications/${applicationId}/workflow-history?page=1&pageSize=100`),
    getJson<VersionPage>(`/api/applications/${applicationId}/versions?page=1&pageSize=100`),
    getJson<DocumentListResponse>(`/api/applications/${applicationId}/documents`),
    getJson<DocumentRequestList>(`/api/applications/${applicationId}/document-requests`),
    getJson<NotePage>(`/api/applications/${applicationId}/notes?page=1&pageSize=100`),
  ]);

  // Defensive formal-only filter — the server already strips non-formal notes
  // for borrowers (S-7); the UI never renders any other type regardless.
  const formalNotes = notes.ok ? notes.data.rows.filter((note) => note.type === "formal") : [];

  return {
    phase: "ready",
    data: {
      application: application.data,
      history: history.ok ? history.data : null,
      versions: versions.ok ? versions.data : null,
      documents: documents.ok ? documents.data : null,
      requests: requests.ok ? requests.data.rows : [],
      formalNotes: formalNotes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    },
  };
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function ApplicationViewClient({ applicationId }: { applicationId: string }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(async () => {
    setState(await loadAll(applicationId));
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <div className="space-y-4">
        <SkeletonBlock className="h-12 w-96" />
        <div className="grid gap-4 lg:grid-cols-3">
          <SkeletonBlock className="h-80 lg:col-span-2" />
          <SkeletonBlock className="h-80" />
        </div>
      </div>
    );
  }

  if (state.phase === "error") {
    return <ApiErrorBanner message={state.message} details={state.details} testId="application-view-error" />;
  }

  const { application: app, history, versions, documents, requests, formalNotes } = state.data;

  // Server-driven action availability: availableTransitions is computed for
  // the CALLER role by the API; "continue" is the wizard link the server
  // exposes on borrower-editable states via the dashboard action ids.
  const actions: string[] = [];
  if (app.workflowState === "draft" || app.workflowState === "revision_requested") actions.push("continue");
  const transitions = app.availableTransitions ?? [];
  if (transitions.includes("withdrawn")) actions.push("withdraw");
  if (transitions.includes("declined_by_borrower")) actions.push("decline");

  const revisionNote =
    app.workflowState === "revision_requested"
      ? (formalNotes.find((note) => note.content)?.content ?? null)
      : null;

  return (
    <div>
      {/* Status strip */}
      <div data-testid="view-status-strip">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-bold text-ink">{app.applicationNumber}</h1>
          <StateBadge state={app.workflowState} label={app.workflowStateLabel} testId="view-state-badge" />
        </div>
        <p className="mt-1.5 text-sm text-ink-soft">
          {app.submittedAt ? <>Submitted {formatDate(app.submittedAt)}</> : <>Created {formatDate(app.createdAt)}</>}
          {app.decidedAt ? <> · Decision {formatDate(app.decidedAt)}</> : null}
          {slaNote(app)}
        </p>
      </div>

      {revisionNote !== null ? (
        <div
          data-testid="revision-banner"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-info/30 bg-info-soft px-4 py-3"
        >
          <p className="text-sm text-info">
            <strong>Revision requested:</strong> “{revisionNote}”
          </p>
          <a
            href={`/applications/${app.id}`}
            className="whitespace-nowrap text-sm font-semibold text-info underline-offset-2 transition-colors duration-200 hover:underline"
          >
            Continue to the application →
          </a>
        </div>
      ) : null}

      <div className="mt-6 grid items-start gap-5 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-5 lg:col-span-2">
          <TimelineCard history={history} />
          <NotesCard notes={formalNotes} />
          <SectionsCard app={app} />
          <VersionsCard applicationId={app.id} versions={versions} />
        </div>

        {/* Right column */}
        <div className="space-y-5">
          <SummaryCard app={app} />
          <DocumentsCard
            applicationId={app.id}
            documents={documents}
            requests={requests}
            onChanged={() => void load()}
          />
          <Card testId="view-actions-card">
            <CardLabel>Actions</CardLabel>
            <div className="mt-3">
              {actions.length === 0 ? (
                <p data-testid="view-no-actions" className="text-sm text-ink-soft">
                  No further actions are available for this application.
                </p>
              ) : (
                <ApplicationActions
                  applicationId={app.id}
                  applicationNumber={app.applicationNumber}
                  availableActions={actions}
                  onChanged={() => void load()}
                  size="panel"
                />
              )}
              {actions.includes("decline") ? (
                <p className="mt-2.5 text-xs text-muted">
                  Requires confirmation. Withdraw is offered instead while a decision is pending.
                </p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function slaNote(app: ApplicationWire): React.ReactNode {
  if (
    app.decidedAt &&
    app.submittedAt &&
    new Date(app.decidedAt).getTime() - new Date(app.submittedAt).getTime() <= 30 * 86_400_000
  ) {
    return <> · within the 30-day service target</>;
  }
  if (app.overallSlaDaysRemaining !== undefined && app.overallSlaDaysRemaining !== null) {
    return <> · {app.overallSlaDaysRemaining} days remaining in the 30-day service target</>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function TimelineCard({ history }: { history: WorkflowHistoryPage | null }) {
  const rows = useMemo(
    () => (history ? [...history.rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : []),
    [history],
  );
  return (
    <Card testId="workflow-timeline">
      <CardHeading>Progress</CardHeading>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-soft">No workflow activity yet.</p>
      ) : (
        <ol className="mt-4 space-y-3">
          {rows.map((row) => (
            <li key={row.id} data-testid={`timeline-entry-${row.id}`} className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-[11px] font-bold text-success"
              >
                ✓
              </span>
              <p className="text-sm text-ink">
                {row.toStateLabel}
                <span className="text-muted"> — {formatDate(row.createdAt)}</span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Formal notes ("Messages from your loan team")
// ---------------------------------------------------------------------------

function NotesCard({ notes }: { notes: ApplicationNote[] }) {
  return (
    <Card testId="formal-notes-list">
      <CardHeading>Messages from your loan team</CardHeading>
      {notes.length === 0 ? (
        <p className="mt-3 text-sm text-ink-soft">No messages yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {notes.map((note) => (
            <li
              key={note.id}
              data-testid={`formal-note-${note.id}`}
              className="rounded-md border border-line bg-paper px-4 py-3"
            >
              <p className="text-sm font-semibold text-ink">
                {note.authorDisplayName} · {humanizeEnum(note.authorRole.toLowerCase())} · Formal note ·{" "}
                {formatDate(note.createdAt)}
              </p>
              <p className="mt-1 text-sm text-ink-soft">{note.content}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">Staff shown by role and display name only.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Read-only section summaries (same grouping as the wizard)
// ---------------------------------------------------------------------------

function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5 text-sm last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-ink">{value ?? "—"}</span>
    </div>
  );
}

function addressText(address?: { street?: string; unit?: string; city?: string; state?: string; zip?: string }): string {
  if (!address?.street) return "—";
  const unit = address.unit ? ` ${address.unit}` : "";
  return `${address.street}${unit}, ${address.city ?? ""}, ${address.state ?? ""} ${address.zip ?? ""}`.trim();
}

function borrowerTitle(borrower: BorrowerRecordWire): string {
  const name = [borrower.firstName, borrower.lastName].filter(Boolean).join(" ");
  const roleLabel = borrower.ordinal === 1 ? "Primary borrower" : "Co-borrower";
  return name ? `${roleLabel} — ${name}` : roleLabel;
}

function SectionsCard({ app }: { app: ApplicationWire }) {
  const data = app.data;
  return (
    <Card testId="sections-summary">
      <CardHeading>Application sections</CardHeading>
      <div className="mt-4 space-y-2">
        <details className="group rounded-md border border-line" data-testid="section-summary-identity">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("identity")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            {app.borrowers.map((borrower) => (
              <div key={borrower.id} className="py-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  {borrowerTitle(borrower)}
                </p>
                <DataRow label="SSN" value={borrower.ssnMasked} />
                <DataRow label="Date of birth" value={borrower.dateOfBirthDisplay} />
                <DataRow label="Citizenship" value={humanizeEnum(borrower.citizenship)} />
                <DataRow label="Marital status" value={humanizeEnum(borrower.maritalStatus)} />
                <DataRow
                  label="Phone"
                  value={borrower.cellPhone ?? borrower.homePhone ?? borrower.workPhone}
                />
                <DataRow label="Email" value={borrower.email} />
                <DataRow label="Type of credit" value={humanizeEnum(borrower.creditType)} />
              </div>
            ))}
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-address-history">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("address-history")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            {app.borrowers.map((borrower) => (
              <div key={borrower.id} className="py-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  {borrowerTitle(borrower)}
                </p>
                <DataRow label="Current address" value={addressText(borrower.currentAddress)} />
                <DataRow label="Housing" value={humanizeEnum(borrower.housingStatus)} />
                <DataRow
                  label="Time at address"
                  value={
                    borrower.yearsAtAddress !== undefined
                      ? `${borrower.yearsAtAddress} yr ${borrower.monthsAtAddress ?? 0} mo`
                      : "—"
                  }
                />
              </div>
            ))}
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-employment-income">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("employment-income")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            {app.borrowers.map((borrower) => (
              <div key={borrower.id} className="py-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  {borrowerTitle(borrower)}
                </p>
                {(borrower.employments ?? []).length === 0 ? (
                  <p className="py-1.5 text-sm text-muted">No employment entered.</p>
                ) : (
                  (borrower.employments ?? []).map((employment, index) => (
                    <DataRow
                      key={employment.id ?? index}
                      label={employment.employerName || "Employer"}
                      value={
                        employment.selfEmployed
                          ? `${formatCurrency(employment.selfEmployedMonthlyIncome)} / mo (self-employed)`
                          : `${formatCurrency(employment.baseMonthlyIncome)} / mo`
                      }
                    />
                  ))
                )}
              </div>
            ))}
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-assets-reo">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("assets-reo")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            {(data?.assets ?? []).length === 0 ? (
              <p className="py-1.5 text-sm text-muted">No assets entered.</p>
            ) : (
              (data?.assets ?? []).map((asset, index) => (
                <DataRow
                  key={asset.id ?? index}
                  label={`${humanizeEnum(asset.accountType)}${asset.financialInstitution ? ` — ${asset.financialInstitution}` : ""}${asset.accountNumberLast4 ? ` (…${asset.accountNumberLast4})` : ""}`}
                  value={formatCurrency(asset.cashOrMarketValue)}
                />
              ))
            )}
            {(data?.realEstateOwned ?? []).map((reo, index) => (
              <DataRow
                key={reo.id ?? index}
                label={`Real estate — ${addressText(reo.address)}`}
                value={formatCurrency(reo.propertyValue)}
              />
            ))}
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-liabilities">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("liabilities")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            {(data?.liabilities ?? []).length === 0 && (data?.otherLiabilities ?? []).length === 0 ? (
              <p className="py-1.5 text-sm text-muted">No liabilities entered.</p>
            ) : (
              <>
                {(data?.liabilities ?? []).map((liability, index) => (
                  <DataRow
                    key={liability.id ?? index}
                    label={`${humanizeEnum(liability.accountType)}${liability.companyName ? ` — ${liability.companyName}` : ""}${liability.accountNumberLast4 ? ` (…${liability.accountNumberLast4})` : ""}`}
                    value={`${formatCurrency(liability.unpaidBalance)} · ${formatCurrency(liability.monthlyPayment)} / mo`}
                  />
                ))}
                {(data?.otherLiabilities ?? []).map((other, index) => (
                  <DataRow
                    key={other.id ?? index}
                    label={humanizeEnum(other.type)}
                    value={`${formatCurrency(other.monthlyPayment)} / mo`}
                  />
                ))}
              </>
            )}
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-subject-property">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("subject-property")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            <DataRow label="Address" value={addressText(data?.subjectProperty?.address)} />
            <DataRow label="Property type" value={humanizeEnum(data?.subjectProperty?.propertyType)} />
            <DataRow label="Occupancy" value={humanizeEnum(data?.subjectProperty?.occupancy)} />
            <DataRow label="Estimated value" value={formatCurrency(data?.subjectProperty?.estimatedValue)} />
            <DataRow label="Target closing" value={formatDate(data?.subjectProperty?.targetClosingDate)} />
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-loan-details">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("loan-details")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            <DataRow label="Purpose" value={humanizeEnum(data?.loan?.loanPurpose)} />
            <DataRow label="Loan type" value={humanizeEnum(data?.loan?.loanType)} />
            <DataRow
              label="Term"
              value={data?.loan?.loanTermMonths ? `${data.loan.loanTermMonths / 12} years` : "—"}
            />
            <DataRow label="Loan amount" value={formatCurrency(data?.loan?.requestedLoanAmount)} />
            <DataRow label="Down payment" value={formatCurrency(data?.loan?.downPaymentAmount)} />
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-declarations">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("declarations")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            {app.borrowers.map((borrower) => {
              const declarations = borrower.declarations ?? {};
              const yesCount = Object.values(declarations).filter((value) => value === true).length;
              const answered = Object.values(declarations).filter((value) => typeof value === "boolean").length;
              return (
                <DataRow
                  key={borrower.id}
                  label={borrowerTitle(borrower)}
                  value={answered > 0 ? `${answered} answered · ${yesCount} “yes”` : "Not completed"}
                />
              );
            })}
          </div>
        </details>

        <details className="group rounded-md border border-line" data-testid="section-summary-demographics">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:text-copper">
            {sectionLabel("demographics")}
          </summary>
          <div className="border-t border-line px-4 py-2">
            {app.borrowers.map((borrower) => (
              <div key={borrower.id} className="py-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  {borrowerTitle(borrower)}
                </p>
                <DataRow
                  label="Ethnicity"
                  value={(borrower.demographics?.ethnicity ?? []).map(humanizeEnum).join(", ") || "—"}
                />
                <DataRow
                  label="Race"
                  value={(borrower.demographics?.race ?? []).map(humanizeEnum).join(", ") || "—"}
                />
                <DataRow label="Sex" value={humanizeEnum(borrower.demographics?.sex)} />
              </div>
            ))}
          </div>
        </details>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Right-column summary
// ---------------------------------------------------------------------------

function SummaryCard({ app }: { app: ApplicationWire }) {
  const loan = app.data?.loan;
  const property = app.data?.subjectProperty;
  const borrowerNames = app.borrowers
    .map((borrower) => [borrower.firstName, borrower.lastName].filter(Boolean).join(" "))
    .filter((name) => name.length > 0)
    .join(" & ");
  return (
    <Card testId="view-summary-card">
      <CardLabel>Application summary</CardLabel>
      <div className="mt-2">
        <DataRow label="Loan amount" value={formatCurrency(loan?.requestedLoanAmount)} />
        <DataRow
          label="Loan type"
          value={
            loan?.loanType
              ? `${humanizeEnum(loan.loanType)}${loan.loanTermMonths ? ` · ${loan.loanTermMonths / 12} yr` : ""}`
              : "—"
          }
        />
        <DataRow
          label="Property"
          value={
            property?.address?.city && property.address.state
              ? `${property.address.city}, ${property.address.state}`
              : "—"
          }
        />
        <DataRow label="Borrowers" value={borrowerNames || "—"} />
        {app.assignedCaseworkerName ? (
          <DataRow label="Loan processor" value={app.assignedCaseworkerName} />
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Documents + request-gated upload (ASM-004 UI mirror)
// ---------------------------------------------------------------------------

const DOC_STATUS_TONE: Record<DocumentWire["status"], "gray" | "info" | "warn" | "success" | "danger"> = {
  pending: "info",
  accepted: "success",
  insufficient: "danger",
  waived: "gray",
};

function documentDisplayName(document: DocumentWire): string {
  const current = document.versions?.find((version) => version.id === document.currentVersionId);
  return current?.originalFileName ?? humanizeEnum(document.documentType);
}

function DocumentsCard({
  applicationId,
  documents,
  requests,
  onChanged,
}: {
  applicationId: string;
  documents: DocumentListResponse | null;
  requests: DocumentRequestInfo[];
  onChanged: () => void;
}) {
  const [uploadingRequestId, setUploadingRequestId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{ message: string; details?: string[] } | null>(null);

  const openRequests = requests.filter((request) => !request.fulfilledByDocumentId);
  const documentRows = documents?.documents ?? [];

  async function onUpload(request: DocumentRequestInfo, file: File) {
    setUploadingRequestId(request.id);
    setUploadError(null);

    // Replacement when an insufficient document of the requested type exists;
    // otherwise a new upload. Both are server-gated (ASM-004) — this only
    // chooses the §B endpoint.
    const replaceTarget = documentRows.find(
      (document) => document.documentType === request.documentType && document.status === "insufficient",
    );
    const form = new FormData();
    form.append("file", file);
    form.append("documentType", request.documentType);
    form.append("description", `Uploaded for request: ${request.reason}`.slice(0, 200));

    const result = replaceTarget
      ? await postMultipartWithCsrf(`/api/documents/${replaceTarget.id}/versions`, form)
      : await postMultipartWithCsrf(`/api/applications/${applicationId}/documents`, form);

    setUploadingRequestId(null);
    if (!result.ok) {
      setUploadError({ message: result.error.message, details: result.error.details });
      return;
    }
    onChanged();
  }

  return (
    <Card testId="documents-list">
      <CardLabel>Documents</CardLabel>

      {documentRows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-soft">No documents uploaded.</p>
      ) : (
        <ul className="mt-2">
          {documentRows.map((document) => (
            <li
              key={document.id}
              data-testid={`view-doc-${document.id}`}
              className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm last:border-b-0"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{documentDisplayName(document)}</span>
                <span className="block text-xs text-muted">
                  {humanizeEnum(document.documentType)} · v{document.currentVersionNumber}
                  {document.jobStatus && document.jobStatus !== "completed"
                    ? ` · scan ${document.jobStatus}`
                    : ""}
                </span>
              </span>
              <Badge tone={DOC_STATUS_TONE[document.status]} testId={`view-doc-status-${document.id}`}>
                {humanizeEnum(document.status)}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {openRequests.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-warn">Requested by your loan team</p>
          <ul className="mt-2 space-y-3">
            {openRequests.map((request) => (
              <li
                key={request.id}
                data-testid={`open-doc-request-${request.id}`}
                className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2.5"
              >
                <p className="text-sm font-semibold text-warn">{humanizeEnum(request.documentType)}</p>
                <p className="mt-0.5 text-xs text-warn">{request.reason}</p>
                <label className={`${btnPrimary} mt-2.5 cursor-pointer text-xs`}>
                  {uploadingRequestId === request.id ? "Uploading…" : "Upload document"}
                  <input
                    type="file"
                    data-testid={`doc-request-upload-${request.id}`}
                    className="sr-only"
                    disabled={uploadingRequestId !== null}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void onUpload(request, file);
                      event.target.value = "";
                    }}
                  />
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {uploadError ? (
        <div className="mt-3">
          <ApiErrorBanner message={uploadError.message} details={uploadError.details} testId="doc-upload-error" />
        </div>
      ) : null}
    </Card>
  );
}
