/**
 * CH-023 — AUDIT TEMPORAL INTEGRITY / SEED TEMPORAL COHERENCE (INV-048, INV-049).
 *
 * This is the standing ratchet for the BUG-16 defect class: seed-written rows —
 * and audit entries derived from them — carrying timestamps in the FUTURE.
 * Backdating is legitimate and deliberate (the demo seed writes historical
 * history); future-dating never is, for any writer.
 *
 *   INV-048  No AuditLogEntry.timestamp may postdate the moment the entry is
 *            written. Also: the audit() service exposes no caller-supplied
 *            timestamp input (checked at COMPILE time, below).
 *   INV-049  Every record the demo seed writes, and every audit entry derived
 *            from one, carries timestamps at or before seed time, and
 *            intra-record chronology always holds: createdAt <= updatedAt;
 *            Condition.createdAt <= clearedAt; a decision precedes the clearing
 *            of its conditions; a derived AuditLogEntry.timestamp never precedes
 *            the event it records and never postdates seed time.
 *
 * ── The time boundary (read before changing anything here) ──────────────────
 * `seedStart` is captured BEFORE runDemoSeed(). It is deliberately NOT used as
 * the upper bound: the seed captures its own internal "seed time" a moment AFTER
 * seedStart, so legitimate rows can postdate seedStart by the seed's own startup
 * latency. The sound bound is taken AFTER the seed resolves:
 *
 *     bound = max(Node clock now, Postgres `SELECT now()`)
 *
 * Taking the max of both clocks guards against Node-vs-DB clock skew in either
 * direction (rows are written with whichever clock the writer used). Every
 * timestamp the seed may legitimately write is <= its internal seed time <=
 * bound, so the bound is SOUND (no false red). It is also SHARP enough for the
 * defect this exists to catch: BUG-16 produced values ~+24h past seed time, far
 * beyond any plausible clock skew or seed duration.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * All 28 seed-written models are swept, every DateTime field enumerated from
 * prisma/schema.prisma — including nullable and validity-bound fields
 * (Session.expiresAt, PasswordResetToken.expiresAt, DocumentJob.nextRetryAt,
 * Notification.nextAttemptAt). Those are NOT exempt: the seed writes only
 * historical, already-expired/already-due fixtures, so a future value in one of
 * them is precisely the violation this ratchet exists to catch.
 *
 * Anti-vacuity: a broken scope query or an unseeded database would let every
 * sweep pass on zero rows. Test 1 and the per-model non-empty assertions in
 * test 3 make that a failure of THIS suite rather than a silent green.
 *
 * ── Cleanup hygiene ─────────────────────────────────────────────────────────
 * This suite creates NO prefixed fixture rows, so it has no cleanupSuiteData
 * counterpart. Its only write is the contracted, idempotent, removal-first demo
 * seed operation itself — which IS the subject under test and is deliberately
 * left in place (the demo dataset must survive the run; removeDemoData is never
 * called). after() only disconnects.
 *
 * Run: npx tsx --env-file=.env --test task-046/suites/24-seed-temporal-ratchet.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { runDemoSeed } from "@/lib/services/demo-seed";
import type { AuditInput } from "@/lib/services/audit";

/**
 * INV-048, write-path posture — COMPILE-TIME assertion.
 *
 * The audit service must never accept a caller-supplied timestamp: the entry's
 * timestamp is the moment of the write, full stop. If anyone adds a `timestamp`
 * key to AuditInput, `AuditInputHasNoTimestamp` resolves to `never`, the
 * initializer below stops type-checking, and `tsc --noEmit` goes red.
 */
type AuditInputHasNoTimestamp = "timestamp" extends keyof AuditInput ? never : true;
const auditInputHasNoTimestamp: AuditInputHasNoTimestamp = true;
void auditInputHasNoTimestamp;

/** Contract enum literals (prisma/schema.prisma + contracts.json). */
const CONDITION_STATUS_CLEARED = "cleared";
const ACTION_TYPE_CONDITION_CLEAR = "condition-clear";

/** Postgres `IN (...)` batch size for id-scoped queries. */
const CHUNK_SIZE = 500;

async function chunked<R>(
  ids: readonly string[],
  fn: (chunk: string[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const rows = await fn(ids.slice(i, i + CHUNK_SIZE));
    for (const row of rows) out.push(row);
  }
  return out;
}

/** One DateTime value pulled off one row, kept with enough context to name it. */
interface DateValue {
  readonly model: string;
  readonly id: string;
  readonly field: string;
  readonly value: Date;
}

interface SweptModel {
  readonly model: string;
  readonly rowCount: number;
  readonly values: readonly DateValue[];
  readonly createdUpdated: ReadonlyArray<{ id: string; createdAt: Date; updatedAt: Date }>;
}

/**
 * Flatten a model's rows into (model, id, field, Date) tuples. `createdAt` /
 * `updatedAt` are universal across all 28 models; `extraFields` names the rest
 * of that model's DateTime columns (nullable ones included — nulls skipped).
 */
function sweep<T extends { id: string; createdAt: Date; updatedAt: Date }>(
  model: string,
  rows: readonly T[],
  extraFields: readonly (keyof T & string)[],
): SweptModel {
  const values: DateValue[] = [];
  const createdUpdated: Array<{ id: string; createdAt: Date; updatedAt: Date }> = [];
  for (const row of rows) {
    values.push({ model, id: row.id, field: "createdAt", value: row.createdAt });
    values.push({ model, id: row.id, field: "updatedAt", value: row.updatedAt });
    createdUpdated.push({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt });
    for (const field of extraFields) {
      const raw: unknown = row[field];
      if (raw === null || raw === undefined) continue;
      values.push({ model, id: row.id, field, value: raw as Date });
    }
  }
  return { model, rowCount: rows.length, values, createdUpdated };
}

const DATE_ONLY = { createdAt: true, updatedAt: true, id: true } as const;

// ---------------------------------------------------------------------------
// Shared fixture: one seed run, one boundary, one scoped snapshot.
// ---------------------------------------------------------------------------

let seedStart: Date;
let bound: Date;
let seedRunId: string;
let seedRunRemovedAt: Date | null;

let swept: SweptModel[] = [];
let seededApplicationCount = 0;
let seededAuditCount = 0;

interface ConditionRow {
  id: string;
  applicationId: string;
  approvalRecordId: string;
  status: string;
  clearedAt: Date | null;
  createdAt: Date;
}
let seededConditions: ConditionRow[] = [];
let approvalCreatedAtById = new Map<string, Date>();
let conditionClearAudits: Array<{ id: string; entityId: string | null; timestamp: Date }> = [];

describe("CH-023 seed temporal ratchet (INV-048 / INV-049)", () => {
  before(async () => {
    seedStart = new Date();
    const result = await runDemoSeed();
    seedRunId = result.run.id;
    seedRunRemovedAt = result.run.removedAt;

    // Sound upper bound: whichever clock is ahead, Node's or Postgres's.
    const nodeNow = new Date();
    const dbRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    const dbNow = dbRows[0].now;
    bound = nodeNow.getTime() >= dbNow.getTime() ? nodeNow : dbNow;

    // --- seed scope ----------------------------------------------------------
    const appIds = (
      await prisma.application.findMany({ where: { isSeed: true }, select: { id: true } })
    ).map((r) => r.id);
    const userIds = (
      await prisma.user.findMany({
        where: { OR: [{ isSeed: true }, { isDemo: true }] },
        select: { id: true },
      })
    ).map((r) => r.id);
    const documentIds = (
      await prisma.document.findMany({ where: { isSeed: true }, select: { id: true } })
    ).map((r) => r.id);
    const documentVersionIds = (
      await chunked(documentIds, (ids) =>
        prisma.documentVersion.findMany({ where: { documentId: { in: ids } }, select: { id: true } }),
      )
    ).map((r) => r.id);
    const notificationIds = (
      await chunked(appIds, (ids) =>
        prisma.notification.findMany({
          where: { OR: [{ applicationId: { in: ids } }, { recipientUserId: { in: userIds } }] },
          select: { id: true },
        }),
      )
    ).map((r) => r.id);

    seededApplicationCount = appIds.length;

    // --- per-model sweeps (DateTime fields enumerated from schema.prisma) -----
    swept = [
      sweep(
        "User",
        await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            ...DATE_ONLY,
            emailVerifiedAt: true,
            passwordChangedAt: true,
            lockedUntil: true,
            smsVerifiedAt: true,
            lastSignInAt: true,
          },
        }),
        ["emailVerifiedAt", "passwordChangedAt", "lockedUntil", "smsVerifiedAt", "lastSignInAt"],
      ),
      sweep(
        "Session",
        await chunked(userIds, (ids) =>
          prisma.session.findMany({
            where: { userId: { in: ids }, userAgent: "seed-fixture" },
            select: {
              ...DATE_ONLY,
              lastSeenAt: true,
              expiresAt: true,
              revokedAt: true,
              mfaPendingAt: true,
            },
          }),
        ),
        ["lastSeenAt", "expiresAt", "revokedAt", "mfaPendingAt"],
      ),
      sweep(
        "MfaEnrollment",
        await chunked(userIds, (ids) =>
          prisma.mfaEnrollment.findMany({
            where: { userId: { in: ids } },
            select: { ...DATE_ONLY, verifiedAt: true },
          }),
        ),
        ["verifiedAt"],
      ),
      sweep(
        "PasswordResetToken",
        await chunked(userIds, (ids) =>
          prisma.passwordResetToken.findMany({
            where: { userId: { in: ids } },
            select: { ...DATE_ONLY, expiresAt: true, usedAt: true },
          }),
        ),
        ["expiresAt", "usedAt"],
      ),
      sweep(
        "PasswordHistory",
        await chunked(userIds, (ids) =>
          prisma.passwordHistory.findMany({
            where: { userId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "RateLimitBucket",
        await prisma.rateLimitBucket.findMany({
          where: { key: { startsWith: "demo-seed:" } },
          select: { ...DATE_ONLY, windowStart: true },
        }),
        ["windowStart"],
      ),
      sweep(
        "Application",
        await chunked(appIds, (ids) =>
          prisma.application.findMany({
            where: { id: { in: ids } },
            select: {
              ...DATE_ONLY,
              submittedAt: true,
              decidedAt: true,
              stateEnteredAt: true,
              slaPausedAt: true,
            },
          }),
        ),
        ["submittedAt", "decidedAt", "stateEnteredAt", "slaPausedAt"],
      ),
      sweep(
        "Borrower",
        await chunked(appIds, (ids) =>
          prisma.borrower.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "ApplicationData",
        await chunked(appIds, (ids) =>
          prisma.applicationData.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "ApplicationVersion",
        await chunked(appIds, (ids) =>
          prisma.applicationVersion.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "Document",
        await chunked(documentIds, (ids) =>
          prisma.document.findMany({ where: { id: { in: ids } }, select: { ...DATE_ONLY } }),
        ),
        [],
      ),
      sweep(
        "DocumentVersion",
        await chunked(documentVersionIds, (ids) =>
          prisma.documentVersion.findMany({ where: { id: { in: ids } }, select: { ...DATE_ONLY } }),
        ),
        [],
      ),
      sweep(
        "DocumentJob",
        await chunked(documentVersionIds, (ids) =>
          prisma.documentJob.findMany({
            where: { documentVersionId: { in: ids } },
            select: { ...DATE_ONLY, startedAt: true, finishedAt: true, nextRetryAt: true },
          }),
        ),
        ["startedAt", "finishedAt", "nextRetryAt"],
      ),
      sweep(
        "OcrExtraction",
        await chunked(documentVersionIds, (ids) =>
          prisma.ocrExtraction.findMany({
            where: { documentVersionId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "DocumentRequest",
        await chunked(appIds, (ids) =>
          prisma.documentRequest.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "Signature",
        await chunked(appIds, (ids) =>
          prisma.signature.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY, signedAt: true, invalidatedAt: true },
          }),
        ),
        ["signedAt", "invalidatedAt"],
      ),
      sweep(
        "BankLink",
        await chunked(appIds, (ids) =>
          prisma.bankLink.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY, linkedAt: true, unlinkedAt: true },
          }),
        ),
        ["linkedAt", "unlinkedAt"],
      ),
      sweep(
        "UnderwritingResult",
        await chunked(appIds, (ids) =>
          prisma.underwritingResult.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY, requestedAt: true, completedAt: true },
          }),
        ),
        ["requestedAt", "completedAt"],
      ),
      sweep(
        "FraudFlag",
        await chunked(appIds, (ids) =>
          prisma.fraudFlag.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY, resolvedAt: true },
          }),
        ),
        ["resolvedAt"],
      ),
      sweep(
        "CaseworkerAssignment",
        await chunked(appIds, (ids) =>
          prisma.caseworkerAssignment.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY, assignedAt: true, endedAt: true },
          }),
        ),
        ["assignedAt", "endedAt"],
      ),
      sweep(
        "ApprovalRecord",
        await chunked(appIds, (ids) =>
          prisma.approvalRecord.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "Condition",
        await chunked(appIds, (ids) =>
          prisma.condition.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY, clearedAt: true },
          }),
        ),
        ["clearedAt"],
      ),
      sweep(
        "WorkflowHistory",
        await chunked(appIds, (ids) =>
          prisma.workflowHistory.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "ApplicationNote",
        await chunked(appIds, (ids) =>
          prisma.applicationNote.findMany({
            where: { applicationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "AuditLogEntry",
        await prisma.auditLogEntry.findMany({
          where: { isSeed: true },
          select: { ...DATE_ONLY, timestamp: true },
        }),
        ["timestamp"],
      ),
      sweep(
        "Notification",
        await chunked(notificationIds, (ids) =>
          prisma.notification.findMany({
            where: { id: { in: ids } },
            select: { ...DATE_ONLY, nextAttemptAt: true, readAt: true },
          }),
        ),
        ["nextAttemptAt", "readAt"],
      ),
      sweep(
        "OutboundMessage",
        await chunked(notificationIds, (ids) =>
          prisma.outboundMessage.findMany({
            where: { notificationId: { in: ids } },
            select: { ...DATE_ONLY },
          }),
        ),
        [],
      ),
      sweep(
        "SeedRun",
        await prisma.seedRun.findMany({
          where: { OR: [{ id: seedRunId }, { removedAt: { not: null } }] },
          select: { ...DATE_ONLY, removedAt: true },
        }),
        ["removedAt"],
      ),
    ];

    seededAuditCount = swept.find((s) => s.model === "AuditLogEntry")?.rowCount ?? 0;

    // --- chronology / linkage detail ----------------------------------------
    seededConditions = await chunked(appIds, (ids) =>
      prisma.condition.findMany({
        where: { applicationId: { in: ids } },
        select: {
          id: true,
          applicationId: true,
          approvalRecordId: true,
          status: true,
          clearedAt: true,
          createdAt: true,
        },
      }),
    );

    const approvals = await chunked(appIds, (ids) =>
      prisma.approvalRecord.findMany({
        where: { applicationId: { in: ids } },
        select: { id: true, createdAt: true },
      }),
    );
    approvalCreatedAtById = new Map(approvals.map((a) => [a.id, a.createdAt]));

    conditionClearAudits = await prisma.auditLogEntry.findMany({
      where: { isSeed: true, actionType: ACTION_TYPE_CONDITION_CLEAR },
      select: { id: true, entityId: true, timestamp: true },
    });
  }, { timeout: 900_000 });

  after(async () => {
    // No fixture rows to clean: the seeded demo dataset is left in place on purpose.
    await prisma.$disconnect();
  });

  test("1. the demo seed runs and produces a non-trivial dataset (anti-vacuity guard)", () => {
    assert.equal(
      seedRunRemovedAt,
      null,
      "runDemoSeed returned a SeedRun already marked removed — the seed did not complete cleanly",
    );
    assert.ok(
      seededApplicationCount >= 50,
      `REQ-066: expected >= 50 isSeed applications, found ${seededApplicationCount}`,
    );
    assert.ok(
      seededAuditCount > 0,
      `expected seeded AuditLogEntry rows, found ${seededAuditCount} — INV-048 would pass vacuously`,
    );
    const cleared = seededConditions.filter(
      (c) => c.status === CONDITION_STATUS_CLEARED && c.clearedAt !== null,
    );
    assert.ok(
      cleared.length > 0,
      "expected at least one cleared Condition with a non-null clearedAt on a seeded application — " +
        "without one the INV-049 clear-chronology and condition-clear audit checks pass vacuously",
    );
    assert.ok(
      bound.getTime() >= seedStart.getTime(),
      "boundary is malformed: bound must be at or after seedStart",
    );
  });

  test("2. INV-048: no AuditLogEntry timestamp/createdAt/updatedAt postdates the write moment", async () => {
    const rows = await prisma.auditLogEntry.findMany({
      // ALL rows, not just isSeed — nothing else writes audit entries during this
      // suite, so every row on the database must satisfy INV-048.
      select: { id: true, timestamp: true, createdAt: true, updatedAt: true, actionType: true },
    });
    assert.ok(rows.length > 0, "expected AuditLogEntry rows to check");

    const offenders: string[] = [];
    for (const row of rows) {
      for (const field of ["timestamp", "createdAt", "updatedAt"] as const) {
        const value = row[field];
        if (value.getTime() > bound.getTime()) {
          offenders.push(
            `AuditLogEntry ${row.id} (${row.actionType}) .${field} = ${value.toISOString()} > bound ${bound.toISOString()}`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `INV-048 VIOLATED — ${offenders.length} future-dated audit value(s). An audit entry may never ` +
        `postdate the moment it was written (bound ${bound.toISOString()}):\n  ` +
        offenders.slice(0, 40).join("\n  "),
    );
  });

  test("3. INV-049: no DateTime field on any of the 28 seed-written models postdates seed time", () => {
    assert.equal(swept.length, 28, "expected all 28 seed-written models to be swept");

    const offenders: string[] = [];
    for (const model of swept) {
      for (const v of model.values) {
        if (v.value.getTime() > bound.getTime()) {
          offenders.push(
            `${v.model} ${v.id} .${v.field} = ${v.value.toISOString()} > bound ${bound.toISOString()}`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `INV-049 VIOLATED — ${offenders.length} seed-written value(s) postdate seed time ` +
        `(bound ${bound.toISOString()}):\n  ` +
        offenders.slice(0, 40).join("\n  "),
    );

    // A broken scope query would make the sweep above vacuous. These models are
    // guaranteed non-empty by the contracted seed distribution.
    const emptyScopes = [
      "Application",
      "Borrower",
      "Document",
      "AuditLogEntry",
      "Condition",
      "ApprovalRecord",
      "WorkflowHistory",
      "Notification",
    ].filter((name) => (swept.find((s) => s.model === name)?.rowCount ?? 0) === 0);
    assert.deepEqual(
      emptyScopes,
      [],
      `seed-scoped query returned ZERO rows for ${emptyScopes.join(", ")} — the sweep above was ` +
        "vacuous for those models; fix the scoping or the seed, do not relax this assertion",
    );
  });

  test("4. INV-049: intra-record chronology holds on every seed-written row", () => {
    const offenders: string[] = [];

    // createdAt <= updatedAt, every swept model.
    for (const model of swept) {
      for (const row of model.createdUpdated) {
        if (row.createdAt.getTime() > row.updatedAt.getTime()) {
          offenders.push(
            `${model.model} ${row.id}: createdAt ${row.createdAt.toISOString()} > updatedAt ${row.updatedAt.toISOString()}`,
          );
        }
      }
    }

    // Condition.createdAt <= clearedAt, and the deciding ApprovalRecord precedes the clear.
    let clearedChecked = 0;
    for (const c of seededConditions) {
      if (c.status !== CONDITION_STATUS_CLEARED || c.clearedAt === null) continue;
      clearedChecked += 1;
      if (c.createdAt.getTime() > c.clearedAt.getTime()) {
        offenders.push(
          `Condition ${c.id}: createdAt ${c.createdAt.toISOString()} > clearedAt ${c.clearedAt.toISOString()}`,
        );
      }
      const approvalCreatedAt = approvalCreatedAtById.get(c.approvalRecordId);
      if (approvalCreatedAt === undefined) {
        offenders.push(
          `Condition ${c.id}: approvalRecordId ${c.approvalRecordId} resolves to no ApprovalRecord on a seeded application`,
        );
        continue;
      }
      if (approvalCreatedAt.getTime() > c.clearedAt.getTime()) {
        offenders.push(
          `Condition ${c.id}: deciding ApprovalRecord ${c.approvalRecordId} createdAt ` +
            `${approvalCreatedAt.toISOString()} POSTDATES clearedAt ${c.clearedAt.toISOString()} — ` +
            "a condition was cleared before the decision that raised it",
        );
      }
    }
    assert.ok(clearedChecked > 0, "expected cleared conditions to check chronology against");

    assert.deepEqual(
      offenders,
      [],
      `INV-049 VIOLATED — ${offenders.length} chronology inversion(s):\n  ` +
        offenders.slice(0, 40).join("\n  "),
    );
  });

  test("5. INV-049: every condition-clear audit entry is dated at its condition's clearedAt", () => {
    const clearedById = new Map(
      seededConditions
        .filter((c) => c.status === CONDITION_STATUS_CLEARED && c.clearedAt !== null)
        .map((c) => [c.id, c]),
    );
    const conditionById = new Map(seededConditions.map((c) => [c.id, c]));

    assert.equal(
      conditionClearAudits.length,
      clearedById.size,
      `expected exactly one seeded "${ACTION_TYPE_CONDITION_CLEAR}" audit entry per cleared seeded ` +
        `condition: ${conditionClearAudits.length} entries vs ${clearedById.size} cleared conditions`,
    );

    const offenders: string[] = [];
    for (const entry of conditionClearAudits) {
      if (entry.entityId === null) {
        offenders.push(`AuditLogEntry ${entry.id}: entityId is null, cannot resolve a Condition`);
        continue;
      }
      const condition = conditionById.get(entry.entityId);
      if (condition === undefined) {
        offenders.push(
          `AuditLogEntry ${entry.id}: entityId ${entry.entityId} resolves to no seeded Condition`,
        );
        continue;
      }
      if (condition.clearedAt === null) {
        offenders.push(
          `AuditLogEntry ${entry.id}: Condition ${condition.id} has a clear audit entry but clearedAt is null`,
        );
        continue;
      }
      if (entry.timestamp.getTime() !== condition.clearedAt.getTime()) {
        offenders.push(
          `AuditLogEntry ${entry.id}: timestamp ${entry.timestamp.toISOString()} != Condition ` +
            `${condition.id} clearedAt ${condition.clearedAt.toISOString()} — a derived audit entry ` +
            "must be dated at the event it records, not at write time",
        );
      }
      if (entry.timestamp.getTime() < condition.createdAt.getTime()) {
        offenders.push(
          `AuditLogEntry ${entry.id}: timestamp ${entry.timestamp.toISOString()} PRECEDES Condition ` +
            `${condition.id} createdAt ${condition.createdAt.toISOString()}`,
        );
      }
      if (entry.timestamp.getTime() > bound.getTime()) {
        offenders.push(
          `AuditLogEntry ${entry.id}: timestamp ${entry.timestamp.toISOString()} > bound ${bound.toISOString()}`,
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `INV-049 VIOLATED — ${offenders.length} condition-clear audit linkage/temporal defect(s):\n  ` +
        offenders.slice(0, 40).join("\n  "),
    );
  });

  test("6. INV-048: the audit service exposes no caller-supplied timestamp input", () => {
    // The real guard is the `AuditInputHasNoTimestamp` alias at module scope: adding
    // a `timestamp` key to AuditInput makes this file fail `tsc --noEmit`. This
    // runtime assertion exists so the guard is a named, reported test.
    assert.equal(auditInputHasNoTimestamp, true);
  });
});
