// Supervisor all-applications list service (task-031) — REQ-055, NFR-024,
// NFR-015, DATA-004.
//
// Serves GET /api/supervisor/applications → §A SupervisorApplicationPage
// (rows: QueueRow[] WITH the supervisor-only fields assignedCaseworkerName /
// approvalStatus; cards: SupervisorSummaryCards; offset-limit max 100; date
// span ≤ 1096 days validated BEFORE querying → 400 VALIDATION_ERROR).
//
// Query parameters (§B, all auto-applying):
//   ?states=<csv>&caseworkerId=<uuid|unassigned>&priority=&slaStatus=&
//   loanType=&submittedFrom=&submittedTo=&pendingApprovalLevel=1|2&
//   needsMyLevel2=true&search=&sort=&dir=&page&pageSize
//
// FILTER STRATEGY: states / caseworker / submitted date range /
// pendingApprovalLevel / needsMyLevel2 state-narrowing push down to indexed
// Prisma WHERE clauses (workflowState, submittedAt, the partial-unique active
// assignment); priority / slaStatus are COMPUTED at read time (task-021
// engine) and loanType / property city live in the JSON data document, so
// those four — plus text search — filter in memory over the enriched rows,
// the same enrichment pattern as the task-028 queue service (one row query +
// one batched history query + one fraud-flag groupBy + one approval-record
// batch per request).
//
// needs-my-Level-2 (§4.6.1 / FLOW-008): applications PENDING a Level-2
// decision (workflowState escalated_review) where the CURRENT supervisor is an
// ELIGIBLE different approver — the INV-001 rule is NOT re-derived here: the
// latest level-1 ApprovalRecord for the application's currentVersionNumber is
// evaluated through approval.ts evaluateLevel2DecisionEligibility (the same
// rule the decision gate's resolveRoute enforces).
//
// DOCUMENTED INTERPRETATIONS (contract-silent points):
//   - Summary cards are POPULATION-WIDE (whole book of business), not filtered
//     by the current filter set — they are the frame's at-a-glance strip; the
//     table below is what the filters narrow.
//   - Card buckets are disjoint (frame totals sum to Total): draft = state
//     draft; pendingApproval = preliminary_decision + escalated_review
//     (§4.6.1); approved / denied = recorded outcome (covers approved/denied +
//     borrower_notified); withdrawn = withdrawn + declined_by_borrower (both
//     borrower-terminated); inUnderwriting = everything else (submitted,
//     in-flight, undecided). thisMonth = applications SUBMITTED in the current
//     calendar month (company time zone).
//   - approvalStatus (supervisor-only QueueRow field): "Needs Level-1" in
//     preliminary_decision; "Needs Level-2 · eligible" / "Needs Level-2 · you
//     recorded Level-1" / "Needs Level-2" (no valid L1 approve) in
//     escalated_review — VIEWER-relative per the frame's eligible chip;
//     "Conditionally approved" in conditional_approval; "Approved"/"Denied"
//     once an outcome is recorded; absent otherwise (frame renders "—").
//   - Date filters accept YYYY-MM-DD or full ISO datetimes; a bare date is
//     inclusive of the whole day on the `submittedTo` side. The 1096-day span
//     rule applies when both bounds are present; from > to is a 400.
//   - Sortable fields = the queue columns plus the two supervisor columns
//     (assignedCaseworkerName, approvalStatus).

import type { Prisma, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { pageEnvelope, type PageEnvelope, type Pagination } from "@/lib/http/pagination";
import { TERMINAL_STATES } from "@/lib/pure/workflow";
import {
  computeSlaForApplications,
  getCompanyTimeZone,
  refreshAutomaticPriority,
} from "@/lib/services/sla";
import {
  LOAN_TYPE_VALUES,
  QUEUE_SELECT,
  QUEUE_SORT_FIELDS,
  buildQueueRow,
  columnCompare,
  defaultCompare,
  type QueueRowWire,
  type QueueSortField,
} from "@/lib/services/queue";
import { evaluateLevel2DecisionEligibility } from "@/lib/services/approval";

// ---------------------------------------------------------------------------
// Wire shapes (contracts.json — field names verbatim)
// ---------------------------------------------------------------------------

/** contracts.json models.QueueRow — full supervisor projection (§A: the two
 *  extra fields are "Supervisor list only"). */
export interface SupervisorQueueRowWire extends QueueRowWire {
  assignedCaseworkerName?: string;
  approvalStatus?: string;
}

/** contracts.json models.SupervisorSummaryCards. */
export interface SupervisorSummaryCardsWire {
  total: number;
  draft: number;
  inUnderwriting: number;
  pendingApproval: number;
  approved: number;
  denied: number;
  withdrawn: number;
  thisMonth: number;
}

/** contracts.json models.SupervisorApplicationPage. */
export interface SupervisorApplicationPageWire extends PageEnvelope<SupervisorQueueRowWire> {
  cards: SupervisorSummaryCardsWire;
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

const WORKFLOW_STATE_VALUES: readonly WorkflowState[] = [
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

const PRIORITY_VALUES = ["urgent", "high", "normal", "low"] as const;
const SLA_STATUS_VALUES = ["on-track", "at-risk", "overdue"] as const;

/** §B: span ≤ 1096d (contracts.json maxDateSpanDays — NFR-015). */
export const MAX_DATE_SPAN_DAYS = 1096;

const SUPERVISOR_SORT_FIELDS = [
  ...QUEUE_SORT_FIELDS,
  "assignedCaseworkerName",
  "approvalStatus",
] as const;

export type SupervisorSortField = (typeof SUPERVISOR_SORT_FIELDS)[number];

export interface SupervisorListParams {
  states: WorkflowState[] | null;
  /** User.id, or the literal "unassigned". */
  caseworkerId: string | null;
  priority: (typeof PRIORITY_VALUES)[number] | null;
  slaStatus: (typeof SLA_STATUS_VALUES)[number] | null;
  loanType: (typeof LOAN_TYPE_VALUES)[number] | null;
  submittedFrom: Date | null;
  submittedTo: Date | null;
  pendingApprovalLevel: 1 | 2 | null;
  needsMyLevel2: boolean;
  search: string | null;
  sort: SupervisorSortField | null;
  dir: "asc" | "desc";
}

/** Parse a date filter value: bare YYYY-MM-DD or full ISO datetime (UTC). */
function parseDateParam(raw: string, endOfDay: boolean): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const instant = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Parse and validate every query parameter. Invalid VALUES — unknown enum
 * literals, malformed dates, from > to, span > 1096 days — are the contract's
 * 400 validation error, raised BEFORE any data query. Unknown query params are
 * ignored (the established GET /api/applications convention).
 */
export function parseSupervisorListParams(request: Request): SupervisorListParams {
  const params = new URL(request.url).searchParams;
  const details: string[] = [];

  let states: WorkflowState[] | null = null;
  const statesRaw = params.get("states");
  if (statesRaw !== null && statesRaw.trim() !== "") {
    const items = statesRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const bad = items.filter((s) => !(WORKFLOW_STATE_VALUES as readonly string[]).includes(s));
    if (bad.length > 0) {
      details.push(`states: unknown workflow state(s) ${bad.join(", ")}`);
    } else if (items.length > 0) {
      states = items as WorkflowState[];
    }
  }

  const caseworkerRaw = params.get("caseworkerId");
  const caseworkerId = caseworkerRaw && caseworkerRaw.trim() !== "" ? caseworkerRaw.trim() : null;

  function enumParam<T extends string>(name: string, allowed: readonly T[]): T | null {
    const raw = params.get(name);
    if (raw === null || raw.trim() === "") return null;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    details.push(`${name}: must be one of ${allowed.join(", ")}`);
    return null;
  }

  const priority = enumParam("priority", PRIORITY_VALUES);
  const slaStatus = enumParam("slaStatus", SLA_STATUS_VALUES);
  const loanType = enumParam("loanType", LOAN_TYPE_VALUES);

  let submittedFrom: Date | null = null;
  const fromRaw = params.get("submittedFrom");
  if (fromRaw !== null && fromRaw.trim() !== "") {
    submittedFrom = parseDateParam(fromRaw.trim(), false);
    if (!submittedFrom) details.push("submittedFrom: must be an ISO date (YYYY-MM-DD) or datetime");
  }
  let submittedTo: Date | null = null;
  const toRaw = params.get("submittedTo");
  if (toRaw !== null && toRaw.trim() !== "") {
    submittedTo = parseDateParam(toRaw.trim(), true);
    if (!submittedTo) details.push("submittedTo: must be an ISO date (YYYY-MM-DD) or datetime");
  }
  if (submittedFrom && submittedTo) {
    if (submittedFrom.getTime() > submittedTo.getTime()) {
      details.push("submittedFrom: must not be after submittedTo");
    } else {
      const spanDays = (submittedTo.getTime() - submittedFrom.getTime()) / (24 * 60 * 60 * 1000);
      if (spanDays > MAX_DATE_SPAN_DAYS) {
        details.push(
          `submittedFrom/submittedTo: date span must not exceed ${MAX_DATE_SPAN_DAYS} days`,
        );
      }
    }
  }

  let pendingApprovalLevel: 1 | 2 | null = null;
  const levelRaw = params.get("pendingApprovalLevel");
  if (levelRaw !== null && levelRaw.trim() !== "") {
    if (levelRaw === "1" || levelRaw === "2") pendingApprovalLevel = Number(levelRaw) as 1 | 2;
    else details.push("pendingApprovalLevel: must be 1 or 2");
  }

  const needsRaw = params.get("needsMyLevel2");
  let needsMyLevel2 = false;
  if (needsRaw !== null && needsRaw.trim() !== "") {
    if (needsRaw === "true") needsMyLevel2 = true;
    else if (needsRaw !== "false") details.push('needsMyLevel2: must be "true" or "false"');
  }

  const sortRaw = params.get("sort");
  let sort: SupervisorSortField | null = null;
  if (sortRaw !== null && sortRaw !== "") {
    if ((SUPERVISOR_SORT_FIELDS as readonly string[]).includes(sortRaw)) {
      sort = sortRaw as SupervisorSortField;
    } else {
      details.push(`sort: "${sortRaw}" is not a sortable column`);
    }
  }
  const dirRaw = params.get("dir");
  let dir: "asc" | "desc" = "asc";
  if (dirRaw !== null && dirRaw !== "") {
    if (dirRaw === "asc" || dirRaw === "desc") dir = dirRaw;
    else details.push('dir: must be "asc" or "desc"');
  }

  if (details.length > 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details,
    });
  }

  const searchRaw = params.get("search");
  const search = searchRaw && searchRaw.trim().length > 0 ? searchRaw.trim() : null;

  return {
    states,
    caseworkerId,
    priority,
    slaStatus,
    loanType,
    submittedFrom,
    submittedTo,
    pendingApprovalLevel,
    needsMyLevel2,
    search,
    sort,
    dir,
  };
}

// ---------------------------------------------------------------------------
// Candidate loading
// ---------------------------------------------------------------------------

/** QUEUE_SELECT plus the supervisor-only needs: active assignment holder name,
 *  currentVersionNumber (L1 record matching), outcome (approvalStatus). */
const SUPERVISOR_SELECT = {
  ...QUEUE_SELECT,
  currentVersionNumber: true,
  outcome: true,
  assignments: {
    where: { endedAt: null },
    select: { caseworkerUser: { select: { firstName: true, lastName: true } } },
    take: 1,
  },
} satisfies Prisma.ApplicationSelect;

type SupervisorCandidate = Prisma.ApplicationGetPayload<{ select: typeof SUPERVISOR_SELECT }>;

/** Indexed WHERE for the pushdown-able filters (see module header). */
function candidateWhere(params: SupervisorListParams): Prisma.ApplicationWhereInput {
  const and: Prisma.ApplicationWhereInput[] = [];

  if (params.states) and.push({ workflowState: { in: params.states } });
  if (params.pendingApprovalLevel === 1) and.push({ workflowState: "preliminary_decision" });
  if (params.pendingApprovalLevel === 2) and.push({ workflowState: "escalated_review" });
  // needs-my-Level-2 = pending a Level-2 decision (escalated_review); the
  // per-viewer eligibility is applied after the approval-record batch below.
  if (params.needsMyLevel2) and.push({ workflowState: "escalated_review" });

  if (params.caseworkerId === "unassigned") {
    and.push({ assignments: { none: { endedAt: null } } });
  } else if (params.caseworkerId) {
    and.push({ assignments: { some: { endedAt: null, caseworkerUserId: params.caseworkerId } } });
  }

  if (params.submittedFrom || params.submittedTo) {
    const range: Prisma.DateTimeNullableFilter = {};
    if (params.submittedFrom) range.gte = params.submittedFrom;
    if (params.submittedTo) range.lte = params.submittedTo;
    and.push({ submittedAt: range });
  }

  return and.length > 0 ? { AND: and } : {};
}

// ---------------------------------------------------------------------------
// approvalStatus + Level-2 eligibility (INV-001 via approval.ts helper)
// ---------------------------------------------------------------------------

interface EscalatedL1Slice {
  approverUserId: string;
  decision: string;
}

/**
 * Latest level-1 ApprovalRecord per escalated application for that
 * application's currentVersionNumber — ONE batched indexed query (the same
 * record resolveRoute reads per-application inside the decision gate).
 */
async function latestL1ByApplication(
  candidates: SupervisorCandidate[],
): Promise<Map<string, EscalatedL1Slice | null>> {
  const escalated = candidates.filter((c) => c.workflowState === "escalated_review");
  const result = new Map<string, EscalatedL1Slice | null>();
  if (escalated.length === 0) return result;
  for (const c of escalated) result.set(c.id, null);

  const versionByApp = new Map(escalated.map((c) => [c.id, c.currentVersionNumber]));
  const rows = await prisma.approvalRecord.findMany({
    where: { applicationId: { in: escalated.map((c) => c.id) }, level: 1 },
    orderBy: { createdAt: "asc" },
    select: { applicationId: true, approverUserId: true, decision: true, versionNumber: true },
  });
  // Ascending order → the last matching row per application is the latest.
  for (const row of rows) {
    if (row.versionNumber !== versionByApp.get(row.applicationId)) continue;
    result.set(row.applicationId, { approverUserId: row.approverUserId, decision: row.decision });
  }
  return result;
}

/** Viewer-relative approvalStatus label (see module-header interpretation). */
function approvalStatusFor(
  candidate: SupervisorCandidate,
  l1: EscalatedL1Slice | null | undefined,
  viewerUserId: string,
): string | undefined {
  switch (candidate.workflowState) {
    case "preliminary_decision":
      return "Needs Level-1";
    case "escalated_review": {
      const eligibility = evaluateLevel2DecisionEligibility(l1 ?? null, viewerUserId);
      if (eligibility.eligible) return "Needs Level-2 · eligible";
      if (eligibility.reason === "self-l1-approver") return "Needs Level-2 · you recorded Level-1";
      return "Needs Level-2";
    }
    case "conditional_approval":
      return "Conditionally approved";
    default:
      if (candidate.outcome === "approved") return "Approved";
      if (candidate.outcome === "denied") return "Denied";
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Summary cards (population-wide — see module header)
// ---------------------------------------------------------------------------

/** Cached per zone — the company zone is configurable (INV-045). */
const MONTH_FORMATS = new Map<string, Intl.DateTimeFormat>();

function monthKey(instant: Date, timeZone: string): string {
  let fmt = MONTH_FORMATS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" });
    MONTH_FORMATS.set(timeZone, fmt);
  }
  return fmt.format(instant);
}

export async function supervisorSummaryCards(
  now: Date = new Date(),
): Promise<SupervisorSummaryCardsWire> {
  const [byState, approved, denied, recentSubmissions] = await Promise.all([
    prisma.application.groupBy({ by: ["workflowState"], _count: { _all: true } }),
    prisma.application.count({ where: { outcome: "approved" } }),
    prisma.application.count({ where: { outcome: "denied" } }),
    // This-month probe: a 32-day indexed window, then exact company-TZ month
    // membership in memory (avoids fragile TZ month-start arithmetic).
    prisma.application.findMany({
      where: { submittedAt: { gte: new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000), lte: now } },
      select: { submittedAt: true },
    }),
  ]);

  const stateCount = new Map<WorkflowState, number>(
    byState.map((g) => [g.workflowState, g._count._all]),
  );
  const count = (state: WorkflowState) => stateCount.get(state) ?? 0;

  const total = byState.reduce((sum, g) => sum + g._count._all, 0);
  const draft = count("draft");
  const pendingApproval = count("preliminary_decision") + count("escalated_review");
  const withdrawn = TERMINAL_STATES.reduce((sum, s) => sum + count(s), 0);
  const inUnderwriting = Math.max(
    0,
    total - draft - pendingApproval - approved - denied - withdrawn,
  );

  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time
  const thisMonthKey = monthKey(now, timeZone);
  const thisMonth = recentSubmissions.filter(
    (r) => r.submittedAt !== null && monthKey(r.submittedAt, timeZone) === thisMonthKey,
  ).length;

  return { total, draft, inUnderwriting, pendingApproval, approved, denied, withdrawn, thisMonth };
}

// ---------------------------------------------------------------------------
// GET /api/supervisor/applications
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Property city from the §A data document (subjectProperty.address.city). */
function propertyCity(candidate: SupervisorCandidate): string | null {
  const property = asRecord(candidate.data?.subjectProperty);
  const address = asRecord(property?.address);
  return typeof address?.city === "string" ? address.city : null;
}

function supervisorColumnCompare(
  field: SupervisorSortField,
  a: SupervisorQueueRowWire,
  b: SupervisorQueueRowWire,
): number {
  if (field === "assignedCaseworkerName") {
    return (a.assignedCaseworkerName ?? "").localeCompare(b.assignedCaseworkerName ?? "");
  }
  if (field === "approvalStatus") {
    return (a.approvalStatus ?? "").localeCompare(b.approvalStatus ?? "");
  }
  return columnCompare(field as QueueSortField, a, b);
}

/**
 * Build the §A SupervisorApplicationPage for the authenticated Supervisor.
 * `user` MUST be the guard's session user — needs-my-Level-2 and the
 * escalated-row eligibility labels are viewer-relative.
 */
export async function listSupervisorApplications(
  user: SessionUser,
  params: SupervisorListParams,
  pagination: Pagination,
  now: Date = new Date(),
): Promise<SupervisorApplicationPageWire> {
  const candidates = await prisma.application.findMany({
    where: candidateWhere(params),
    select: SUPERVISOR_SELECT,
  });

  // Enrichment batches (same shape as the task-028 queue service).
  const [slaById, l1ByApp, cards, timeZone] = await Promise.all([
    computeSlaForApplications(candidates, now),
    latestL1ByApplication(candidates),
    supervisorSummaryCards(now),
    getCompanyTimeZone(), // INV-045: resolved at call time
  ]);

  const flagCounts = new Map<string, number>();
  if (candidates.length > 0) {
    const groups = await prisma.fraudFlag.groupBy({
      by: ["applicationId"],
      where: { applicationId: { in: candidates.map((c) => c.id) }, status: "open" },
      _count: { _all: true },
    });
    for (const g of groups) flagCounts.set(g.applicationId, g._count._all);
  }

  const cityById = new Map<string, string | null>();
  const rows: SupervisorQueueRowWire[] = [];
  for (const candidate of candidates) {
    // needs-my-Level-2: keep only escalated files where the viewer is an
    // ELIGIBLE different approver (INV-001 via the shared approval.ts rule).
    if (params.needsMyLevel2) {
      const eligibility = evaluateLevel2DecisionEligibility(
        l1ByApp.get(candidate.id) ?? null,
        user.userId,
      );
      if (!eligibility.eligible) continue;
    }

    const priority = await refreshAutomaticPriority(candidate, now);
    const base = buildQueueRow(
      candidate,
      priority,
      slaById.get(candidate.id),
      flagCounts.get(candidate.id) ?? 0,
      now,
      timeZone,
    );

    const row: SupervisorQueueRowWire = { ...base };
    const holder = candidate.assignments[0]?.caseworkerUser;
    if (holder) {
      row.assignedCaseworkerName = `${holder.firstName} ${holder.lastName}`.trim();
    }
    const approvalStatus = approvalStatusFor(candidate, l1ByApp.get(candidate.id), user.userId);
    if (approvalStatus !== undefined) row.approvalStatus = approvalStatus;

    cityById.set(candidate.id, propertyCity(candidate));
    rows.push(row);
  }

  // In-memory filters over computed/JSON-backed fields (see module header).
  let filtered = rows;
  if (params.priority) filtered = filtered.filter((r) => r.priority === params.priority);
  if (params.slaStatus) filtered = filtered.filter((r) => r.slaStatus === params.slaStatus);
  if (params.loanType) filtered = filtered.filter((r) => r.loanType === params.loanType);
  if (params.search) {
    const needle = params.search.toLowerCase();
    filtered = filtered.filter((r) => {
      const city = cityById.get(r.applicationId);
      return (
        r.applicationNumber.toLowerCase().includes(needle) ||
        r.borrowerDisplayName.toLowerCase().includes(needle) ||
        (city !== null && city !== undefined && city.toLowerCase().includes(needle))
      );
    });
  }

  if (params.sort) {
    const field = params.sort;
    const sign = params.dir === "desc" ? -1 : 1;
    filtered.sort((a, b) => sign * supervisorColumnCompare(field, a, b));
  } else {
    filtered.sort(defaultCompare);
  }

  const pageRows = filtered.slice(pagination.skip, pagination.skip + pagination.take);
  return { ...pageEnvelope(pageRows, pagination, filtered.length), cards };
}
