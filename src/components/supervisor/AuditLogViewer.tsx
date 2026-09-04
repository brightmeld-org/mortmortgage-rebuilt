"use client";

// AuditLogViewer (contracts §C, task-039, REQ-064 / NFR-015 / §4.6.10) —
// /supervisor/audit-log: paginated (25/page) chronological viewer (newest
// first) with AUTO-APPLYING filters (action-type dropdown sourced from the
// real values in use, application search-as-you-type by number or borrower
// name, user search-as-you-type by name or email, date range; ID-ish inputs
// carry placeholder text with the expected format), expandable row detail
// (before/after values pretty-rendered for corrections/config changes, result
// summaries for underwriting checks), and a streamed CSV export of the
// CURRENT filter with the configured row cap + cap-hit message state.
//
// Navigation path: (app) shell supervisor header → "Audit Log"
// (nav-sup-audit-log, added by task-038 in AppHeader.tsx) →
// /supervisor/audit-log (src/app/(app)/supervisor/audit-log/page.tsx).
//
// Data: GET /api/admin/audit-log (AuditLogPage — rows/page/pageSize/total) and
// GET /api/admin/audit-log/export (streamed text/csv). NO write endpoints
// exist for the audit log (INV-009) — this component only ever GETs.
// Export cap-hit state: the export response carries x-audit-export-cap-hit /
// x-audit-export-row-cap / x-audit-export-total headers (plus a trailer
// message line inside the CSV itself); the fetch-based download reads the
// headers and shows the gui-spec "export row-cap hit message" state.
//
// Selector contract (build-plan §C): audit-row-{id}, audit-filter-{name},
// audit-expand-{id}, audit-export-btn — extended within the audit-* namespace
// only (audit-detail-{id}, audit-empty, audit-load-error, audit-export-error,
// audit-export-cap-message, audit-filter-clear, audit-page-prev/next via
// PaginationBar testIdPrefix "audit-page").
//
// Design language: supervisor table pattern (frame/screen-supapps.png,
// OutboundMessagesView/SupervisorApplicationsClient) — Card, filter bar with
// selects + search inputs, Badge tones, btn classes, PaginationBar.

import { useCallback, useEffect, useState } from "react";
import { getJson, type ErrorResponseBody } from "@/components/borrower/api";
import { humanizeEnum } from "@/components/borrower/format";
import { ApiErrorBanner, Badge, SkeletonBlock, btnPrimary } from "@/components/borrower/ui";
import { PaginationBar } from "@/components/caseworker/ui";

// contracts.json models.AuditLogEntryInfo — exact field names.
interface AuditLogEntryInfo {
  id: string;
  timestamp: string;
  actorName?: string;
  actorRole?: string;
  actionType: string;
  applicationNumber?: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  before?: string; // JSON-encoded before value (corrections/config changes)
  after?: string; // JSON-encoded after value
  reason?: string;
  requestId?: string;
}

// contracts.json models.AuditLogPage — exact field names.
interface AuditLogPage {
  rows: AuditLogEntryInfo[];
  page: number;
  pageSize: number;
  total: number;
}

interface Filters {
  actionType: string;
  applicationSearch: string;
  userSearch: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  actionType: "",
  applicationSearch: "",
  userSearch: "",
  from: "",
  to: "",
};

/** Viewer page size — §B "the audit viewer default page size is 25". */
const PAGE_SIZE = 25;

const selectClass =
  "rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25";
const searchClass =
  "rounded-md border border-line bg-card px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25";

function filterParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.actionType) params.set("actionType", filters.actionType);
  if (filters.applicationSearch.trim()) params.set("applicationSearch", filters.applicationSearch.trim());
  if (filters.userSearch.trim()) params.set("userSearch", filters.userSearch.trim());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params;
}

function listUrl(filters: Filters, page: number): string {
  const params = filterParams(filters);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  return `/api/admin/audit-log?${params.toString()}`;
}

function exportUrl(filters: Filters): string {
  const params = filterParams(filters);
  const query = params.toString();
  return query ? `/api/admin/audit-log/export?${query}` : "/api/admin/audit-log/export";
}

/** "Mon D, YYYY, H:MM AM" — the staff log-timestamp convention (OutboundMessagesView). */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Pretty-render a JSON-encoded before/after string; falls back to the raw text. */
function prettyJson(encoded: string): string {
  try {
    return JSON.stringify(JSON.parse(encoded), null, 2);
  } catch {
    return encoded;
  }
}

interface CapHitState {
  rowCap: number;
  total: number;
}

function BeforeAfterPanel({ label, encoded, testId }: { label: string; encoded: string; testId: string }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <pre
        data-testid={testId}
        className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-paper p-2 text-xs text-ink-soft"
      >
        {prettyJson(encoded)}
      </pre>
    </div>
  );
}

export function AuditLogViewer({ actionTypes, exportRowCap }: { actionTypes: string[]; exportRowCap: number }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [debouncedFilters, setDebouncedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const [data, setData] = useState<AuditLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<ErrorResponseBody | null>(null);
  const [capHit, setCapHit] = useState<CapHitState | null>(null);

  // AUTO-APPLY with debounce: the two search-as-you-type inputs settle for
  // 300ms before refetching (established sup-applications pattern — no Apply
  // button anywhere); select/date changes ride the same debounce.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFilters(filters);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getJson<AuditLogPage>(listUrl(debouncedFilters, page));
    if (result.ok) {
      setData(result.data);
      setLoadError(null);
    } else {
      setData(null);
      setLoadError(result.error);
    }
    setLoading(false);
  }, [debouncedFilters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  const filterCount = Object.values(filters).filter((v) => v.trim().length > 0).length;

  /** Streamed CSV download of the CURRENT filter via fetch (reads cap-hit headers). */
  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    setCapHit(null);
    try {
      const response = await fetch(exportUrl(debouncedFilters), { credentials: "same-origin" });
      if (!response.ok) {
        let body: ErrorResponseBody | null = null;
        try {
          body = (await response.json()) as ErrorResponseBody;
        } catch {
          body = null;
        }
        setExportError(
          body && typeof body.message === "string"
            ? body
            : { code: "unavailable", message: "The export could not be generated. Please try again." },
        );
        return;
      }

      // §4.6.10 cap-hit message state (also present as a trailer line in the CSV).
      if (response.headers.get("x-audit-export-cap-hit") === "true") {
        const rowCap = Number(response.headers.get("x-audit-export-row-cap") ?? exportRowCap);
        const total = Number(response.headers.get("x-audit-export-total") ?? 0);
        setCapHit({ rowCap, total });
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const nameMatch = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = nameMatch?.[1] ?? "audit-log-export.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError({
        code: "network_error",
        message: "Could not reach the server. Check your connection and try again.",
      });
    } finally {
      setExporting(false);
    }
  }

  const rows = data?.rows ?? [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Audit log</h1>
          <p className="mt-1 text-sm text-muted">
            Append-only record of every state-changing action. Filters auto-apply; the CSV export
            streams the current filter (up to {exportRowCap.toLocaleString("en-US")} rows per
            export).
          </p>
        </div>
        <button
          type="button"
          data-testid="audit-export-btn"
          className={btnPrimary}
          disabled={exporting}
          onClick={() => void exportCsv()}
        >
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {loadError ? (
        <ApiErrorBanner message={loadError.message} details={loadError.details} testId="audit-load-error" />
      ) : null}
      {exportError ? (
        <ApiErrorBanner message={exportError.message} details={exportError.details} testId="audit-export-error" />
      ) : null}
      {capHit ? (
        <div
          role="status"
          data-testid="audit-export-cap-message"
          className="mb-4 rounded-md border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-sm text-warn"
        >
          Export row cap reached: the download contains the first{" "}
          {capHit.rowCap.toLocaleString("en-US")} of {capHit.total.toLocaleString("en-US")} matching
          rows. Narrow the filter to export the remaining rows.
        </div>
      ) : null}

      {/* ---------------- Auto-applying filter bar (no Apply button) ---------------- */}
      <div className="rounded-lg border border-line bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select
            data-testid="audit-filter-actionType"
            aria-label="Filter by action type"
            value={filters.actionType}
            onChange={(event) => patchFilters({ actionType: event.target.value })}
            className={selectClass}
          >
            <option value="">Action type: any</option>
            {actionTypes.map((type) => (
              <option key={type} value={type}>
                {humanizeEnum(type)}
              </option>
            ))}
          </select>

          <input
            type="search"
            data-testid="audit-filter-applicationSearch"
            value={filters.applicationSearch}
            onChange={(event) => patchFilters({ applicationSearch: event.target.value })}
            placeholder="Application: MM-YYYY-NNNNNN or borrower name"
            aria-label="Filter by application number or borrower name"
            className={`${searchClass} w-72`}
          />

          <input
            type="search"
            data-testid="audit-filter-userSearch"
            value={filters.userSearch}
            onChange={(event) => patchFilters({ userSearch: event.target.value })}
            placeholder="User: name or email@example.com"
            aria-label="Filter by user name or email"
            className={`${searchClass} w-64`}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          <label className="flex items-center gap-1.5">
            From
            <input
              type="date"
              data-testid="audit-filter-from"
              value={filters.from}
              onChange={(event) => patchFilters({ from: event.target.value })}
              className={selectClass}
            />
          </label>
          <label className="flex items-center gap-1.5">
            to
            <input
              type="date"
              data-testid="audit-filter-to"
              value={filters.to}
              onChange={(event) => patchFilters({ to: event.target.value })}
              className={selectClass}
            />
          </label>
          {filterCount > 0 ? (
            <button
              type="button"
              data-testid="audit-filter-clear"
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="ml-auto rounded-md border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft transition-colors duration-200 hover:border-navy hover:text-navy"
            >
              Clear filters ({filterCount})
            </button>
          ) : null}
        </div>
      </div>

      {/* ---------------- Table (25/page, newest first) ---------------- */}
      <div className="mt-4 overflow-hidden rounded-lg border border-line bg-card shadow-sm">
        {loading && !data ? (
          <div className="p-4">
            <SkeletonBlock className="h-64 w-full" />
          </div>
        ) : data && rows.length === 0 ? (
          <p data-testid="audit-empty" className="px-6 py-10 text-center text-sm text-ink-soft">
            No audit entries match the current filters.
          </p>
        ) : data ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
                    <th className="px-3 py-2.5 pl-4 font-semibold">Timestamp</th>
                    <th className="px-3 py-2.5 font-semibold">User</th>
                    <th className="px-3 py-2.5 font-semibold">Action type</th>
                    <th className="px-3 py-2.5 font-semibold">App #</th>
                    <th className="px-3 py-2.5 font-semibold">Summary</th>
                    <th className="px-3 py-2.5 pr-4 text-right font-semibold">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const expanded = expandedId === row.id;
                    const hasDiff = row.before !== undefined || row.after !== undefined;
                    return [
                      <tr
                        key={row.id}
                        data-testid={`audit-row-${row.id}`}
                        className="border-b border-line align-top last:border-b-0"
                      >
                        <td className="whitespace-nowrap px-3 py-2.5 pl-4 text-ink-soft">
                          {formatTimestamp(row.timestamp)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          {row.actorName ? (
                            <span className="text-ink">{row.actorName}</span>
                          ) : (
                            <span className="text-ink-soft">System</span>
                          )}
                          {row.actorRole ? (
                            <span className="ml-1.5 text-xs uppercase tracking-wide text-muted">
                              {row.actorRole}
                            </span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <Badge tone="info">{humanizeEnum(row.actionType)}</Badge>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-navy">
                          {row.applicationNumber ?? <span className="font-normal text-muted">—</span>}
                        </td>
                        <td className="max-w-[26rem] px-3 py-2.5 text-ink">
                          <p className={expanded ? "" : "truncate"}>{row.summary}</p>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 pr-4 text-right">
                          <button
                            type="button"
                            data-testid={`audit-expand-${row.id}`}
                            aria-expanded={expanded}
                            onClick={() => setExpandedId(expanded ? null : row.id)}
                            className="text-xs font-semibold text-copper hover:underline"
                          >
                            {expanded ? "Hide ▲" : "Expand ▼"}
                          </button>
                        </td>
                      </tr>,
                      expanded ? (
                        <tr key={`${row.id}-detail`} className="border-b border-line bg-paper/60 last:border-b-0">
                          <td colSpan={6} className="px-4 py-3">
                            <div data-testid={`audit-detail-${row.id}`} className="space-y-3">
                              {/* Result summaries (underwriting checks etc.) — the full summary line. */}
                              <p className="text-sm text-ink">{row.summary}</p>
                              {row.reason ? (
                                <p className="text-sm text-ink-soft">
                                  <span className="font-semibold text-ink">Reason:</span> {row.reason}
                                </p>
                              ) : null}
                              {hasDiff ? (
                                <div className="flex flex-col gap-3 sm:flex-row">
                                  {row.before !== undefined ? (
                                    <BeforeAfterPanel
                                      label="Before"
                                      encoded={row.before}
                                      testId={`audit-before-${row.id}`}
                                    />
                                  ) : null}
                                  {row.after !== undefined ? (
                                    <BeforeAfterPanel
                                      label="After"
                                      encoded={row.after}
                                      testId={`audit-after-${row.id}`}
                                    />
                                  ) : null}
                                </div>
                              ) : null}
                              <p className="text-xs text-muted">
                                {row.entityType ? `${row.entityType}${row.entityId ? ` · ${row.entityId}` : ""}` : null}
                                {row.entityType && row.requestId ? " · " : null}
                                {row.requestId ? `Request ${row.requestId}` : null}
                                {!row.entityType && !row.requestId ? "No additional metadata" : null}
                              </p>
                            </div>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </div>
            <PaginationBar
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
              testIdPrefix="audit-page"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
