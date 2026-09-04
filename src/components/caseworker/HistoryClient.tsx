"use client";

// Completion-history surface (task-028, contracts §C CaseworkerQueue;
// REQ-048) — /caseworker/history.
//
// Navigation path: caseworker header "History" link (nav-history) and the
// "Completion History" tab on /caseworker/queue (history-tab). Row click →
// /staff/applications/:id (task-029).
//
// Frame: gui-spec §cw-history — caseworker header + paginated table of the
// last 12 months: application number, outcome, days to decision, decided
// date. Data: GET /api/caseworker/history (?page&pageSize — the 12-month
// window is fixed server-side). outcomeLabel comes from the server verbatim
// (never "unknown").

import { useCallback, useEffect, useState } from "react";
import { getJson, type ErrorResponseBody } from "@/components/borrower/api";
import { formatDate } from "@/components/borrower/format";
import { SkeletonBlock } from "@/components/borrower/ui";
import { PaginationBar } from "./ui";
import type { CompletionHistoryPage } from "./types";

const PAGE_SIZE = 25;

export function HistoryClient() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CompletionHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await getJson<CompletionHistoryPage>(
      `/api/caseworker/history?page=${page}&pageSize=${PAGE_SIZE}`,
    );
    if (result.ok) {
      setData(result.data);
    } else {
      setData(null);
      setLoadError(result.error);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  function openDetail(applicationId: string) {
    window.location.assign(`/staff/applications/${applicationId}`);
  }

  return (
    <div>
      <h1 className="font-display text-3xl font-bold text-ink">Completion History</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Applications you processed to a final decision or terminal state in the last 12 months.
      </p>

      {/* Tab strip mirroring the queue page (frame §cw-queue tab vocabulary). */}
      <div className="mt-6 flex gap-1 border-b border-line" role="tablist" aria-label="Queue tabs">
        <a
          href="/caseworker/queue"
          role="tab"
          aria-selected={false}
          data-testid="history-back-to-queue"
          className="-mb-px border-b-2 border-transparent px-4 py-2 text-sm font-semibold text-ink-soft transition-colors duration-200 hover:text-ink"
        >
          Queue
        </a>
        <span
          role="tab"
          aria-selected="true"
          data-testid="history-tab"
          className="-mb-px border-b-2 border-copper px-4 py-2 text-sm font-semibold text-copper"
        >
          Completion History{data ? ` (${data.total})` : ""}
        </span>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-line bg-card shadow-sm">
        {loading && !data ? (
          <div className="p-4">
            <SkeletonBlock className="h-48 w-full" />
          </div>
        ) : loadError ? (
          <div
            role="alert"
            data-testid="history-load-error"
            className="m-4 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
          >
            {loadError.message}
          </div>
        ) : data && data.rows.length === 0 ? (
          <p data-testid="history-empty" className="px-6 py-10 text-center text-sm text-ink-soft">
            No completed applications in the last 12 months.
          </p>
        ) : data ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="whitespace-nowrap px-3 py-2.5 pl-4 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      App #
                    </th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Outcome
                    </th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Days to decision
                    </th>
                    <th className="whitespace-nowrap px-3 py-2.5 pr-4 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Decided
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr
                      key={row.applicationId}
                      data-testid={`history-row-${row.applicationId}`}
                      onClick={() => openDetail(row.applicationId)}
                      className="cursor-pointer border-b border-line last:border-b-0 transition-colors duration-200 hover:bg-paper"
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 pl-4">
                        {/* NFR-025: real link affordance on the primary cell —
                            keyboard reachable and Enter-activated (the row
                            onClick is a mouse convenience only). */}
                        <a
                          href={`/staff/applications/${row.applicationId}`}
                          data-testid={`history-open-${row.applicationId}`}
                          aria-label={`Open application ${row.applicationNumber}`}
                          onClick={(event) => event.stopPropagation()}
                          className="rounded-sm font-semibold text-navy underline-offset-2 transition-colors duration-200 hover:text-copper hover:underline focus:outline-none focus:ring-2 focus:ring-navy/40"
                        >
                          {row.applicationNumber}
                        </a>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span
                          className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            row.outcomeLabel === "Approved"
                              ? "bg-success-soft text-success"
                              : row.outcomeLabel === "Denied"
                                ? "bg-danger-soft text-danger"
                                : "bg-gray-soft text-ink-soft"
                          }`}
                        >
                          {row.outcomeLabel}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink">{row.daysToDecision}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 pr-4 text-ink-soft">
                        {formatDate(row.decidedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
              testIdPrefix="history-page"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
