// Caseworker queue + stats + completion history service (task-028) —
// REQ-047, REQ-048, REQ-003, DATA-004, NFR-023, SEC-22 / S-2.
//
// Serves the four §B endpoints owned by this task:
//   GET /api/queue/unassigned    → QueuePage   (caseworker, supervisor)
//   GET /api/queue/mine          → QueuePage   (caseworker, supervisor)
//   GET /api/caseworker/stats    → CaseworkerStats        (caseworker)
//   GET /api/caseworker/history  → CompletionHistoryPage  (caseworker)
//
// RECORD-LEVEL SCOPING (SEC-22 / S-2): unassigned rows are the QueueRow summary
// projection ONLY — serializeQueueRow emits exactly the §A QueueRow caseworker
// fields (applicationId, applicationNumber, borrowerDisplayName, loanAmount,
// loanType, submittedAt, workflowState, workflowStateLabel, priority,
// slaStatus, daysInState, lastActivityAt, openFraudFlagCount) and NOTHING more.
// assignedCaseworkerName / approvalStatus are "Supervisor list only" (§A) and
// belong to the task-031 supervisor list — this service never emits them.
// /api/queue/mine is WHERE-scoped to the SESSION user's active assignments —
// never a client-supplied caseworker id.
//
// TABS (§4.4.1):
//   Unassigned — no active assignment AND workflowState in CLAIMABLE_STATES.
//   My Queue   — active assignment held by the session user AND not terminal
//                (terminal = withdrawn / declined_by_borrower, plus
//                borrower_notified once an outcome is recorded — INV-033, the
//                same reading as the task-022 workload counter).
//
// SORT: default = Overdue first, then priority urgent→low, then At-risk, then
// oldest submission first (§B / AC-23). slaStatus and daysInState are COMPUTED
// (task-021 engine, WALK-003 batched), so ordering/pagination run over the full
// filtered candidate set in memory: one row query + one batched history query +
// one fraud-flag groupBy per request. Column sort via ?sort=<QueueRow field>&
// dir=asc|desc (sortable fields = the §4.4.1 columns); invalid values are the
// contract's 400 validation error; unknown query params are ignored (the
// established GET /api/applications convention).
//
// DOCUMENTED INTERPRETATIONS (contract-silent points):
//   - daysInState: whole calendar days (company time zone) since
//     Application.stateEnteredAt — the live "current state" clock the engine
//     resets on every transition.
//   - lastActivityAt: Application.updatedAt (any persisted write to the
//     application touches it).
//   - slaStatus for states with no per-state SLA target (e.g. approved/denied
//     awaiting SYS notification in My Queue): "on-track" — QueueRow.slaStatus
//     is required, and a state with no clock cannot be at risk or overdue.
//   - stats "completed this month": final DECISIONS (outcome recorded) in the
//     current calendar month (company TZ) on applications whose decision moment
//     my assignment covered (the §4.4.2 "applications I held" reading already
//     established by task-022's completions90d).
//   - history "processed to a final decision or terminal state": decisions
//     (outcome + decidedAt) plus terminal states (withdrawn /
//     declined_by_borrower, dated by entry into the terminal state);
//     outcomeLabel falls back to the state label for outcome-less terminal
//     rows; daysToDecision = calendar days submission → completion.

import type { Prisma, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { pageEnvelope, type PageEnvelope, type Pagination } from "@/lib/http/pagination";
import { CLAIMABLE_STATES } from "@/lib/guard";
import { TERMINAL_STATES, workflowStateLabel } from "@/lib/pure/workflow";
import { calendarDaysBetween } from "@/lib/pure/sla";
import {
  computeSlaForApplications,
  getCompanyTimeZone,
  refreshAutomaticPriority,
  type SlaComputation,
} from "@/lib/services/sla";

// ---------------------------------------------------------------------------
// Wire shapes (contracts.json — field names verbatim)
// ---------------------------------------------------------------------------

/** contracts.json models.QueueRow — caseworker projection (no supervisor-only fields). */
export interface QueueRowWire {
  applicationId: string;
  applicationNumber: string;
  borrowerDisplayName: string;
  loanAmount?: number;
  loanType?: string;
  submittedAt?: string;
  workflowState: WorkflowState;
  workflowStateLabel: string;
  priority: string;
  slaStatus: string;
  daysInState: number;
  lastActivityAt?: string;
  openFraudFlagCount?: number;
}

/** contracts.json models.CaseworkerStats. */
export interface CaseworkerStatsWire {
  queueSize: number;
  completedThisMonth: number;
  avgDaysToDecision90d: number;
  approvalRatePct90d: number;
  overdueCount: number;
}

/** contracts.json models.CompletionHistoryRow. */
export interface CompletionHistoryRowWire {
  applicationId: string;
  applicationNumber: string;
  outcomeLabel: string;
  daysToDecision: number;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Query parameters (?sort&dir&search — §B)
// ---------------------------------------------------------------------------

/** Sortable fields = the §4.4.1 queue columns, named by their QueueRow field. */
export const QUEUE_SORT_FIELDS = [
  "applicationNumber",
  "borrowerDisplayName",
  "loanAmount",
  "loanType",
  "submittedAt",
  "workflowState",
  "priority",
  "slaStatus",
  "daysInState",
  "lastActivityAt",
  "openFraudFlagCount",
] as const;

export type QueueSortField = (typeof QUEUE_SORT_FIELDS)[number];

export interface QueueListParams {
  sort: QueueSortField | null;
  dir: "asc" | "desc";
  search: string | null;
}

/**
 * Parse ?sort&dir&search. Invalid sort/dir VALUES are the contract's 400
 * validation error; unknown query params are ignored (GET /api/applications
 * convention). Throws HttpProblem — routes map it via problemResponse.
 */
export function parseQueueListParams(request: Request): QueueListParams {
  const params = new URL(request.url).searchParams;
  const details: string[] = [];

  const sortRaw = params.get("sort");
  let sort: QueueSortField | null = null;
  if (sortRaw !== null && sortRaw !== "") {
    if ((QUEUE_SORT_FIELDS as readonly string[]).includes(sortRaw)) {
      sort = sortRaw as QueueSortField;
    } else {
      details.push(`sort: "${sortRaw}" is not a sortable queue column`);
    }
  }

  const dirRaw = params.get("dir");
  let dir: "asc" | "desc" = "asc";
  if (dirRaw !== null && dirRaw !== "") {
    if (dirRaw === "asc" || dirRaw === "desc") dir = dirRaw;
    else details.push(`dir: must be "asc" or "desc"`);
  }

  if (details.length > 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details,
    });
  }

  const searchRaw = params.get("search");
  const search = searchRaw && searchRaw.trim().length > 0 ? searchRaw.trim() : null;
  return { sort, dir, search };
}

// ---------------------------------------------------------------------------
// Candidate loading + row building
// ---------------------------------------------------------------------------

/**
 * Exported for the task-031 supervisor list service (supervisor-list.ts),
 * which builds on the same candidate slice + row builder and ADDS the two
 * supervisor-only §A QueueRow fields on its own supervisor-gated endpoint.
 */
export const QUEUE_SELECT = {
  id: true,
  applicationNumber: true,
  workflowState: true,
  previousStateForSuspend: true,
  stateEnteredAt: true,
  slaPausedAt: true,
  submittedAt: true,
  decidedAt: true,
  priority: true,
  priorityOverride: true,
  updatedAt: true,
  borrowerUser: { select: { firstName: true, lastName: true } },
  borrowers: {
    where: { ordinal: 1 },
    select: { firstName: true, lastName: true },
    take: 1,
  },
  data: { select: { subjectProperty: true, loan: true } },
} satisfies Prisma.ApplicationSelect;

export type QueueCandidate = Prisma.ApplicationGetPayload<{ select: typeof QUEUE_SELECT }>;

export const LOAN_TYPE_VALUES = ["conventional", "fha", "va", "usda"] as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const SLA_RANK: Record<string, number> = { overdue: 0, "at-risk": 1, "on-track": 2 };

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Primary borrower name; falls back to the owning account's name (never blank). */
function borrowerDisplayName(row: QueueCandidate): string {
  const b = row.borrowers[0];
  const fromBorrower = b ? `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() : "";
  if (fromBorrower.length > 0) return fromBorrower;
  return `${row.borrowerUser.firstName} ${row.borrowerUser.lastName}`.trim();
}

/**
 * Build one wire row from the candidate + computed SLA + open-flag count.
 * SEC-22: this is the ONLY queue serializer — it emits exactly the §A QueueRow
 * caseworker fields, nothing more (no identity/contact/asset/liability detail,
 * no supervisor-only fields).
 */
export function buildQueueRow(
  row: QueueCandidate,
  priority: string,
  sla: SlaComputation | undefined,
  openFlagCount: number,
  now: Date,
  /** Company zone, resolved by the caller at call time (INV-045). */
  timeZone: string,
): QueueRowWire {
  const loan = asRecord(row.data?.loan);
  const loanAmount =
    typeof loan?.requestedLoanAmount === "number" ? loan.requestedLoanAmount : undefined;
  const loanTypeRaw = typeof loan?.loanType === "string" ? loan.loanType : undefined;
  const loanType = (LOAN_TYPE_VALUES as readonly string[]).includes(loanTypeRaw ?? "")
    ? loanTypeRaw
    : undefined;

  const wire: QueueRowWire = {
    applicationId: row.id,
    applicationNumber: row.applicationNumber,
    borrowerDisplayName: borrowerDisplayName(row),
    workflowState: row.workflowState,
    workflowStateLabel: workflowStateLabel(row.workflowState),
    priority,
    // Required field; states with no per-state SLA clock report "on-track"
    // (see module header interpretation).
    slaStatus: sla?.slaStatus ?? "on-track",
    daysInState: Math.max(0, calendarDaysBetween(row.stateEnteredAt, now, timeZone)),
    lastActivityAt: row.updatedAt.toISOString(),
    openFraudFlagCount: openFlagCount,
  };
  if (loanAmount !== undefined) wire.loanAmount = loanAmount;
  if (loanType !== undefined) wire.loanType = loanType;
  if (row.submittedAt) wire.submittedAt = row.submittedAt.toISOString();
  return wire;
}

/**
 * Default queue order (§B / §4.4.1 / AC-23): Overdue first, then priority
 * urgent→low, then At-risk, then oldest submission first.
 */
export function defaultCompare(a: QueueRowWire, b: QueueRowWire): number {
  const overdue = (a.slaStatus === "overdue" ? 0 : 1) - (b.slaStatus === "overdue" ? 0 : 1);
  if (overdue !== 0) return overdue;
  const priority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (priority !== 0) return priority;
  const sla = (SLA_RANK[a.slaStatus] ?? 9) - (SLA_RANK[b.slaStatus] ?? 9);
  if (sla !== 0) return sla;
  const aSub = a.submittedAt ? Date.parse(a.submittedAt) : Number.MAX_SAFE_INTEGER;
  const bSub = b.submittedAt ? Date.parse(b.submittedAt) : Number.MAX_SAFE_INTEGER;
  return aSub - bSub;
}

/** Column sort: enum-ranked for priority/slaStatus, label-based for state, natural otherwise. */
export function columnCompare(field: QueueSortField, a: QueueRowWire, b: QueueRowWire): number {
  switch (field) {
    case "priority":
      return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    case "slaStatus":
      return (SLA_RANK[a.slaStatus] ?? 9) - (SLA_RANK[b.slaStatus] ?? 9);
    case "workflowState":
      return a.workflowStateLabel.localeCompare(b.workflowStateLabel);
    case "loanAmount":
      return (a.loanAmount ?? -1) - (b.loanAmount ?? -1);
    case "daysInState":
      return a.daysInState - b.daysInState;
    case "openFraudFlagCount":
      return (a.openFraudFlagCount ?? 0) - (b.openFraudFlagCount ?? 0);
    case "submittedAt":
      return (
        (a.submittedAt ? Date.parse(a.submittedAt) : 0) -
        (b.submittedAt ? Date.parse(b.submittedAt) : 0)
      );
    case "lastActivityAt":
      return (
        (a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0) -
        (b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0)
      );
    case "applicationNumber":
      return a.applicationNumber.localeCompare(b.applicationNumber);
    case "borrowerDisplayName":
      return a.borrowerDisplayName.localeCompare(b.borrowerDisplayName);
    case "loanType":
      return (a.loanType ?? "").localeCompare(b.loanType ?? "");
  }
}

/**
 * Shared tail of both queue endpoints: enrich candidates (live SLA batch +
 * read-time automatic-priority refresh + open-flag counts), filter by search,
 * sort, and paginate. LIVE-STATE: every row field is derived from the loaded
 * records / SystemConfig-driven SLA computation at call time.
 */
async function buildQueuePage(
  candidates: QueueCandidate[],
  params: QueueListParams,
  pagination: Pagination,
  now: Date,
): Promise<PageEnvelope<QueueRowWire>> {
  const slaById = await computeSlaForApplications(candidates, now);
  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time

  // Open fraud-flag counts (task-027 queue-row seam) — one groupBy for the set.
  const flagCounts = new Map<string, number>();
  if (candidates.length > 0) {
    const groups = await prisma.fraudFlag.groupBy({
      by: ["applicationId"],
      where: { applicationId: { in: candidates.map((c) => c.id) }, status: "open" },
      _count: { _all: true },
    });
    for (const g of groups) flagCounts.set(g.applicationId, g._count._all);
  }

  const rows: QueueRowWire[] = [];
  for (const candidate of candidates) {
    // Read-time automatic priority (§4.4.1 rules; persists only on change,
    // never overwrites a Supervisor override — task-021 engine).
    const priority = await refreshAutomaticPriority(candidate, now);
    rows.push(
      buildQueueRow(
        candidate,
        priority,
        slaById.get(candidate.id),
        flagCounts.get(candidate.id) ?? 0,
        now,
        timeZone,
      ),
    );
  }

  // Text filter by application number or borrower name (§4.4.1).
  let filtered = rows;
  if (params.search) {
    const needle = params.search.toLowerCase();
    filtered = rows.filter(
      (r) =>
        r.applicationNumber.toLowerCase().includes(needle) ||
        r.borrowerDisplayName.toLowerCase().includes(needle),
    );
  }

  if (params.sort) {
    const field = params.sort;
    const sign = params.dir === "desc" ? -1 : 1;
    filtered.sort((a, b) => sign * columnCompare(field, a, b));
  } else {
    filtered.sort(defaultCompare);
  }

  const pageRows = filtered.slice(pagination.skip, pagination.skip + pagination.take);
  return pageEnvelope(pageRows, pagination, filtered.length);
}

// ---------------------------------------------------------------------------
// GET /api/queue/unassigned — QueuePage (SEC-22 summary rows only)
// ---------------------------------------------------------------------------

export async function listUnassignedQueue(
  params: QueueListParams,
  pagination: Pagination,
  now: Date = new Date(),
): Promise<PageEnvelope<QueueRowWire>> {
  const candidates = await prisma.application.findMany({
    where: {
      workflowState: { in: [...CLAIMABLE_STATES] },
      assignments: { none: { endedAt: null } },
    },
    select: QUEUE_SELECT,
  });
  return buildQueuePage(candidates, params, pagination, now);
}

// ---------------------------------------------------------------------------
// GET /api/queue/mine — QueuePage scoped to the SESSION user's assignments
// ---------------------------------------------------------------------------

/** Prisma WHERE for "my active, non-terminal queue" (see module header). */
function myQueueWhere(user: SessionUser): Prisma.ApplicationWhereInput {
  return {
    assignments: { some: { caseworkerUserId: user.userId, endedAt: null } },
    workflowState: { notIn: [...TERMINAL_STATES] },
    // borrower_notified with a recorded outcome is terminal (INV-033).
    NOT: { workflowState: "borrower_notified", outcome: { not: null } },
  };
}

export async function listMyQueue(
  user: SessionUser,
  params: QueueListParams,
  pagination: Pagination,
  now: Date = new Date(),
): Promise<PageEnvelope<QueueRowWire>> {
  const candidates = await prisma.application.findMany({
    where: myQueueWhere(user), // SESSION scoping — never a client-supplied id
    select: QUEUE_SELECT,
  });
  return buildQueuePage(candidates, params, pagination, now);
}

// ---------------------------------------------------------------------------
// GET /api/caseworker/stats — CaseworkerStats
// ---------------------------------------------------------------------------

/**
 * Month formatters, cached per zone — the company zone is configurable
 * (INV-045), so the formatter can no longer be a module constant.
 */
const MONTH_FORMATS = new Map<string, Intl.DateTimeFormat>();

function monthFormat(timeZone: string): Intl.DateTimeFormat {
  let fmt = MONTH_FORMATS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" });
    MONTH_FORMATS.set(timeZone, fmt);
  }
  return fmt;
}

/** "YYYY-MM"-style key of an instant's calendar month in the company time zone. */
function monthKey(instant: Date, timeZone: string): string {
  return monthFormat(timeZone).format(instant);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

interface HeldDecision {
  applicationId: string;
  submittedAt: Date | null;
  decidedAt: Date;
  outcome: string;
}

/**
 * Final decisions (outcome recorded) whose decision moment the caseworker's
 * assignment covered, within [since, now] — the task-022 "applications I held"
 * reading, one count per application.
 */
async function heldDecisions(userId: string, since: Date, now: Date): Promise<HeldDecision[]> {
  const rows = await prisma.caseworkerAssignment.findMany({
    where: {
      caseworkerUserId: userId,
      application: { decidedAt: { gte: since, lte: now }, outcome: { not: null } },
    },
    select: {
      assignedAt: true,
      endedAt: true,
      application: {
        select: { id: true, submittedAt: true, decidedAt: true, outcome: true },
      },
    },
  });

  const byApp = new Map<string, HeldDecision>();
  for (const row of rows) {
    const { id, submittedAt, decidedAt, outcome } = row.application;
    if (!decidedAt || !outcome || byApp.has(id)) continue;
    const covers =
      row.assignedAt.getTime() <= decidedAt.getTime() &&
      (row.endedAt === null || row.endedAt.getTime() >= decidedAt.getTime());
    if (covers) byApp.set(id, { applicationId: id, submittedAt, decidedAt, outcome });
  }
  return [...byApp.values()];
}

export async function caseworkerStats(
  user: SessionUser,
  now: Date = new Date(),
): Promise<CaseworkerStatsWire> {
  // Queue size + overdue count from the live My Queue set (same definition as
  // the tab, so the strip always matches what the table shows).
  const queueApps = await prisma.application.findMany({
    where: myQueueWhere(user),
    select: {
      id: true,
      workflowState: true,
      previousStateForSuspend: true,
      stateEnteredAt: true,
      slaPausedAt: true,
      submittedAt: true,
      decidedAt: true,
    },
  });
  const slaById = await computeSlaForApplications(queueApps, now);
  let overdueCount = 0;
  for (const app of queueApps) {
    if (slaById.get(app.id)?.slaStatus === "overdue") overdueCount += 1;
  }

  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const decisions90d = await heldDecisions(user.userId, ninetyDaysAgo, now);

  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time
  const thisMonth = monthKey(now, timeZone);
  const completedThisMonth = decisions90d.filter(
    (d) => monthKey(d.decidedAt, timeZone) === thisMonth,
  ).length;

  let avgDaysToDecision90d = 0;
  if (decisions90d.length > 0) {
    const totalDays = decisions90d.reduce(
      (sum, d) =>
        sum +
        (d.submittedAt
          ? Math.max(0, calendarDaysBetween(d.submittedAt, d.decidedAt, timeZone))
          : 0),
      0,
    );
    avgDaysToDecision90d = round1(totalDays / decisions90d.length);
  }

  const approvals = decisions90d.filter((d) => d.outcome === "approved").length;
  const approvalRatePct90d =
    decisions90d.length > 0 ? round1((approvals / decisions90d.length) * 100) : 0;

  return {
    queueSize: queueApps.length,
    completedThisMonth,
    avgDaysToDecision90d,
    approvalRatePct90d,
    overdueCount,
  };
}

// ---------------------------------------------------------------------------
// GET /api/caseworker/history — CompletionHistoryPage (12-month window fixed
// server-side; offset-limit max 100)
// ---------------------------------------------------------------------------

const OUTCOME_LABELS: Record<string, string> = {
  approved: "Approved",
  denied: "Denied",
};

export async function caseworkerHistory(
  user: SessionUser,
  pagination: Pagination,
  now: Date = new Date(),
): Promise<PageEnvelope<CompletionHistoryRowWire>> {
  // Fixed 12-calendar-month window — never client-supplied (§B).
  const windowStart = new Date(now);
  windowStart.setUTCMonth(windowStart.getUTCMonth() - 12);

  const rows = await prisma.caseworkerAssignment.findMany({
    where: {
      caseworkerUserId: user.userId,
      application: {
        OR: [
          { outcome: { not: null }, decidedAt: { gte: windowStart, lte: now } },
          { workflowState: { in: [...TERMINAL_STATES] } },
        ],
      },
    },
    select: {
      assignedAt: true,
      endedAt: true,
      application: {
        select: {
          id: true,
          applicationNumber: true,
          submittedAt: true,
          decidedAt: true,
          outcome: true,
          workflowState: true,
          stateEnteredAt: true,
        },
      },
    },
  });

  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time
  const byApp = new Map<string, CompletionHistoryRowWire>();
  for (const row of rows) {
    const app = row.application;
    if (byApp.has(app.id)) continue;

    // Completion moment: the recorded decision, else entry into the terminal
    // state (withdrawn / declined_by_borrower carry no outcome).
    const isDecision = app.outcome !== null && app.decidedAt !== null;
    const isTerminal = TERMINAL_STATES.includes(app.workflowState);
    if (!isDecision && !isTerminal) continue;
    const completedAt = isDecision ? app.decidedAt! : app.stateEnteredAt;
    if (completedAt.getTime() < windowStart.getTime() || completedAt.getTime() > now.getTime()) {
      continue;
    }

    // "I processed" — my assignment covered the completion moment.
    const covers =
      row.assignedAt.getTime() <= completedAt.getTime() &&
      (row.endedAt === null || row.endedAt.getTime() >= completedAt.getTime());
    if (!covers) continue;

    const outcomeLabel = app.outcome
      ? OUTCOME_LABELS[app.outcome]
      : workflowStateLabel(app.workflowState);

    byApp.set(app.id, {
      applicationId: app.id,
      applicationNumber: app.applicationNumber,
      outcomeLabel,
      daysToDecision: app.submittedAt
        ? Math.max(0, calendarDaysBetween(app.submittedAt, completedAt, timeZone))
        : 0,
      decidedAt: completedAt.toISOString(),
    });
  }

  const all = [...byApp.values()].sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
  const pageRows = all.slice(pagination.skip, pagination.skip + pagination.take);
  return pageEnvelope(pageRows, pagination, all.length);
}
