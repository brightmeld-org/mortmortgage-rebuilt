"use client";

// History tab (task-029 — §4.4.3 "History" / frame: WorkflowHistory timeline
// with from→to labels, actor, note, timestamp). GET
// /api/applications/:id/workflow-history (WorkflowHistoryPage, offset-limit).

import { useCallback, useEffect, useState } from "react";
import { formatDate } from "@/components/borrower/format";
import type { WorkflowHistoryPage } from "@/components/borrower/types";
import { ApiErrorBanner } from "@/components/borrower/ui";
import { PaginationBar } from "@/components/caseworker/ui";
import { getJson, type ErrorResponseBody } from "./api";
import { DetailSection, EmptyLine } from "./ui";

export function HistoryTab({ applicationId }: { applicationId: string }) {
  const [pageData, setPageData] = useState<WorkflowHistoryPage | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<ErrorResponseBody | null>(null);

  const load = useCallback(async () => {
    const result = await getJson<WorkflowHistoryPage>(
      `/api/applications/${applicationId}/workflow-history?page=${page}&pageSize=50`,
    );
    if (result.ok) {
      setPageData(result.data);
      setError(null);
    } else {
      setPageData({ rows: [], page: 1, pageSize: 50, total: 0 });
      setError(result.error);
    }
  }, [applicationId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DetailSection title="Workflow history" testId="history-timeline">
      {error ? <ApiErrorBanner message={error.message} details={error.details} testId="history-load-error" /> : null}
      {pageData === null ? (
        <p className="text-sm text-muted">Loading history…</p>
      ) : pageData.rows.length === 0 ? (
        <EmptyLine>No workflow transitions recorded yet.</EmptyLine>
      ) : (
        <ol className="relative ml-2 border-l-2 border-line pl-5">
          {pageData.rows.map((row) => (
            <li key={row.id} data-testid={`history-row-${row.id}`} className="relative pb-5 last:pb-0">
              <span aria-hidden className="absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full bg-copper" />
              <p className="text-sm font-semibold text-ink">
                {row.fromStateLabel} → {row.toStateLabel}
              </p>
              <p className="mt-0.5 text-xs text-ink-soft">
                {row.actorDisplayName ? `${row.actorDisplayName} · ` : ""}
                {row.actorRole} · {formatDate(row.createdAt)}
                {row.versionNumber !== undefined ? ` · v${row.versionNumber}` : ""}
              </p>
              {row.note ? <p className="mt-1 text-sm text-ink-soft">“{row.note}”</p> : null}
            </li>
          ))}
        </ol>
      )}
      {pageData ? (
        <PaginationBar
          page={pageData.page}
          pageSize={pageData.pageSize}
          total={pageData.total}
          onPage={setPage}
          testIdPrefix="history-page"
        />
      ) : null}
    </DetailSection>
  );
}
