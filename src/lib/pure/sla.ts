// Pure SLA / business-day math (task-021) — REQ-047, INV-012, ASM-001, AC-33.
//
// Deterministic, no Prisma, no Date.now(): every function takes its instants
// (and the company time zone) as parameters. Uses Intl APIs only — no date
// libraries (profile allowlist).
//
// CLOCK SEMANTICS (RFP §4.4.1 + glossary "SLA: Service-level target for time in
// a workflow state" + AC-33):
//   - The per-state SLA clock measures time spent in the CURRENT workflow state
//     for its current contiguous occupancy. Suspend/resume cycles within that
//     occupancy do NOT reset the clock — each suspended interval is excluded
//     from elapsed time exactly once (INV-012), including across multiple
//     cycles. Re-entering a state via a genuine transition (e.g. a T36
//     resubmission back to Application Received) starts a NEW clock.
//   - Business days are Monday–Friday, no holidays, evaluated in a single
//     configurable company time zone (ASM-001, default U.S. Eastern).
//   - Elapsed time uses WALL-CLOCK local time: a span from Friday 09:00 to
//     Monday 09:00 local is exactly 1.0 business day regardless of a DST
//     transition on the intervening Sunday. U.S. DST shifts always fall on a
//     Sunday (a zero-weight day here), so wall-clock coordinates are monotonic
//     for the supported zones; minutes-into-day is clamped to [0, 1440]
//     defensively for zones that shift on weekdays.
//
// THRESHOLDS (RFP §4.4.1, verbatim): On track < 75% elapsed; At risk >= 75%;
// Overdue > 100%. Exactly 75% and exactly 100% are both At risk.
//
// SlaStatus enum literals are contracts.json-verbatim: 'on-track' | 'at-risk'
// | 'overdue' (hyphenated).

/** contracts.json enums.SlaStatus, verbatim. */
export type SlaStatusValue = "on-track" | "at-risk" | "overdue";

export const MINUTES_PER_BUSINESS_DAY = 1440;

/** A closed suspension interval [start, end); an open suspension uses `now` as end. */
export interface SuspendedInterval {
  start: Date;
  end: Date;
}

// ---------------------------------------------------------------------------
// Local-time decomposition (Intl, cached per zone)
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

interface LocalParts {
  /** Days since 1970-01-01 of the LOCAL calendar date. */
  epochDay: number;
  /** Wall-clock minutes into the local day (fractional; clamped to [0, 1440]). */
  minutesIntoDay: number;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
    }
  }
  const epochDay = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  const minutesIntoDay = Math.min(
    MINUTES_PER_BUSINESS_DAY,
    Math.max(0, hour * 60 + minute + second / 60 + instant.getUTCMilliseconds() / 60_000),
  );
  return { epochDay, minutesIntoDay };
}

/** Local calendar day (days since 1970-01-01) of an instant in a time zone. */
export function localEpochDay(instant: Date, timeZone: string): number {
  return localParts(instant, timeZone).epochDay;
}

/** Day of week for an epoch day: 0 = Sunday .. 6 = Saturday (1970-01-01 was a Thursday). */
function dayOfWeek(epochDay: number): number {
  return (((epochDay + 4) % 7) + 7) % 7;
}

function isWeekendDay(epochDay: number): boolean {
  const dow = dayOfWeek(epochDay);
  return dow === 0 || dow === 6;
}

/** Count of Monday–Friday days in [0, epochDay). Feb-29-agnostic (pure day arithmetic). */
function weekdaysBefore(epochDay: number): number {
  const fullWeeks = Math.floor(epochDay / 7);
  let count = fullWeeks * 5;
  for (let d = fullWeeks * 7; d < epochDay; d += 1) {
    if (!isWeekendDay(d)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Business-time coordinate + elapsed
// ---------------------------------------------------------------------------

/**
 * Monotonic business-timeline coordinate in minutes: weekdays advance the
 * coordinate by wall-clock minutes; weekend instants sit at the boundary
 * (Saturday 00:00 == Friday 24:00 == Monday 00:00 on this timeline).
 */
function businessCoordinateMinutes(instant: Date, timeZone: string): number {
  const { epochDay, minutesIntoDay } = localParts(instant, timeZone);
  const base = weekdaysBefore(epochDay) * MINUTES_PER_BUSINESS_DAY;
  return isWeekendDay(epochDay) ? base : base + minutesIntoDay;
}

/** Business minutes (Mon–Fri wall clock) between two instants. Never negative. */
export function businessMinutesBetween(start: Date, end: Date, timeZone: string): number {
  if (end.getTime() <= start.getTime()) return 0;
  return Math.max(
    0,
    businessCoordinateMinutes(end, timeZone) - businessCoordinateMinutes(start, timeZone),
  );
}

/** Business days (fractional) between two instants. */
export function businessDaysBetween(start: Date, end: Date, timeZone: string): number {
  return businessMinutesBetween(start, end, timeZone) / MINUTES_PER_BUSINESS_DAY;
}

/**
 * Net business minutes in [start, end] with the given suspended intervals
 * excluded EXACTLY ONCE each (INV-012). Intervals are clipped to [start, end];
 * callers pass them in chronological order (derived from WorkflowHistory —
 * suspend/resume pairs never overlap by construction of the state machine).
 * Monotonic in `end`: elapsed never decreases as time advances, and each
 * closed interval subtracts a fixed amount exactly once.
 */
export function netBusinessMinutes(
  start: Date,
  end: Date,
  suspendedIntervals: readonly SuspendedInterval[],
  timeZone: string,
): number {
  let elapsed = businessMinutesBetween(start, end, timeZone);
  for (const interval of suspendedIntervals) {
    const s = interval.start.getTime() < start.getTime() ? start : interval.start;
    const e = interval.end.getTime() > end.getTime() ? end : interval.end;
    if (e.getTime() > s.getTime()) {
      elapsed -= businessMinutesBetween(s, e, timeZone);
    }
  }
  return Math.max(0, elapsed);
}

// ---------------------------------------------------------------------------
// Threshold classification (RFP §4.4.1 verbatim)
// ---------------------------------------------------------------------------

/**
 * Classify elapsed business minutes against a business-day target:
 *   < 75% of target      → 'on-track'
 *   >= 75% and <= 100%   → 'at-risk'   (exactly 75% and exactly 100% both at-risk)
 *   > 100%               → 'overdue'
 */
export function classifySlaStatus(elapsedBusinessMinutes: number, targetBusinessDays: number): SlaStatusValue {
  const targetMinutes = targetBusinessDays * MINUTES_PER_BUSINESS_DAY;
  if (targetMinutes <= 0) return "overdue";
  if (elapsedBusinessMinutes > targetMinutes) return "overdue";
  if (elapsedBusinessMinutes >= 0.75 * targetMinutes) return "at-risk";
  return "on-track";
}

// ---------------------------------------------------------------------------
// Overall calendar-day SLA (30 calendar days submission → final decision)
// ---------------------------------------------------------------------------

/** Whole calendar days between two instants' LOCAL calendar dates (company zone). */
export function calendarDaysBetween(start: Date, end: Date, timeZone: string): number {
  return localEpochDay(end, timeZone) - localEpochDay(start, timeZone);
}

/**
 * Days remaining on the overall SLA: target calendar days minus calendar days
 * elapsed from submission to `endInstant` (decidedAt when decided, else now —
 * the caller freezes the clock at the final decision). Negative when the
 * overall SLA is exceeded.
 */
export function overallSlaDaysRemaining(
  targetCalendarDays: number,
  submittedAt: Date,
  endInstant: Date,
  timeZone: string,
): number {
  return targetCalendarDays - calendarDaysBetween(submittedAt, endInstant, timeZone);
}
