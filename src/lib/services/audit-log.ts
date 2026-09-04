// Audit-log read side (task-039) — REQ-064, NFR-015, INV-009, SEC-14.
//
// Serves the two GET-only §B endpoints:
//   GET /api/admin/audit-log         → AuditLogPage (offset-limit, max 100,
//                                      viewer default 25/page)
//   GET /api/admin/audit-log/export  → streamed text/csv (cursor batches,
//                                      configured row cap audit.exportRowCap)
//
// Query parameters (§B ~line 2654, auto-applying):
//   ?actionType=&applicationSearch=&userSearch=&from=&to=&page
//   - actionType: exact match. contracts.json defines NO enum for
//     AuditLogEntryInfo.actionType (string on the wire); the UI dropdown is
//     sourced from listDistinctActionTypes() (real values in use), and an
//     unknown hand-typed value simply matches zero rows (documented
//     interpretation — no fabricated enum whitelist).
//   - applicationSearch: application number OR borrower name (search-as-you-
//     type). Borrower names are PLAINTEXT columns (only SSN/DOB are encrypted
//     at rest — prisma/schema.prisma Borrower), so the match pushes down to an
//     indexed-relation DB WHERE — same data the queue/supervisor-list search
//     matches (User.firstName/lastName + Borrower rows), but expressed
//     DB-side so the export can cursor-batch over it (SEC-14) instead of
//     loading candidates into memory.
//   - userSearch: acting user's name OR email (actorUser relation).
//   - from/to: timestamp range; bare YYYY-MM-DD is whole-day inclusive on the
//     `to` side (established supervisor-list convention); span > 1096 days or
//     from > to → 400 VALIDATION_ERROR before any data query (NFR-015).
//
// ORDERING (documented interpretation): "chronological viewer" = strict time
// order, served NEWEST-FIRST ([timestamp desc, id desc]) — the convention the
// codebase already uses for audit-entry reads (corrections history) and for
// the notification/outbound log surfaces. The CSV export streams the SAME
// order so the file is exactly "the current filter" as seen in the viewer.
//
// SEC-14 / cursor batching: the export NEVER loads the full filtered set —
// iterateAuditRows() pulls batches of ≤ EXPORT_BATCH_SIZE rows via a Prisma
// cursor ((timestamp, id) total order, cursor on unique id) and stops at the
// configured cap. The client is injectable for query-log evidence.
//
// INV-009: this module is READ-ONLY over AuditLogEntry — no create/update/
// delete of audit rows exists here; the sole write path stays audit() in
// src/lib/services/audit.ts (tx-only, append-only).
//
// Server-side only — never import from client components.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { pageEnvelope, type PageEnvelope, type Pagination } from "@/lib/http/pagination";
import {
  toAuditLogEntryInfo,
  type AuditLogEntryInfo,
  type AuditLogEntryWithRelations,
} from "@/lib/services/audit";
import { MAX_DATE_SPAN_DAYS } from "@/lib/services/supervisor-list";

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface AuditLogFilters {
  actionType: string | null;
  applicationSearch: string | null;
  userSearch: string | null;
  from: Date | null;
  to: Date | null;
}

/** Raw filter strings as sent by the client — recorded on the export's own audit entry. */
export interface AuditLogFilterEcho {
  actionType?: string;
  applicationSearch?: string;
  userSearch?: string;
  from?: string;
  to?: string;
}

/** Parse a date filter: bare YYYY-MM-DD or full ISO datetime (supervisor-list convention). */
function parseDateParam(raw: string, endOfDay: boolean): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const instant = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Parse + validate the shared §B query parameters for both audit-log
 * endpoints. Malformed dates, from > to, and span > 1096 days raise the
 * contract's 400 validation error BEFORE any data query. Unknown query params
 * are ignored (established convention). Also returns the raw filter echo for
 * the export's audit entry.
 */
export function parseAuditLogParams(request: Request): {
  filters: AuditLogFilters;
  echo: AuditLogFilterEcho;
} {
  const params = new URL(request.url).searchParams;
  const details: string[] = [];

  const text = (name: string): string | null => {
    const raw = params.get(name);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const actionType = text("actionType");
  const applicationSearch = text("applicationSearch");
  const userSearch = text("userSearch");

  let from: Date | null = null;
  const fromRaw = text("from");
  if (fromRaw !== null) {
    from = parseDateParam(fromRaw, false);
    if (!from) details.push("from: must be an ISO date (YYYY-MM-DD) or datetime");
  }
  let to: Date | null = null;
  const toRaw = text("to");
  if (toRaw !== null) {
    to = parseDateParam(toRaw, true);
    if (!to) details.push("to: must be an ISO date (YYYY-MM-DD) or datetime");
  }
  if (from && to) {
    if (from.getTime() > to.getTime()) {
      details.push("from: must not be after to");
    } else {
      const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      if (spanDays > MAX_DATE_SPAN_DAYS) {
        details.push(`from/to: date span must not exceed ${MAX_DATE_SPAN_DAYS} days`);
      }
    }
  }

  if (details.length > 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details,
    });
  }

  const echo: AuditLogFilterEcho = {};
  if (actionType) echo.actionType = actionType;
  if (applicationSearch) echo.applicationSearch = applicationSearch;
  if (userSearch) echo.userSearch = userSearch;
  if (fromRaw) echo.from = fromRaw;
  if (toRaw) echo.to = toRaw;

  return { filters: { actionType, applicationSearch, userSearch, from, to }, echo };
}

// ---------------------------------------------------------------------------
// WHERE composition (fully DB-side so the export can cursor over it — SEC-14)
// ---------------------------------------------------------------------------

/** Case-insensitive token match against a person's first or last name. */
function nameTokenOr(token: string): Prisma.UserWhereInput["OR"] {
  return [
    { firstName: { contains: token, mode: "insensitive" } },
    { lastName: { contains: token, mode: "insensitive" } },
  ];
}

/** Prisma WHERE for the parsed filters. */
export function auditLogWhere(filters: AuditLogFilters): Prisma.AuditLogEntryWhereInput {
  const and: Prisma.AuditLogEntryWhereInput[] = [];

  if (filters.actionType) and.push({ actionType: filters.actionType });

  if (filters.applicationSearch) {
    const q = filters.applicationSearch;
    const tokens = q.split(/\s+/).filter((t) => t.length > 0);
    // Multi-token names ("Jane Doe"): every token must hit firstName or
    // lastName of the owning account OR any per-application Borrower row —
    // same fields the queue's borrowerDisplayName search matches.
    const nameMatch: Prisma.ApplicationWhereInput = {
      AND: tokens.map((token) => ({
        OR: [
          { borrowerUser: { is: { OR: nameTokenOr(token) } } },
          {
            borrowers: {
              some: {
                OR: [
                  { firstName: { contains: token, mode: "insensitive" } },
                  { lastName: { contains: token, mode: "insensitive" } },
                ],
              },
            },
          },
        ],
      })),
    };
    and.push({
      application: {
        is: {
          OR: [{ applicationNumber: { contains: q, mode: "insensitive" } }, nameMatch],
        },
      },
    });
  }

  if (filters.userSearch) {
    const q = filters.userSearch;
    const tokens = q.split(/\s+/).filter((t) => t.length > 0);
    and.push({
      actorUser: {
        is: {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { AND: tokens.map((token) => ({ OR: nameTokenOr(token) })) },
          ],
        },
      },
    });
  }

  if (filters.from || filters.to) {
    const range: Prisma.DateTimeFilter = {};
    if (filters.from) range.gte = filters.from;
    if (filters.to) range.lte = filters.to;
    and.push({ timestamp: range });
  }

  return and.length > 0 ? { AND: and } : {};
}

/** Newest-first total order (see ORDERING note in the module header). */
const AUDIT_ORDER: Prisma.AuditLogEntryOrderByWithRelationInput[] = [
  { timestamp: "desc" },
  { id: "desc" },
];

/** Relations the §A serializer derives display fields from. */
const AUDIT_INCLUDE = {
  actorUser: { select: { firstName: true, lastName: true } },
  application: { select: { applicationNumber: true } },
} as const;

// ---------------------------------------------------------------------------
// Viewer page (offset-limit, server-clamped ≤ 100, default 25)
// ---------------------------------------------------------------------------

/** Build the §A AuditLogPage for GET /api/admin/audit-log. */
export async function listAuditLog(
  filters: AuditLogFilters,
  pagination: Pagination,
): Promise<PageEnvelope<AuditLogEntryInfo>> {
  const where = auditLogWhere(filters);
  const [total, rows] = await Promise.all([
    prisma.auditLogEntry.count({ where }),
    prisma.auditLogEntry.findMany({
      where,
      orderBy: AUDIT_ORDER,
      skip: pagination.skip,
      take: pagination.take,
      include: AUDIT_INCLUDE,
    }),
  ]);
  return pageEnvelope(rows.map(toAuditLogEntryInfo), pagination, total);
}

/**
 * Distinct actionType values actually in use (indexed DISTINCT scan) — the
 * source for the viewer's action-type dropdown (task-039: "real action types,
 * not a hardcoded partial list").
 */
export async function listDistinctActionTypes(): Promise<string[]> {
  const rows = await prisma.auditLogEntry.findMany({
    distinct: ["actionType"],
    select: { actionType: true },
    orderBy: { actionType: "asc" },
  });
  return rows.map((r) => r.actionType);
}

// ---------------------------------------------------------------------------
// Export: cursor-batched row iteration (SEC-14 — never a full-set load)
// ---------------------------------------------------------------------------

/** DB rows fetched per export batch — every export SELECT carries take ≤ this. */
export const EXPORT_BATCH_SIZE = 1000;

/** Client seam for query-log evidence (a fresh PrismaClient with query events). */
export type AuditReadClient = Pick<PrismaClient, "auditLogEntry">;

/**
 * Async-iterate the filtered rows newest-first in batches of ≤ batchSize,
 * stopping after `cap` rows total. Uses a (timestamp desc, id desc) cursor on
 * the unique id — each batch is one bounded SELECT; the full filtered set is
 * never resident in memory (SEC-14).
 */
export async function* iterateAuditRows(
  filters: AuditLogFilters,
  cap: number,
  batchSize: number = EXPORT_BATCH_SIZE,
  client: AuditReadClient = prisma,
): AsyncGenerator<AuditLogEntryWithRelations[], void, unknown> {
  const where = auditLogWhere(filters);
  let cursorId: string | null = null;
  let sent = 0;

  while (sent < cap) {
    const take = Math.min(batchSize, cap - sent);
    const rows: AuditLogEntryWithRelations[] = await client.auditLogEntry.findMany({
      where,
      orderBy: AUDIT_ORDER,
      ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
      include: AUDIT_INCLUDE,
    });
    if (rows.length === 0) return;
    cursorId = rows[rows.length - 1].id;
    sent += rows.length;
    yield rows;
    if (rows.length < take) return;
  }
}

// ---------------------------------------------------------------------------
// CSV encoding — RFC-4180 quoting + formula-injection guard (per contract)
// ---------------------------------------------------------------------------

/** Export columns = the §A AuditLogEntryInfo fields, contract order. */
export const AUDIT_CSV_COLUMNS: ReadonlyArray<keyof AuditLogEntryInfo> = [
  "id",
  "timestamp",
  "actorName",
  "actorRole",
  "actionType",
  "applicationNumber",
  "entityType",
  "entityId",
  "summary",
  "before",
  "after",
  "reason",
  "requestId",
];

/**
 * One csv-safe cell: cells beginning with a formula trigger (=, +, -, @, tab,
 * CR) are prefixed with a literal apostrophe so spreadsheet apps treat them as
 * text (FT-61), then RFC-4180-quoted when they contain delimiters/quotes/
 * newlines.
 */
export function csvCell(value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  let cell = value;
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  if (/[",\r\n]/.test(cell)) cell = `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

/** Serialize one wire row to a CSV line (no trailing newline). */
export function csvLine(info: AuditLogEntryInfo): string {
  return AUDIT_CSV_COLUMNS.map((column) => csvCell(info[column])).join(",");
}

/** Header line for the export. */
export function csvHeaderLine(): string {
  return AUDIT_CSV_COLUMNS.join(",");
}

/**
 * Cap-hit trailer appended as the final stream chunk when the filtered total
 * exceeds the configured cap (§4.6.10 "a message when the cap is hit"). Also
 * surfaced to the UI via the x-audit-export-cap-hit response header.
 */
export function capHitMessage(cap: number, total: number): string {
  return `Export row cap reached: first ${cap} of ${total} matching rows exported. Narrow the filter to export the remaining rows.`;
}
