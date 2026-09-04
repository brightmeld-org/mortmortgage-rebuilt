// SQL projection of the task-021 SLA clock (LENS-006 / AC-39, SEC-14).
//
// WHY THIS EXISTS: the supervisor dashboard must compute every figure by
// DATABASE aggregation (AC-39). Three figures depended on the SLA engine —
// summary.overdueCount and the compliance overdue / at-risk / avgDaysInState
// columns — and were therefore computed by pulling the in-flight application
// rows into memory and reducing in JS. This module expresses the SAME clock as
// SQL so those figures aggregate in the database and the service materializes a
// bounded number of rows regardless of book size.
//
// SEMANTICS ARE NOT RE-DERIVED, THEY ARE TRANSLATED. Every rule below is a
// line-for-line mirror of src/lib/pure/sla.ts + the deriveStateClock walk in
// src/lib/services/sla.ts, and the translation is proved equal to the TypeScript
// engine over staged suspend/resume topologies by
// verification/lens-fixes/lens-006/01_sla_sql_equivalence.ts. sla.ts remains the
// authority for every ROW-LEVEL surface (queue badges, detail page); this module
// is used only where an AGGREGATE over a WHERE-scoped set is required.
//
// The mirrored rules:
//   - Business-day coordinate (pure/sla.ts businessCoordinateMinutes):
//     weekdaysBefore(localEpochDay) * 1440, plus wall-clock minutes-into-day on
//     weekdays (weekend instants sit on the day boundary). Local = the CONFIGURED
//     company zone (INV-045), applied as (col AT TIME ZONE 'UTC') AT TIME ZONE $tz.
//   - Clock start (services/sla.ts deriveStateClock): the genuine entry into the
//     effective state for its current contiguous occupancy, found by walking
//     WorkflowHistory backwards over suspend→resume pairs; Application.stateEnteredAt
//     is the fallback when the walk finds no entry.
//   - Suspended intervals excluded EXACTLY ONCE each (INV-012), clipped to
//     [clockStart, now]; an open suspension contributes [slaPausedAt ?? suspend
//     row ?? now, now].
//   - Thresholds (pure/sla.ts classifySlaStatus): > 100% overdue, >= 75% at-risk,
//     else on-track; a non-positive target is overdue.
//   - Drafts and unsubmitted applications have no clock; a suspended row with no
//     previousStateForSuspend has no effective state. Both yield a NULL status,
//     exactly as the engine returns slaStatus null.

import { Prisma } from "@prisma/client";

/** Local (company-zone) wall-clock timestamp of a UTC-stored column/expression. */
function local(expr: Prisma.Sql, timeZone: string): Prisma.Sql {
  return Prisma.sql`((${expr}) AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}`;
}

/** Days since 1970-01-01 of the LOCAL calendar date (pure/sla.ts localParts). */
function epochDay(expr: Prisma.Sql, timeZone: string): Prisma.Sql {
  return Prisma.sql`FLOOR(EXTRACT(EPOCH FROM date_trunc('day', ${local(expr, timeZone)})) / 86400.0)`;
}

/**
 * The monotonic business-timeline coordinate, in minutes, of a timestamp
 * expression — the SQL twin of pure/sla.ts businessCoordinateMinutes.
 *
 *   weekdaysBefore(d) = (d / 7) * 5 + (d % 7) - LEAST(GREATEST((d % 7) - 2, 0), 2)
 *
 * (epoch day 0 was a Thursday, so within each 7-day block starting at a multiple
 * of 7 the weekend sits at offsets 2 and 3 — the same table dayOfWeek() gives.)
 */
export function businessCoordinateSql(expr: Prisma.Sql, timeZone: string): Prisma.Sql {
  const d = epochDay(expr, timeZone);
  const weekdaysBefore = Prisma.sql`(
    FLOOR((${d}) / 7.0) * 5.0
    + MOD((${d})::numeric, 7::numeric)
    - LEAST(GREATEST(MOD((${d})::numeric, 7::numeric) - 2, 0), 2)
  )`;
  const isWeekend = Prisma.sql`MOD((${d})::numeric, 7::numeric) IN (2, 3)`;
  const minutesIntoDay = Prisma.sql`LEAST(1440.0, GREATEST(0.0,
    EXTRACT(EPOCH FROM (${local(expr, timeZone)} - date_trunc('day', ${local(expr, timeZone)}))) / 60.0
  ))`;
  return Prisma.sql`((${weekdaysBefore}) * 1440.0 + CASE WHEN ${isWeekend} THEN 0.0 ELSE ${minutesIntoDay} END)::float8`;
}

/** Business minutes between two timestamp expressions (never negative). */
function businessMinutesBetweenSql(
  startExpr: Prisma.Sql,
  endExpr: Prisma.Sql,
  timeZone: string,
): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN (${endExpr}) <= (${startExpr}) THEN 0.0
    ELSE GREATEST(0.0, ${businessCoordinateSql(endExpr, timeZone)} - ${businessCoordinateSql(startExpr, timeZone)})
  END`;
}

export interface SlaSqlOptions {
  /** Company IANA zone, resolved by the caller at call time (INV-045). */
  timeZone: string;
  /** Evaluation instant (the request's `now`). */
  now: Date;
  /** WorkflowState → business-day target, from SystemConfig (sla.ts getSlaTargets). */
  perStateBusinessDays: ReadonlyMap<string, number>;
}

/** `(VALUES ('state', days), ...)` for the configured per-state targets. */
function targetsValuesSql(perStateBusinessDays: ReadonlyMap<string, number>): Prisma.Sql {
  const rows = [...perStateBusinessDays.entries()].map(
    ([state, days]) => Prisma.sql`(${state}::text, ${days}::float8)`,
  );
  // Defensive: a registry with no SLA states still needs a well-typed relation.
  if (rows.length === 0) return Prisma.sql`(VALUES (NULL::text, NULL::float8))`;
  return Prisma.sql`(VALUES ${Prisma.join(rows, ", ")})`;
}

/**
 * Build the CTE chain that computes, per application in `scopeSql`, the live SLA
 * clock. `scopeSql` MUST be a SELECT yielding the columns
 *   "id", "workflowState", "previousStateForSuspend", "stateEnteredAt",
 *   "slaPausedAt", "submittedAt"
 * and carries the caller's SEC-14 WHERE scoping unchanged — this module never
 * widens a scope, it only aggregates over the one it is given.
 *
 * The chain defines a relation named `sla_status` with columns:
 *   "applicationId" text, "effectiveState" text, "elapsedMinutes" float8,
 *   "targetMinutes" float8, "slaStatus" text ('on-track' | 'at-risk' | 'overdue'
 *   | NULL when the state carries no clock).
 *
 * Callers append their own aggregate SELECT over `sla_status` (optionally
 * joining it), e.g. `WITH ${slaStatusCte(...)} SELECT COUNT(*) FILTER (...)`.
 */
export function slaStatusCte(scopeSql: Prisma.Sql, opts: SlaSqlOptions): Prisma.Sql {
  const { timeZone, now } = opts;
  const nowExpr = Prisma.sql`${now}::timestamp`;

  return Prisma.sql`
    sla_scope AS MATERIALIZED (${scopeSql}),
    sla_targets ("state", "days") AS MATERIALIZED ${targetsValuesSql(opts.perStateBusinessDays)},
    -- Effective state: while suspended the clock belongs to the pre-suspension
    -- state. Drafts / unsubmitted rows have no clock at all (engine parity).
    sla_eff AS MATERIALIZED (
      SELECT s."id" AS "applicationId",
             CASE WHEN s."workflowState"::text = 'suspended'
                  THEN s."previousStateForSuspend"::text
                  ELSE s."workflowState"::text END AS "effectiveState",
             (s."workflowState"::text = 'suspended') AS "suspendedNow",
             s."slaPausedAt" AS "slaPausedAt",
             s."stateEnteredAt" AS "stateEnteredAt"
      FROM sla_scope s
      WHERE s."submittedAt" IS NOT NULL
        AND s."workflowState"::text <> 'draft'
        AND (CASE WHEN s."workflowState"::text = 'suspended'
                  THEN s."previousStateForSuspend"::text
                  ELSE s."workflowState"::text END) IS NOT NULL
    ),
    -- One indexed history walk for the whole set (WALK-003), positioned so the
    -- backward walk of deriveStateClock becomes window arithmetic.
    sla_hist AS MATERIALIZED (
      SELECT wh."applicationId" AS "applicationId",
             wh."fromState"::text AS "fromState",
             wh."toState"::text AS "toState",
             wh."createdAt" AS "occurredAt",
             row_number() OVER wnd AS "rn",
             count(*) OVER (PARTITION BY wh."applicationId") AS "rowCount",
             lag(wh."fromState"::text) OVER wnd AS "prevFrom",
             lag(wh."toState"::text) OVER wnd AS "prevTo",
             lag(wh."createdAt") OVER wnd AS "prevAt",
             lead(wh."fromState"::text) OVER wnd AS "nextFrom",
             lead(wh."toState"::text) OVER wnd AS "nextTo"
      FROM "WorkflowHistory" wh
      JOIN sla_eff e ON e."applicationId" = wh."applicationId"
      WINDOW wnd AS (PARTITION BY wh."applicationId" ORDER BY wh."createdAt", wh."id")
    ),
    -- "blocked": a row the backward walk cannot step over (it breaks there).
    -- "stopper": a row the walk stops ON — a genuine entry, or an unpaired resume.
    sla_marked AS MATERIALIZED (
      SELECT h."applicationId" AS "applicationId",
             h."rn" AS "rn",
             h."occurredAt" AS "occurredAt",
             h."prevAt" AS "prevAt",
             (h."toState" <> e."effectiveState"
               AND NOT COALESCE(
                 h."toState" = 'suspended' AND h."fromState" = e."effectiveState"
                 AND ((h."rn" = h."rowCount" AND e."suspendedNow")
                      OR (h."nextTo" = e."effectiveState" AND h."nextFrom" = 'suspended')),
                 FALSE)
             ) AS "blocked",
             (h."toState" = e."effectiveState"
               AND (h."fromState" <> 'suspended'
                    OR NOT COALESCE(h."prevTo" = 'suspended' AND h."prevFrom" = e."effectiveState", FALSE))
             ) AS "stopper",
             COALESCE(h."toState" = e."effectiveState" AND h."fromState" = 'suspended'
                      AND h."prevTo" = 'suspended' AND h."prevFrom" = e."effectiveState", FALSE) AS "pairedResume",
             (h."rn" = h."rowCount" AND h."toState" = 'suspended'
              AND h."fromState" = e."effectiveState" AND e."suspendedNow") AS "trailingSuspend"
      FROM sla_hist h
      JOIN sla_eff e ON e."applicationId" = h."applicationId"
    ),
    -- Last row the walk cannot pass, then the walk's stopping row above it.
    sla_floor AS MATERIALIZED (
      SELECT m."applicationId" AS "applicationId",
             MAX(m."rn") FILTER (WHERE m."blocked") AS "blockedRn"
      FROM sla_marked m GROUP BY m."applicationId"
    ),
    sla_stop AS MATERIALIZED (
      SELECT m."applicationId" AS "applicationId",
             MAX(m."rn") FILTER (
               WHERE m."stopper" AND m."rn" > COALESCE(f."blockedRn", 0)
             ) AS "stopRn",
             MAX(f."blockedRn") AS "blockedRn"
      FROM sla_marked m
      LEFT JOIN sla_floor f ON f."applicationId" = m."applicationId"
      GROUP BY m."applicationId"
    ),
    sla_clock AS MATERIALIZED (
      SELECT e."applicationId" AS "applicationId",
             e."effectiveState" AS "effectiveState",
             e."suspendedNow" AS "suspendedNow",
             e."slaPausedAt" AS "slaPausedAt",
             COALESCE(sr."occurredAt", e."stateEnteredAt") AS "clockStart",
             -- Rows below this ordinal were never visited by the walk, so their
             -- suspensions are outside the current occupancy.
             COALESCE(st."stopRn", st."blockedRn", 0) AS "visitedFloor"
      FROM sla_eff e
      LEFT JOIN sla_stop st ON st."applicationId" = e."applicationId"
      LEFT JOIN sla_marked sr
             ON sr."applicationId" = e."applicationId" AND sr."rn" = st."stopRn"
    ),
    -- Closed suspensions the walk stepped over, clipped to [clockStart, now].
    sla_closed AS MATERIALIZED (
      SELECT c."applicationId" AS "applicationId",
             COALESCE(SUM(${businessMinutesBetweenSql(
               Prisma.sql`GREATEST(m."prevAt", c."clockStart")`,
               Prisma.sql`LEAST(m."occurredAt", ${nowExpr})`,
               timeZone,
             )}), 0.0) AS "excludedMinutes"
      FROM sla_clock c
      JOIN sla_marked m
        ON m."applicationId" = c."applicationId"
       AND m."pairedResume"
       AND m."rn" > c."visitedFloor"
      WHERE LEAST(m."occurredAt", ${nowExpr}) > GREATEST(m."prevAt", c."clockStart")
      GROUP BY c."applicationId"
    ),
    -- The open suspension (INV-012): [slaPausedAt ?? suspend row ?? now, now].
    sla_open AS MATERIALIZED (
      SELECT c."applicationId" AS "applicationId",
             ${businessMinutesBetweenSql(
               Prisma.sql`GREATEST(COALESCE(c."slaPausedAt", ts."occurredAt", ${nowExpr}), c."clockStart")`,
               nowExpr,
               timeZone,
             )} AS "excludedMinutes"
      FROM sla_clock c
      LEFT JOIN sla_marked ts
             ON ts."applicationId" = c."applicationId" AND ts."trailingSuspend"
      WHERE c."suspendedNow"
    ),
    sla_elapsed AS MATERIALIZED (
      SELECT c."applicationId" AS "applicationId",
             c."effectiveState" AS "effectiveState",
             GREATEST(0.0,
               ${businessMinutesBetweenSql(Prisma.sql`c."clockStart"`, nowExpr, timeZone)}
               - COALESCE(cl."excludedMinutes", 0.0)
               - COALESCE(op."excludedMinutes", 0.0)
             ) AS "elapsedMinutes",
             (t."days" * 1440.0) AS "targetMinutes"
      FROM sla_clock c
      LEFT JOIN sla_closed cl ON cl."applicationId" = c."applicationId"
      LEFT JOIN sla_open op ON op."applicationId" = c."applicationId"
      LEFT JOIN sla_targets t ON t."state" = c."effectiveState"
    ),
    sla_status AS MATERIALIZED (
      SELECT e."applicationId" AS "applicationId",
             e."effectiveState" AS "effectiveState",
             e."elapsedMinutes" AS "elapsedMinutes",
             e."targetMinutes" AS "targetMinutes",
             CASE
               WHEN e."targetMinutes" IS NULL THEN NULL
               WHEN e."targetMinutes" <= 0 THEN 'overdue'
               WHEN e."elapsedMinutes" > e."targetMinutes" THEN 'overdue'
               WHEN e."elapsedMinutes" >= 0.75 * e."targetMinutes" THEN 'at-risk'
               ELSE 'on-track'
             END AS "slaStatus",
             CASE WHEN e."targetMinutes" IS NULL THEN NULL
                  ELSE e."elapsedMinutes" / 1440.0 END AS "businessDaysElapsed"
      FROM sla_elapsed e
    )`;
}
