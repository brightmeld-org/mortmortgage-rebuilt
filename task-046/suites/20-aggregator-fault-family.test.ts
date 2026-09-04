/**
 * §7.7 — the §6.3.5 financial-data-aggregator FAULT FAMILY (LENS-012).
 *
 * §6.3.5 declares two INPUT-TRIGGER faults for the aggregator simulation
 * ("password `fail` → authentication failure; password `slow` → 8 s latency"),
 * plus the SIM_FAULT_BANKLINK=slow configuration trigger and the documented
 * "2,000 ms ± 800 on exchange" base latency. Implementation:
 * `src/lib/services/bank-aggregator.ts` (exchangeCredentials / isSlowExchange /
 * bankLinkExchangeLatencyMs) behind `POST /api/applications/:id/bank-links`.
 *
 * HOW EACH CLAIM IS PROVED
 *   - `fail` → the REAL route, asserting the contracted 401 `auth_failed` AND
 *     that NOTHING was persisted (no `bank-link` audit entry ⇒ no BankLink row
 *     and no encrypted access token), contrasted with a successful link on the
 *     same draft which DOES produce one.
 *   - the EXACT +8,000 ms slow-extra → the PURE latency function, called twice
 *     for the same username (slow=false vs slow=true) and differenced. No 8 s
 *     wall-clock sleep is needed to prove the number.
 *   - that the ROUTE actually applies the slow-extra → one wall-clock
 *     measurement (the only way to observe a sleep the caller cannot see);
 *     bounds are deliberately loose there and the tolerance is called out.
 *
 * Everything except the two pure-function describes runs over HTTP against the
 * running app, like the rest of the §7.7 suite.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
  bankLinkExchangeLatencyMs,
  bankLinkSimFault,
  exchangeCredentials,
  isSlowExchange,
  listInstitutions,
  SIMULATED_INSTITUTIONS,
  type InstitutionInfo,
} from "@/lib/services/bank-aggregator";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { GET, POST, expectOk, type ErrorResponse } from "../helpers/http.js";
import { createDraft, type Application } from "../helpers/application.js";

const PREFIX = suitePrefix("agg");

/** §6.3.5 documented defaults (bank-aggregator.ts envInt fallbacks). */
const BASE_MS = 2000;
const JITTER_MS = 800;
const SLOW_EXTRA_MS = 8000;

/** The env keys that would move those defaults out from under the assertions. */
const LATENCY_ENV_KEYS = [
  "SIM_LATENCY_BANKLINK_BASE_MS",
  "SIM_LATENCY_BANKLINK_JITTER_MS",
  "SIM_LATENCY_BANKLINK_SLOW_EXTRA_MS",
] as const;

/** A spread of usernames — the latency seed is `banklink|{username}`. */
const USERNAMES = [
  "alice",
  "bob",
  "match-borrower",
  "carol.smith",
  "d",
  "eve@example.test",
  "frank123",
  "grace-hopper",
  "heidi",
  "ivan",
  "judy",
  "ken",
];

/** §A InstitutionList. */
interface InstitutionList {
  rows: InstitutionInfo[];
}

/** §A BankLinkSession. */
interface BankLinkSession {
  linkId: string;
  accounts: Array<{
    externalAccountId: string;
    accountType: string;
    institution: string;
    last4: string;
    balance: number;
  }>;
  incomeEvidence?: Array<{ employerName: string; employerMatch: boolean; averageMonthlyDeposit: number }>;
}

interface AuditPage {
  rows: Array<{ actionType: string; entityType?: string; entityId?: string; summary: string }>;
  total: number;
}

let supervisor: Session;
let borrower: Session;

before(async () => {
  // The §6.3.5 numbers under test are the documented defaults; an env override in
  // the harness process would silently redefine them, so refuse to run instead.
  for (const key of LATENCY_ENV_KEYS) {
    const raw = process.env[key];
    assert.ok(
      raw === undefined || raw.trim() === "",
      `${key} is set to "${raw}" — this suite asserts the §6.3.5 documented defaults, unset it to run`,
    );
  }

  supervisor = await demoLogin("supervisor");
  await ensureAuthHeadroom(supervisor);
  borrower = (await registerBorrower(supervisor, `${PREFIX}-b`)).session;
});

/** Every `bank-link` audit entry recorded for one application number. */
async function bankLinkAudits(applicationNumber: string): Promise<AuditPage["rows"]> {
  const path =
    `/api/admin/audit-log?actionType=bank-link` +
    `&applicationSearch=${encodeURIComponent(applicationNumber)}&page=1&pageSize=100`;
  const body = expectOk(await GET<AuditPage>(path, { session: supervisor }), `GET ${path}`, 200);
  return body.rows ?? [];
}

async function firstInstitutionId(): Promise<string> {
  const body = expectOk(
    await GET<InstitutionList>("/api/bank-link/institutions", { session: borrower }),
    "GET /api/bank-link/institutions",
    200,
  );
  assert.ok(body.rows.length >= 6, `§6.3.5 requires at least 6 institutions, got ${body.rows.length}`);
  return body.rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Input trigger: password `fail` → institution authentication failure
// ---------------------------------------------------------------------------

describe("§6.3.5 fault trigger — password `fail` is an authentication failure that persists nothing", () => {
  test("the route answers 401 auth_failed and writes no bank-link, then the same draft links successfully", { timeout: 120000 }, async () => {
    const institutionId = await firstInstitutionId();
    const draft: Application = await createDraft(borrower);
    const path = `/api/applications/${draft.id}/bank-links`;

    assert.deepEqual(
      await bankLinkAudits(draft.applicationNumber),
      [],
      "a fresh draft must start with no bank-link audit entries",
    );

    const failed = await POST<ErrorResponse>(path, {
      session: borrower,
      body: { institutionId, username: `${PREFIX}-fail-user`, password: "fail" },
    });
    assert.equal(failed.status, 401, `password \`fail\` must be a 401: ${failed.text.slice(0, 300)}`);
    assert.equal(
      failed.body.code,
      "auth_failed",
      "§6.3.5 institution rejection is the contracted auth_failed code, not the session 401",
    );
    assert.ok(
      !("linkId" in (failed.body as unknown as Record<string, unknown>)),
      "a rejected exchange must not return a link session",
    );

    // The audit entry is written INSIDE the same transaction as the BankLink row
    // (bank-link.ts createBankLink), so its absence is proof that neither the row
    // nor the encrypted access token was persisted.
    assert.deepEqual(
      await bankLinkAudits(draft.applicationNumber),
      [],
      "a failed credential exchange must persist no BankLink row and no access token",
    );

    // Contrast: the identical call with a non-trigger password succeeds and DOES persist.
    const ok = await POST<BankLinkSession>(path, {
      session: borrower,
      body: { institutionId, username: `${PREFIX}-ok-user`, password: "Tst-Fixture-Phrase-4417" },
    });
    const session = expectOk(ok, `POST ${path} (non-trigger password)`, 200);
    assert.ok(session.linkId && session.linkId.length > 0, "a successful exchange returns a link session");
    assert.ok(
      session.accounts.length >= 2 && session.accounts.length <= 4,
      `§6.3.5 derives 2–4 accounts, got ${session.accounts.length}`,
    );
    for (const account of session.accounts) {
      assert.match(account.last4, /^\d{4}$/, "accounts expose last4 only");
      assert.ok(
        account.balance >= 1800 && account.balance <= 85000,
        `§6.3.5 balances are $1,800–$85,000, got ${account.balance}`,
      );
    }

    const after = await bankLinkAudits(draft.applicationNumber);
    assert.equal(after.length, 1, "exactly the successful link is audited");
    assert.equal(after[0]!.entityType, "BankLink");
  });

  test("the `fail` trigger is exact-match — neighbouring passwords still link", () => {
    const institution = SIMULATED_INSTITUTIONS[0]!;
    const call = (password: string) =>
      exchangeCredentials(institution, "trigger-probe", password, 6000, "Northwind Traders", new Date("2026-01-15T00:00:00Z"));

    assert.equal(call("fail").ok, false, "`fail` is the documented authentication-failure trigger");
    for (const near of ["failure", "Fail", "FAIL", " fail", "fail ", "failed", "prevail"]) {
      assert.equal(call(near).ok, true, `\`${near}\` is not the trigger — it must link successfully`);
    }
  });

  test("a rejected exchange yields no accounts, no income evidence and no access token", () => {
    const rejected = exchangeCredentials(
      SIMULATED_INSTITUTIONS[1]!,
      "rejected-user",
      "fail",
      6000,
      "Northwind Traders",
      new Date("2026-01-15T00:00:00Z"),
    );
    assert.equal(rejected.ok, false);
    const asRecord = rejected as unknown as Record<string, unknown>;
    for (const field of ["accounts", "incomeEvidence", "accessToken", "usernameHash", "institution"]) {
      assert.equal(asRecord[field], undefined, `an auth failure must carry no ${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Input trigger: password `slow` → +8 s
// ---------------------------------------------------------------------------

describe("§6.3.5 fault trigger — `slow` adds exactly the documented 8 s, deterministically", () => {
  test("the slow-extra is exactly 8,000 ms for every username (pure function, no wall-clock sleep)", () => {
    for (const username of USERNAMES) {
      const normal = bankLinkExchangeLatencyMs(username, false);
      const slow = bankLinkExchangeLatencyMs(username, true);
      assert.equal(
        slow - normal,
        SLOW_EXTRA_MS,
        `§6.3.5 "password \`slow\` → 8 s latency": ${username} moved by ${slow - normal} ms, not ${SLOW_EXTRA_MS}`,
      );
    }
  });

  test("base latency is 2,000 ms ± 800 and slow latency is that band shifted by 8 s", () => {
    for (const username of USERNAMES) {
      const normal = bankLinkExchangeLatencyMs(username, false);
      assert.ok(
        normal >= BASE_MS - JITTER_MS && normal <= BASE_MS + JITTER_MS,
        `§6.3.5 "2,000 ms ± 800": ${username} → ${normal} ms is outside [${BASE_MS - JITTER_MS}, ${BASE_MS + JITTER_MS}]`,
      );
      const slow = bankLinkExchangeLatencyMs(username, true);
      assert.ok(
        slow >= BASE_MS - JITTER_MS + SLOW_EXTRA_MS && slow <= BASE_MS + JITTER_MS + SLOW_EXTRA_MS,
        `slow latency ${slow} ms is outside the shifted band`,
      );
    }
  });

  test("latency is deterministic per username and genuinely jittered across usernames", () => {
    for (const username of USERNAMES) {
      const a = bankLinkExchangeLatencyMs(username, false);
      const b = bankLinkExchangeLatencyMs(username, false);
      const c = bankLinkExchangeLatencyMs(username, false);
      assert.equal(a, b, `same username must always yield the same latency (${username})`);
      assert.equal(b, c, `same username must always yield the same latency (${username})`);
    }
    const distinct = new Set(USERNAMES.map((u) => bankLinkExchangeLatencyMs(u, false)));
    assert.ok(
      distinct.size >= 3,
      `the ±800 jitter must actually vary by username — ${USERNAMES.length} usernames produced ${distinct.size} distinct latencies`,
    );
  });

  test("isSlowExchange: the password trigger is exact-match", () => {
    assert.equal(bankLinkSimFault(), "none", "SIM_FAULT_BANKLINK must be unset/none for this assertion");
    assert.equal(isSlowExchange("slow"), true, "`slow` is the documented latency trigger");
    for (const near of ["slowly", "Slow", "SLOW", " slow", "slow ", "slower", "fail", "hunter2"]) {
      assert.equal(isSlowExchange(near), false, `\`${near}\` is not the trigger`);
    }
  });

  test("SIM_FAULT_BANKLINK=slow applies the slow-extra to EVERY exchange; unknown values degrade to none", () => {
    const original = process.env.SIM_FAULT_BANKLINK;
    try {
      process.env.SIM_FAULT_BANKLINK = "slow";
      assert.equal(bankLinkSimFault(), "slow");
      assert.equal(isSlowExchange("hunter2"), true, "the configuration trigger ignores the password");
      const username = "config-fault-user";
      assert.equal(
        bankLinkExchangeLatencyMs(username, isSlowExchange("hunter2")) -
          bankLinkExchangeLatencyMs(username, false),
        SLOW_EXTRA_MS,
        "SIM_FAULT_BANKLINK=slow must add the same 8 s the password trigger adds",
      );

      // The ENV value is normalized (`.trim().toLowerCase()`), unlike the
      // password trigger which is exact-match — both are asserted deliberately.
      for (const variant of ["SLOW", " slow ", "Slow"]) {
        process.env.SIM_FAULT_BANKLINK = variant;
        assert.equal(bankLinkSimFault(), "slow", `SIM_FAULT_BANKLINK=${JSON.stringify(variant)} is normalized to slow`);
        assert.equal(isSlowExchange("hunter2"), true);
      }

      // §6.3 preamble lists six modes; the aggregator implements none|slow only,
      // and bank-aggregator.ts documents that anything else degrades to none.
      for (const unknown of ["timeout", "unavailable", "partial", "invalid", "yes", ""]) {
        process.env.SIM_FAULT_BANKLINK = unknown;
        assert.equal(bankLinkSimFault(), "none", `SIM_FAULT_BANKLINK=${unknown} must degrade to none`);
        assert.equal(isSlowExchange("hunter2"), false);
        assert.equal(isSlowExchange("slow"), true, "the password trigger stays active regardless of the fault mode");
      }
    } finally {
      if (original === undefined) delete process.env.SIM_FAULT_BANKLINK;
      else process.env.SIM_FAULT_BANKLINK = original;
    }
    assert.equal(bankLinkSimFault(), "none", "the environment must be restored");
  });

  test("the ROUTE applies the slow-extra — same username, `slow` vs a normal password", { timeout: 120000 }, async () => {
    const institutionId = await firstInstitutionId();
    const draft = await createDraft(borrower);
    const path = `/api/applications/${draft.id}/bank-links`;
    const username = `${PREFIX}-slow-user`;

    // Same username ⇒ identical deterministic base latency, so the difference
    // between the two round trips IS the slow-extra plus network/handler noise.
    const normalStart = Date.now();
    expectOk(
      await POST<BankLinkSession>(path, { session: borrower, body: { institutionId, username, password: "Tst-Fixture-Phrase-4417" } }),
      `POST ${path} (normal password)`,
      200,
    );
    const normalMs = Date.now() - normalStart;

    const slowStart = Date.now();
    expectOk(
      await POST<BankLinkSession>(path, { session: borrower, body: { institutionId, username, password: "slow" } }),
      `POST ${path} (slow password)`,
      200,
    );
    const slowMs = Date.now() - slowStart;

    // TOLERANCE (stated deliberately): the lower bound is tight — the handler
    // cannot return early — while the upper bound is loose because a shared dev
    // server adds unbounded scheduling noise. The EXACT 8,000 ms is asserted on
    // the pure function above; this test only proves the route applies it.
    const delta = slowMs - normalMs;
    assert.ok(
      delta >= SLOW_EXTRA_MS - 500,
      `the \`slow\` password must add ~8 s at the route: normal ${normalMs} ms, slow ${slowMs} ms (delta ${delta} ms)`,
    );
    assert.ok(
      slowMs >= BASE_MS - JITTER_MS + SLOW_EXTRA_MS - 500,
      `the slow round trip must itself exceed the shifted band floor, got ${slowMs} ms`,
    );
    assert.ok(
      normalMs < BASE_MS + JITTER_MS + SLOW_EXTRA_MS - 2000,
      `the control round trip must NOT carry the slow-extra, got ${normalMs} ms`,
    );
  });
});

// ---------------------------------------------------------------------------
// Roster (§6.3.5 "at least 6 fictional institutions")
// ---------------------------------------------------------------------------

describe("§6.3.5 institution roster", () => {
  test("at least 6 fictional institutions with stable ids, identical over HTTP and in the module", async () => {
    const body = expectOk(
      await GET<InstitutionList>("/api/bank-link/institutions", { session: borrower }),
      "GET /api/bank-link/institutions",
      200,
    );
    assert.ok(body.rows.length >= 6, `§6.3.5 requires at least 6, got ${body.rows.length}`);
    assert.deepEqual(body.rows, [...listInstitutions()], "the route serves the module roster verbatim");
    assert.equal(new Set(body.rows.map((r) => r.id)).size, body.rows.length, "institution ids are unique");

    const again = expectOk(
      await GET<InstitutionList>("/api/bank-link/institutions", { session: borrower }),
      "GET /api/bank-link/institutions (repeat)",
      200,
    );
    assert.deepEqual(again.rows, body.rows, "ids are stable across calls (clients may cache them)");
  });
});
