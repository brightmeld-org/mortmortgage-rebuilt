"use client";

// Borrower dashboard (task-017, REQ-020, §C BorrowerDashboard, FLOW-004/005).
// Frame authority: frame/screen-dashboard.png + gui-spec "borrower-dashboard".
//
// Data: GET /api/applications (BorrowerApplicationList — rows + summary cards).
// Per-row actions come from server-provided availableActions (never re-derived
// client-side). Revision banner: for each application in Revision Requested,
// the formal note text is read from the revision transition's
// WorkflowHistoryInfo.note (GET workflow-history — §B, borrower-readable; the
// transition engine stores the required formal note on that row).

import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api";
import { ApplicationActions } from "./ApplicationActions";
import { formatCurrency, formatDate } from "./format";
import type { BorrowerApplicationList, WorkflowHistoryPage } from "./types";
import { ApiErrorBanner, btnCopper, Card, SkeletonBlock, StatCard, StateBadge } from "./ui";

interface RevisionNotice {
  applicationId: string;
  applicationNumber: string;
  note: string | null;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string; details?: string[] }
  | { phase: "ready"; list: BorrowerApplicationList; revisions: RevisionNotice[] };

const SUMMARY_CARDS: { key: keyof BorrowerApplicationList["cards"]; label: string; testId: string }[] = [
  { key: "total", label: "Total", testId: "dashboard-summary-total" },
  { key: "draft", label: "Draft", testId: "dashboard-summary-draft" },
  { key: "inUnderwriting", label: "In Underwriting", testId: "dashboard-summary-in-underwriting" },
  { key: "approved", label: "Approved", testId: "dashboard-summary-approved" },
  { key: "denied", label: "Denied", testId: "dashboard-summary-denied" },
  { key: "withdrawn", label: "Withdrawn", testId: "dashboard-summary-withdrawn" },
];

async function loadRevisionNotices(
  rows: BorrowerApplicationList["rows"],
): Promise<RevisionNotice[]> {
  const revisionRows = rows.filter((row) => row.workflowState === "revision_requested");
  return Promise.all(
    revisionRows.map(async (row) => {
      const history = await getJson<WorkflowHistoryPage>(
        `/api/applications/${row.id}/workflow-history?page=1&pageSize=100`,
      );
      let note: string | null = null;
      if (history.ok) {
        // Most recent transition INTO revision_requested carries the formal note.
        const entries = history.data.rows
          .filter((entry) => entry.toState === "revision_requested" && entry.note)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        note = entries[0]?.note ?? null;
      }
      return { applicationId: row.id, applicationNumber: row.applicationNumber, note };
    }),
  );
}

export function DashboardClient() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(async () => {
    const result = await getJson<BorrowerApplicationList>("/api/applications?page=1&pageSize=100");
    if (!result.ok) {
      setState({ phase: "error", message: result.error.message, details: result.error.details });
      return;
    }
    const revisions = await loadRevisionNotices(result.data.rows);
    setState({ phase: "ready", list: result.data, revisions });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <div className="space-y-4">
        <SkeletonBlock className="h-10 w-64" />
        <SkeletonBlock className="h-20 w-full" />
        <SkeletonBlock className="h-64 w-full" />
      </div>
    );
  }

  if (state.phase === "error") {
    return <ApiErrorBanner message={state.message} details={state.details} testId="dashboard-error" />;
  }

  const { list, revisions } = state;

  return (
    <div>
      {/* Revision banner(s) — conditional, above everything (frame) */}
      {revisions.map((revision) => (
        <div
          key={revision.applicationId}
          data-testid="revision-banner"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-info/30 bg-info-soft px-4 py-3"
        >
          <p className="text-sm text-info">
            <strong>Revision requested on {revision.applicationNumber}:</strong>{" "}
            {revision.note ? `“${revision.note}”` : "Your loan team requested revisions."}
          </p>
          <a
            href={`/applications/${revision.applicationId}`}
            data-testid={`revision-banner-continue-${revision.applicationId}`}
            className="whitespace-nowrap text-sm font-semibold text-info underline-offset-2 transition-colors duration-200 hover:underline"
          >
            Continue →
          </a>
        </div>
      ))}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-bold text-ink">Your applications</h1>
        <a href="/applications/new" data-testid="start-new-application-btn" className={btnCopper}>
          Start New Application
        </a>
      </div>

      {/* Summary cards row */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SUMMARY_CARDS.map((card) => (
          <StatCard
            key={card.testId}
            value={list.cards[card.key]}
            label={card.label}
            testId={card.testId}
          />
        ))}
      </div>

      {list.rows.length === 0 ? (
        <Card testId="dashboard-empty-state" className="py-12 text-center">
          <p className="font-display text-xl font-bold text-ink">No applications yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
            Start your mortgage application — your progress saves automatically, and you can come
            back any time.
          </p>
          <div className="mt-5">
            <a href="/applications/new" data-testid="empty-state-start-btn" className={btnCopper}>
              Start New Application
            </a>
          </div>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-sm">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                {["Application #", "Created", "Submitted", "Status", "Loan Amount", "Property", "Actions"].map(
                  (heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted"
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`application-row-${row.id}`}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-4 py-3 font-semibold text-ink">{row.applicationNumber}</td>
                  <td className="px-4 py-3 text-ink-soft">{formatDate(row.createdAt)}</td>
                  <td className="px-4 py-3 text-ink-soft">{formatDate(row.submittedAt)}</td>
                  <td className="px-4 py-3">
                    <StateBadge
                      state={row.workflowState}
                      label={row.workflowStateLabel}
                      testId={`application-state-${row.id}`}
                    />
                  </td>
                  <td className="px-4 py-3 text-ink">{formatCurrency(row.loanAmount)}</td>
                  <td className="px-4 py-3 text-ink-soft">{row.propertyCityState ?? "—"}</td>
                  <td className="px-4 py-3">
                    <ApplicationActions
                      applicationId={row.id}
                      applicationNumber={row.applicationNumber}
                      availableActions={row.availableActions}
                      onChanged={() => void load()}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.total > list.pageSize ? (
        <p className="mt-3 text-xs text-muted">
          Showing {list.rows.length} of {list.total} applications.
        </p>
      ) : null}
    </div>
  );
}
