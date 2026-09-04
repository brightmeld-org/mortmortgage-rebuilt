/**
 * Audit service — in-transaction, append-only (task-003).
 *
 * NFR-009 / NFR-010 / SEC-8 / AC-26 / INV-009 / XBR-013.
 *
 * APPEND-ONLY GUARANTEE (INV-009):
 *   AuditLogEntry rows are NEVER updated or deleted by any code path or role.
 *   This module exposes create (`audit`) and read-side serialization
 *   (`toAuditLogEntryInfo`) ONLY — no update, delete, or upsert function exists
 *   here, and none may ever be added. No HTTP write path for audit entries may
 *   ever exist for ANY role (borrower, caseworker, supervisor, or anonymous):
 *   the only audit-related endpoints are the supervisor read/export routes
 *   (GET /api/admin/audit-log, GET /api/admin/audit-log/export). The SOLE
 *   delete path in the entire system is seed-flagged removal by the
 *   Remove Demo Data operation (task-043), which targets rows with
 *   `isSeed = true` exclusively (WALK-004).
 *
 * IN-TRANSACTION GUARANTEE (SEC-8 / AC-26 / XBR-013):
 *   `audit()` is callable only with a `Prisma.TransactionClient` — the client
 *   handed to the callback of `prisma.$transaction(async (tx) => ...)`. The
 *   first parameter's type rejects the global `PrismaClient` at compile time
 *   (its `$transaction` method conflicts with `{ $transaction?: never }`),
 *   and a runtime guard backs this up. Because the audit INSERT runs inside
 *   the same database transaction as the audited change, a failed audit write
 *   rolls back the change: the action fails, never silently un-audited.
 *
 * ACTOR IDENTITY (audit integrity):
 *   `actor` MUST be the authenticated session user's User.id (or null for
 *   SYSTEM actions such as T27/T28 automatic transitions). It must NEVER be
 *   taken from a request body. This module is server-side only and must never
 *   be imported into client components.
 */

import { Prisma, UserRole, type AuditLogEntry } from "@prisma/client";

// ---------------------------------------------------------------------------
// Audit action types
// ---------------------------------------------------------------------------

/**
 * The audited-action vocabulary, derived from the contract's SEC-8 list
 * (requirements §7.2 / NFR-009) plus the contract clauses that require
 * auditing of specific operations. contracts.json defines no formal enum for
 * `AuditLogEntryInfo.actionType` (it is `string` on the wire); this closed
 * union is the system-wide canonical set — every producer imports it from
 * here, and the audit-log filter (`?actionType=`, task-039) filters on these
 * values. Each value cites its contract source.
 */
export const AUDIT_ACTION_TYPES = [
  "workflow-transition", // XBR-013 / WF-047: every transition audited in-transaction
  "signature-capture", // SEC-8, AC-15
  "co-borrower-add", // SEC-8
  "co-borrower-remove", // SEC-8
  "section-copy", // SEC-8, XBR-020 (audited with source id + section list)
  "document-status-change", // SEC-8, VR-097/098
  "bank-link", // SEC-8
  "bank-import", // contracts §D: link/import/unlink audited
  "bank-unlink", // SEC-8
  "config-change", // SEC-8, AC-32 (audited with before/after)
  "export", // SEC-8 (analytics/MISMO/LAR/audit exports; full-SSN export carries reason)
  "mfa-reset", // SEC-8
  "mfa-enrollment", // REQ-013 (task-007): enroll-init / activation / reenroll-init — state-changing MFA lifecycle events
  "mfa-recovery-codes", // REQ-013 / INV-010 (task-007): recovery-code consumption + regeneration (codes never logged)
  "note", // SEC-8 ("all notes")
  "chatter", // SEC-8 ("and chatter")
  "correction", // AC-26 (audited correction with before/after, source document)
  "assignment", // AC-26 (claim/manual/bulk/auto/reassign — FLOW-007 "all events audited")
  "approval-decision", // FLOW-004 ("every action audited in-transaction")
  "condition-clear", // WF-036 / REQ-054 (task-020): per-condition clear via POST /api/conditions/:id/clear, audited in-tx
  "staff-management", // FLOW-011 ("all management actions audited")
  "invitation-accepted", // REQ-063 / NFR-011 (task-033): staff invitation set-password completion (INV-010 token consume)
  "seed-demo-data", // FLOW-012 ("both operations audited")
  "remove-demo-data", // FLOW-012
  // --- Account lifecycle (task-006; SEC-8 "every state-changing action", SEC-20) ---
  "account-registration", // §4.1.2 borrower self-registration
  "email-verification", // §4.1.2 verification consume/resend (INV-010)
  "password-reset", // §4.1.6 forgot-password token issue + reset completion
  "password-change", // §4.1.6 authenticated password change
  "email-change", // §4.2.12 change-email request + verified swap (REQ-041)
  "profile-update", // §4.2.12 name/phone edits (REQ-041)
  "notification-preferences", // §4.2.12 channel preference change (REQ-041, VR-030)
  "sms-verification", // §4.2.12 SMS code issue/confirm (REQ-041)
  "account-lockout", // §4.1.5 lockout after consecutive failures
  "session-revocation", // §4.1.7 sign-out / server-side revocation (SEC-20)
  // --- Application lifecycle (task-011; SEC-8 "every state-changing action", INV-027) ---
  "application-created", // POST /api/applications (REQ-022; includes copy/handoff provenance)
  "application-deleted", // DELETE /api/applications/:id draft delete (§4.2.1 "audited")
  "section-saved", // PUT /api/applications/:id/sections/:section (REQ-023/REQ-035, INV-036)
  "application-submitted", // T1/T36 submission substance (src/lib/services/submission.ts, WF-003/WF-042)
  // --- Documents (task-013; SEC-8 "every state-changing action", §4.2.9) ---
  "document-upload", // POST /api/applications/:id/documents + POST /api/documents/:id/versions (upload/replacement, XBR-016)
  "document-delete", // DELETE /api/documents/:id draft-only delete of all versions (§4.2.9 "audited")
  "document-request", // POST /api/applications/:id/document-requests (REQ-053, VR-099/100)
  // --- SLA & priority (task-021; §4.6.3 "overrides are audited", REQ-057) ---
  "priority-override", // PATCH /api/applications/:id/priority — Supervisor override with before/after + reason
  // --- Underwriting checks (task-025; REQ-059 / §4.6.5 "audited with a result summary", ASYNC-005) ---
  "underwriting-check", // completion/error of a check recorded with its result summary (e.g. "credit: score 742, tier Good")
  // --- Fraud flags (task-027; REQ-060 / §4.6.6 "flag creation and resolution are audited") ---
  "fraud-flag", // automatic creation (SYSTEM actor) + resolve/dismiss (session actor), both in-tx with the flag write
  // --- Notifications (task-036; REQ-068 / WF-049 — staff retry mutations are audited) ---
  "notification-retry", // manual delivery retry (POST /api/notifications/:id/retry) + decision-notification retry (POST /api/applications/:id/decision-notification/retry)
  // --- Document OCR jobs (task-034; REQ-067 / ASYNC-001/004) ---
  "ocr-job", // extraction completed/failed (SYSTEM), stuck-job reconciliation (SYSTEM), manual Retry (session actor)
] as const;

export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number];

// ---------------------------------------------------------------------------
// Transaction-only client type
// ---------------------------------------------------------------------------

/**
 * A Prisma client that is provably an interactive-transaction client.
 *
 * `Prisma.TransactionClient` omits `$transaction`; the global `PrismaClient`
 * declares it as a method. Intersecting with `{ $transaction?: never }` makes
 * passing the global client a COMPILE ERROR while every `tx` handed to a
 * `prisma.$transaction(async (tx) => ...)` callback remains assignable.
 */
export type AuditTransactionClient = Prisma.TransactionClient & {
  $transaction?: never;
};

/** Role recorded on an audit entry: a real user role, or SYSTEM for automatic actions (T27/T28 etc.). */
export type AuditActorRole = UserRole | "SYSTEM";

// ---------------------------------------------------------------------------
// Test seam — one-shot audit-write failure (task-046/test-fixtures-contract.md,
// op "fail-next-audit-write")
// ---------------------------------------------------------------------------
//
// Proves the IN-TRANSACTION guarantee end to end (XBR-013 / AC-26 / INV-037):
// while armed, the NEXT AuditLogEntry insert throws inside its enclosing
// transaction, so the audited action must roll back entirely. The arming is
// consumed by that one attempt.
//
// PRODUCTION POSTURE: armFailNextAuditWrite throws unless the process is
// non-production AND DEMO_MODE === "true" — the same gate that makes the
// fixtures route absent (404) — so the flag can never become true in a
// production build and the check in audit() is dead code there. The flag lives
// on globalThis (same posture as src/lib/prisma.ts) so the fixtures route's
// bundle and the audited routes' bundles observe the same value under Next dev.

const globalForAuditSeam = globalThis as unknown as { auditWriteFailureArmed?: boolean };

/** Arm (or disarm) the one-shot audit-write failure. Demo-gated test seam ONLY. */
export function armFailNextAuditWrite(armed: boolean): void {
  if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE !== "true") {
    throw new Error(
      "armFailNextAuditWrite is a demo-mode test seam (task-046/test-fixtures-contract.md) and is unavailable in this environment",
    );
  }
  globalForAuditSeam.auditWriteFailureArmed = armed;
}

/** Consume the one-shot arming; true exactly once per arm. Always false in production. */
function consumeAuditWriteFailure(): boolean {
  if (globalForAuditSeam.auditWriteFailureArmed === true) {
    globalForAuditSeam.auditWriteFailureArmed = false;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// audit() — the single write path
// ---------------------------------------------------------------------------

export interface AuditInput {
  /**
   * User.id of the acting user, taken from the authenticated session/token
   * ONLY — never from a request body. `null` for SYSTEM actions.
   */
  actor: string | null;
  /** Role of the actor at action time (session role), or "SYSTEM". */
  role: AuditActorRole | null;
  /** One of the contract's audited-action values (SEC-8 vocabulary above). */
  actionType: AuditActionType;
  /** Application the action concerns, when applicable. */
  applicationId?: string | null;
  /** Entity type label for the affected record (e.g. "Document", "SystemConfig"). */
  entityType?: string | null;
  /** Primary key of the affected record. */
  entityId?: string | null;
  /** Human-readable one-line description of what happened. Required. */
  summary: string;
  /** State before the change (corrections/config changes). Stored as JSON. */
  before?: Prisma.InputJsonValue;
  /** State after the change. Stored as JSON. */
  after?: Prisma.InputJsonValue;
  /** Operator-supplied reason, where the contract requires one (e.g. full-SSN export). */
  reason?: string | null;
  /** Client IP from the request (server-derived, respecting proxy trust config). */
  ip?: string | null;
  /** Request-correlation id (echoed in error responses). */
  requestId?: string | null;
  /** Demo-seed marker — the ONLY attribute that can ever make this row deletable (by Remove Demo Data). Defaults false. */
  isSeed?: boolean;
}

/**
 * Write one audit entry inside the caller's open transaction.
 *
 * Must be called with the `tx` client of the SAME `prisma.$transaction` that
 * performs the audited change, so that an audit-insert failure rolls the
 * change back (AC-26) and the change's failure discards the audit row.
 *
 * @returns the created row (id + persisted fields).
 */
export async function audit(
  tx: AuditTransactionClient,
  input: AuditInput,
): Promise<AuditLogEntry> {
  // Runtime backstop for the compile-time guarantee: the interactive
  // transaction client has no $transaction method; the global client does.
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error(
      "audit() requires a Prisma transaction client (the `tx` inside prisma.$transaction) — the global PrismaClient was passed.",
    );
  }
  if (!input.summary || input.summary.trim().length === 0) {
    throw new Error("audit(): summary is required and must be non-empty.");
  }
  if (!AUDIT_ACTION_TYPES.includes(input.actionType)) {
    throw new Error(
      `audit(): unknown actionType "${String(input.actionType)}" — must be one of the SEC-8 audited-action values.`,
    );
  }

  // Test seam (see armFailNextAuditWrite above): a one-shot simulated insert
  // failure thrown INSIDE the caller's transaction — the audited action must
  // roll back with it. Unreachable in production (the flag can never be set).
  if (consumeAuditWriteFailure()) {
    throw new Error(
      "Simulated audit-write failure (task-046 test seam) — the enclosing transaction must roll back",
    );
  }

  return tx.auditLogEntry.create({
    data: {
      actorUserId: input.actor,
      actorRole: input.role ?? null,
      actionType: input.actionType,
      applicationId: input.applicationId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      summary: input.summary,
      before: input.before === undefined ? undefined : input.before,
      after: input.after === undefined ? undefined : input.after,
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
      isSeed: input.isSeed ?? false,
    },
  });
}

// ---------------------------------------------------------------------------
// AuditLogEntryInfo serializer (contracts.md §A — field names verbatim)
// ---------------------------------------------------------------------------

/** Wire shape per contracts.json models.AuditLogEntryInfo — exact field names. */
export interface AuditLogEntryInfo {
  id: string;
  timestamp: string;
  actorName?: string;
  actorRole?: string;
  actionType: string;
  applicationNumber?: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  /** JSON-encoded before value for corrections/config changes. */
  before?: string;
  /** JSON-encoded after value. */
  after?: string;
  reason?: string;
  requestId?: string;
}

/**
 * An AuditLogEntry row with the relations the serializer derives display
 * fields from: `actorUser` → actorName, `application` → applicationNumber.
 * Load with `include: { actorUser: ..., application: ... }` (or selects
 * covering these fields).
 */
export type AuditLogEntryWithRelations = AuditLogEntry & {
  actorUser?: { firstName: string; lastName: string } | null;
  application?: { applicationNumber: string } | null;
};

/**
 * Serialize a row to the §A AuditLogEntryInfo wire shape. Live-derived from
 * the row: `before`/`after` are returned as JSON-encoded strings (they are
 * stored as JSON), optional fields are omitted when absent. Note `ip` and
 * `isSeed` are stored but deliberately NOT serialized — they are not part of
 * the contract shape.
 */
export function toAuditLogEntryInfo(
  row: AuditLogEntryWithRelations,
): AuditLogEntryInfo {
  const actorName = row.actorUser
    ? `${row.actorUser.firstName} ${row.actorUser.lastName}`.trim()
    : undefined;

  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    actorName,
    actorRole: row.actorRole ?? undefined,
    actionType: row.actionType,
    applicationNumber: row.application?.applicationNumber ?? undefined,
    entityType: row.entityType ?? undefined,
    entityId: row.entityId ?? undefined,
    summary: row.summary,
    before: row.before === null ? undefined : JSON.stringify(row.before),
    after: row.after === null ? undefined : JSON.stringify(row.after),
    reason: row.reason ?? undefined,
    requestId: row.requestId ?? undefined,
  };
}
