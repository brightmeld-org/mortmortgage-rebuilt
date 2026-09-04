// SLA + automatic-priority engine service (task-021) — REQ-047, REQ-057,
// INV-012, WALK-003, AC-33, ASM-001.
//
// Responsibilities:
//   - Load per-state business-day targets + the overall calendar-day target
//     from SystemConfig (sla.businessDays.* / sla.overallDecisionCalendarDays,
//     task-004 registry) through the single cached accessor — a Supervisor
//     config change takes effect without restart (invalidate-on-write).
//   - Derive suspended intervals from LIVE WorkflowHistory rows (to=suspended /
//     from=suspended pairs, plus Application.slaPausedAt for an open
//     suspension) — never a global scan: one indexed walk per application set
//     (@@index([applicationId, createdAt]), WALK-003).
//   - Compute { slaStatus, overallSlaDaysRemaining } per application, batched
//     (task-028 QueueRow calls computeSlaForApplications for a page of rows).
//   - Refresh automatic priority (RFP §4.4.1 rules) on read, persisting only
//     when the value changed AND no Supervisor override pins it
//     (priorityOverride=true — the guarded updateMany can never overwrite an
//     override, even under a concurrent override race).
//
// CURRENT-STATE CLOCK (RFP §4.4.1 + glossary + AC-33 — see src/lib/pure/sla.ts
// header): the clock starts at the FIRST entry into the current state for its
// current contiguous occupancy. The task-019 engine resets
// Application.stateEnteredAt on EVERY transition (including T38 resume), so the
// clock start is reconstructed from WorkflowHistory: walking back from the
// latest row, suspend→resume pairs within the same state are stepped over
// (each contributing one excluded interval) until the genuine entry transition
// is found. stateEnteredAt is only a fallback when no history exists (e.g.
// directly-staged data).
//
// TIME ZONE (ASM-001, INV-045 via contract delta CH-015): business-day math
// runs in a single company time zone, RUNTIME-CONFIGURABLE under the
// SystemConfig key `company.timeZone` (registry default America/New_York).
// No module holds it as a compile-time constant: every consumer — SLA
// computation, queue badges, HMDA LAR, warehouse extract, URLA PDF, analytics
// bucketing — resolves it through `getCompanyTimeZone()` at call time, so a
// Supervisor config write takes effect on the next read (30s TTL cache,
// invalidated on write) with no restart.
//
// EVALUATION POINT for automatic priority: on read (serialization/enrichment),
// persisting only on change. The closing-date rules are functions of the
// passage of time ("within 14 days"), so a write-time-only evaluation would go
// stale with no writes; read-time evaluation keeps queue badges and the stored
// column current without a scheduler. Draft applications are not evaluated
// (no clock before submission; queues only show submitted applications).
//
// Draft rule: slaStatus / overallSlaDaysRemaining are ABSENT for drafts —
// contracts.md §A marks both optional; there is no clock before submission.

import type { Prisma, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getNumberSetting,
  getRegistryEntry,
  getStringSetting,
  isIanaTimeZone,
} from "@/lib/services/config";
import {
  classifySlaStatus,
  netBusinessMinutes,
  overallSlaDaysRemaining,
  MINUTES_PER_BUSINESS_DAY,
  type SlaStatusValue,
  type SuspendedInterval,
} from "@/lib/pure/sla";
import { evaluateAutomaticPriority } from "@/lib/pure/priority";

// ---------------------------------------------------------------------------
// Company time zone (ASM-001 / INV-045 — see module header)
// ---------------------------------------------------------------------------

/** SystemConfig key holding the company IANA time zone (INV-045). */
export const COMPANY_TIME_ZONE_CONFIG_KEY = "company.timeZone";

/**
 * The company time zone, resolved through the config registry AT CALL TIME
 * (INV-045). Backed by the same cached accessor every other configured value
 * uses (30s TTL, invalidated on write), so this is cheap enough to call once
 * per operation. Defensive: a stored value the runtime cannot resolve falls
 * back to the registry default rather than throwing deep inside a date format.
 */
export async function getCompanyTimeZone(): Promise<string> {
  const configured = await getStringSetting(COMPANY_TIME_ZONE_CONFIG_KEY);
  return isIanaTimeZone(configured)
    ? configured
    : (getRegistryEntry(COMPANY_TIME_ZONE_CONFIG_KEY)?.defaultValue as string);
}

// ---------------------------------------------------------------------------
// Per-state targets (SystemConfig keys — task-004 registry, §4.4.1 defaults)
// ---------------------------------------------------------------------------

/** WorkflowState → sla.businessDays.* config key. States absent here have no per-state SLA. */
const SLA_STATE_CONFIG_KEYS: Partial<Record<WorkflowState, string>> = {
  application_received: "sla.businessDays.application_received",
  completeness_validated: "sla.businessDays.completeness_validated",
  documents_received: "sla.businessDays.documents_received",
  aus_executed: "sla.businessDays.aus_executed",
  preliminary_decision: "sla.businessDays.preliminary_decision",
  escalated_review: "sla.businessDays.escalated_review",
  conditional_approval: "sla.businessDays.conditional_approval",
  // Borrower clock (RFP §4.4.1): same computation, its own target key.
  revision_requested: "sla.businessDays.revision_requested",
};

export const OVERALL_SLA_CONFIG_KEY = "sla.overallDecisionCalendarDays";

export interface SlaTargets {
  /** Business-day target per SLA-tracked state (LIVE SystemConfig values). */
  perStateBusinessDays: ReadonlyMap<WorkflowState, number>;
  /** Overall submission→decision SLA in calendar days. */
  overallCalendarDays: number;
  /** Company IANA time zone the business-day clocks run in (INV-045). */
  timeZone: string;
}

/** Load every SLA target from SystemConfig (cached accessor; invalidated on config writes). */
export async function getSlaTargets(): Promise<SlaTargets> {
  const perStateBusinessDays = new Map<WorkflowState, number>();
  for (const [state, key] of Object.entries(SLA_STATE_CONFIG_KEYS)) {
    perStateBusinessDays.set(state as WorkflowState, await getNumberSetting(key));
  }
  return {
    perStateBusinessDays,
    overallCalendarDays: await getNumberSetting(OVERALL_SLA_CONFIG_KEY),
    timeZone: await getCompanyTimeZone(),
  };
}

/** The SLA-clocked states, exported for callers that must WHERE-scope to them. */
export const SLA_STATE_KEYS_BY_STATE: Readonly<Partial<Record<WorkflowState, string>>> =
  SLA_STATE_CONFIG_KEYS;

// ---------------------------------------------------------------------------
// Application slice + computed fields
// ---------------------------------------------------------------------------

/** The application fields SLA computation reads (a full Prisma Application row satisfies this). */
export interface SlaApplicationSlice {
  id: string;
  workflowState: WorkflowState;
  previousStateForSuspend: WorkflowState | null;
  stateEnteredAt: Date;
  slaPausedAt: Date | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
}

export interface SlaComputation {
  /** contracts SlaStatus, or null when the state carries no per-state SLA (or draft). */
  slaStatus: SlaStatusValue | null;
  /** Overall 30-calendar-day SLA remaining (frozen at decidedAt), or null pre-submission. */
  overallSlaDaysRemaining: number | null;
  /** The state whose clock is running (previousStateForSuspend while suspended). */
  effectiveState: WorkflowState | null;
  /** Net business days elapsed on the current state clock (suspensions excluded once each). */
  businessDaysElapsed: number | null;
  /** The state's configured business-day target. */
  targetBusinessDays: number | null;
}

interface HistorySlice {
  applicationId: string;
  fromState: WorkflowState;
  toState: WorkflowState;
  createdAt: Date;
}

interface StateClock {
  clockStart: Date;
  intervals: SuspendedInterval[];
}

/**
 * Reconstruct the current-state clock from that application's WorkflowHistory
 * (ascending). Walks backward from the latest row, stepping over
 * suspend→resume pairs (each yields one excluded interval — INV-012 "exactly
 * once") until the genuine entry into the effective state. An open suspension
 * contributes [slaPausedAt (fallback: the suspend row), now].
 */
function deriveStateClock(app: SlaApplicationSlice, history: HistorySlice[], now: Date): StateClock | null {
  const suspendedNow = app.workflowState === "suspended";
  const effectiveState = suspendedNow ? app.previousStateForSuspend : app.workflowState;
  if (!effectiveState) return null;

  const intervals: SuspendedInterval[] = [];
  let i = history.length - 1;

  if (suspendedNow) {
    // Open suspension: live slaPausedAt is authoritative; the latest history
    // row (effectiveState → suspended) is the fallback.
    let openStart = app.slaPausedAt;
    if (i >= 0 && history[i].toState === "suspended" && history[i].fromState === effectiveState) {
      openStart = openStart ?? history[i].createdAt;
      i -= 1;
    }
    intervals.push({ start: openStart ?? now, end: now });
  }

  // Walk back to the genuine entry into effectiveState, stepping over closed
  // suspend→resume pairs inside this occupancy.
  let clockStart: Date | null = null;
  while (i >= 0) {
    const row = history[i];
    if (row.toState !== effectiveState) break; // structure anomaly — fall back below
    if (row.fromState === "suspended") {
      // A resume (T38). The matching suspend row precedes it.
      const resumeAt = row.createdAt;
      i -= 1;
      if (i >= 0 && history[i].toState === "suspended" && history[i].fromState === effectiveState) {
        intervals.push({ start: history[i].createdAt, end: resumeAt });
        i -= 1;
        continue; // keep walking back for the original entry
      }
      // Unpaired resume — treat the resume itself as the entry.
      clockStart = resumeAt;
      break;
    }
    // Genuine entry transition into effectiveState.
    clockStart = row.createdAt;
    break;
  }

  intervals.reverse(); // chronological order
  return { clockStart: clockStart ?? app.stateEnteredAt, intervals };
}

/**
 * Batch SLA computation (LIVE-STATE: targets from SystemConfig, intervals from
 * WorkflowHistory + slaPausedAt, all per-application — output changes whenever
 * a transition, suspension, or config write lands). One indexed history query
 * for the whole batch (WALK-003) — task-028 QueueRow enrichment seam.
 */
export async function computeSlaForApplications(
  apps: readonly SlaApplicationSlice[],
  now: Date = new Date(),
): Promise<Map<string, SlaComputation>> {
  const result = new Map<string, SlaComputation>();
  if (apps.length === 0) return result;

  const targets = await getSlaTargets();

  // Only submitted applications have clocks; drafts short-circuit to nulls.
  const clocked = apps.filter((a) => a.submittedAt !== null && a.workflowState !== "draft");
  const historyByApp = new Map<string, HistorySlice[]>();
  if (clocked.length > 0) {
    const rows = await prisma.workflowHistory.findMany({
      where: { applicationId: { in: clocked.map((a) => a.id) } },
      orderBy: { createdAt: "asc" },
      select: { applicationId: true, fromState: true, toState: true, createdAt: true },
    });
    for (const row of rows) {
      const list = historyByApp.get(row.applicationId);
      if (list) list.push(row);
      else historyByApp.set(row.applicationId, [row]);
    }
  }

  for (const app of apps) {
    if (app.submittedAt === null || app.workflowState === "draft") {
      result.set(app.id, {
        slaStatus: null,
        overallSlaDaysRemaining: null,
        effectiveState: null,
        businessDaysElapsed: null,
        targetBusinessDays: null,
      });
      continue;
    }

    const overall = overallSlaDaysRemaining(
      targets.overallCalendarDays,
      app.submittedAt,
      app.decidedAt ?? now, // frozen at the final decision
      targets.timeZone,
    );

    const clock = deriveStateClock(app, historyByApp.get(app.id) ?? [], now);
    const effectiveState = clock
      ? app.workflowState === "suspended"
        ? app.previousStateForSuspend
        : app.workflowState
      : null;
    const target = effectiveState ? (targets.perStateBusinessDays.get(effectiveState) ?? null) : null;

    let slaStatus: SlaStatusValue | null = null;
    let businessDaysElapsed: number | null = null;
    if (clock && target !== null) {
      const elapsedMinutes = netBusinessMinutes(clock.clockStart, now, clock.intervals, targets.timeZone);
      businessDaysElapsed = elapsedMinutes / MINUTES_PER_BUSINESS_DAY;
      slaStatus = classifySlaStatus(elapsedMinutes, target);
    }

    result.set(app.id, {
      slaStatus,
      overallSlaDaysRemaining: overall,
      effectiveState,
      businessDaysElapsed,
      targetBusinessDays: target,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Automatic priority refresh (read-time; persist-on-change; override-pinned)
// ---------------------------------------------------------------------------

/** The application fields priority evaluation reads (full row + data relation satisfies this). */
export interface PriorityApplicationSlice {
  id: string;
  submittedAt: Date | null;
  workflowState: WorkflowState;
  priority: string;
  priorityOverride: boolean;
  data: {
    subjectProperty: Prisma.JsonValue;
    loan: Prisma.JsonValue;
  } | null;
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Evaluate the automatic rules for one application and persist the result when
 * it changed. NEVER overwrites a Supervisor override: skipped up front when
 * priorityOverride is set, and the persistence uses an atomic
 * updateMany({ priorityOverride: false }) guard so a concurrent override wins
 * any race. Drafts are not evaluated. Returns the priority the caller should
 * serialize.
 */
export async function refreshAutomaticPriority(
  app: PriorityApplicationSlice,
  now: Date = new Date(),
): Promise<string> {
  if (app.priorityOverride) return app.priority;
  if (app.submittedAt === null || app.workflowState === "draft") return app.priority;

  const subjectProperty = asRecord(app.data?.subjectProperty);
  const loan = asRecord(app.data?.loan);
  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time
  const automatic = evaluateAutomaticPriority(
    {
      loanPurpose: typeof loan?.loanPurpose === "string" ? loan.loanPurpose : null,
      targetClosingDate:
        typeof subjectProperty?.targetClosingDate === "string" ? subjectProperty.targetClosingDate : null,
      requestedLoanAmount:
        typeof loan?.requestedLoanAmount === "number" ? loan.requestedLoanAmount : null,
    },
    now,
    timeZone,
  );

  if (automatic === app.priority) return app.priority;

  // CHECK-THEN-ACT: the WHERE clause re-checks the override flag atomically —
  // zero rows updated means an override landed concurrently and pins the value.
  const updated = await prisma.application.updateMany({
    where: { id: app.id, priorityOverride: false },
    data: { priority: automatic },
  });
  if (updated.count === 0) {
    const fresh = await prisma.application.findUnique({
      where: { id: app.id },
      select: { priority: true },
    });
    return fresh?.priority ?? app.priority;
  }
  return automatic;
}

// ---------------------------------------------------------------------------
// Serialized-Application enrichment (routes/services call this after
// serializeApplication — the sync serializer is not restructured)
// ---------------------------------------------------------------------------

/** Row shape withSlaFields needs — an APPLICATION_INCLUDE row satisfies it. */
export type SlaEnrichableRow = SlaApplicationSlice & PriorityApplicationSlice;

/**
 * Merge live { slaStatus, overallSlaDaysRemaining } into a serialized §A
 * Application and refresh its automatic priority (override-pinned). Draft
 * applications pass through untouched — no clock before submission.
 */
export async function withSlaFields(
  wire: Record<string, unknown>,
  row: SlaEnrichableRow,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  if (row.submittedAt === null || row.workflowState === "draft") return wire;

  const [computed, priority] = await Promise.all([
    computeSlaForApplications([row], now),
    refreshAutomaticPriority(row, now),
  ]);
  const sla = computed.get(row.id);
  if (sla) {
    if (sla.slaStatus !== null) wire.slaStatus = sla.slaStatus;
    if (sla.overallSlaDaysRemaining !== null) wire.overallSlaDaysRemaining = sla.overallSlaDaysRemaining;
  }
  wire.priority = priority;
  return wire;
}
