// Supervisor analytics service (task-038) — REQ-062, NFR-015, NFR-024, SEC-14.
//
// Serves GET /api/supervisor/analytics (§A AnalyticsDashboardResponse) and the
// per-element CSV endpoint GET /api/supervisor/analytics/:element/csv.
//
// SEC-14 AGGREGATION MANDATE (AC-39, verifiable): every figure is a database
// aggregation — Prisma `groupBy`/`count`/`aggregate` or `$queryRaw` GROUP BY.
// The number of rows this service materializes is BOUNDED and does not grow
// with the size of the application book: the only row-level reads are the
// top-N feeds (`take:` / LIMIT capped) and the staff roster. In particular the
// SLA-derived figures (summary.overdueCount, the compliance overdue / at-risk /
// avgDaysInState columns) are computed by the SQL projection of the task-021
// clock in sla-sql.ts — a translation of pure/sla.ts + deriveStateClock proved
// equal to the engine by verification/lens-fixes/lens-006 — NOT by pulling the
// in-flight rows and reducing in JS (LENS-006).
//
// REUSED SEMANTICS (never re-derived here):
//   - overdue / at-risk / avg-days-in-state  → sla-sql.ts slaStatusCte, the SQL
//     twin of the task-021 engine (business-day clocks, suspension exclusions,
//     SystemConfig targets, configured company zone). Row-level surfaces still
//     use sla.ts itself; only these AGGREGATES run in SQL.
//   - Level-2 eligibility (INV-001)          → approval.ts
//     evaluateLevel2DecisionEligibility — drives eligibleApproverNote.
//   - capacity thresholds                    → config.ts getNumberSetting
//     ("workload.capacityYellow" / "workload.capacityRed", §4.6.11 — a config
//     write takes effect on the next read, no restart).
//   - workflow state labels                  → pure/workflow.ts
//     WORKFLOW_STATE_LABELS (total map — "unknown" can never appear).
//   - "completed" attribution                → the queue.ts heldDecisions
//     reading (final decision whose moment the assignment covered), expressed
//     as SQL so it aggregates in the database.
//
// DOCUMENTED INTERPRETATIONS (contract-silent points):
//   - Date-range membership: an application is in-range when
//     COALESCE(submittedAt, createdAt) ∈ [from, to] — submitted applications by
//     submission date (the §4.6.8 volume basis), drafts by creation date (so
//     the status donut can show Draft, which has no submittedAt).
//   - DATE RANGE APPLIES TO EVERY ELEMENT (AC-40 / LENS-007). Elements derived
//     from dated events (summary, volume, breakdowns, risk bands, trend,
//     compliance period columns, activity) honor the range on the event date.
//     The CURRENT-STATE operational elements (workload distribution, pending
//     approvals, and the compliance active/overdue/atRisk/
//     pendingApprovalsAwaiting/avgDaysInState columns) are live snapshots
//     RESTRICTED TO THE APPLICATIONS IN RANGE — same membership predicate as
//     every other element (COALESCE(submittedAt, createdAt) ∈ [from, to]). The
//     state they report is today's, the population they report it over is the
//     selected period, so every chart moves when the range moves and the CSV
//     export of each element agrees with the dashboard.
//   - volume grain: daily points (period = YYYY-MM-DD, company time zone).
//     Daily is the exact common refinement of the UI's weekly/monthly toggle —
//     the client folds days into ISO weeks or calendar months losslessly.
//   - performanceTrend window: the 6 calendar months ending at range.to
//     (company time zone), per the RFP's fixed "last 6 months" wording;
//     months carry the sortable form YYYY-MM.
//   - Risk bands: only decided applications (outcome recorded) with a stored
//     ratio value band; the top LTV band absorbs the >97% edge (submission
//     blocks at 97, so it is unreachable through the product itself).
//   - Compliance roster: every CASEWORKER account that is active OR has any
//     non-zero figure in the period (inactive caseworkers with no activity are
//     noise, not oversight).
//   - applicationsThisMonth: submissions in the CURRENT company-TZ calendar
//     month intersected with the range.
//   - averageLoanAmount: mean requestedLoanAmount over in-range applications
//     that carry one (JSON data document), rounded to cents.
//   - averageDaysToDecision: mean calendar days submittedAt → decidedAt over
//     in-range decided applications, 1 decimal.
//   - approvalRatePct figures: approved ÷ (approved + denied) × 100, 1 decimal,
//     0 when no decisions exist.
//   - daysWaiting: whole days since entry into the pending state (stateEnteredAt
//     — those states cannot themselves be suspended).
//   - pendingApprovals is a BOUNDED list: the oldest-waiting
//     ANALYTICS_PENDING_APPROVALS_LIMIT rows, ordered and limited in SQL
//     (SEC-14 — an untaken findMany over a workflow state is unbounded).
//
// CSV: per-element download of the SAME aggregates (streamed text/csv — the
// file-stream endpoints note in contracts §B). Cells are csv-safe (FT-61):
// formula-leading characters are apostrophe-prefixed, quoting per RFC 4180.

import { Prisma, type PrismaClient, type WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { WORKFLOW_STATE_LABELS } from "@/lib/pure/workflow";
import { getCompanyTimeZone, getSlaTargets } from "@/lib/services/sla";
import { slaStatusCte } from "@/lib/services/sla-sql";
import { evaluateLevel2DecisionEligibility } from "@/lib/services/approval";
import { getNumberSetting } from "@/lib/services/config";

/** Injectable client seam (evidence harness passes a query-logging client). */
export type AnalyticsDb = PrismaClient;

// ---------------------------------------------------------------------------
// Wire shapes (contracts.json — field names verbatim)
// ---------------------------------------------------------------------------

export interface AnalyticsSummaryWire {
  totalApplications: number;
  applicationsThisMonth: number;
  approvalRatePct: number;
  averageLoanAmount: number;
  averageDaysToDecision: number;
  overdueCount: number;
}

export interface VolumePointWire {
  period: string;
  count: number;
}

export interface LabelCountWire {
  label: string;
  count: number;
}

export type CapacityColorWire = "green" | "yellow" | "red";

export interface WorkloadRowWire {
  caseworkerName: string;
  activeAssignments: number;
  capacityColor: CapacityColorWire;
}

export interface RiskBandWire {
  band: string;
  approvedCount: number;
  deniedCount: number;
}

export interface TrendPointWire {
  month: string;
  caseworkerName: string;
  completedCount: number;
}

export interface ComplianceRowWire {
  caseworkerName: string;
  activeCount: number;
  overdueCount: number;
  atRiskCount: number;
  pendingApprovalsAwaiting: number;
  avgDaysInState: number;
  correctionsMade: number;
  revisionRequestsIssued: number;
  completedInPeriod: number;
  approvalRatePct: number;
}

export interface PendingApprovalRowWire {
  applicationId: string;
  applicationNumber: string;
  workflowState: WorkflowState;
  daysWaiting: number;
  eligibleApproverNote: string;
}

export interface ActivityEventWire {
  occurredAt: string;
  eventType: string;
  applicationNumber?: string;
  description: string;
}

export interface AnalyticsDashboardResponseWire {
  summary: AnalyticsSummaryWire;
  volume: VolumePointWire[];
  statusBreakdown: LabelCountWire[];
  loanTypeBreakdown: LabelCountWire[];
  propertyTypeBreakdown: LabelCountWire[];
  workload: WorkloadRowWire[];
  ltvRisk: RiskBandWire[];
  dtiRisk: RiskBandWire[];
  performanceTrend: TrendPointWire[];
  compliance: ComplianceRowWire[];
  pendingApprovals: PendingApprovalRowWire[];
  activityFeed: ActivityEventWire[];
}

// ---------------------------------------------------------------------------
// Range parsing — ?from&to, default last 12 months, span ≤ 1096d (NFR-015)
// ---------------------------------------------------------------------------

/** contracts.json endpoint cardinality: maxDateSpanDays 1096 (FT-67). */
export const ANALYTICS_MAX_DATE_SPAN_DAYS = 1096;

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

/** Bare YYYY-MM-DD or full ISO datetime (same convention as supervisor-list). */
function parseDateParam(raw: string, endOfDay: boolean): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const instant = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Parse ?from&to. Absent to → now; absent from → to minus 12 calendar months
 * (the contract's "default last 12 months"). Malformed dates, from > to, and
 * span > 1096 days are the contract's 400 validation error, raised BEFORE any
 * data query.
 */
export function parseAnalyticsRange(request: Request, now: Date = new Date()): AnalyticsRange {
  const params = new URL(request.url).searchParams;
  const details: string[] = [];

  let to: Date | null = null;
  const toRaw = params.get("to");
  if (toRaw !== null && toRaw.trim() !== "") {
    to = parseDateParam(toRaw.trim(), true);
    if (!to) details.push("to: must be an ISO date (YYYY-MM-DD) or datetime");
  }

  let from: Date | null = null;
  const fromRaw = params.get("from");
  if (fromRaw !== null && fromRaw.trim() !== "") {
    from = parseDateParam(fromRaw.trim(), false);
    if (!from) details.push("from: must be an ISO date (YYYY-MM-DD) or datetime");
  }

  if (details.length === 0) {
    if (!to) to = now;
    if (!from) {
      const start = new Date(to);
      start.setUTCMonth(start.getUTCMonth() - 12);
      from = start;
    }
    if (from.getTime() > to.getTime()) {
      details.push("from: must not be after to");
    } else {
      const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      if (spanDays > ANALYTICS_MAX_DATE_SPAN_DAYS) {
        details.push(`from/to: date span must not exceed ${ANALYTICS_MAX_DATE_SPAN_DAYS} days`);
      }
    }
  }

  if (details.length > 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details,
    });
  }
  return { from: from as Date, to: to as Date };
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** In-range membership (see module-header interpretation). */
function inRangeWhere(range: AnalyticsRange): Prisma.ApplicationWhereInput {
  return {
    OR: [
      { submittedAt: { gte: range.from, lte: range.to } },
      { submittedAt: null, createdAt: { gte: range.from, lte: range.to } },
    ],
  };
}

/** Same membership as raw SQL (parameters bound, never interpolated). */
function inRangeSql(range: AnalyticsRange): Prisma.Sql {
  return Prisma.sql`COALESCE(a."submittedAt", a."createdAt") >= ${range.from} AND COALESCE(a."submittedAt", a."createdAt") <= ${range.to}`;
}

/**
 * UTC-stored timestamp → company-local timestamp (for day/month bucketing).
 * The zone is resolved by the caller at call time (INV-045) and bound, never a
 * compile-time constant.
 */
const LOCAL = (col: string, timeZone: string): Prisma.Sql =>
  Prisma.sql`(${Prisma.raw(col)} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}`;

/** SLA scope columns the sla-sql.ts CTE requires. */
const SLA_SCOPE_COLUMNS = Prisma.sql`a."id", a."workflowState", a."previousStateForSuspend", a."stateEnteredAt", a."slaPausedAt", a."submittedAt"`;

/** The SLA-clocked states as bound SQL literals. */
function slaClockedStatesSql(): Prisma.Sql {
  return Prisma.join(SLA_CLOCKED_STATES.map((state) => Prisma.sql`${state}`), ", ");
}

/** The two states whose files await an approval decision (§4.6.8). */
const PENDING_APPROVAL_STATES: readonly WorkflowState[] = [
  "preliminary_decision",
  "escalated_review",
];

/** SEC-14 cap on the pending-approvals list (ordered + limited in SQL). */
export const ANALYTICS_PENDING_APPROVALS_LIMIT = 100;

/**
 * States with a running per-state SLA clock (mirrors the sla.ts
 * SLA_STATE_CONFIG_KEYS registry, which is module-private, plus `suspended`,
 * whose clock belongs to previousStateForSuspend). Only these states can ever
 * be overdue/at-risk, so SLA slices are WHERE-scoped to them (SEC-14: the
 * in-flight subset, never the full set).
 */
const SLA_CLOCKED_STATES: readonly WorkflowState[] = [
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
  "revision_requested",
  "suspended",
];

/** LabelCount label tables (display labels — machine enums stay server-side). */
const LOAN_TYPE_LABELS: Record<string, string> = {
  conventional: "Conventional",
  fha: "FHA",
  va: "VA",
  usda: "USDA",
};

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  "single-family-detached": "Single-family detached",
  "townhouse-pud": "Townhouse / PUD",
  condominium: "Condominium",
  cooperative: "Cooperative",
  "two-unit": "2-unit",
  "three-unit": "3-unit",
  "four-unit": "4-unit",
  "manufactured-home": "Manufactured home",
};

const NOT_SPECIFIED_LABEL = "Not specified";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

export async function analyticsSummary(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
  now: Date = new Date(),
): Promise<AnalyticsSummaryWire> {
  // INV-045 / task-021 config: zone + per-state targets resolved at call time.
  const [timeZone, targets] = await Promise.all([getCompanyTimeZone(), getSlaTargets()]);

  const [totalApplications, outcomeGroups, thisMonthRows, loanAvgRows, daysAvgRows, overdueRows] =
    await Promise.all([
      db.application.count({ where: inRangeWhere(range) }),
      db.application.groupBy({
        by: ["outcome"],
        where: { AND: [inRangeWhere(range)], outcome: { not: null } },
        _count: { _all: true },
      }),
      // Submissions in the current company-TZ calendar month ∩ range.
      db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "Application" a
        WHERE a."submittedAt" IS NOT NULL
          AND a."submittedAt" >= ${range.from} AND a."submittedAt" <= ${range.to}
          AND date_trunc('month', ${LOCAL('a."submittedAt"', timeZone)})
              = date_trunc('month', (${now}::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})
      `),
      db.$queryRaw<Array<{ avg: number | null }>>(Prisma.sql`
        SELECT AVG((d."loan"->>'requestedLoanAmount')::numeric)::float8 AS avg
        FROM "Application" a
        JOIN "ApplicationData" d ON d."applicationId" = a."id"
        WHERE ${inRangeSql(range)}
          AND d."loan"->>'requestedLoanAmount' ~ '^[0-9]+(\\.[0-9]+)?$'
      `),
      db.$queryRaw<Array<{ avg: number | null }>>(Prisma.sql`
        SELECT AVG(EXTRACT(EPOCH FROM (a."decidedAt" - a."submittedAt")) / 86400.0)::float8 AS avg
        FROM "Application" a
        WHERE a."decidedAt" IS NOT NULL AND a."submittedAt" IS NOT NULL
          AND ${inRangeSql(range)}
      `),
      // AC-39: overdue is an aggregate over the SQL projection of the task-021
      // clock. The WHERE scope is unchanged — the in-range, SLA-clocked slice.
      db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        WITH ${slaStatusCte(
          Prisma.sql`
            SELECT ${SLA_SCOPE_COLUMNS}
            FROM "Application" a
            WHERE ${inRangeSql(range)}
              AND a."workflowState"::text IN (${slaClockedStatesSql()})`,
          { timeZone, now, perStateBusinessDays: targets.perStateBusinessDays },
        )}
        SELECT COUNT(*) FILTER (WHERE s."slaStatus" = 'overdue')::int AS count
        FROM sla_status s
      `),
    ]);

  let approved = 0;
  let denied = 0;
  for (const g of outcomeGroups) {
    if (g.outcome === "approved") approved = g._count._all;
    if (g.outcome === "denied") denied = g._count._all;
  }
  const decided = approved + denied;

  return {
    totalApplications,
    applicationsThisMonth: thisMonthRows[0]?.count ?? 0,
    approvalRatePct: decided > 0 ? round1((approved / decided) * 100) : 0,
    averageLoanAmount: round2(loanAvgRows[0]?.avg ?? 0),
    averageDaysToDecision: round1(daysAvgRows[0]?.avg ?? 0),
    overdueCount: overdueRows[0]?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Volume (daily grain — see module header) + categorical breakdowns
// ---------------------------------------------------------------------------

export async function analyticsVolume(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<VolumePointWire[]> {
  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time
  const rows = await db.$queryRaw<Array<{ period: string; count: number }>>(Prisma.sql`
    SELECT to_char(date_trunc('day', ${LOCAL('a."submittedAt"', timeZone)}), 'YYYY-MM-DD') AS period,
           COUNT(*)::int AS count
    FROM "Application" a
    WHERE a."submittedAt" IS NOT NULL
      AND a."submittedAt" >= ${range.from} AND a."submittedAt" <= ${range.to}
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((r) => ({ period: r.period, count: r.count }));
}

export async function analyticsStatusBreakdown(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<LabelCountWire[]> {
  const groups = await db.application.groupBy({
    by: ["workflowState"],
    where: inRangeWhere(range),
    _count: { _all: true },
  });
  return groups
    .map((g) => ({ label: WORKFLOW_STATE_LABELS[g.workflowState], count: g._count._all }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

async function jsonFieldBreakdown(
  range: AnalyticsRange,
  db: AnalyticsDb,
  column: '"loan"' | '"subjectProperty"',
  field: string,
  labels: Record<string, string>,
): Promise<LabelCountWire[]> {
  const rows = await db.$queryRaw<Array<{ value: string | null; count: number }>>(Prisma.sql`
    SELECT d.${Prisma.raw(column)}->>${field} AS value, COUNT(*)::int AS count
    FROM "Application" a
    LEFT JOIN "ApplicationData" d ON d."applicationId" = a."id"
    WHERE ${inRangeSql(range)}
    GROUP BY 1
  `);
  const byLabel = new Map<string, number>();
  for (const row of rows) {
    const label = row.value !== null && labels[row.value] ? labels[row.value] : NOT_SPECIFIED_LABEL;
    byLabel.set(label, (byLabel.get(label) ?? 0) + row.count);
  }
  // Fixed enum order (contracts.json order), "Not specified" last, zero-less.
  const ordered: LabelCountWire[] = [];
  for (const label of Object.values(labels)) {
    const count = byLabel.get(label);
    if (count !== undefined) ordered.push({ label, count });
  }
  const unspecified = byLabel.get(NOT_SPECIFIED_LABEL);
  if (unspecified !== undefined && unspecified > 0) {
    ordered.push({ label: NOT_SPECIFIED_LABEL, count: unspecified });
  }
  return ordered;
}

export async function analyticsLoanTypeBreakdown(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<LabelCountWire[]> {
  return jsonFieldBreakdown(range, db, '"loan"', "loanType", LOAN_TYPE_LABELS);
}

export async function analyticsPropertyTypeBreakdown(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<LabelCountWire[]> {
  return jsonFieldBreakdown(range, db, '"subjectProperty"', "propertyType", PROPERTY_TYPE_LABELS);
}

// ---------------------------------------------------------------------------
// Workload distribution (open assignments on the IN-RANGE population — AC-40;
// capacity thresholds from SystemConfig §4.6.11)
// ---------------------------------------------------------------------------

export async function analyticsWorkload(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<WorkloadRowWire[]> {
  const [yellowAt, redAt, groups, activeCaseworkers] = await Promise.all([
    getNumberSetting("workload.capacityYellow"),
    getNumberSetting("workload.capacityRed"),
    db.caseworkerAssignment.groupBy({
      by: ["caseworkerUserId"],
      // AC-40 / LENS-007: the selected date range narrows the population the
      // chart is drawn over — same membership predicate as every other element.
      where: { endedAt: null, application: inRangeWhere(range) },
      _count: { _all: true },
    }),
    db.user.findMany({
      where: { role: "CASEWORKER", status: "active" },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const counts = new Map(groups.map((g) => [g.caseworkerUserId, g._count._all]));
  // Assignment holders outside the active-caseworker roster (e.g. recently
  // deactivated with an in-flight close) still need names for their bars.
  const missing = groups
    .map((g) => g.caseworkerUserId)
    .filter((id) => !activeCaseworkers.some((u) => u.id === id));
  const extraUsers = missing.length
    ? await db.user.findMany({
        where: { id: { in: missing } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];

  const colorFor = (count: number): CapacityColorWire =>
    count >= redAt ? "red" : count >= yellowAt ? "yellow" : "green";

  return [...activeCaseworkers, ...extraUsers]
    .map((u) => {
      const activeAssignments = counts.get(u.id) ?? 0;
      return {
        caseworkerName: `${u.firstName} ${u.lastName}`.trim(),
        activeAssignments,
        capacityColor: colorFor(activeAssignments),
      };
    })
    .sort(
      (a, b) => b.activeAssignments - a.activeAssignments || a.caseworkerName.localeCompare(b.caseworkerName),
    );
}

// ---------------------------------------------------------------------------
// LTV / DTI risk bands (stored task-010 columns — never recomputed per-row)
// ---------------------------------------------------------------------------

const LTV_BAND_LABELS = ["≤ 60%", "60–80%", "80–90%", "90–97%"] as const;
const DTI_BAND_LABELS = ["≤ 36%", "36–43%", "43–50%", "> 50%"] as const;

async function riskBands(
  range: AnalyticsRange,
  db: AnalyticsDb,
  column: '"ltv"' | '"dti"',
  caseSql: Prisma.Sql,
  bandOrder: readonly string[],
): Promise<RiskBandWire[]> {
  const col = Prisma.raw(column);
  const rows = await db.$queryRaw<
    Array<{ band: string; approvedCount: number; deniedCount: number }>
  >(Prisma.sql`
    SELECT ${caseSql} AS band,
           COUNT(*) FILTER (WHERE a."outcome" = 'approved')::int AS "approvedCount",
           COUNT(*) FILTER (WHERE a."outcome" = 'denied')::int AS "deniedCount"
    FROM "Application" a
    WHERE a."outcome" IS NOT NULL AND a.${col} IS NOT NULL
      AND ${inRangeSql(range)}
    GROUP BY 1
  `);
  const byBand = new Map(rows.map((r) => [r.band, r]));
  return bandOrder.map((band) => ({
    band,
    approvedCount: byBand.get(band)?.approvedCount ?? 0,
    deniedCount: byBand.get(band)?.deniedCount ?? 0,
  }));
}

export async function analyticsLtvRisk(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<RiskBandWire[]> {
  // §4.6.8 LTV bands: ≤ 60%, 60–80%, 80–90%, 90–97% (stored percent values).
  const caseSql = Prisma.sql`CASE
    WHEN a."ltv" <= 60 THEN ${LTV_BAND_LABELS[0]}
    WHEN a."ltv" <= 80 THEN ${LTV_BAND_LABELS[1]}
    WHEN a."ltv" <= 90 THEN ${LTV_BAND_LABELS[2]}
    ELSE ${LTV_BAND_LABELS[3]} END`;
  return riskBands(range, db, '"ltv"', caseSql, LTV_BAND_LABELS);
}

export async function analyticsDtiRisk(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<RiskBandWire[]> {
  // §4.6.8 DTI bands: ≤ 36%, 36–43%, 43–50%, > 50%.
  const caseSql = Prisma.sql`CASE
    WHEN a."dti" <= 36 THEN ${DTI_BAND_LABELS[0]}
    WHEN a."dti" <= 43 THEN ${DTI_BAND_LABELS[1]}
    WHEN a."dti" <= 50 THEN ${DTI_BAND_LABELS[2]}
    ELSE ${DTI_BAND_LABELS[3]} END`;
  return riskBands(range, db, '"dti"', caseSql, DTI_BAND_LABELS);
}

// ---------------------------------------------------------------------------
// 6-month per-caseworker performance trend (held-decision attribution in SQL)
// ---------------------------------------------------------------------------

/** 'YYYY-MM' month keys for the 6 company-TZ months ending at `to`. */
function trailingMonths(to: Date, count: number, timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.format(to).split("-"); // en-CA → YYYY-MM
  let year = Number(parts[0]);
  let month = Number(parts[1]);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    keys.unshift(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return keys;
}

export async function analyticsPerformanceTrend(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<TrendPointWire[]> {
  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time
  const months = trailingMonths(range.to, 6, timeZone);
  // Window start: first instant that can fall in the earliest month bucket
  // (UTC padding of one day keeps the bound cheap; bucketing below is exact).
  const windowStart = new Date(`${months[0]}-01T00:00:00.000Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);

  // "Completed" = queue.ts heldDecisions: a final decision whose moment the
  // assignment covered, counted once per application per caseworker.
  const rows = await db.$queryRaw<
    Array<{ month: string; caseworkerUserId: string; completedCount: number }>
  >(Prisma.sql`
    SELECT to_char(date_trunc('month', ${LOCAL('a."decidedAt"', timeZone)}), 'YYYY-MM') AS month,
           ca."caseworkerUserId" AS "caseworkerUserId",
           COUNT(DISTINCT a."id")::int AS "completedCount"
    FROM "CaseworkerAssignment" ca
    JOIN "Application" a ON a."id" = ca."applicationId"
    WHERE a."outcome" IS NOT NULL
      AND a."decidedAt" >= ${windowStart} AND a."decidedAt" <= ${range.to}
      AND ca."assignedAt" <= a."decidedAt"
      AND (ca."endedAt" IS NULL OR ca."endedAt" >= a."decidedAt")
    GROUP BY 1, 2
  `);

  const inWindow = rows.filter((r) => months.includes(r.month));
  const userIds = [...new Set(inWindow.map((r) => r.caseworkerUserId))];
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

  // Zero-fill every (month, caseworker) pair so each line spans all 6 months.
  const byKey = new Map(inWindow.map((r) => [`${r.month}|${r.caseworkerUserId}`, r.completedCount]));
  const points: TrendPointWire[] = [];
  const sortedIds = userIds.sort((a, b) =>
    (nameById.get(a) ?? "").localeCompare(nameById.get(b) ?? ""),
  );
  for (const month of months) {
    for (const id of sortedIds) {
      points.push({
        month,
        caseworkerName: nameById.get(id) ?? "(former staff)",
        completedCount: byKey.get(`${month}|${id}`) ?? 0,
      });
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Caseworker compliance table
// ---------------------------------------------------------------------------

export async function analyticsCompliance(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
  now: Date = new Date(),
): Promise<ComplianceRowWire[]> {
  const [caseworkers, corrections, revisions, decided] = await Promise.all([
    db.user.findMany({
      where: { role: "CASEWORKER" },
      select: { id: true, firstName: true, lastName: true, status: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    db.auditLogEntry.groupBy({
      by: ["actorUserId"],
      where: {
        actionType: "correction",
        actorUserId: { not: null },
        timestamp: { gte: range.from, lte: range.to },
      },
      _count: { _all: true },
    }),
    db.workflowHistory.groupBy({
      by: ["actorUserId"],
      where: {
        toState: "revision_requested",
        actorUserId: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      _count: { _all: true },
    }),
    // Held decisions in the period, split by outcome (queue.ts attribution).
    db.$queryRaw<
      Array<{ caseworkerUserId: string; completed: number; approvedCount: number }>
    >(Prisma.sql`
      SELECT ca."caseworkerUserId" AS "caseworkerUserId",
             COUNT(DISTINCT a."id")::int AS completed,
             COUNT(DISTINCT a."id") FILTER (WHERE a."outcome" = 'approved')::int AS "approvedCount"
      FROM "CaseworkerAssignment" ca
      JOIN "Application" a ON a."id" = ca."applicationId"
      WHERE a."outcome" IS NOT NULL
        AND a."decidedAt" >= ${range.from} AND a."decidedAt" <= ${range.to}
        AND ca."assignedAt" <= a."decidedAt"
        AND (ca."endedAt" IS NULL OR ca."endedAt" >= a."decidedAt")
      GROUP BY 1
    `),
  ]);

  // Live columns (AC-39): ONE aggregate over the open-assignment set joined to
  // the SQL projection of the task-021 clock — no application rows are pulled
  // into memory. WHERE scope is unchanged apart from the AC-40 range predicate
  // that every other element already applies.
  interface LiveAgg {
    active: number;
    overdue: number;
    atRisk: number;
    pendingApprovals: number;
    avgDaysInState: number | null;
  }
  const live = new Map<string, LiveAgg>();
  if (caseworkers.length > 0) {
    const [timeZone, targets] = await Promise.all([getCompanyTimeZone(), getSlaTargets()]);
    const caseworkerIds = Prisma.join(
      caseworkers.map((c) => Prisma.sql`${c.id}`),
      ", ",
    );
    const activeScope = Prisma.sql`
      SELECT DISTINCT ${SLA_SCOPE_COLUMNS}
      FROM "Application" a
      JOIN "CaseworkerAssignment" ca ON ca."applicationId" = a."id" AND ca."endedAt" IS NULL
      WHERE ca."caseworkerUserId" IN (${caseworkerIds})
        AND ${inRangeSql(range)}`;

    const liveRows = await db.$queryRaw<
      Array<{
        caseworkerUserId: string;
        activeCount: number;
        overdueCount: number;
        atRiskCount: number;
        pendingApprovalsAwaiting: number;
        avgDaysInState: number | null;
      }>
    >(Prisma.sql`
      WITH ${slaStatusCte(activeScope, {
        timeZone,
        now,
        perStateBusinessDays: targets.perStateBusinessDays,
      })}
      SELECT ca."caseworkerUserId" AS "caseworkerUserId",
             COUNT(*)::int AS "activeCount",
             COUNT(*) FILTER (WHERE s."slaStatus" = 'overdue')::int AS "overdueCount",
             COUNT(*) FILTER (WHERE s."slaStatus" = 'at-risk')::int AS "atRiskCount",
             COUNT(*) FILTER (
               WHERE a."workflowState"::text IN (${Prisma.join(
                 PENDING_APPROVAL_STATES.map((state) => Prisma.sql`${state}`),
                 ", ",
               )})
             )::int AS "pendingApprovalsAwaiting",
             AVG(s."businessDaysElapsed")::float8 AS "avgDaysInState"
      FROM "CaseworkerAssignment" ca
      JOIN "Application" a ON a."id" = ca."applicationId"
      LEFT JOIN sla_status s ON s."applicationId" = a."id"
      WHERE ca."endedAt" IS NULL
        AND ca."caseworkerUserId" IN (${caseworkerIds})
        AND ${inRangeSql(range)}
      GROUP BY 1
    `);
    for (const row of liveRows) {
      live.set(row.caseworkerUserId, {
        active: row.activeCount,
        overdue: row.overdueCount,
        atRisk: row.atRiskCount,
        pendingApprovals: row.pendingApprovalsAwaiting,
        avgDaysInState: row.avgDaysInState,
      });
    }
  }

  const correctionsBy = new Map(corrections.map((g) => [g.actorUserId as string, g._count._all]));
  const revisionsBy = new Map(revisions.map((g) => [g.actorUserId as string, g._count._all]));
  const decidedBy = new Map(decided.map((r) => [r.caseworkerUserId, r]));

  const rows: ComplianceRowWire[] = [];
  for (const cw of caseworkers) {
    const agg = live.get(cw.id);
    const dec = decidedBy.get(cw.id);
    const row: ComplianceRowWire = {
      caseworkerName: `${cw.firstName} ${cw.lastName}`.trim(),
      activeCount: agg?.active ?? 0,
      overdueCount: agg?.overdue ?? 0,
      atRiskCount: agg?.atRisk ?? 0,
      pendingApprovalsAwaiting: agg?.pendingApprovals ?? 0,
      avgDaysInState:
        agg && agg.avgDaysInState !== null && agg.avgDaysInState !== undefined
          ? round1(agg.avgDaysInState)
          : 0,
      correctionsMade: correctionsBy.get(cw.id) ?? 0,
      revisionRequestsIssued: revisionsBy.get(cw.id) ?? 0,
      completedInPeriod: dec?.completed ?? 0,
      approvalRatePct: dec && dec.completed > 0 ? round1((dec.approvedCount / dec.completed) * 100) : 0,
    };
    const hasActivity =
      row.activeCount > 0 ||
      row.correctionsMade > 0 ||
      row.revisionRequestsIssued > 0 ||
      row.completedInPeriod > 0;
    if (cw.status === "active" || hasActivity) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Pending approvals (in-range population, BOUNDED + ordered in SQL;
// viewer-relative eligible-approver note — INV-001)
// ---------------------------------------------------------------------------

export async function analyticsPendingApprovals(
  viewer: SessionUser,
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
  now: Date = new Date(),
): Promise<PendingApprovalRowWire[]> {
  // SEC-14 (LENS-006): daysWaiting, the ordering and the cap are all computed in
  // the database — never an untaken findMany over a workflow state.
  // AC-40 (LENS-007): restricted to the selected range like every other element.
  const pending = await db.$queryRaw<
    Array<{
      id: string;
      applicationNumber: string;
      workflowState: WorkflowState;
      currentVersionNumber: number;
      daysWaiting: number;
    }>
  >(Prisma.sql`
    SELECT a."id" AS "id",
           a."applicationNumber" AS "applicationNumber",
           a."workflowState"::text AS "workflowState",
           a."currentVersionNumber" AS "currentVersionNumber",
           GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - a."stateEnteredAt")) / 86400.0))::int
             AS "daysWaiting"
    FROM "Application" a
    WHERE a."workflowState"::text IN (${Prisma.join(
      PENDING_APPROVAL_STATES.map((state) => Prisma.sql`${state}`),
      ", ",
    )})
      AND ${inRangeSql(range)}
    ORDER BY "daysWaiting" DESC, a."applicationNumber" ASC
    LIMIT ${ANALYTICS_PENDING_APPROVALS_LIMIT}
  `);

  // Latest level-1 record per escalated file for its current version — the
  // same batched read the task-031 list uses for the INV-001 rule.
  const escalated = pending.filter((p) => p.workflowState === "escalated_review");
  const l1ByApp = new Map<string, { approverUserId: string; decision: string } | null>();
  if (escalated.length > 0) {
    for (const p of escalated) l1ByApp.set(p.id, null);
    const versionByApp = new Map(escalated.map((p) => [p.id, p.currentVersionNumber]));
    const records = await db.approvalRecord.findMany({
      where: { applicationId: { in: escalated.map((p) => p.id) }, level: 1 },
      orderBy: { createdAt: "asc" },
      select: { applicationId: true, approverUserId: true, decision: true, versionNumber: true },
    });
    for (const record of records) {
      if (record.versionNumber !== versionByApp.get(record.applicationId)) continue;
      l1ByApp.set(record.applicationId, {
        approverUserId: record.approverUserId,
        decision: record.decision,
      });
    }
  }

  // Order is already the contract order (SQL ORDER BY above).
  return pending.map((p) => {
      let note: string;
      if (p.workflowState === "preliminary_decision") {
        note = "Awaiting Level-1 — any supervisor may decide.";
      } else {
        const eligibility = evaluateLevel2DecisionEligibility(l1ByApp.get(p.id) ?? null, viewer.userId);
        if (eligibility.eligible) {
          note = "Awaiting Level-2 — you are eligible to decide.";
        } else if (eligibility.reason === "self-l1-approver") {
          note = "Awaiting Level-2 — you recorded Level-1; a different supervisor must decide.";
        } else {
          note = "Awaiting Level-2 — Level-1 approval pending.";
        }
      }
      return {
        applicationId: p.id,
        applicationNumber: p.applicationNumber,
        workflowState: p.workflowState,
        daysWaiting: p.daysWaiting,
        eligibleApproverNote: note,
      };
  });
}

// ---------------------------------------------------------------------------
// Recent activity feed (top-N per source, merged — labels never "unknown")
// ---------------------------------------------------------------------------

/** Feed size: latest 50 served (≥ the RFP's "at least the latest 25"). */
export const ACTIVITY_FEED_SIZE = 50;

export async function analyticsActivityFeed(
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
): Promise<ActivityEventWire[]> {
  const [transitions, assignments, approvals] = await Promise.all([
    db.workflowHistory.findMany({
      where: { createdAt: { gte: range.from, lte: range.to } },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_FEED_SIZE,
      select: {
        fromState: true,
        toState: true,
        createdAt: true,
        application: { select: { applicationNumber: true } },
      },
    }),
    db.caseworkerAssignment.findMany({
      where: { assignedAt: { gte: range.from, lte: range.to } },
      orderBy: { assignedAt: "desc" },
      take: ACTIVITY_FEED_SIZE,
      select: {
        assignedAt: true,
        method: true,
        caseworkerUser: { select: { firstName: true, lastName: true } },
        application: { select: { applicationNumber: true } },
      },
    }),
    db.approvalRecord.findMany({
      where: { createdAt: { gte: range.from, lte: range.to } },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_FEED_SIZE,
      select: {
        createdAt: true,
        level: true,
        decision: true,
        approverUser: { select: { firstName: true, lastName: true } },
        application: { select: { applicationNumber: true } },
      },
    }),
  ]);

  const events: ActivityEventWire[] = [];
  for (const t of transitions) {
    const fromLabel = WORKFLOW_STATE_LABELS[t.fromState];
    const toLabel = WORKFLOW_STATE_LABELS[t.toState];
    const isSubmission = t.fromState === "draft" && t.toState === "application_received";
    events.push({
      occurredAt: t.createdAt.toISOString(),
      eventType: isSubmission ? "submission" : "transition",
      applicationNumber: t.application.applicationNumber,
      description: isSubmission
        ? `Submitted — ${fromLabel} → ${toLabel}`
        : `${fromLabel} → ${toLabel}`,
    });
  }
  for (const a of assignments) {
    const name = `${a.caseworkerUser.firstName} ${a.caseworkerUser.lastName}`.trim();
    events.push({
      occurredAt: a.assignedAt.toISOString(),
      eventType: "assignment",
      applicationNumber: a.application.applicationNumber,
      description: `Assigned to ${name} (${a.method})`,
    });
  }
  for (const r of approvals) {
    const name = `${r.approverUser.firstName} ${r.approverUser.lastName}`.trim();
    const decisionWord = r.decision === "approve" ? "approval" : "denial";
    events.push({
      occurredAt: r.createdAt.toISOString(),
      eventType: "approval",
      applicationNumber: r.application.applicationNumber,
      description: `Level-${r.level} ${decisionWord} recorded by ${name}`,
    });
  }

  return events
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, ACTIVITY_FEED_SIZE);
}

// ---------------------------------------------------------------------------
// Dashboard assembler — GET /api/supervisor/analytics
// ---------------------------------------------------------------------------

export async function getAnalyticsDashboard(
  viewer: SessionUser,
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
  now: Date = new Date(),
): Promise<AnalyticsDashboardResponseWire> {
  const [
    summary,
    volume,
    statusBreakdown,
    loanTypeBreakdown,
    propertyTypeBreakdown,
    workload,
    ltvRisk,
    dtiRisk,
    performanceTrend,
    compliance,
    pendingApprovals,
    activityFeed,
  ] = await Promise.all([
    analyticsSummary(range, db, now),
    analyticsVolume(range, db),
    analyticsStatusBreakdown(range, db),
    analyticsLoanTypeBreakdown(range, db),
    analyticsPropertyTypeBreakdown(range, db),
    analyticsWorkload(range, db),
    analyticsLtvRisk(range, db),
    analyticsDtiRisk(range, db),
    analyticsPerformanceTrend(range, db),
    analyticsCompliance(range, db, now),
    analyticsPendingApprovals(viewer, range, db, now),
    analyticsActivityFeed(range, db),
  ]);

  return {
    summary,
    volume,
    statusBreakdown,
    loanTypeBreakdown,
    propertyTypeBreakdown,
    workload,
    ltvRisk,
    dtiRisk,
    performanceTrend,
    compliance,
    pendingApprovals,
    activityFeed,
  };
}

// ---------------------------------------------------------------------------
// Per-element CSV (contracts §B :element whitelist, verbatim — 12 values)
// ---------------------------------------------------------------------------

export const ANALYTICS_CSV_ELEMENTS = [
  "summary",
  "volume",
  "status",
  "loan-type",
  "property-type",
  "workload",
  "ltv-risk",
  "dti-risk",
  "performance-trend",
  "compliance",
  "pending-approvals",
  "activity",
] as const;

export type AnalyticsCsvElement = (typeof ANALYTICS_CSV_ELEMENTS)[number];

export function isAnalyticsCsvElement(value: string): value is AnalyticsCsvElement {
  return (ANALYTICS_CSV_ELEMENTS as readonly string[]).includes(value);
}

export interface CsvTable {
  header: string[];
  rows: Array<Array<string | number>>;
}

/** Build one element's CSV table from the SAME aggregation functions. */
export async function analyticsElementTable(
  element: AnalyticsCsvElement,
  viewer: SessionUser,
  range: AnalyticsRange,
  db: AnalyticsDb = prisma,
  now: Date = new Date(),
): Promise<CsvTable> {
  switch (element) {
    case "summary": {
      const s = await analyticsSummary(range, db, now);
      return {
        header: ["metric", "value"],
        rows: [
          ["totalApplications", s.totalApplications],
          ["applicationsThisMonth", s.applicationsThisMonth],
          ["approvalRatePct", s.approvalRatePct],
          ["averageLoanAmount", s.averageLoanAmount],
          ["averageDaysToDecision", s.averageDaysToDecision],
          ["overdueCount", s.overdueCount],
        ],
      };
    }
    case "volume": {
      const points = await analyticsVolume(range, db);
      return { header: ["period", "count"], rows: points.map((p) => [p.period, p.count]) };
    }
    case "status": {
      const rows = await analyticsStatusBreakdown(range, db);
      return { header: ["label", "count"], rows: rows.map((r) => [r.label, r.count]) };
    }
    case "loan-type": {
      const rows = await analyticsLoanTypeBreakdown(range, db);
      return { header: ["label", "count"], rows: rows.map((r) => [r.label, r.count]) };
    }
    case "property-type": {
      const rows = await analyticsPropertyTypeBreakdown(range, db);
      return { header: ["label", "count"], rows: rows.map((r) => [r.label, r.count]) };
    }
    case "workload": {
      const rows = await analyticsWorkload(range, db);
      return {
        header: ["caseworkerName", "activeAssignments", "capacityColor"],
        rows: rows.map((r) => [r.caseworkerName, r.activeAssignments, r.capacityColor]),
      };
    }
    case "ltv-risk": {
      const rows = await analyticsLtvRisk(range, db);
      return {
        header: ["band", "approvedCount", "deniedCount"],
        rows: rows.map((r) => [r.band, r.approvedCount, r.deniedCount]),
      };
    }
    case "dti-risk": {
      const rows = await analyticsDtiRisk(range, db);
      return {
        header: ["band", "approvedCount", "deniedCount"],
        rows: rows.map((r) => [r.band, r.approvedCount, r.deniedCount]),
      };
    }
    case "performance-trend": {
      const rows = await analyticsPerformanceTrend(range, db);
      return {
        header: ["month", "caseworkerName", "completedCount"],
        rows: rows.map((r) => [r.month, r.caseworkerName, r.completedCount]),
      };
    }
    case "compliance": {
      const rows = await analyticsCompliance(range, db, now);
      return {
        header: [
          "caseworkerName",
          "activeCount",
          "overdueCount",
          "atRiskCount",
          "pendingApprovalsAwaiting",
          "avgDaysInState",
          "correctionsMade",
          "revisionRequestsIssued",
          "completedInPeriod",
          "approvalRatePct",
        ],
        rows: rows.map((r) => [
          r.caseworkerName,
          r.activeCount,
          r.overdueCount,
          r.atRiskCount,
          r.pendingApprovalsAwaiting,
          r.avgDaysInState,
          r.correctionsMade,
          r.revisionRequestsIssued,
          r.completedInPeriod,
          r.approvalRatePct,
        ]),
      };
    }
    case "pending-approvals": {
      const rows = await analyticsPendingApprovals(viewer, range, db, now);
      return {
        header: [
          "applicationId",
          "applicationNumber",
          "workflowState",
          "daysWaiting",
          "eligibleApproverNote",
        ],
        rows: rows.map((r) => [
          r.applicationId,
          r.applicationNumber,
          r.workflowState,
          r.daysWaiting,
          r.eligibleApproverNote,
        ]),
      };
    }
    case "activity": {
      const rows = await analyticsActivityFeed(range, db);
      return {
        header: ["occurredAt", "eventType", "applicationNumber", "description"],
        rows: rows.map((r) => [r.occurredAt, r.eventType, r.applicationNumber ?? "", r.description]),
      };
    }
  }
}

// --- CSV encoding (csv-safe cells) ---

/**
 * Encode one CSV cell: formula-leading characters (`=`, `+`, `-`, `@`, tab,
 * CR) are apostrophe-prefixed so spreadsheet apps never execute them; cells
 * containing separators/quotes/newlines are RFC-4180 quoted.
 */
export function csvCell(value: string | number): string {
  let text = typeof value === "number" ? String(value) : value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Chunk size for streamed CSV bodies (bounded aggregate tables). */
const CSV_STREAM_CHUNK_ROWS = 200;

/**
 * Stream a CSV table as a ReadableStream body (file-stream endpoints return
 * streams, never JSON — contracts §B / SEC-14). Rows are emitted in chunks.
 */
export function csvStream(table: CsvTable): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = 0;
  let headerSent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headerSent) {
        controller.enqueue(encoder.encode(`${table.header.map(csvCell).join(",")}\r\n`));
        headerSent = true;
        return;
      }
      if (sent >= table.rows.length) {
        controller.close();
        return;
      }
      const chunk = table.rows
        .slice(sent, sent + CSV_STREAM_CHUNK_ROWS)
        .map((row) => `${row.map(csvCell).join(",")}\r\n`)
        .join("");
      sent += CSV_STREAM_CHUNK_ROWS;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}
