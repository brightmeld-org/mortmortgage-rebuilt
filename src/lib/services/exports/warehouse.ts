// Data-warehouse extract service (task-042 — REQ-077 / NFR-015, RFP §4.9.5,
// WALK-006, SEC-14, AC-51).
//
// Produces a ZIP (hand-rolled writer, src/lib/pure/zip.ts) containing one CSV
// per star-schema table plus `schema.json` describing every column of every
// table. The WAREHOUSE_TABLES descriptor below is the single authority for
// both the CSV headers and schema.json — they cannot drift.
//
// SEC-14 / WALK-006: every table streams by keyset cursor (batches <= 1000,
// every SELECT carries LIMIT/cursor or is an aggregate); rows are folded into
// the ZIP stream chunk-by-chunk — no table is ever held in memory.
//
// Modes (contracts §B `?mode=full|incremental&since=<ISO>`):
//   - full (default): every row of every table.
//   - incremental: rows changed since `?since`. Per-table basis (documented in
//     schema.json `incrementalBasis`): the source row's `updatedAt > since`
//     for all fact tables, dim_caseworker and dim_borrower; dim_date emits
//     dates strictly after `since`'s America/New_York calendar date; the
//     static enum dimensions (dim_loan_type / dim_property_type /
//     dim_workflow_state) are always emitted in full (tiny, immutable).
//
// dim_borrower (AC-51): NO ssn column, NO dob column — DOB is decrypted only
// to derive age_band (age as of extract time, documented) and discarded.
//
// CSV encoding: RFC-4180 (quote cells containing separators/quotes/newlines,
// CRLF row endings) + csv-safe formula-prefix escaping. Own copy of the
// established csv-safe pattern (task-038/039) — builder-common forbids
// refactoring theirs from this task.

import type { PrismaClient, Prisma, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { getCompanyTimeZone } from "@/lib/services/sla";
import { WORKFLOW_STATE_LABELS } from "@/lib/pure/workflow";
import { decryptField } from "@/lib/crypto/encryption";
import { createZipStream, type ZipEntry } from "@/lib/pure/zip";

// ---------------------------------------------------------------------------
// Query-parameter boundary
// ---------------------------------------------------------------------------

export type WarehouseMode = "full" | "incremental";

export interface WarehouseParams {
  mode: WarehouseMode;
  /** Non-null exactly when mode = incremental. */
  since: Date | null;
}

/**
 * Validate `?mode=full|incremental&since=<ISO>`: mode defaults to full;
 * `since` is required (valid ISO timestamp) for incremental and rejected for
 * full. Throws HttpProblem 400 with details[].
 */
export function parseWarehouseParams(request: Request): WarehouseParams {
  const url = new URL(request.url);
  const modeRaw = url.searchParams.get("mode");
  const sinceRaw = url.searchParams.get("since");
  const details: string[] = [];

  let mode: WarehouseMode = "full";
  if (modeRaw !== null) {
    if (modeRaw === "full" || modeRaw === "incremental") {
      mode = modeRaw;
    } else {
      details.push('mode: must be "full" or "incremental"');
    }
  }

  let since: Date | null = null;
  if (mode === "incremental") {
    if (sinceRaw === null || sinceRaw.trim() === "") {
      details.push("since: required for incremental mode (ISO 8601 timestamp)");
    } else {
      const parsed = new Date(sinceRaw);
      if (Number.isNaN(parsed.getTime())) {
        details.push("since: must be a valid ISO 8601 timestamp");
      } else {
        since = parsed;
      }
    }
  } else if (sinceRaw !== null) {
    details.push("since: only valid together with mode=incremental");
  }

  if (details.length > 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details,
    });
  }
  return { mode, since };
}

// ---------------------------------------------------------------------------
// CSV encoding (csv-safe + RFC-4180; own copy — see module header)
// ---------------------------------------------------------------------------

/** Encode one CSV cell: formula-leading chars apostrophe-prefixed; RFC-4180 quoting. */
export function csvCell(value: string): string {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvLine(cells: readonly string[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

// ---------------------------------------------------------------------------
// Star-schema descriptor (single authority: CSV headers AND schema.json)
// ---------------------------------------------------------------------------

export interface WarehouseColumn {
  name: string;
  type: string;
  description: string;
}

export interface WarehouseTableSpec {
  name: string;
  grain: string;
  incrementalBasis: string;
  columns: readonly WarehouseColumn[];
}

/** WorkflowState machine names in contract order (days_in_* column order). */
export const WORKFLOW_STATES: readonly WorkflowState[] = [
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

const col = (name: string, type: string, description: string): WarehouseColumn => ({
  name,
  type,
  description,
});

const daysInStateColumns: WarehouseColumn[] = WORKFLOW_STATES.map((state) =>
  col(
    `days_in_${state}`,
    "number",
    `Cumulative days the application has spent in the ${state} state (from WorkflowHistory; current state counted up to extract time).`,
  ),
);

const STATIC_DIM_BASIS = "static dimension — always emitted in full (immutable enum table)";

export const WAREHOUSE_TABLES: readonly WarehouseTableSpec[] = [
  {
    name: "fact_application",
    grain: "one row per application",
    incrementalBasis: "Application.updatedAt > since",
    columns: [
      col("application_id", "string", "Application UUID (degenerate key)."),
      col("application_number", "string", "Human-readable MM-YYYY-NNNNNN number."),
      col("borrower_user_id", "string", "Owning borrower User UUID."),
      col("workflow_state", "string", "Current WorkflowState (key into dim_workflow_state)."),
      col("outcome", "string", "Final outcome: approved / denied / blank while undecided."),
      col("priority", "string", "Priority: urgent / high / normal / low."),
      col("loan_type", "string", "LoanDetails.loanType (key into dim_loan_type; blank when unset)."),
      col("property_type", "string", "SubjectProperty.propertyType (key into dim_property_type; blank when unset)."),
      col("occupancy", "string", "SubjectProperty.occupancy (blank when unset)."),
      col("requested_loan_amount", "number", "LoanDetails.requestedLoanAmount (blank when unset)."),
      col("dti", "number", "Stored shared-module DTI percent (task-010, AC-13)."),
      col("ltv", "number", "Stored shared-module LTV percent (task-010, AC-13)."),
      col("cltv", "number", "Stored shared-module CLTV percent (task-010, AC-13)."),
      col("revision_cycles", "number", "Completed revision cycles."),
      col("escalation_required", "boolean", "Level-2 escalation required at L1 decision."),
      col("submitted_at", "timestamp", "Submission instant (ISO 8601; blank while draft)."),
      col("decided_at", "timestamp", "Decision instant (ISO 8601; blank while undecided)."),
      col("submitted_date_key", "number", "dim_date key (YYYYMMDD, America/New_York) of submission."),
      col("decided_date_key", "number", "dim_date key (YYYYMMDD, America/New_York) of decision."),
      ...daysInStateColumns,
      col("created_at", "timestamp", "Row creation instant."),
      col("updated_at", "timestamp", "Row update instant (incremental basis)."),
    ],
  },
  {
    name: "fact_workflow_event",
    grain: "one row per workflow transition (WorkflowHistory)",
    incrementalBasis: "WorkflowHistory.updatedAt > since",
    columns: [
      col("workflow_event_id", "string", "WorkflowHistory UUID."),
      col("application_id", "string", "Application UUID."),
      col("from_state", "string", "State before the transition (key into dim_workflow_state)."),
      col("to_state", "string", "State after the transition (key into dim_workflow_state)."),
      col("actor_user_id", "string", "Acting User UUID (blank for SYSTEM transitions)."),
      col("actor_role", "string", "Actor role label recorded on the transition."),
      col("version_number", "number", "Application version at the transition (blank when n/a)."),
      col("occurred_at", "timestamp", "Transition instant (ISO 8601)."),
      col("occurred_date_key", "number", "dim_date key (YYYYMMDD, America/New_York)."),
      col("updated_at", "timestamp", "Row update instant (incremental basis)."),
    ],
  },
  {
    name: "fact_underwriting_check",
    grain: "one row per underwriting check execution (UnderwritingResult)",
    incrementalBasis: "UnderwritingResult.updatedAt > since",
    columns: [
      col("underwriting_check_id", "string", "UnderwritingResult UUID."),
      col("application_id", "string", "Application UUID."),
      col("check_type", "string", "credit / income / avm / pricing / aus."),
      col("status", "string", "running / completed / error."),
      col("risk_badge", "string", "green / yellow / red (blank when none)."),
      col("is_stale", "boolean", "Superseded-by-data-change staleness flag."),
      col("provider", "string", "Provider name that executed the check."),
      col("requested_by_user_id", "string", "Requesting User UUID."),
      col("requested_at", "timestamp", "Request instant (ISO 8601)."),
      col("completed_at", "timestamp", "Completion instant (blank while running)."),
      col("duration_seconds", "number", "completed_at - requested_at in seconds (blank while running)."),
      col("requested_date_key", "number", "dim_date key (YYYYMMDD, America/New_York)."),
      col("updated_at", "timestamp", "Row update instant (incremental basis)."),
    ],
  },
  {
    name: "fact_assignment",
    grain: "one row per caseworker assignment interval (CaseworkerAssignment)",
    incrementalBasis: "CaseworkerAssignment.updatedAt > since",
    columns: [
      col("assignment_id", "string", "CaseworkerAssignment UUID."),
      col("application_id", "string", "Application UUID."),
      col("caseworker_user_id", "string", "Assigned caseworker User UUID (key into dim_caseworker)."),
      col("assigned_by_user_id", "string", "Assigning User UUID (blank for self-claim)."),
      col("method", "string", "claim / manual / bulk / auto / reassign."),
      col("reason", "string", "Reassignment reason text (blank when none)."),
      col("end_reason", "string", "Assignment end reason (blank while active)."),
      col("is_active", "boolean", "True while ended_at is null."),
      col("assigned_at", "timestamp", "Assignment start instant (ISO 8601)."),
      col("ended_at", "timestamp", "Assignment end instant (blank while active)."),
      col("duration_days", "number", "Days from assigned_at to ended_at (or extract time while active)."),
      col("assigned_date_key", "number", "dim_date key (YYYYMMDD, America/New_York)."),
      col("updated_at", "timestamp", "Row update instant (incremental basis)."),
    ],
  },
  {
    name: "fact_document",
    grain: "one row per document (Document)",
    incrementalBasis: "Document.updatedAt > since",
    columns: [
      col("document_id", "string", "Document UUID."),
      col("application_id", "string", "Application UUID."),
      col("document_type", "string", "DocumentType value."),
      col("status", "string", "pending / accepted / insufficient / waived."),
      col("status_reason", "string", "Reviewer status reason (blank when none)."),
      col("checklist_item_key", "string", "Fulfilled checklist item key (blank when none)."),
      col("uploaded_by_user_id", "string", "Uploading User UUID."),
      col("is_seed", "boolean", "Demo-seed flag."),
      col("created_at", "timestamp", "Upload instant (ISO 8601)."),
      col("created_date_key", "number", "dim_date key (YYYYMMDD, America/New_York)."),
      col("updated_at", "timestamp", "Row update instant (incremental basis)."),
    ],
  },
  {
    name: "dim_date",
    grain: "one row per calendar date (America/New_York) from the earliest application to extract day",
    incrementalBasis: "date_iso strictly after since's America/New_York calendar date",
    columns: [
      col("date_key", "number", "YYYYMMDD surrogate key."),
      col("date_iso", "string", "ISO calendar date (YYYY-MM-DD)."),
      col("year", "number", "Calendar year."),
      col("quarter", "number", "Calendar quarter 1-4."),
      col("month", "number", "Calendar month 1-12."),
      col("month_name", "string", "English month name."),
      col("day_of_month", "number", "Day of month 1-31."),
      col("day_of_week_iso", "number", "ISO weekday 1 (Monday) - 7 (Sunday)."),
      col("day_name", "string", "English weekday name."),
      col("is_weekend", "boolean", "True for Saturday/Sunday."),
    ],
  },
  {
    name: "dim_caseworker",
    grain: "one row per staff user (CASEWORKER or SUPERVISOR)",
    incrementalBasis: "User.updatedAt > since",
    columns: [
      col("caseworker_user_id", "string", "User UUID."),
      col("first_name", "string", "First name."),
      col("last_name", "string", "Last name."),
      col("role", "string", "CASEWORKER or SUPERVISOR."),
      col("status", "string", "active / inactive."),
      col("is_demo", "boolean", "Demo persona flag."),
      col("created_at", "timestamp", "Row creation instant."),
      col("updated_at", "timestamp", "Row update instant (incremental basis)."),
    ],
  },
  {
    name: "dim_loan_type",
    grain: "one row per LoanType enum value",
    incrementalBasis: STATIC_DIM_BASIS,
    columns: [
      col("loan_type_code", "string", "LoanType enum literal (contracts.json)."),
      col("loan_type_label", "string", "Display label."),
    ],
  },
  {
    name: "dim_property_type",
    grain: "one row per PropertyType enum value",
    incrementalBasis: STATIC_DIM_BASIS,
    columns: [
      col("property_type_code", "string", "PropertyType enum literal (contracts.json)."),
      col("property_type_label", "string", "Display label."),
    ],
  },
  {
    name: "dim_workflow_state",
    grain: "one row per WorkflowState enum value",
    incrementalBasis: STATIC_DIM_BASIS,
    columns: [
      col("workflow_state_code", "string", "WorkflowState machine name (contracts.json)."),
      col("workflow_state_label", "string", "§4.5.1 display label (shared WORKFLOW_STATE_LABELS)."),
      col("sort_order", "number", "Contract declaration order."),
    ],
  },
  {
    name: "dim_borrower",
    grain: "one row per borrower record (Borrower) — MASKED: no SSN, no DOB (age band instead, AC-51)",
    incrementalBasis: "Borrower.updatedAt > since",
    columns: [
      col("borrower_id", "string", "Borrower UUID."),
      col("application_id", "string", "Application UUID."),
      col("ordinal", "number", "1 = primary borrower, 2 = co-borrower."),
      col("first_name", "string", "First name (blank when unset)."),
      col("last_name", "string", "Last name (blank when unset)."),
      col("age_band", "string", "Age band at extract time (<25 / 25-34 / 35-44 / 45-54 / 55-64 / 65-74 / >74 / unknown) — replaces DOB per AC-51."),
      col("citizenship", "string", "Citizenship enum value (blank when unset)."),
      col("marital_status", "string", "married / separated / unmarried (blank when unset)."),
      col("dependents_count", "number", "Number of dependents (blank when unset)."),
      col("credit_type", "string", "individual / joint (blank when unset)."),
      col("updated_at", "timestamp", "Row update instant (incremental basis)."),
    ],
  },
];

/** schema.json content — generated from the same descriptor as the CSV headers. */
export function buildWarehouseSchema(
  params: WarehouseParams,
  timeZone: string,
): Record<string, unknown> {
  return {
    extract: "MortMortgage data-warehouse star schema (RFP §4.9.5)",
    generatedAt: new Date().toISOString(),
    mode: params.mode,
    since: params.since ? params.since.toISOString() : null,
    timezone: timeZone,
    tables: WAREHOUSE_TABLES.map((t) => ({
      name: t.name,
      file: `${t.name}.csv`,
      grain: t.grain,
      incrementalBasis: t.incrementalBasis,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, description: c.description })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Cached per zone — the company zone is configurable (INV-045). */
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();

function etIsoDate(instant: Date, timeZone: string): string {
  let fmt = DATE_FORMATS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DATE_FORMATS.set(timeZone, fmt);
  }
  return fmt.format(instant); // en-CA => YYYY-MM-DD
}

function dateKey(instant: Date | null, timeZone: string): string {
  return instant ? etIsoDate(instant, timeZone).replace(/-/g, "") : "";
}

function iso(instant: Date | null): string {
  return instant ? instant.toISOString() : "";
}

function numText(value: number | Prisma.Decimal | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(Number(value));
}

function boolText(value: boolean): string {
  return value ? "true" : "false";
}

function jsonStr(value: Prisma.JsonValue | null | undefined, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function jsonNum(value: Prisma.JsonValue | null | undefined, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** AC-51 age band (age as of extract time — analytics dimension, documented). */
export function ageBand(age: number | null): string {
  if (age === null || !Number.isFinite(age) || age < 0) return "unknown";
  if (age < 25) return "<25";
  if (age <= 34) return "25-34";
  if (age <= 44) return "35-44";
  if (age <= 54) return "45-54";
  if (age <= 64) return "55-64";
  if (age <= 74) return "65-74";
  return ">74";
}

function titleCase(code: string): string {
  return code
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Row streams (keyset cursor, batches <= 1000 — WALK-006)
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 1000;

export interface WarehouseStreamOptions {
  /** Cursor batch size (<= 1000; overridable for evidence). */
  batchSize?: number;
}

type RowGenerator = AsyncGenerator<string[]>;

async function loadAllBatched<T extends { id: string }>(
  fetchPage: (cursorId: string | null) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursorId: string | null = null;
  for (;;) {
    const page = await fetchPage(cursorId);
    rows.push(...page);
    if (page.length === 0) break;
    cursorId = page[page.length - 1]!.id;
  }
  return rows;
}

interface WhAppRow {
  id: string;
  applicationNumber: string;
  borrowerUserId: string;
  workflowState: WorkflowState;
  outcome: string | null;
  priority: string;
  revisionCycles: number;
  escalationRequired: boolean;
  submittedAt: Date | null;
  decidedAt: Date | null;
  dti: Prisma.Decimal | null;
  ltv: Prisma.Decimal | null;
  cltv: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
  data: { loan: Prisma.JsonValue | null; subjectProperty: Prisma.JsonValue | null } | null;
}

async function* factApplicationRows(
  db: PrismaClient,
  since: Date | null,
  batchSize: number,
  extractedAt: Date,
  timeZone: string,
): RowGenerator {
  let cursorId: string | null = null;
  for (;;) {
    const apps: WhAppRow[] = await db.application.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      cursor: cursorId === null ? undefined : { id: cursorId },
      skip: cursorId === null ? 0 : 1,
      select: {
        id: true,
        applicationNumber: true,
        borrowerUserId: true,
        workflowState: true,
        outcome: true,
        priority: true,
        revisionCycles: true,
        escalationRequired: true,
        submittedAt: true,
        decidedAt: true,
        dti: true,
        ltv: true,
        cltv: true,
        createdAt: true,
        updatedAt: true,
        data: { select: { loan: true, subjectProperty: true } },
      },
    });
    if (apps.length === 0) break;
    cursorId = apps[apps.length - 1]!.id;
    const ids = apps.map((a) => a.id);

    // Bounded history load for the days-in-state measures (WALK-003-style
    // per-application walk, batched with LIMIT for SEC-14).
    const history = await loadAllBatched((cur) =>
      db.workflowHistory.findMany({
        where: { applicationId: { in: ids } },
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cur ? { cursor: { id: cur }, skip: 1 } : {}),
        select: { id: true, applicationId: true, fromState: true, toState: true, createdAt: true },
      }),
    );
    const historyByApp = new Map<string, { toState: WorkflowState; createdAt: Date }[]>();
    for (const row of history) {
      const list = historyByApp.get(row.applicationId) ?? [];
      list.push({ toState: row.toState, createdAt: row.createdAt });
      historyByApp.set(row.applicationId, list);
    }

    for (const app of apps) {
      const events = (historyByApp.get(app.id) ?? []).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      // Timeline: created in draft; each transition moves to toState at its
      // instant; the current state accrues until extract time.
      const daysMs = new Map<WorkflowState, number>();
      let currentState: WorkflowState = "draft";
      let currentSince = app.createdAt;
      for (const event of events) {
        const elapsed = Math.max(0, event.createdAt.getTime() - currentSince.getTime());
        daysMs.set(currentState, (daysMs.get(currentState) ?? 0) + elapsed);
        currentState = event.toState;
        currentSince = event.createdAt;
      }
      const tailElapsed = Math.max(0, extractedAt.getTime() - currentSince.getTime());
      daysMs.set(currentState, (daysMs.get(currentState) ?? 0) + tailElapsed);

      yield [
        app.id,
        app.applicationNumber,
        app.borrowerUserId,
        app.workflowState,
        app.outcome ?? "",
        app.priority,
        jsonStr(app.data?.loan, "loanType"),
        jsonStr(app.data?.subjectProperty, "propertyType"),
        jsonStr(app.data?.subjectProperty, "occupancy"),
        jsonNum(app.data?.loan, "requestedLoanAmount"),
        numText(app.dti),
        numText(app.ltv),
        numText(app.cltv),
        String(app.revisionCycles),
        boolText(app.escalationRequired),
        iso(app.submittedAt),
        iso(app.decidedAt),
        dateKey(app.submittedAt, timeZone),
        dateKey(app.decidedAt, timeZone),
        ...WORKFLOW_STATES.map((state) => String(round2((daysMs.get(state) ?? 0) / 86_400_000))),
        iso(app.createdAt),
        iso(app.updatedAt),
      ];
    }
  }
}

interface WhEventRow {
  id: string;
  applicationId: string;
  fromState: string;
  toState: string;
  actorUserId: string | null;
  actorRole: string;
  versionNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
}

async function* factWorkflowEventRows(
  db: PrismaClient,
  since: Date | null,
  batchSize: number,
  timeZone: string,
): RowGenerator {
  let cursorId: string | null = null;
  for (;;) {
    const rows: WhEventRow[] = await db.workflowHistory.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      cursor: cursorId === null ? undefined : { id: cursorId },
      skip: cursorId === null ? 0 : 1,
      select: {
        id: true,
        applicationId: true,
        fromState: true,
        toState: true,
        actorUserId: true,
        actorRole: true,
        versionNumber: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      yield [
        row.id,
        row.applicationId,
        row.fromState,
        row.toState,
        row.actorUserId ?? "",
        row.actorRole,
        row.versionNumber === null ? "" : String(row.versionNumber),
        iso(row.createdAt),
        dateKey(row.createdAt, timeZone),
        iso(row.updatedAt),
      ];
    }
  }
}

interface WhCheckRow {
  id: string;
  applicationId: string;
  checkType: string;
  status: string;
  riskBadge: string | null;
  isStale: boolean;
  provider: string | null;
  requestedByUserId: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}

async function* factUnderwritingCheckRows(
  db: PrismaClient,
  since: Date | null,
  batchSize: number,
  timeZone: string,
): RowGenerator {
  let cursorId: string | null = null;
  for (;;) {
    const rows: WhCheckRow[] = await db.underwritingResult.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      cursor: cursorId === null ? undefined : { id: cursorId },
      skip: cursorId === null ? 0 : 1,
      select: {
        id: true,
        applicationId: true,
        checkType: true,
        status: true,
        riskBadge: true,
        isStale: true,
        provider: true,
        requestedByUserId: true,
        requestedAt: true,
        completedAt: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const durationSeconds =
        row.completedAt !== null
          ? String(round2((row.completedAt.getTime() - row.requestedAt.getTime()) / 1000))
          : "";
      yield [
        row.id,
        row.applicationId,
        row.checkType,
        row.status,
        row.riskBadge ?? "",
        boolText(row.isStale),
        row.provider ?? "",
        row.requestedByUserId ?? "",
        iso(row.requestedAt),
        iso(row.completedAt),
        durationSeconds,
        dateKey(row.requestedAt, timeZone),
        iso(row.updatedAt),
      ];
    }
  }
}

interface WhAssignmentRow {
  id: string;
  applicationId: string;
  caseworkerUserId: string;
  assignedByUserId: string | null;
  method: string;
  reason: string | null;
  endReason: string | null;
  assignedAt: Date;
  endedAt: Date | null;
  updatedAt: Date;
}

async function* factAssignmentRows(
  db: PrismaClient,
  since: Date | null,
  batchSize: number,
  extractedAt: Date,
  timeZone: string,
): RowGenerator {
  let cursorId: string | null = null;
  for (;;) {
    const rows: WhAssignmentRow[] = await db.caseworkerAssignment.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      cursor: cursorId === null ? undefined : { id: cursorId },
      skip: cursorId === null ? 0 : 1,
      select: {
        id: true,
        applicationId: true,
        caseworkerUserId: true,
        assignedByUserId: true,
        method: true,
        reason: true,
        endReason: true,
        assignedAt: true,
        endedAt: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const end = row.endedAt ?? extractedAt;
      yield [
        row.id,
        row.applicationId,
        row.caseworkerUserId,
        row.assignedByUserId ?? "",
        row.method,
        row.reason ?? "",
        row.endReason ?? "",
        boolText(row.endedAt === null),
        iso(row.assignedAt),
        iso(row.endedAt),
        String(round2(Math.max(0, end.getTime() - row.assignedAt.getTime()) / 86_400_000)),
        dateKey(row.assignedAt, timeZone),
        iso(row.updatedAt),
      ];
    }
  }
}

interface WhDocumentRow {
  id: string;
  applicationId: string;
  documentType: string;
  status: string;
  statusReason: string | null;
  checklistItemKey: string | null;
  uploadedByUserId: string | null;
  isSeed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

async function* factDocumentRows(
  db: PrismaClient,
  since: Date | null,
  batchSize: number,
  timeZone: string,
): RowGenerator {
  let cursorId: string | null = null;
  for (;;) {
    const rows: WhDocumentRow[] = await db.document.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      cursor: cursorId === null ? undefined : { id: cursorId },
      skip: cursorId === null ? 0 : 1,
      select: {
        id: true,
        applicationId: true,
        documentType: true,
        status: true,
        statusReason: true,
        checklistItemKey: true,
        uploadedByUserId: true,
        isSeed: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      yield [
        row.id,
        row.applicationId,
        row.documentType,
        row.status,
        row.statusReason ?? "",
        row.checklistItemKey ?? "",
        row.uploadedByUserId ?? "",
        boolText(row.isSeed),
        iso(row.createdAt),
        dateKey(row.createdAt, timeZone),
        iso(row.updatedAt),
      ];
    }
  }
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function* dimDateRows(
  db: PrismaClient,
  since: Date | null,
  extractedAt: Date,
  timeZone: string,
): RowGenerator {
  // Aggregate min — bounded query (SEC-14).
  const agg = await db.application.aggregate({ _min: { createdAt: true } });
  const firstIso = etIsoDate(agg._min.createdAt ?? extractedAt, timeZone);
  const lastIso = etIsoDate(extractedAt, timeZone);
  const sinceIso = since ? etIsoDate(since, timeZone) : null;

  // Walk calendar dates as UTC-noon instants (date arithmetic only — the ET
  // calendar labels come from the ISO strings themselves).
  const [fy, fm, fd] = firstIso.split("-").map(Number);
  const [ly, lm, ld] = lastIso.split("-").map(Number);
  const cursor = new Date(Date.UTC(fy!, fm! - 1, fd!, 12));
  const end = new Date(Date.UTC(ly!, lm! - 1, ld!, 12));
  while (cursor.getTime() <= end.getTime()) {
    const isoDate = cursor.toISOString().slice(0, 10);
    if (sinceIso === null || isoDate > sinceIso) {
      const [y, m, d] = isoDate.split("-").map(Number);
      const dowIso = ((cursor.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
      yield [
        isoDate.replace(/-/g, ""),
        isoDate,
        String(y),
        String(Math.floor((m! - 1) / 3) + 1),
        String(m),
        MONTH_NAMES[m! - 1]!,
        String(d),
        String(dowIso),
        DAY_NAMES[dowIso - 1]!,
        boolText(dowIso >= 6),
      ];
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

async function* dimCaseworkerRows(
  db: PrismaClient,
  since: Date | null,
  batchSize: number,
): RowGenerator {
  let cursorId: string | null = null;
  for (;;) {
    const rows: {
      id: string;
      firstName: string;
      lastName: string;
      role: string;
      status: string;
      isDemo: boolean;
      createdAt: Date;
      updatedAt: Date;
    }[] = await db.user.findMany({
      where: {
        role: { in: ["CASEWORKER", "SUPERVISOR"] },
        ...(since ? { updatedAt: { gt: since } } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      cursor: cursorId === null ? undefined : { id: cursorId },
      skip: cursorId === null ? 0 : 1,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        isDemo: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      yield [
        row.id,
        row.firstName,
        row.lastName,
        row.role,
        row.status,
        boolText(row.isDemo),
        iso(row.createdAt),
        iso(row.updatedAt),
      ];
    }
  }
}

const LOAN_TYPES = ["conventional", "fha", "va", "usda"] as const;
const LOAN_TYPE_LABELS: Record<string, string> = {
  conventional: "Conventional",
  fha: "FHA",
  va: "VA",
  usda: "USDA",
};

async function* dimLoanTypeRows(): RowGenerator {
  for (const code of LOAN_TYPES) {
    yield [code, LOAN_TYPE_LABELS[code] ?? titleCase(code)];
  }
}

const PROPERTY_TYPES = [
  "single-family-detached",
  "townhouse-pud",
  "condominium",
  "cooperative",
  "two-unit",
  "three-unit",
  "four-unit",
  "manufactured-home",
] as const;

async function* dimPropertyTypeRows(): RowGenerator {
  for (const code of PROPERTY_TYPES) {
    yield [code, titleCase(code)];
  }
}

async function* dimWorkflowStateRows(): RowGenerator {
  for (let i = 0; i < WORKFLOW_STATES.length; i++) {
    const state = WORKFLOW_STATES[i]!;
    yield [state, WORKFLOW_STATE_LABELS[state], String(i + 1)];
  }
}

async function* dimBorrowerRows(
  db: PrismaClient,
  since: Date | null,
  batchSize: number,
  extractedAt: Date,
  timeZone: string,
): RowGenerator {
  const nowIso = etIsoDate(extractedAt, timeZone);
  const [ny, nm, nd] = nowIso.split("-").map(Number);
  let cursorId: string | null = null;
  for (;;) {
    const rows: {
      id: string;
      applicationId: string;
      ordinal: number;
      firstName: string | null;
      lastName: string | null;
      dateOfBirthCiphertext: Uint8Array | null;
      dateOfBirthKeyId: string | null;
      citizenship: string | null;
      maritalStatus: string | null;
      dependentsCount: number | null;
      creditType: string | null;
      updatedAt: Date;
    }[] = await db.borrower.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      cursor: cursorId === null ? undefined : { id: cursorId },
      skip: cursorId === null ? 0 : 1,
      select: {
        id: true,
        applicationId: true,
        ordinal: true,
        firstName: true,
        lastName: true,
        dateOfBirthCiphertext: true,
        dateOfBirthKeyId: true,
        citizenship: true,
        maritalStatus: true,
        dependentsCount: true,
        creditType: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      // AC-51: DOB is decrypted ONLY to derive the age band, never emitted.
      let age: number | null = null;
      if (row.dateOfBirthCiphertext && row.dateOfBirthKeyId) {
        try {
          const dobIso = decryptField({
            ciphertext: Buffer.from(row.dateOfBirthCiphertext),
            keyId: row.dateOfBirthKeyId,
          });
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobIso.trim());
          if (m) {
            age = ny! - Number(m[1]);
            if (nm! < Number(m[2]) || (nm! === Number(m[2]) && nd! < Number(m[3]))) age -= 1;
          }
        } catch {
          age = null;
        }
      }
      yield [
        row.id,
        row.applicationId,
        String(row.ordinal),
        row.firstName ?? "",
        row.lastName ?? "",
        ageBand(age),
        row.citizenship ?? "",
        row.maritalStatus ?? "",
        row.dependentsCount === null ? "" : String(row.dependentsCount),
        row.creditType ?? "",
        iso(row.updatedAt),
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// ZIP assembly
// ---------------------------------------------------------------------------

const CSV_CHUNK_ROWS = 200;

/** Fold a row generator into encoded CSV chunks (header first). */
async function* csvChunks(header: readonly string[], rows: RowGenerator): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  yield encoder.encode(csvLine(header));
  let buffer = "";
  let buffered = 0;
  for await (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`warehouse row has ${row.length} cells, header has ${header.length}`);
    }
    buffer += csvLine(row);
    buffered += 1;
    if (buffered >= CSV_CHUNK_ROWS) {
      yield encoder.encode(buffer);
      buffer = "";
      buffered = 0;
    }
  }
  if (buffer.length > 0) yield encoder.encode(buffer);
}

function tableSpec(name: string): WarehouseTableSpec {
  const spec = WAREHOUSE_TABLES.find((t) => t.name === name);
  if (!spec) throw new Error(`unknown warehouse table ${name}`);
  return spec;
}

/**
 * The complete warehouse extract as a streaming ZIP byte generator:
 * schema.json + one CSV per star-schema table, each table streamed by keyset
 * cursor (WALK-006) into the hand-rolled ZIP writer.
 */
export function generateWarehouseZip(
  params: WarehouseParams,
  db: PrismaClient = prisma,
  opts: WarehouseStreamOptions = {},
): AsyncGenerator<Uint8Array> {
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, 1000));
  const since = params.since;
  const extractedAt = new Date();
  const encoder = new TextEncoder();

  async function* entries(): AsyncGenerator<ZipEntry> {
    // INV-045: the company zone is resolved ONCE per extract, at call time, and
    // threaded into every table generator + the schema descriptor.
    const timeZone = await getCompanyTimeZone();
    yield {
      name: "schema.json",
      data: [encoder.encode(JSON.stringify(buildWarehouseSchema(params, timeZone), null, 2))],
    };
    const tables: [string, RowGenerator][] = [
      ["fact_application", factApplicationRows(db, since, batchSize, extractedAt, timeZone)],
      ["fact_workflow_event", factWorkflowEventRows(db, since, batchSize, timeZone)],
      ["fact_underwriting_check", factUnderwritingCheckRows(db, since, batchSize, timeZone)],
      ["fact_assignment", factAssignmentRows(db, since, batchSize, extractedAt, timeZone)],
      ["fact_document", factDocumentRows(db, since, batchSize, timeZone)],
      ["dim_date", dimDateRows(db, since, extractedAt, timeZone)],
      ["dim_caseworker", dimCaseworkerRows(db, since, batchSize)],
      ["dim_loan_type", dimLoanTypeRows()],
      ["dim_property_type", dimPropertyTypeRows()],
      ["dim_workflow_state", dimWorkflowStateRows()],
      ["dim_borrower", dimBorrowerRows(db, since, batchSize, extractedAt, timeZone)],
    ];
    for (const [name, rows] of tables) {
      const spec = tableSpec(name);
      yield {
        name: `${name}.csv`,
        data: csvChunks(spec.columns.map((c) => c.name), rows),
      };
    }
  }

  return createZipStream(entries());
}
