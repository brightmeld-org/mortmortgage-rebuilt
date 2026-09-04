"use client";

// SupervisorApplications (contracts §C, task-031) — /supervisor.
//
// Navigation path: sign-in → role home (SUPERVISOR → /supervisor); also the
// supervisor header "All Applications" link (nav-sup-applications) and the app
// logo. Row click → /staff/applications/:id (task-029 detail).
//
// Frame: frame/screen-supapps.png + gui-spec §sup-applications — summary-card
// strip, auto-applying filter bar (state multi-select, caseworker incl.
// Unassigned, priority, SLA, loan type, needs-my-Level-2 pill), search by
// app # / borrower / property city, bulk-action bar, table with queue columns
// + caseworker + approval status, per-row Assign / Reassign / Resume actions.
// §4.6.1 additionally requires the submitted date range and pending-approval-
// level filters and the page-size select — added in the frame's design
// language (logged in frame-extensions.md).
//
// Data: GET /api/supervisor/applications (auto-applying ?states&caseworkerId&
// priority&slaStatus&loanType&submittedFrom&submittedTo&pendingApprovalLevel&
// needsMyLevel2&search&sort&dir&page&pageSize — NO Apply button, every change
// refetches); caseworker options from GET /api/admin/staff. Assignment ops via
// the AssignmentDialogs; priority override via PATCH /api/applications/:id/
// priority; suspend/resume via POST /api/applications/:id/transition. Server
// error bodies surface VERBATIM (NFR-025).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import { patchWithCsrf } from "@/components/staff/detail/api";
import { formatCurrency, formatDate, humanizeEnum } from "@/components/borrower/format";
import { SkeletonBlock, StateBadge } from "@/components/borrower/ui";
import {
  PaginationBar,
  PriorityBadge,
  SlaBadge,
  Toast,
  type ToastState,
} from "@/components/caseworker/ui";
import type { Priority, SlaStatus } from "@/components/caseworker/types";
import { AssignDialog, AutoAssignDialog, BulkAssignDialog, SuspendDialog } from "./AssignmentDialogs";
import {
  PRIORITY_VALUES,
  SUSPENDABLE_STATES,
  type StaffAccountRow,
  type StaffListResponse,
  type SupervisorApplicationPage,
  type SupervisorQueueRow,
  type WorkflowState,
} from "./list-types";

// ---------------------------------------------------------------------------
// Static option lists (enum literals verbatim from contracts.json)
// ---------------------------------------------------------------------------

const STATE_OPTIONS: readonly WorkflowState[] = [
  "draft",
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
  "approved",
  "denied",
  "borrower_notified",
  "revision_requested",
  "suspended",
  "withdrawn",
  "declined_by_borrower",
];

const STATE_LABELS: Record<WorkflowState, string> = {
  draft: "Draft",
  application_received: "Application Received",
  completeness_validated: "Completeness Validated",
  documents_received: "Supporting Documents Received",
  aus_executed: "AUS Executed",
  preliminary_decision: "Preliminary Decision",
  escalated_review: "Escalated Review",
  conditional_approval: "Conditional Approval",
  approved: "Approved",
  denied: "Denied",
  borrower_notified: "Borrower Notified",
  revision_requested: "Revision Requested",
  suspended: "Suspended",
  withdrawn: "Withdrawn",
  declined_by_borrower: "Declined by Borrower",
};

const SLA_OPTIONS: readonly SlaStatus[] = ["overdue", "at-risk", "on-track"];
const LOAN_TYPE_OPTIONS = ["conventional", "fha", "va", "usda"] as const;
const LOAN_TYPE_LABELS: Record<string, string> = {
  conventional: "Conventional",
  fha: "FHA",
  va: "VA",
  usda: "USDA",
};

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

// §4.6.1 columns: §4.4.1 queue columns + assigned caseworker + approval status.
const COLUMNS: Array<{ field: string; label: string }> = [
  { field: "applicationNumber", label: "App #" },
  { field: "borrowerDisplayName", label: "Borrower" },
  { field: "loanAmount", label: "Amount" },
  { field: "loanType", label: "Type" },
  { field: "submittedAt", label: "Submitted" },
  { field: "workflowState", label: "State" },
  { field: "priority", label: "Priority" },
  { field: "slaStatus", label: "SLA" },
  { field: "daysInState", label: "Days" },
  { field: "lastActivityAt", label: "Last activity" },
  { field: "openFraudFlagCount", label: "Flags" },
  { field: "assignedCaseworkerName", label: "Caseworker" },
  { field: "approvalStatus", label: "Approval" },
];

const CARD_METRICS: Array<{ metric: keyof SupervisorApplicationPage["cards"]; label: string }> = [
  { metric: "total", label: "Total" },
  { metric: "draft", label: "Draft" },
  { metric: "inUnderwriting", label: "In underwriting" },
  { metric: "pendingApproval", label: "Pending approval" },
  { metric: "approved", label: "Approved" },
  { metric: "denied", label: "Denied" },
  { metric: "withdrawn", label: "Withdrawn" },
  { metric: "thisMonth", label: "This month" },
];

interface Filters {
  states: WorkflowState[];
  caseworkerId: string; // "" | "unassigned" | User.id
  priority: "" | Priority;
  slaStatus: "" | SlaStatus;
  loanType: string;
  submittedFrom: string;
  submittedTo: string;
  pendingApprovalLevel: "" | "1" | "2";
  needsMyLevel2: boolean;
}

const EMPTY_FILTERS: Filters = {
  states: [],
  caseworkerId: "",
  priority: "",
  slaStatus: "",
  loanType: "",
  submittedFrom: "",
  submittedTo: "",
  pendingApprovalLevel: "",
  needsMyLevel2: false,
};

const selectClass =
  "rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25";

function listUrl(
  filters: Filters,
  search: string,
  sort: string | null,
  dir: "asc" | "desc",
  page: number,
  pageSize: number,
): string {
  const params = new URLSearchParams();
  if (filters.states.length > 0) params.set("states", filters.states.join(","));
  if (filters.caseworkerId) params.set("caseworkerId", filters.caseworkerId);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.slaStatus) params.set("slaStatus", filters.slaStatus);
  if (filters.loanType) params.set("loanType", filters.loanType);
  if (filters.submittedFrom) params.set("submittedFrom", filters.submittedFrom);
  if (filters.submittedTo) params.set("submittedTo", filters.submittedTo);
  if (filters.pendingApprovalLevel) params.set("pendingApprovalLevel", filters.pendingApprovalLevel);
  if (filters.needsMyLevel2) params.set("needsMyLevel2", "true");
  if (search.trim()) params.set("search", search.trim());
  if (sort) {
    params.set("sort", sort);
    params.set("dir", dir);
  }
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  return `/api/supervisor/applications?${params.toString()}`;
}

type DialogState =
  | { kind: "assign"; app: SupervisorQueueRow; mode: "manual" | "reassign" }
  | { kind: "bulk" }
  | { kind: "auto"; applicationIds: string[] | null }
  | { kind: "suspend"; app: SupervisorQueueRow }
  | null;

export function SupervisorApplicationsClient() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [data, setData] = useState<SupervisorApplicationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  const [staff, setStaff] = useState<StaffAccountRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [statesOpen, setStatesOpen] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const fetchSeq = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Debounced auto-applying text search (§4.6.1 — no Apply button anywhere).
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setLoadError(null);
    const result = await getJson<SupervisorApplicationPage>(
      listUrl(filters, debouncedSearch, sort, dir, page, pageSize),
    );
    if (seq !== fetchSeq.current) return; // stale response
    if (result.ok) {
      setData(result.data);
    } else {
      setData(null);
      setLoadError(result.error);
    }
    setLoading(false);
  }, [filters, debouncedSearch, sort, dir, page, pageSize]);

  // AUTO-APPLY: every filter/sort/page change refetches — no Apply button.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const result = await getJson<StaffListResponse>("/api/admin/staff");
      if (result.ok) setStaff(result.data.rows);
    })();
  }, []);

  function patchFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }

  function toggleState(state: WorkflowState) {
    setFilters((prev) => ({
      ...prev,
      states: prev.states.includes(state)
        ? prev.states.filter((s) => s !== state)
        : [...prev.states, state],
    }));
    setPage(1);
  }

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

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const numberById = useMemo(
    () => new Map(rows.map((r) => [r.applicationId, r.applicationNumber])),
    [rows],
  );
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.applicationId));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) rows.forEach((r) => next.delete(r.applicationId));
      else rows.forEach((r) => next.add(r.applicationId));
      return next;
    });
  }

  async function afterMutation(message?: string) {
    setDialog(null);
    setSelected(new Set());
    if (message) showToast({ kind: "success", message });
    await load();
  }

  // Priority override (§4.6.3): PATCH /api/applications/:id/priority — audited
  // and notifies the assigned caseworker server-side.
  async function overridePriority(row: SupervisorQueueRow, priority: Priority) {
    setRowBusy(row.applicationId);
    const result = await patchWithCsrf<{ priority: string }>(
      `/api/applications/${row.applicationId}/priority`,
      { priority },
    );
    setRowBusy(null);
    if (result.ok) {
      showToast({
        kind: "success",
        message: `${row.applicationNumber} priority overridden to ${humanizeEnum(priority)}.`,
      });
      await load();
    } else {
      showToast({ kind: "error", message: result.error.message });
    }
  }

  // Resume (§4.6.3 / INV-032): returns exactly to previousStateForSuspend via
  // the transition engine; the fresh GET supplies both the target state and
  // the current versionStamp.
  async function resume(row: SupervisorQueueRow) {
    setRowBusy(row.applicationId);
    const current = await getJson<{
      versionStamp: number;
      previousStateForSuspend?: WorkflowState;
    }>(`/api/applications/${row.applicationId}`);
    if (!current.ok || !current.data.previousStateForSuspend) {
      setRowBusy(null);
      showToast({
        kind: "error",
        message: current.ok
          ? "This application has no recorded pre-suspension state."
          : current.error.message,
      });
      return;
    }
    const result = await postWithCsrf<{ workflowStateLabel: string }>(
      `/api/applications/${row.applicationId}/transition`,
      { toState: current.data.previousStateForSuspend, versionStamp: current.data.versionStamp },
    );
    setRowBusy(null);
    if (result.ok) {
      showToast({
        kind: "success",
        message: `${row.applicationNumber} resumed to ${result.data.workflowStateLabel}.`,
      });
      await load();
    } else {
      showToast({ kind: "error", message: result.error.message });
    }
  }

  function openDetail(applicationId: string) {
    window.location.assign(`/staff/applications/${applicationId}`);
  }

  const caseworkerOptions = staff.filter((s) => s.role === "CASEWORKER");
  const filterCount =
    filters.states.length +
    (filters.caseworkerId ? 1 : 0) +
    (filters.priority ? 1 : 0) +
    (filters.slaStatus ? 1 : 0) +
    (filters.loanType ? 1 : 0) +
    (filters.submittedFrom ? 1 : 0) +
    (filters.submittedTo ? 1 : 0) +
    (filters.pendingApprovalLevel ? 1 : 0) +
    (filters.needsMyLevel2 ? 1 : 0);

  return (
    <div data-testid="supervisor-applications">
      <h1 className="font-display text-3xl font-bold text-ink">All applications</h1>

      {/* ---------------- Summary cards (population-wide) ---------------- */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {data ? (
          CARD_METRICS.map(({ metric, label }) => (
            <div
              key={metric}
              data-testid={`sup-card-${metric}`}
              className="rounded-lg border border-line bg-card px-4 py-3 shadow-sm"
            >
              <p
                className={`font-display text-2xl font-bold ${
                  metric === "pendingApproval" && data.cards.pendingApproval > 0
                    ? "text-copper"
                    : "text-ink"
                }`}
              >
                {data.cards[metric]}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {label}
              </p>
            </div>
          ))
        ) : (
          <SkeletonBlock className="col-span-full h-[74px] w-full" />
        )}
      </div>

      {/* ---------------- Filter bar (auto-apply — no Apply button) ---------------- */}
      <div className="mt-5 rounded-lg border border-line bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {/* State multi-select */}
          <div className="relative">
            <button
              type="button"
              data-testid="sup-filter-states"
              aria-expanded={statesOpen}
              onClick={() => setStatesOpen((open) => !open)}
              className={`${selectClass} ${filters.states.length > 0 ? "border-navy text-navy" : ""}`}
            >
              State: {filters.states.length === 0 ? "any" : `${filters.states.length} selected`} ▾
            </button>
            {statesOpen ? (
              <div className="absolute left-0 top-full z-40 mt-1 max-h-72 w-64 overflow-y-auto rounded-md border border-line bg-card p-2 shadow-lg">
                {STATE_OPTIONS.map((state) => (
                  <label
                    key={state}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-ink hover:bg-paper"
                  >
                    <input
                      type="checkbox"
                      data-testid={`sup-filter-state-${state}`}
                      checked={filters.states.includes(state)}
                      onChange={() => toggleState(state)}
                    />
                    {STATE_LABELS[state]}
                  </label>
                ))}
                <button
                  type="button"
                  data-testid="sup-filter-states-clear"
                  onClick={() => patchFilters({ states: [] })}
                  className="mt-1 w-full rounded border border-line px-2 py-1 text-xs font-semibold text-ink-soft hover:text-ink"
                >
                  Clear states
                </button>
              </div>
            ) : null}
          </div>

          {/* Caseworker (incl. Unassigned) */}
          <select
            data-testid="sup-filter-caseworkerId"
            aria-label="Filter by caseworker"
            value={filters.caseworkerId}
            onChange={(event) => patchFilters({ caseworkerId: event.target.value })}
            className={selectClass}
          >
            <option value="">Caseworker: any</option>
            <option value="unassigned">Unassigned</option>
            {caseworkerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName}
                {c.status === "inactive" ? " (inactive)" : ""}
              </option>
            ))}
          </select>

          <select
            data-testid="sup-filter-priority"
            aria-label="Filter by priority"
            value={filters.priority}
            onChange={(event) => patchFilters({ priority: event.target.value as Filters["priority"] })}
            className={selectClass}
          >
            <option value="">Priority: any</option>
            {PRIORITY_VALUES.map((p) => (
              <option key={p} value={p}>
                {humanizeEnum(p)}
              </option>
            ))}
          </select>

          <select
            data-testid="sup-filter-slaStatus"
            aria-label="Filter by SLA status"
            value={filters.slaStatus}
            onChange={(event) => patchFilters({ slaStatus: event.target.value as Filters["slaStatus"] })}
            className={selectClass}
          >
            <option value="">SLA: any</option>
            {SLA_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === "overdue" ? "Overdue" : s === "at-risk" ? "At risk" : "On track"}
              </option>
            ))}
          </select>

          <select
            data-testid="sup-filter-loanType"
            aria-label="Filter by loan type"
            value={filters.loanType}
            onChange={(event) => patchFilters({ loanType: event.target.value })}
            className={selectClass}
          >
            <option value="">Loan type: any</option>
            {LOAN_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {LOAN_TYPE_LABELS[t]}
              </option>
            ))}
          </select>

          <select
            data-testid="sup-filter-pendingApprovalLevel"
            aria-label="Filter by pending approval level"
            value={filters.pendingApprovalLevel}
            onChange={(event) =>
              patchFilters({
                pendingApprovalLevel: event.target.value as Filters["pendingApprovalLevel"],
              })
            }
            className={selectClass}
          >
            <option value="">Pending level: any</option>
            <option value="1">Pending Level-1</option>
            <option value="2">Pending Level-2</option>
          </select>

          {/* needs-my-Level-2 pill (frame) — viewer-relative eligibility */}
          <button
            type="button"
            data-testid="sup-filter-needsMyLevel2"
            aria-pressed={filters.needsMyLevel2}
            onClick={() => patchFilters({ needsMyLevel2: !filters.needsMyLevel2 })}
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors duration-200 ${
              filters.needsMyLevel2
                ? "bg-navy text-white"
                : "border border-line bg-card text-ink-soft hover:text-ink"
            }`}
          >
            Needs my Level-2
          </button>

          <input
            type="search"
            data-testid="sup-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search app #, borrower, city…"
            aria-label="Search by application number, borrower name, or property city"
            className="ml-auto w-60 rounded-md border border-line bg-card px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
          />
        </div>

        {/* Date range (§4.6.1 submitted date range — span ≤ 1096 days server-side) */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          <label className="flex items-center gap-1.5">
            Submitted from
            <input
              type="date"
              data-testid="sup-filter-submittedFrom"
              value={filters.submittedFrom}
              onChange={(event) => patchFilters({ submittedFrom: event.target.value })}
              className={selectClass}
            />
          </label>
          <label className="flex items-center gap-1.5">
            to
            <input
              type="date"
              data-testid="sup-filter-submittedTo"
              value={filters.submittedTo}
              onChange={(event) => patchFilters({ submittedTo: event.target.value })}
              className={selectClass}
            />
          </label>
          {filterCount > 0 ? (
            <button
              type="button"
              data-testid="sup-filter-clear-all"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
              }}
              className="ml-auto rounded-md border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft transition-colors duration-200 hover:border-navy hover:text-navy"
            >
              Clear filters ({filterCount})
            </button>
          ) : null}
        </div>
      </div>

      {/* ---------------- Bulk action bar ---------------- */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="bulk-assign-btn"
          disabled={selected.size === 0}
          onClick={() => setDialog({ kind: "bulk" })}
          className="rounded-md border border-line bg-card px-3.5 py-1.5 text-sm font-semibold text-ink transition-colors duration-200 hover:border-navy hover:text-navy disabled:cursor-not-allowed disabled:opacity-40"
        >
          Bulk assign{selected.size > 0 ? ` (${selected.size} selected)` : ""}
        </button>
        <button
          type="button"
          data-testid="auto-assign-btn"
          onClick={() =>
            setDialog({
              kind: "auto",
              applicationIds: selected.size > 0 ? [...selected] : null,
            })
          }
          className="rounded-md border border-line bg-card px-3.5 py-1.5 text-sm font-semibold text-ink transition-colors duration-200 hover:border-navy hover:text-navy"
        >
          Auto-assign — workload balanced{selected.size > 0 ? ` (${selected.size} selected)` : " (all unassigned)"}
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-sm text-ink-soft">
          Page size
          <select
            data-testid="sup-page-size"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
            className={selectClass}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ---------------- Table ---------------- */}
      <div className="mt-3 overflow-hidden rounded-lg border border-line bg-card shadow-sm">
        {loading && !data ? (
          <div className="p-4">
            <SkeletonBlock className="h-64 w-full" />
          </div>
        ) : loadError ? (
          <div
            role="alert"
            data-testid="sup-load-error"
            className="m-4 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
          >
            {loadError.message}
            {loadError.details?.length ? (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {loadError.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : data && rows.length === 0 ? (
          <p data-testid="sup-empty" className="px-6 py-10 text-center text-sm text-ink-soft">
            No applications match the current filters.
          </p>
        ) : data ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1280px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="px-3 py-2.5 pl-4">
                      <input
                        type="checkbox"
                        data-testid="bulk-select-all"
                        aria-label="Select all rows on this page"
                        checked={allOnPageSelected}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    {COLUMNS.map((col) => (
                      <th key={col.field} className="whitespace-nowrap px-3 py-2.5">
                        <button
                          type="button"
                          data-testid={`sup-sort-${col.field}`}
                          onClick={() => toggleSort(col.field)}
                          aria-sort={
                            sort === col.field ? (dir === "asc" ? "ascending" : "descending") : undefined
                          }
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider transition-colors duration-200 ${
                            sort === col.field ? "text-copper" : "text-muted hover:text-ink"
                          }`}
                        >
                          {col.label}
                          {sort === col.field ? <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span> : null}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-2.5 pr-4 text-right text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const unassigned = row.assignedCaseworkerName === undefined;
                    const suspendable = SUSPENDABLE_STATES.includes(row.workflowState);
                    const suspended = row.workflowState === "suspended";
                    return (
                      <tr
                        key={row.applicationId}
                        data-testid={`sup-row-${row.applicationId}`}
                        onClick={() => openDetail(row.applicationId)}
                        className="cursor-pointer border-b border-line last:border-b-0 transition-colors duration-200 hover:bg-paper"
                      >
                        <td className="px-3 py-2.5 pl-4" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            data-testid={`bulk-select-${row.applicationId}`}
                            aria-label={`Select ${row.applicationNumber}`}
                            checked={selected.has(row.applicationId)}
                            onChange={() => toggleSelected(row.applicationId)}
                          />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          {/* NFR-025: real link affordance on the primary cell —
                              keyboard reachable and Enter-activated (the row
                              onClick is a mouse convenience only). */}
                          <a
                            href={`/staff/applications/${row.applicationId}`}
                            data-testid={`sup-open-${row.applicationId}`}
                            aria-label={`Open application ${row.applicationNumber}`}
                            onClick={(event) => event.stopPropagation()}
                            className="rounded-sm font-semibold text-navy underline-offset-2 transition-colors duration-200 hover:text-copper hover:underline focus:outline-none focus:ring-2 focus:ring-navy/40"
                          >
                            {row.applicationNumber}
                          </a>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink">{row.borrowerDisplayName}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink">{formatCurrency(row.loanAmount)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">
                          {row.loanType ? (LOAN_TYPE_LABELS[row.loanType] ?? humanizeEnum(row.loanType)) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">{formatDate(row.submittedAt)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <StateBadge state={row.workflowState} label={row.workflowStateLabel} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5" onClick={(event) => event.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            <PriorityBadge priority={row.priority} testId={`sup-priority-badge-${row.applicationId}`} />
                            <select
                              data-testid={`priority-select-${row.applicationId}`}
                              aria-label={`Override priority of ${row.applicationNumber}`}
                              value={row.priority}
                              disabled={rowBusy === row.applicationId}
                              onChange={(event) => void overridePriority(row, event.target.value as Priority)}
                              className="rounded border border-line bg-card px-1 py-0.5 text-xs text-ink-soft focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/20"
                            >
                              {PRIORITY_VALUES.map((p) => (
                                <option key={p} value={p}>
                                  {humanizeEnum(p)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <SlaBadge slaStatus={row.slaStatus} testId={`sup-sla-badge-${row.applicationId}`} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink">{row.daysInState}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">{formatDate(row.lastActivityAt)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          {row.openFraudFlagCount ? (
                            <span className="inline-block whitespace-nowrap rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-semibold text-danger">
                              {row.openFraudFlagCount} open
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-ink">
                          {row.assignedCaseworkerName ?? <span className="text-ink-soft">Unassigned</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          {row.approvalStatus ? (
                            <span
                              data-testid={`sup-approval-status-${row.applicationId}`}
                              className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                                row.approvalStatus.startsWith("Needs")
                                  ? "bg-copper-soft text-copper"
                                  : "bg-gray-soft text-ink-soft"
                              }`}
                            >
                              {row.approvalStatus}
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td
                          className="whitespace-nowrap px-3 py-2.5 pr-4 text-right"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="flex justify-end gap-1.5">
                            {unassigned && row.workflowState !== "draft" ? (
                              <button
                                type="button"
                                data-testid={`assign-btn-${row.applicationId}`}
                                onClick={() => setDialog({ kind: "assign", app: row, mode: "manual" })}
                                className="rounded-md border border-navy/40 px-2.5 py-1 text-xs font-semibold text-navy transition-colors duration-200 hover:border-navy hover:bg-navy/5"
                              >
                                Assign
                              </button>
                            ) : null}
                            {!unassigned ? (
                              <button
                                type="button"
                                data-testid={`reassign-btn-${row.applicationId}`}
                                onClick={() => setDialog({ kind: "assign", app: row, mode: "reassign" })}
                                className="rounded-md border border-navy/40 px-2.5 py-1 text-xs font-semibold text-navy transition-colors duration-200 hover:border-navy hover:bg-navy/5"
                              >
                                Reassign
                              </button>
                            ) : null}
                            {suspendable ? (
                              <button
                                type="button"
                                data-testid={`suspend-btn-${row.applicationId}`}
                                onClick={() => setDialog({ kind: "suspend", app: row })}
                                className="rounded-md border border-danger/40 px-2.5 py-1 text-xs font-semibold text-danger transition-colors duration-200 hover:border-danger hover:bg-danger-soft"
                              >
                                Suspend
                              </button>
                            ) : null}
                            {suspended ? (
                              <button
                                type="button"
                                data-testid={`resume-btn-${row.applicationId}`}
                                disabled={rowBusy === row.applicationId}
                                onClick={() => void resume(row)}
                                className="rounded-md bg-navy px-2.5 py-1 text-xs font-semibold text-white transition-colors duration-200 hover:bg-navy-deep disabled:opacity-50"
                              >
                                {rowBusy === row.applicationId ? "Resuming…" : "Resume"}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationBar
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
              testIdPrefix="sup-page"
            />
          </>
        ) : null}
      </div>

      <p className="mt-3 text-xs text-muted">
        Filters auto-apply. Paginated with a server-enforced maximum page size. Bulk and
        auto-assignment report per-application success or conflict.
      </p>

      {/* ---------------- Dialogs ---------------- */}
      {dialog?.kind === "assign" ? (
        <AssignDialog
          app={dialog.app}
          mode={dialog.mode}
          caseworkers={staff}
          onClose={() => setDialog(null)}
          onDone={(message) => void afterMutation(message)}
        />
      ) : null}
      {dialog?.kind === "bulk" ? (
        <BulkAssignDialog
          applicationIds={[...selected]}
          numberById={numberById}
          caseworkers={staff}
          onClose={(didAssign) => {
            setDialog(null);
            if (didAssign) void afterMutation();
          }}
        />
      ) : null}
      {dialog?.kind === "auto" ? (
        <AutoAssignDialog
          applicationIds={dialog.applicationIds}
          numberById={numberById}
          onClose={(didAssign) => {
            setDialog(null);
            if (didAssign) void afterMutation();
          }}
        />
      ) : null}
      {dialog?.kind === "suspend" ? (
        <SuspendDialog
          app={dialog.app}
          onClose={() => setDialog(null)}
          onDone={(message) => void afterMutation(message)}
        />
      ) : null}

      {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} testId="sup-toast" /> : null}
    </div>
  );
}
