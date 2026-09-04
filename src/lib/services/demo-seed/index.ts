// Demo-seed service (task-043) — REQ-066, INT-022, NFR-016, ASYNC-006, WALK-004.
//
// Public surface:
//   ensureBaseSeed()  — ALWAYS-run base seed (any DEMO_MODE): the three demo
//                       accounts (isDemo, pre-enrolled MFA — exactly the
//                       identities the task-008 demo-login service provisions)
//                       and idempotent SystemConfig defaults (create-if-missing
//                       only; never overwrites operator changes; HMDA
//                       identifiers stay blank per §4.6.11).
//   runDemoSeed()     — the full §4.6.12 dataset (DEMO_MODE=true only).
//                       SINGLE interactive transaction (ASYNC-006 single-tx)
//                       with a raised timeout; global-singleton concurrency via
//                       a Postgres transaction-scoped advisory lock (a
//                       concurrent seed OR removal → 409, across processes).
//                       Removal-first: the prior seed set is deleted inside the
//                       same transaction before reseeding (idempotent re-seed).
//   removeDemoData()  — deletes ONLY isSeed-flagged records INCLUDING their
//                       seed-flagged audit entries (WALK-004) and nothing
//                       else; sets SeedRun.removedAt; restores the HMDA
//                       LEI/agency-code to blank IFF they still hold the
//                       seeded values; audited.
//
// ASYNC-006 EXECUTION INTERPRETATION (documented): the contract's 202 response
// with `SeedRunInfo` defines no GET-seed-run endpoint, so this build executes
// the seed run WITHIN the request (interactive transaction, raised timeout)
// and returns the COMPLETED SeedRunInfo with per-entity recordCounts; the Demo
// Data page's pending state during the POST is the progress affordance. A
// failed run rolls back atomically and surfaces its error verbatim — the
// operator re-runs it (fire-and-forget recovery posture per ASYNC-006).
//
// HMDA staging (FLOW-010 precondition, documented): the DEMO seed sets
// `hmda.lei` / `hmda.agencyCode` to synthetic-but-format-valid values (valid
// ISO 17442 check digits) through the same validated, audited config write the
// ConfigurationPage uses; the audit rows for these config changes — like the
// seed/remove ACTION audits themselves — are NOT seed-flagged, so the record
// that the operations happened survives Remove Demo Data (INV-009 posture).

import { Prisma, type SeedRun, type UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import {
  CONFIG_REGISTRY,
  decodeAndValidateValue,
  getRegistryEntry,
} from "@/lib/services/config";
import { invalidateConfigCache } from "@/lib/http/config";
import { demoModeEnabled, DEMO_ACCOUNTS } from "@/lib/services/demo-login";
import { getIdentityProvider } from "@/lib/services/idp";
import { hashPassword } from "@/lib/services/password-hash";
import { getStorage } from "@/lib/services/storage";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import {
  SEEDED_HMDA_AGENCY_CODE,
  SEEDED_HMDA_LEI,
} from "@/lib/services/demo-seed/content";
import {
  buildFullDataset,
  prepareIdentities,
  type DemoAccountRefs,
  type FileWrite,
} from "@/lib/services/demo-seed/dataset";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interactive-transaction timeout for a full seed run (reported in evidence). */
export const SEED_TX_TIMEOUT_MS = 600_000;
/** Wait budget to OPEN the interactive transaction. */
export const SEED_TX_MAX_WAIT_MS = 15_000;
/** Advisory-lock key for the ASYNC-006 global-singleton (seed AND removal). */
export const SEED_ADVISORY_LOCK_KEY = 730_443_001;

/** Actor context: the triggering Supervisor's session identity, or SYSTEM (CLI). */
export interface SeedActorContext {
  userId: string | null;
  role: UserRole | "SYSTEM";
  ip?: string | null;
  requestId?: string | null;
}

export const SYSTEM_SEED_ACTOR: SeedActorContext = { userId: null, role: "SYSTEM" };

/** contracts.md §A SeedRunInfo — exact field names; recordCounts JSON-encoded. */
export interface SeedRunInfoWire {
  id: string;
  createdAt: string;
  recordCounts: string;
  removedAt?: string;
}

export function toSeedRunInfo(row: SeedRun): SeedRunInfoWire {
  const info: SeedRunInfoWire = {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    recordCounts: JSON.stringify(row.recordCounts ?? {}),
  };
  if (row.removedAt) info.removedAt = row.removedAt.toISOString();
  return info;
}

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Global-singleton lock (ASYNC-006)
// ---------------------------------------------------------------------------

/** Acquire the tx-scoped advisory lock or throw the contract 409. */
async function acquireSeedLock(tx: Tx): Promise<void> {
  const rows = await tx.$queryRaw<{ locked: boolean }[]>(
    Prisma.sql`SELECT pg_try_advisory_xact_lock(${SEED_ADVISORY_LOCK_KEY}::bigint) AS locked`,
  );
  if (!rows[0]?.locked) {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "A demo-data seed or removal run is already in progress — wait for it to finish and try again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Base seed (always)
// ---------------------------------------------------------------------------

/**
 * Idempotent base seed: demo accounts (find-or-create through the identity
 * provider seam — the SAME identities `POST /api/auth/demo-login` provisions,
 * MFA pre-enrolled) + SystemConfig registry defaults (create-if-missing).
 */
export async function ensureBaseSeed(): Promise<DemoAccountRefs> {
  // SystemConfig defaults — never overwrites existing values (migration seeds
  // them normally; this heals a wiped table without touching operator edits).
  await prisma.systemConfig.createMany({
    data: CONFIG_REGISTRY.map((entry) => ({
      key: entry.key,
      value: entry.defaultValue as Prisma.InputJsonValue,
      description: entry.description,
    })),
    skipDuplicates: true,
  });

  const meta = { ip: null, userAgent: "prisma-db-seed", requestId: null };
  for (const role of ["borrower", "caseworker", "supervisor"] as const) {
    const spec = DEMO_ACCOUNTS[role];
    await getIdentityProvider().provision(
      {
        email: spec.email,
        role: spec.role,
        firstName: spec.firstName,
        lastName: spec.lastName,
        emailVerified: true,
        isDemo: true,
        mfaPreEnrolled: true,
      },
      meta,
    );
  }
  return loadDemoAccountRefs();
}

async function loadDemoAccountRefs(): Promise<DemoAccountRefs> {
  const pick = async (email: string) => {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, isDemo: true },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!user) throw new Error(`demo account ${email} missing — ensureBaseSeed must run first`);
    return user;
  };
  return {
    borrower: await pick(DEMO_ACCOUNTS.borrower.email),
    caseworker: await pick(DEMO_ACCOUNTS.caseworker.email),
    supervisor: await pick(DEMO_ACCOUNTS.supervisor.email),
  };
}

// ---------------------------------------------------------------------------
// HMDA config staging helpers (validated + audited, actor-aware)
// ---------------------------------------------------------------------------

async function writeHmdaSetting(
  tx: Tx,
  actor: SeedActorContext,
  key: "hmda.lei" | "hmda.agencyCode",
  value: string,
  why: string,
): Promise<void> {
  const entry = getRegistryEntry(key);
  if (!entry) throw new Error(`config registry missing ${key}`);
  const decoded = decodeAndValidateValue(entry, JSON.stringify(value));
  const existing = await tx.systemConfig.findUnique({ where: { key } });
  const before: Prisma.InputJsonValue =
    existing === null ? (entry.defaultValue as Prisma.InputJsonValue) : (existing.value as Prisma.InputJsonValue);
  const row = await tx.systemConfig.upsert({
    where: { key },
    update: { value: decoded as Prisma.InputJsonValue, updatedByUserId: actor.userId },
    create: { key, value: decoded as Prisma.InputJsonValue, description: entry.description, updatedByUserId: actor.userId },
  });
  await audit(tx as AuditTransactionClient, {
    actor: actor.userId,
    role: actor.role,
    actionType: "config-change",
    entityType: "SystemConfig",
    entityId: row.id,
    summary: `Configuration setting "${key}" changed (${why})`,
    before: { key, value: before },
    after: { key, value: decoded as Prisma.InputJsonValue },
    ip: actor.ip ?? null,
    requestId: actor.requestId ?? null,
  });
}

/** Blank the HMDA identifiers IFF they still hold the seeded values. */
async function restoreHmdaIfSeeded(tx: Tx, actor: SeedActorContext): Promise<void> {
  const pairs: Array<["hmda.lei" | "hmda.agencyCode", string]> = [
    ["hmda.lei", SEEDED_HMDA_LEI],
    ["hmda.agencyCode", SEEDED_HMDA_AGENCY_CODE],
  ];
  for (const [key, seededValue] of pairs) {
    const row = await tx.systemConfig.findUnique({ where: { key } });
    if (row && row.value === seededValue) {
      await writeHmdaSetting(tx, actor, key, "", "demo-data removal restored the blank default");
    }
  }
}

// ---------------------------------------------------------------------------
// Removal core (WALK-004: seed-flagged rows ONLY, FK-safe order)
// ---------------------------------------------------------------------------

interface RemovalOutcome {
  removedCounts: Record<string, number>;
  storageKeys: string[];
}

async function removeSeedSetInTx(tx: Tx): Promise<RemovalOutcome> {
  // Storage keys BEFORE the rows disappear (files deleted after commit).
  const storageKeys = (
    await tx.documentVersion.findMany({
      where: { document: { isSeed: true } },
      select: { storageKey: true },
    })
  ).map((r) => r.storageKey);

  const removedCounts: Record<string, number> = {};

  // Notifications carry no isSeed column (interpretation 3 in dataset.ts):
  // seeded notifications are exactly those addressed to a seeded user OR
  // attached to a seeded application. Outbound messages first (FK SetNull
  // would otherwise orphan them past recognition).
  const notificationWhere = {
    OR: [{ recipientUser: { isSeed: true } }, { application: { isSeed: true } }],
  };
  removedCounts.OutboundMessage = (
    await tx.outboundMessage.deleteMany({ where: { notification: notificationWhere } })
  ).count;
  removedCounts.Notification = (await tx.notification.deleteMany({ where: notificationWhere })).count;

  // Seed-flagged audit entries — the SOLE audit delete path in the system
  // (INV-009 exception).
  removedCounts.AuditLogEntry = (await tx.auditLogEntry.deleteMany({ where: { isSeed: true } })).count;

  // Applications cascade every child (borrowers, data, versions, documents +
  // versions/jobs/extractions, requests, signatures, bank links, results,
  // flags, assignments, approvals, conditions, history, notes).
  removedCounts.Application = (await tx.application.deleteMany({ where: { isSeed: true } })).count;
  // Stray seed-flagged documents outside seeded applications (none expected).
  removedCounts.Document = (await tx.document.deleteMany({ where: { isSeed: true } })).count;
  // Seeded users cascade sessions, MFA enrollments, tokens, password history.
  removedCounts.User = (await tx.user.deleteMany({ where: { isSeed: true } })).count;
  // Seed-marked rate-limit fixtures (recognizable key prefix — RateLimitBucket
  // has no isSeed column; live buckets NEVER use this prefix).
  removedCounts.RateLimitBucket = (
    await tx.rateLimitBucket.deleteMany({ where: { key: { startsWith: "demo-seed:" } } })
  ).count;

  return { removedCounts, storageKeys };
}

async function deleteStorageObjects(keys: string[]): Promise<void> {
  const storage = getStorage();
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (err) {
      console.error(`demo-seed: storage delete failed for ${key}`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// runDemoSeed — the full §4.6.12 dataset (single tx, removal-first)
// ---------------------------------------------------------------------------

export interface DemoSeedRunResult {
  run: SeedRun;
  /** Seconds the transaction took (reported by evidence). */
  seconds: number;
}

export async function runDemoSeed(actor: SeedActorContext = SYSTEM_SEED_ACTOR): Promise<DemoSeedRunResult> {
  if (!demoModeEnabled()) {
    throw new Error("runDemoSeed invoked with DEMO_MODE off — route gating failed");
  }

  const demo = await ensureBaseSeed();
  // CPU-heavy identity material (argon2, AES) prepared OUTSIDE the transaction.
  const prepared = await prepareIdentities(hashPassword);
  const now = new Date();
  const startedAt = Date.now();

  let fileWrites: FileWrite[] = [];
  let removedStorageKeys: string[] = [];

  const run = await prisma.$transaction(
    async (tx) => {
      await acquireSeedLock(tx);

      // Removal-first re-seed (ASYNC-006): the prior seed set goes away inside
      // the same transaction, including its storage keys.
      const removal = await removeSeedSetInTx(tx);
      removedStorageKeys = removal.storageKeys;
      await tx.seedRun.updateMany({ where: { removedAt: null }, data: { removedAt: now } });
      await restoreHmdaIfSeeded(tx, actor);

      const built = await buildFullDataset(tx, now, demo, prepared);
      fileWrites = built.fileWrites;

      // HMDA identifiers → synthetic valid values (FLOW-010 precondition).
      await writeHmdaSetting(tx, actor, "hmda.lei", SEEDED_HMDA_LEI, "demo seed staged a synthetic LEI");
      await writeHmdaSetting(tx, actor, "hmda.agencyCode", SEEDED_HMDA_AGENCY_CODE, "demo seed staged a synthetic agency code");
      built.counts.SystemConfig = (built.counts.SystemConfig ?? 0) + 2;

      const priorRemoved = Object.values(removal.removedCounts).reduce((a, b) => a + b, 0);
      const seedRun = await tx.seedRun.create({
        data: {
          createdByUserId: actor.userId,
          recordCounts: { ...built.counts, SeedRun: 1 } as Prisma.InputJsonValue,
        },
      });

      // The LIVE seed action audit — NOT seed-flagged (survives removal).
      await audit(tx as AuditTransactionClient, {
        actor: actor.userId,
        role: actor.role,
        actionType: "seed-demo-data",
        entityType: "SeedRun",
        entityId: seedRun.id,
        summary: `Demo data seeded (${built.counts.Application ?? 0} applications; prior seed set removed first: ${priorRemoved} rows)`,
        after: { recordCounts: built.counts } as Prisma.InputJsonValue,
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });

      return seedRun;
    },
    { timeout: SEED_TX_TIMEOUT_MS, maxWait: SEED_TX_MAX_WAIT_MS },
  );

  // Post-commit: storage sync (old files out, new fixture bytes in) + config
  // cache invalidation for the HMDA keys written in-tx.
  await deleteStorageObjects(removedStorageKeys);
  const storage = getStorage();
  for (const file of fileWrites) {
    await storage.put(file.key, file.bytes);
  }
  invalidateConfigCache("hmda.lei");
  invalidateConfigCache("hmda.agencyCode");

  return { run, seconds: (Date.now() - startedAt) / 1000 };
}

// ---------------------------------------------------------------------------
// removeDemoData — DELETE /api/admin/demo-data (204)
// ---------------------------------------------------------------------------

export async function removeDemoData(actor: SeedActorContext = SYSTEM_SEED_ACTOR): Promise<void> {
  if (!demoModeEnabled()) {
    throw new Error("removeDemoData invoked with DEMO_MODE off — route gating failed");
  }

  let storageKeys: string[] = [];
  await prisma.$transaction(
    async (tx) => {
      await acquireSeedLock(tx);
      const removal = await removeSeedSetInTx(tx);
      storageKeys = removal.storageKeys;
      const removedAt = new Date();
      await tx.seedRun.updateMany({ where: { removedAt: null }, data: { removedAt } });
      await restoreHmdaIfSeeded(tx, actor);

      const totalRemoved = Object.values(removal.removedCounts).reduce((a, b) => a + b, 0);
      // The LIVE removal action audit — NOT seed-flagged (survives as the
      // record that seed data was removed; INV-009 exception applies only to
      // seed-flagged rows).
      await audit(tx as AuditTransactionClient, {
        actor: actor.userId,
        role: actor.role,
        actionType: "remove-demo-data",
        entityType: "SeedRun",
        summary: `Demo data removed (${totalRemoved} seed-flagged rows deleted; only isSeed records affected)`,
        after: { removedCounts: removal.removedCounts } as Prisma.InputJsonValue,
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      });
    },
    { timeout: SEED_TX_TIMEOUT_MS, maxWait: SEED_TX_MAX_WAIT_MS },
  );

  await deleteStorageObjects(storageKeys);
  invalidateConfigCache("hmda.lei");
  invalidateConfigCache("hmda.agencyCode");
}
