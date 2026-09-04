/**
 * §7.7 — XBR-013 / AC-26 / INV-037 in-transaction audit coverage for the four
 * state-changing, contractually-audited endpoints that
 * `zz-seam-audit-rollback.test.ts` does not reach (LENS-011):
 *
 *   1. POST /api/notifications/:id/retry                          — HTTP + seam
 *   2. POST /api/applications/:id/decision-notification/retry     — HTTP + seam
 *   3. POST /api/admin/demo-data/seed                             — mechanism + structure
 *   4. DELETE /api/admin/demo-data                                — mechanism + structure
 *
 * (1) and (2) are proven exactly the way the sibling file proves transition and
 * note: arm `fail-next-audit-write`, call the endpoint over HTTP, assert the call
 * fails, assert the state change did not persist and no audit row exists, then
 * repeat with the seam disarmed to prove the endpoint really does mutate AND
 * audit — so "nothing changed" is not vacuously true.
 *
 * (3) and (4) CANNOT be invoked: `POST /api/admin/demo-data/seed` re-seeds
 * removal-first and `DELETE /api/admin/demo-data` deletes every isSeed row —
 * both destroy the §4.6.12 demo dataset the delivery and every other suite
 * depend on, which is exactly why 04-audit-route-coverage.test.ts excludes them
 * from its enumeration. They are proven here in the two halves the seam allows
 * without committing anything:
 *
 *   MECHANISM — a real interactive transaction against the real database runs
 *     the real `audit()` with the real `armFailNextAuditWrite()` seam. Armed, the
 *     audit insert throws and the paired mutation does not commit; disarmed, the
 *     audit row is visible INSIDE the transaction and vanishes when the
 *     transaction aborts. Nothing is ever committed by either half.
 *   USE — an executable source assertion that both demo-data services perform
 *     their mutation and their `audit(tx, ...)` call inside ONE
 *     `prisma.$transaction(...)` callback, and that the two routes call exactly
 *     those services. Mechanism proven once + these routes provably use the
 *     mechanism.
 *
 * What that does NOT prove: that a real seed run or a real removal, with its
 * advisory lock and its full row set, rolls back. Proving that behaviourally
 * requires a disposable database — see verification/lens-fixes/lens-011/README.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { armFailNextAuditWrite, audit, type AuditTransactionClient } from "@/lib/services/audit";
import {
  demoLogin,
  extractToken,
  hydrate,
  outboundMessagesFor,
  registerBorrower,
  suitePrefix,
  STRONG_PASSWORD,
  type Session,
} from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { requireSeam, seam } from "../helpers/seam.js";
import { POST, expectOk } from "../helpers/http.js";
import { auditEntries } from "../helpers/audit.js";
import { getApplication } from "../helpers/application.js";
import {
  approvalDecision,
  toPreliminaryDecision,
  NON_ESCALATING_SHAPE,
  type Actors,
} from "../helpers/workflow.js";

const PREFIX = suitePrefix("rollback-extra");
const ROOT = process.cwd();

let supervisor: Session;
let caseworker: Session;
let db: PrismaClient;

/** Notification row this file fabricated; deleted in after() and verified gone. */
let fixtureNotificationId: string | null = null;

// ---------------------------------------------------------------------------
// Fixture: a failed EXTERNAL delivery for POST /api/notifications/:id/retry
// ---------------------------------------------------------------------------
//
// The endpoint's 409 guards require `channel !== 'in-app'` AND
// `deliveryStatus === 'failed'`. Reaching that state through contracted
// endpoints alone means three real delivery attempts against the §6.3.8
// @bounce.example seam, separated by the PERSISTED ASM-009 backoff (60s then
// 120s) — no contracted endpoint and no fixture-seam op can move
// Notification.nextAttemptAt, so the precondition costs three minutes of wall
// clock and depends on in-process timers. This file therefore writes the
// precondition row directly and deletes it again; the row is a PRECONDITION,
// never the thing under test — every assertion below observes the endpoint's
// own behaviour through HTTP and the contracted audit read path.
//
// The recipient is a SUPERVISOR: §4.8.1 resolves no external sends for staff,
// so the disarmed retry settles deterministically to 'sent' without creating
// OutboundMessage rows. A non-seed supervisor is preferred so the row is not
// even reachable by the WALK-004 removal predicate; the seeded demo supervisor
// is the fallback. isSeed rows are never read-modified by this file.
async function createFailedNotificationFixture(): Promise<string> {
  const staff =
    (await db.user.findFirst({
      where: { role: "SUPERVISOR", status: "active", isSeed: false },
      select: { id: true },
    })) ?? { id: supervisor.userId };

  const row = await db.notification.create({
    data: {
      recipientUserId: staff.id,
      type: "delivery-failure",
      title: `${PREFIX} failed external delivery`,
      body: "LENS-011 precondition row — a failed external delivery awaiting manual retry.",
      channel: "email",
      deliveryStatus: "failed",
      deliveryError: "LENS-011 fixture: simulated bounce",
      deliveryAttempts: 3,
      nextAttemptAt: null,
    },
    select: { id: true },
  });
  fixtureNotificationId = row.id;
  return row.id;
}

interface NotificationRow {
  deliveryStatus: string;
  deliveryAttempts: number;
  deliveryError: string | null;
  nextAttemptAt: Date | null;
  readAt: Date | null;
}

async function readNotification(id: string): Promise<NotificationRow> {
  const row = await db.notification.findUnique({
    where: { id },
    select: {
      deliveryStatus: true,
      deliveryAttempts: true,
      deliveryError: true,
      nextAttemptAt: true,
      readAt: true,
    },
  });
  assert.ok(row, `notification ${id} disappeared`);
  return row as NotificationRow;
}

// ---------------------------------------------------------------------------
// Fixture: an application whose decision dispatch failed (WF-049 pending retry)
// ---------------------------------------------------------------------------
//
// Built entirely through contracted endpoints. A borrower moves its address to
// the §6.3.8 `@bounce.example` seam through the contracted change-email flow,
// so the ASYNC-003 in-tx decision dispatch throws and T27 aborts, leaving the
// application in `approved` with decisionNotificationPending — the exact
// precondition POST /api/applications/:id/decision-notification/retry requires.
async function bounceBorrowerSession(label: string): Promise<Session> {
  const fresh = await registerBorrower(supervisor, `${PREFIX}-${label}`);
  const bounceEmail = `${PREFIX}-${label}@bounce.example`;
  expectOk(
    await POST("/api/profile/change-email", {
      session: fresh.session,
      body: { newEmail: bounceEmail, currentPassword: STRONG_PASSWORD },
    }),
    "POST /api/profile/change-email",
    200,
  );
  const token = extractToken(await outboundMessagesFor(supervisor, bounceEmail));
  expectOk(
    await POST("/api/profile/verify-new-email", { body: { token } }),
    "POST /api/profile/verify-new-email",
    200,
  );
  // The address change rotates nothing the harness caches except the session view.
  return hydrate(fresh.session.cookie);
}

async function awaitPendingDecisionNotification(
  applicationId: string,
  timeoutMs = 60000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const application = await getApplication(supervisor, applicationId);
    if (
      application.decisionNotificationPending === true &&
      (application.workflowState === "approved" || application.workflowState === "denied")
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `application ${applicationId} never reached approved/denied + decisionNotificationPending ` +
          `(state ${application.workflowState}, pending ${String(application.decisionNotificationPending)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  await requireSeam();
  db = new PrismaClient();
});

after(async () => {
  // Every row this file FABRICATED is removed again (audit rows are append-only
  // by INV-009 and are deliberately not touched — see the README).
  if (fixtureNotificationId) {
    await db.outboundMessage.deleteMany({ where: { notificationId: fixtureNotificationId } });
    await db.notification.deleteMany({ where: { id: fixtureNotificationId } });
    const survivors = await db.notification.count({ where: { id: fixtureNotificationId } });
    assert.equal(survivors, 0, "the fabricated notification fixture must be gone");
  }
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. POST /api/notifications/:id/retry
// ---------------------------------------------------------------------------

describe("§7.7 POST /api/notifications/:id/retry audits in-transaction (XBR-013)", () => {
  test("a retry whose audit write fails leaves the delivery row untouched", { timeout: 300000 }, async () => {
    const id = await createFailedNotificationFixture();
    const path = `/api/notifications/${id}/retry`;
    const beforeRow = await readNotification(id);
    assert.equal(beforeRow.deliveryStatus, "failed");
    assert.equal(beforeRow.deliveryAttempts, 3);

    const beforeAudit = new Set((await auditEntries(supervisor, 200)).map((row) => row.id));

    await seam("fail-next-audit-write", { armed: true });
    try {
      const result = await POST(path, { session: supervisor });
      assert.ok(result.status >= 400, `the retry must be rejected, got ${result.status} — ${result.text.slice(0, 300)}`);
    } finally {
      await seam("fail-next-audit-write", { armed: false });
    }

    const afterRow = await readNotification(id);
    assert.deepEqual(
      {
        deliveryStatus: afterRow.deliveryStatus,
        deliveryAttempts: afterRow.deliveryAttempts,
        deliveryError: afterRow.deliveryError,
        nextAttemptAt: afterRow.nextAttemptAt,
      },
      {
        deliveryStatus: beforeRow.deliveryStatus,
        deliveryAttempts: beforeRow.deliveryAttempts,
        deliveryError: beforeRow.deliveryError,
        nextAttemptAt: beforeRow.nextAttemptAt,
      },
      "the attempt-cycle reset must have rolled back with its audit row",
    );

    const added = (await auditEntries(supervisor, 200)).filter((row) => !beforeAudit.has(row.id));
    assert.ok(
      !added.some((row) => row.entityId === id),
      `a rolled-back retry must leave no audit row: ${JSON.stringify(added.map((row) => row.actionType))}`,
    );
  });

  test("the same retry succeeds and IS audited once the audit write is healthy", { timeout: 300000 }, async () => {
    const id = fixtureNotificationId;
    assert.ok(id, "the notification fixture must exist");
    const path = `/api/notifications/${id}/retry`;

    const result = await POST(path, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 400));

    const settled = await readNotification(id);
    assert.notEqual(settled.deliveryStatus, "failed", "the retry must have reset the delivery cycle");

    const audited = (await auditEntries(supervisor, 200)).filter(
      (row) => row.entityId === id && row.actionType === "notification-retry",
    );
    assert.equal(audited.length, 1, "exactly one notification-retry audit row must exist for this notification");
    assert.equal(audited[0]!.actorRole, "SUPERVISOR");
  });
});

// ---------------------------------------------------------------------------
// 2. POST /api/applications/:id/decision-notification/retry
// ---------------------------------------------------------------------------

describe("§7.7 POST /api/applications/:id/decision-notification/retry audits in-transaction (XBR-013)", () => {
  test(
    "a decision-notification retry whose audit write fails dispatches nothing",
    { timeout: 1200000 },
    async () => {
      const borrower = await bounceBorrowerSession("decision");
      const actors: Actors = { borrower, caseworker, supervisor };
      const application = await toPreliminaryDecision(actors, NON_ESCALATING_SHAPE);
      const decided = await approvalDecision(supervisor, application.id, {
        decision: "approve",
        notes: "LENS-011 fixture — the decision dispatch must fail against the bounce address.",
      });
      assert.equal(decided.status, 200, decided.text.slice(0, 400));
      await awaitPendingDecisionNotification(application.id);

      const path = `/api/applications/${application.id}/decision-notification/retry`;
      const beforeApp = await getApplication(supervisor, application.id);
      const beforeAudit = new Set((await auditEntries(supervisor, 400)).map((row) => row.id));

      await seam("fail-next-audit-write", { armed: true });
      try {
        const result = await POST(path, { session: supervisor });
        assert.ok(
          result.status >= 400,
          `the retry must be rejected, got ${result.status} — ${result.text.slice(0, 300)}`,
        );
      } finally {
        await seam("fail-next-audit-write", { armed: false });
      }

      const afterApp = await getApplication(supervisor, application.id);
      assert.equal(afterApp.workflowState, beforeApp.workflowState, "no T27/T28 transition may have happened");
      assert.equal(afterApp.versionStamp, beforeApp.versionStamp, "the version stamp must not have advanced");
      assert.equal(
        afterApp.decisionNotificationPending,
        true,
        "the pending-retry indicator must survive a rolled-back retry",
      );

      const added = (await auditEntries(supervisor, 400)).filter((row) => !beforeAudit.has(row.id));
      assert.ok(
        !added.some((row) => row.applicationNumber === application.applicationNumber),
        `a rolled-back retry must leave no audit row: ${JSON.stringify(added.map((row) => row.actionType))}`,
      );

      // Healthy audit write: the retry action itself must now be audited. The
      // dispatch still bounces, so the application legitimately stays pending —
      // WF-049 audits the retry ACTION, which is the row asserted here.
      const healthy = await POST(path, { session: supervisor });
      assert.equal(healthy.status, 200, healthy.text.slice(0, 400));
      const auditedNow = (await auditEntries(supervisor, 400)).filter(
        (row) =>
          !beforeAudit.has(row.id) &&
          row.applicationNumber === application.applicationNumber &&
          row.actionType === "notification-retry",
      );
      assert.equal(auditedNow.length, 1, "the healthy retry must write exactly one notification-retry audit row");
    },
  );
});

// ---------------------------------------------------------------------------
// 3 + 4. The two demo-data endpoints — mechanism, then use
// ---------------------------------------------------------------------------

const PROBE_MARKER = "LENS-011 mechanism probe — must never commit";

describe("§7.7 the audit mechanism the demo-data endpoints use aborts its transaction", () => {
  test("audit() writes inside the caller's transaction and vanishes when it aborts", { timeout: 120000 }, async () => {
    const key = `t46-lens011:${randomUUID()}`;
    class Sentinel extends Error {}

    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.rateLimitBucket.create({ data: { key, windowStart: new Date(), count: 1 } });
        const row = await audit(tx as AuditTransactionClient, {
          actor: null,
          role: "SYSTEM",
          actionType: "seed-demo-data",
          entityType: "SeedRun",
          summary: PROBE_MARKER,
        });
        // Positive control: the row really is written by audit() — visible on
        // this transaction's own client before the abort.
        const inTx = await tx.auditLogEntry.findUnique({ where: { id: row.id } });
        assert.ok(inTx, "audit() must create the row inside the caller's transaction");
        throw new Sentinel("abort");
      }),
      (err: unknown) => err instanceof Sentinel,
    );

    assert.equal(await db.rateLimitBucket.count({ where: { key } }), 0, "the paired mutation must not commit");
    assert.equal(
      await db.auditLogEntry.count({ where: { summary: PROBE_MARKER } }),
      0,
      "the audit row must not commit when its transaction aborts",
    );
  });

  test("an armed audit-write failure aborts the transaction and commits nothing", { timeout: 120000 }, async () => {
    const key = `t46-lens011:${randomUUID()}`;

    armFailNextAuditWrite(true);
    try {
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.rateLimitBucket.create({ data: { key, windowStart: new Date(), count: 1 } });
          await audit(tx as AuditTransactionClient, {
            actor: null,
            role: "SYSTEM",
            actionType: "remove-demo-data",
            entityType: "SeedRun",
            summary: PROBE_MARKER,
          });
        }),
        /Simulated audit-write failure/,
      );
    } finally {
      armFailNextAuditWrite(false);
    }

    assert.equal(
      await db.rateLimitBucket.count({ where: { key } }),
      0,
      "the mutation paired with a failing audit write must roll back",
    );
    assert.equal(await db.auditLogEntry.count({ where: { summary: PROBE_MARKER } }), 0);
  });
});

// --- executable source assertions -------------------------------------------

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

/**
 * Index of the delimiter matching the one at `open`, skipping line comments,
 * block comments and string/template literals. The demo-seed module's template
 * literals contain no nested quotes or backticks, so opaque-until-close is
 * correct here; a future edit that broke that assumption would fail loudly
 * rather than silently mis-parse.
 */
function matchDelimiter(src: string, open: number, openChar: string, closeChar: string): number {
  assert.equal(src[open], openChar, "matchDelimiter must start on the opening delimiter");
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const eol = src.indexOf("\n", i);
      if (eol < 0) break;
      i = eol;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === "\\") {
          i += 1;
          continue;
        }
        if (src[i] === c) break;
      }
      continue;
    }
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${openChar}${closeChar} from offset ${open}`);
}

function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const brace = src.indexOf("{", start + signature.length);
  return src.slice(brace, matchDelimiter(src, brace, "{", "}") + 1);
}

/** The argument region of the single `prisma.$transaction(...)` call in `body`. */
function soleTransactionRegion(body: string, what: string): string {
  const occurrences = body.split("prisma.$transaction(").length - 1;
  assert.equal(occurrences, 1, `${what} must open exactly one interactive transaction, found ${occurrences}`);
  const open = body.indexOf("prisma.$transaction(") + "prisma.$transaction".length;
  return body.slice(open, matchDelimiter(body, open, "(", ")") + 1);
}

describe("§7.7 the demo-data endpoints use that mechanism (POST seed / DELETE demo-data)", () => {
  const demoSeed = read("src", "lib", "services", "demo-seed", "index.ts");

  test("the demo-seed service audits through the proven module", () => {
    assert.match(
      demoSeed,
      /import \{[\s\S]*?\baudit\b[\s\S]*?\} from "@\/lib\/services\/audit"/,
      "demo-seed must audit through src/lib/services/audit — the module the mechanism tests above exercise",
    );
  });

  test("runDemoSeed mutates and audits inside ONE transaction (POST /api/admin/demo-data/seed)", () => {
    const body = functionBody(demoSeed, "export async function runDemoSeed");
    const tx = soleTransactionRegion(body, "runDemoSeed");

    for (const fragment of ["removeSeedSetInTx(tx)", "buildFullDataset(tx", "audit(tx as AuditTransactionClient"]) {
      assert.ok(tx.includes(fragment), `runDemoSeed's transaction must contain \`${fragment}\``);
    }
    assert.equal(
      body.split("audit(").length - tx.split("audit(").length,
      0,
      "no audit call in runDemoSeed may sit outside the transaction",
    );

    const route = read("src", "app", "api", "admin", "demo-data", "seed", "route.ts");
    assert.match(route, /from "@\/lib\/services\/demo-seed"/);
    assert.match(route, /await runDemoSeed\(/, "POST /api/admin/demo-data/seed must go through runDemoSeed");
  });

  test("removeDemoData mutates and audits inside ONE transaction (DELETE /api/admin/demo-data)", () => {
    const body = functionBody(demoSeed, "export async function removeDemoData");
    const tx = soleTransactionRegion(body, "removeDemoData");

    for (const fragment of ["removeSeedSetInTx(tx)", "audit(tx as AuditTransactionClient"]) {
      assert.ok(tx.includes(fragment), `removeDemoData's transaction must contain \`${fragment}\``);
    }
    assert.equal(
      body.split("audit(").length - tx.split("audit(").length,
      0,
      "no audit call in removeDemoData may sit outside the transaction",
    );

    const route = read("src", "app", "api", "admin", "demo-data", "route.ts");
    assert.match(route, /from "@\/lib\/services\/demo-seed"/);
    assert.match(route, /await removeDemoData\(/, "DELETE /api/admin/demo-data must go through removeDemoData");
  });
});
