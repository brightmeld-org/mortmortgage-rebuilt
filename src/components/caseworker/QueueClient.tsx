"use client";

// CaseworkerQueue (contracts §C, task-028) — /caseworker/queue.
//
// Navigation path: sign-in → role home (CASEWORKER → /caseworker/queue); also
// the caseworker header "Queue" link (nav-queue) and the app logo. Row click →
// /staff/applications/:id (task-029). "Completion History" tab → /caseworker/history.
//
// Frame: frame/screen-queue.png + gui-spec §cw-queue — stats strip, Unassigned/
// My Queue tabs with counts, sortable columns, text filter, atomic Claim with
// conflict toast + row removal (frame Key states: claim conflict toast; empty
// tab states).
//
// Data: GET /api/queue/unassigned | /api/queue/mine (?sort&dir&search&page&
// pageSize) + GET /api/caseworker/stats; claim via the EXISTING
// POST /api/applications/:id/claim. Server error messages surface VERBATIM
// (NFR-025). All state labels come from the server (workflowStateLabel —
// never "unknown").

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import { formatCurrency, formatDate, humanizeEnum } from "@/components/borrower/format";
import { StateBadge, SkeletonBlock } from "@/components/borrower/ui";
import {
  PaginationBar,
  PriorityBadge,
  SlaBadge,
  StatStripCard,
  Toast,
  type ToastState,
} from "./ui";
import type { AssignmentInfo, CaseworkerStats, QueuePage, QueueRow } from "./types";

type TabKey = "unassigned" | "mine";

const PAGE_SIZE = 25;

// Sortable columns (§4.4.1) — `sort` values are QueueRow field names (the §B
// sorting convention); testids kebab-case per the selector contract.
interface ColumnDef {
  field: string;
  label: string;
}

const COLUMNS: ColumnDef[] = [
  { field: "applicationNumber", label: "App #" },
  { field: "borrowerDisplayName", label: "Borrower" },
  { field: "loanAmount", label: "Amount" },
  { field: "loanType", label: "Type" },
  { field: "submittedAt", label: "Submitted" },
  { field: "workflowState", label: "State" },
  { field: "priority", label: "Priority" },
  { field: "slaStatus", label: "SLA" },
  { field: "daysInState", label: "Days in state" },
  { field: "lastActivityAt", label: "Last activity" },
  { field: "openFraudFlagCount", label: "Flags" },
];

function kebab(field: string): string {
  return field.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

const LOAN_TYPE_LABELS: Record<string, string> = {
  conventional: "Conventional",
  fha: "FHA",
  va: "VA",
  usda: "USDA",
};

function queueUrl(
  tab: TabKey,
  page: number,
  sort: string | null,
  dir: "asc" | "desc",
  search: string,
): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  if (sort) {
    params.set("sort", sort);
    params.set("dir", dir);
  }
  if (search.trim().length > 0) params.set("search", search.trim());
  return `/api/queue/${tab}?${params.toString()}`;
}

export function QueueClient() {
  const [tab, setTab] = useState<TabKey>("unassigned");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [data, setData] = useState<QueuePage | null>(null);
  const [counts, setCounts] = useState<{ unassigned: number | null; mine: number | null }>({
    unassigned: null,
    mine: null,
  });
  const [stats, setStats] = useState<CaseworkerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchSeq = useRef(0);

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Debounced auto-applying text filter (§4.4.1).
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const refreshStats = useCallback(async () => {
    const result = await getJson<CaseworkerStats>("/api/caseworker/stats");
    if (result.ok) setStats(result.data);
  }, []);

  /** Total of the OTHER tab (badge count) — 1-row probe for `total`. */
  const refreshOtherCount = useCallback(async (other: TabKey) => {
    const result = await getJson<QueuePage>(`/api/queue/${other}?page=1&pageSize=1`);
    if (result.ok) {
      setCounts((prev) => ({ ...prev, [other]: result.data.total }));
    }
  }, []);

  const loadQueue = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setLoadError(null);
    const result = await getJson<QueuePage>(queueUrl(tab, page, sort, dir, debouncedSearch));
    if (seq !== fetchSeq.current) return; // stale response
    if (result.ok) {
      setData(result.data);
      setCounts((prev) => ({ ...prev, [tab]: result.data.total }));
    } else {
      setData(null);
      setLoadError(result.error);
    }
    setLoading(false);
  }, [tab, page, sort, dir, debouncedSearch]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    void refreshStats();
    void refreshOtherCount(tab === "unassigned" ? "mine" : "unassigned");
  }, [refreshStats, refreshOtherCount, tab]);

  function selectTab(next: TabKey) {
    if (next === tab) return;
    setTab(next);
    setPage(1);
  }

  /** Header click cycles asc → desc → default order. */
  function toggleSort(field: string) {
    setPage(1);
    if (sort !== field) {
      setSort(field);
      setDir("asc");
    } else if (dir === "asc") {
      setDir("desc");
    } else {
      setSort(null);
      setDir("asc");
    }
  }

  async function claim(row: QueueRow) {
    setClaiming(row.applicationId);
    const result = await postWithCsrf<AssignmentInfo>(
      `/api/applications/${row.applicationId}/claim`,
    );
    setClaiming(null);

    if (result.ok) {
      showToast({
        kind: "success",
        message: `Claimed ${row.applicationNumber} — it is now in My Queue.`,
      });
    } else {
      // §4.4.1 / AC-24: losing claimant sees the server's "Already claimed by
      // [name]" message VERBATIM and the row disappears from Unassigned.
      showToast({ kind: "error", message: result.error.message });
    }
    // Either way the row is no longer claimable by this user — drop it locally,
    // then re-sync list, counts, and stats from the server.
    setData((prev) =>
      prev
        ? { ...prev, rows: prev.rows.filter((r) => r.applicationId !== row.applicationId) }
        : prev,
    );
    await Promise.all([loadQueue(), refreshStats(), refreshOtherCount("mine")]);
  }

  function openDetail(applicationId: string) {
    window.location.assign(`/staff/applications/${applicationId}`);
  }

  const statCards = useMemo(() => {
    if (!stats) return null;
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatStripCard testId="stats-queue-size" value={String(stats.queueSize)} label="My queue" />
        <StatStripCard
          testId="stats-completed-this-month"
          value={String(stats.completedThisMonth)}
          label="Completed this month"
        />
        <StatStripCard
          testId="stats-avg-days-to-decision"
          value={stats.avgDaysToDecision90d.toFixed(1)}
          label="Avg days to decision (90d)"
        />
        <StatStripCard
          testId="stats-approval-rate"
          value={`${stats.approvalRatePct90d}%`}
          label="Approval rate (90d)"
        />
        <StatStripCard
          testId="stats-overdue"
          value={String(stats.overdueCount)}
          label="Overdue"
          tone={stats.overdueCount > 0 ? "danger" : undefined}
        />
      </div>
    );
  }, [stats]);

  const emptyMessage =
    debouncedSearch.trim().length > 0
      ? "No applications match your filter."
      : tab === "unassigned"
        ? "No unassigned applications right now — the queue is clear."
        : "Your queue is empty. Claim an application from the Unassigned tab to get started.";

  return (
    <div>
      <h1 className="font-display text-3xl font-bold text-ink">Workbench</h1>

      <div className="mt-6">{statCards ?? <SkeletonBlock className="h-[74px] w-full" />}</div>

      {/* Tabs + filter */}
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-1 border-b border-line" role="tablist" aria-label="Queue tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "unassigned"}
            data-testid="queue-tab-unassigned"
            onClick={() => selectTab("unassigned")}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition-colors duration-200 ${
              tab === "unassigned"
                ? "border-copper text-copper"
                : "border-transparent text-ink-soft hover:text-ink"
            }`}
          >
            Unassigned{counts.unassigned !== null ? ` (${counts.unassigned})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "mine"}
            data-testid="queue-tab-mine"
            onClick={() => selectTab("mine")}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition-colors duration-200 ${
              tab === "mine"
                ? "border-copper text-copper"
                : "border-transparent text-ink-soft hover:text-ink"
            }`}
          >
            My Queue{counts.mine !== null ? ` (${counts.mine})` : ""}
          </button>
          <a
            href="/caseworker/history"
            role="tab"
            aria-selected={false}
            data-testid="history-tab"
            className="-mb-px border-b-2 border-transparent px-4 py-2 text-sm font-semibold text-ink-soft transition-colors duration-200 hover:text-ink"
          >
            Completion History
          </a>
        </div>
        <input
          type="search"
          data-testid="queue-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter by app # or borrower…"
          aria-label="Filter by application number or borrower name"
          className="w-64 rounded-md border border-line bg-card px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
        />
      </div>

      {/* Table */}
      <div className="mt-4 overflow-hidden rounded-lg border border-line bg-card shadow-sm">
        {loading && !data ? (
          <div className="p-4">
            <SkeletonBlock className="h-64 w-full" />
          </div>
        ) : loadError ? (
          <div
            role="alert"
            data-testid="queue-load-error"
            className="m-4 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
          >
            {loadError.message}
          </div>
        ) : data && data.rows.length === 0 ? (
          <p data-testid="queue-empty" className="px-6 py-10 text-center text-sm text-ink-soft">
            {emptyMessage}
          </p>
        ) : data ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line">
                    {COLUMNS.map((col) => (
                      <th key={col.field} className="whitespace-nowrap px-3 py-2.5 first:pl-4">
                        <button
                          type="button"
                          data-testid={`queue-sort-${kebab(col.field)}`}
                          onClick={() => toggleSort(col.field)}
                          aria-sort={
                            sort === col.field ? (dir === "asc" ? "ascending" : "descending") : undefined
                          }
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider transition-colors duration-200 ${
                            sort === col.field ? "text-copper" : "text-muted hover:text-ink"
                          }`}
                        >
                          {col.label}
                          {sort === col.field ? (
                            <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>
                          ) : null}
                        </button>
                      </th>
                    ))}
                    {tab === "unassigned" ? <th className="px-3 py-2.5 pr-4" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr
                      key={row.applicationId}
                      data-testid={`queue-row-${row.applicationId}`}
                      onClick={() => openDetail(row.applicationId)}
                      className="cursor-pointer border-b border-line last:border-b-0 transition-colors duration-200 hover:bg-paper"
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 pl-4">
                        {/* NFR-025 (WCAG 2.1 AA full keyboard operability): the
                            row-open affordance is a REAL link on the primary
                            cell — tabbable, Enter-activated, correctly roled,
                            and middle-clickable — not a click handler on the
                            <tr>. The row onClick is retained as a mouse
                            convenience only. */}
                        <a
                          href={`/staff/applications/${row.applicationId}`}
                          data-testid={`queue-open-${row.applicationId}`}
                          aria-label={`Open application ${row.applicationNumber}`}
                          onClick={(event) => event.stopPropagation()}
                          className="rounded-sm font-semibold text-navy underline-offset-2 transition-colors duration-200 hover:text-copper hover:underline focus:outline-none focus:ring-2 focus:ring-navy/40"
                        >
                          {row.applicationNumber}
                        </a>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink">{row.borrowerDisplayName}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink">
                        {formatCurrency(row.loanAmount)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">
                        {row.loanType ? (LOAN_TYPE_LABELS[row.loanType] ?? humanizeEnum(row.loanType)) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">
                        {formatDate(row.submittedAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <StateBadge state={row.workflowState} label={row.workflowStateLabel} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <PriorityBadge
                          priority={row.priority}
                          testId={`priority-badge-${row.applicationId}`}
                        />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <SlaBadge slaStatus={row.slaStatus} testId={`sla-badge-${row.applicationId}`} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink">{row.daysInState}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">
                        {formatDate(row.lastActivityAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        {row.openFraudFlagCount ? (
                          <span className="inline-block whitespace-nowrap rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-semibold text-danger">
                            {row.openFraudFlagCount} open
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      {tab === "unassigned" ? (
                        <td className="whitespace-nowrap px-3 py-2.5 pr-4 text-right">
                          <button
                            type="button"
                            data-testid={`queue-claim-${row.applicationId}`}
                            disabled={claiming !== null}
                            onClick={(event) => {
                              event.stopPropagation();
                              void claim(row);
                            }}
                            className="inline-flex items-center justify-center rounded-md bg-navy px-3 py-1 text-xs font-semibold text-white transition-colors duration-200 hover:bg-navy-deep active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {claiming === row.applicationId ? "Claiming…" : "Claim"}
                          </button>
                        </td>
                      ) : null}
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
              testIdPrefix="queue-page"
            />
          </>
        ) : null}
      </div>

      <p className="mt-3 text-xs text-muted">
        Default sort: Overdue first, then Urgent → Low, then At risk, then oldest submission.
        {tab === "unassigned"
          ? " Unassigned rows show summary fields only until claimed."
          : ""}
      </p>

      {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} testId="queue-claim-toast" /> : null}
    </div>
  );
}
