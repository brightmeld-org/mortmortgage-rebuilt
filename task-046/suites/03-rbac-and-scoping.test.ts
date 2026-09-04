/**
 * §7.7 — RBAC and data scoping for EVERY route and role, positive and negative.
 *
 * The route list is enumerated from contracts.json so no endpoint can be silently
 * omitted (INV-038, AC-56). Positive direction: a caller whose role is in the
 * declared roleGate must get past the guard (any status other than 401/403).
 * Negative direction: a caller whose role is not in the gate must be denied 403,
 * and an anonymous caller on a non-public route must be denied 401/403 — with no
 * request body, proving the guard runs before body parsing (SEC-19).
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { api, GET, POST, expectOk } from "../helpers/http.js";
import { endpointKey, endpoints, fillPath, type ContractEndpoint } from "../helpers/contract.js";
import { buildSubmittableDraft, createDraft, getApplication, transitionOk, type Application } from "../helpers/application.js";
import { claim } from "../helpers/application.js";

const PREFIX = suitePrefix("rbac");

/**
 * Public POST endpoints on the auth surface are excluded from the automated probe:
 * every one of them is rate-limited at 10 per 15 minutes per key (§B rate limiter),
 * so probing them here would exhaust the buckets the fixture accounts depend on.
 * Each is exercised for real elsewhere in this suite set — listed with its home.
 */
const RATE_LIMITED_PUBLIC_EXCLUSIONS: Record<string, string> = {
  "POST /api/auth/register": "exercised by helpers/auth.registerBorrower in every suite",
  "POST /api/auth/verify-email": "exercised by helpers/auth.registerBorrower in every suite",
  "POST /api/auth/sign-in": "exercised by helpers/auth.registerBorrower and inviteStaff",
  "POST /api/auth/demo-login": "exercised by helpers/auth.demoLogin in every suite",
  "POST /api/auth/accept-invitation": "exercised by helpers/auth.inviteStaff",
  "POST /api/auth/forgot-password": "exercised by 11-auth-and-rate-limits.test.ts",
  "POST /api/auth/reset-password": "exercised by 11-auth-and-rate-limits.test.ts",
  "POST /api/auth/mfa/verify": "exercised by 11-auth-and-rate-limits.test.ts",
  "POST /api/profile/verify-new-email": "exercised by 11-auth-and-rate-limits.test.ts",
};

/**
 * Endpoints skipped in the POSITIVE direction only (their negative direction is still
 * probed). Each either destroys the probing session or the shared demo dataset, so
 * calling it during a matrix walk would invalidate the rest of the matrix.
 */
const POSITIVE_PROBE_EXCLUSIONS: Record<string, string> = {
  "POST /api/auth/sign-out": "terminates the probing session itself (REQ-016); exercised in 04-audit-route-coverage",
  "POST /api/admin/demo-data/seed": "ASYNC-006 re-seed removes the prior seed set first — destroys the shared §4.6.12 dataset",
  "DELETE /api/admin/demo-data": "WALK-004 deletes every isSeed row — destroys the shared §4.6.12 dataset",
  "POST /api/notifications/read-all": "mutates every notification of the probing account; exercised in 04-audit-route-coverage",
  "POST /api/test/fixtures":
    "TEST-ONLY fixture seam (task-046/test-fixtures-contract.md) — a test harness, not a product surface; exercised by the zz-seam-* files",
};

const ROLE_SESSIONS: Array<"borrower" | "caseworker" | "supervisor"> = ["borrower", "caseworker", "supervisor"];

let sessions: Record<string, Session>;
let anonymous: null;

/** Path params that are syntactically valid but reference nothing. */
function probePath(entry: ContractEndpoint): string {
  return fillPath(entry.path, {
    id: randomUUID(),
    section: "identity",
    ordinal: "1",
    versionId: randomUUID(),
    linkId: randomUUID(),
    checkType: "credit",
    element: "summary",
  });
}

function gateAllows(entry: ContractEndpoint, role: string): boolean {
  return (
    entry.roleGate.includes("public") ||
    entry.roleGate.includes("authenticated-any") ||
    entry.roleGate.includes(role)
  );
}

before(async () => {
  const supervisor = await demoLogin("supervisor");
  await ensureAuthHeadroom(supervisor);
  const caseworker = await demoLogin("caseworker");
  const borrower = await registerBorrower(supervisor, `${PREFIX}-b1`);
  sessions = { borrower: borrower.session, caseworker, supervisor };
  anonymous = null;
});

describe("§7.7 route × role authorization matrix (enumerated from contracts.json)", () => {
  test("the enumeration covers every contracted endpoint exactly once", () => {
    const keys = endpoints.map(endpointKey);
    assert.equal(new Set(keys).size, keys.length, "duplicate endpoint entries in the contract");
    assert.ok(keys.length >= 100, `expected the full endpoint table, saw ${keys.length}`);
    for (const key of [
      ...Object.keys(RATE_LIMITED_PUBLIC_EXCLUSIONS),
      ...Object.keys(POSITIVE_PROBE_EXCLUSIONS),
    ]) {
      assert.ok(keys.includes(key), `excluded endpoint ${key} is not in the contract table`);
    }
  });

  for (const role of ROLE_SESSIONS) {
    test(`negative: every route whose gate excludes ${role} denies ${role} with 403`, { timeout: 300000 }, async () => {
      const failures: string[] = [];
      for (const entry of endpoints) {
        if (gateAllows(entry, role)) continue;
        const result = await api(entry.method, probePath(entry), { session: sessions[role] });
        if (result.status !== 403) {
          failures.push(`${endpointKey(entry)} as ${role}: expected 403, got ${result.status} ${result.text.slice(0, 160)}`);
        }
      }
      assert.deepEqual(failures, [], failures.join("\n"));
    });

    test(`positive: every route whose gate includes ${role} lets ${role} past the guard`, { timeout: 300000 }, async () => {
      const failures: string[] = [];
      for (const entry of endpoints) {
        if (!gateAllows(entry, role)) continue;
        if (RATE_LIMITED_PUBLIC_EXCLUSIONS[endpointKey(entry)]) continue;
        if (POSITIVE_PROBE_EXCLUSIONS[endpointKey(entry)]) continue;
        const result = await api(entry.method, probePath(entry), { session: sessions[role] });
        if (result.status === 401 || result.status === 403) {
          failures.push(`${endpointKey(entry)} as ${role}: guard rejected an allowed role (${result.status}) ${result.text.slice(0, 160)}`);
        }
      }
      assert.deepEqual(failures, [], failures.join("\n"));
    });
  }

  test("negative: every non-public route denies an anonymous caller", { timeout: 300000 }, async () => {
    const failures: string[] = [];
    for (const entry of endpoints) {
      if (entry.roleGate.includes("public")) continue;
      const result = await api(entry.method, probePath(entry), { session: anonymous });
      if (![401, 403].includes(result.status)) {
        failures.push(`${endpointKey(entry)} anonymous: expected 401/403, got ${result.status} ${result.text.slice(0, 160)}`);
      }
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });

  test("positive: every public route is reachable without a session", { timeout: 300000 }, async () => {
    const failures: string[] = [];
    for (const entry of endpoints) {
      if (!entry.roleGate.includes("public")) continue;
      if (RATE_LIMITED_PUBLIC_EXCLUSIONS[endpointKey(entry)]) continue;
      const result = await api(entry.method, probePath(entry), { session: anonymous });
      if (result.status === 401 || result.status === 403) {
        failures.push(`${endpointKey(entry)} anonymous: public route rejected (${result.status})`);
      }
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });

  test("state-changing requests require the session-bound CSRF token (SEC-3)", { timeout: 120000 }, async () => {
    const application = await createDraft(sessions.borrower);
    const path = `/api/applications/${application.id}/sections/identity`;
    const withoutToken = await api("PUT", path, {
      session: sessions.borrower,
      omitCsrf: true,
      body: { versionStamp: application.versionStamp, section: "identity", borrowerOrdinal: 1, identity: { firstName: "X" } },
    });
    assert.equal(withoutToken.status, 403, withoutToken.text.slice(0, 200));
  });

  test("SEC-17 security headers are present on every response (AC-55)", async () => {
    const result = await GET("/api/health");
    for (const header of [
      "content-security-policy",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "strict-transport-security",
    ]) {
      assert.ok(result.headers.get(header), `missing ${header}`);
    }
  });
});

describe("§7.7 data scoping — borrowers see only their own file (S-1)", () => {
  let ownerApplication: Application;
  let otherBorrower: Session;

  before(async () => {
    ownerApplication = await createDraft(sessions.borrower);
    otherBorrower = (await registerBorrower(sessions.supervisor, `${PREFIX}-b2`)).session;
  });

  test("another borrower cannot read the application", async () => {
    const path = `/api/applications/${ownerApplication.id}`;
    const result = await GET(path, { session: otherBorrower });
    assert.ok([403, 404].includes(result.status), `expected 403/404, got ${result.status}`);
  });

  test("another borrower cannot write a section on it (INV-026)", async () => {
    const path = `/api/applications/${ownerApplication.id}/sections/identity`;
    const result = await api("PUT", path, {
      session: otherBorrower,
      body: {
        versionStamp: ownerApplication.versionStamp,
        section: "identity",
        borrowerOrdinal: 1,
        identity: { firstName: "Intruder" },
      },
    });
    assert.ok([403, 404].includes(result.status), `expected 403/404, got ${result.status}`);
  });

  test("another borrower cannot read the full-SSN identity-own endpoint (S-5)", async () => {
    const path = `/api/applications/${ownerApplication.id}/borrowers/1/identity`;
    const result = await GET(path, { session: otherBorrower });
    assert.ok([403, 404].includes(result.status), `expected 403/404, got ${result.status}`);
  });

  test("the owning borrower can read their own identity endpoint", async () => {
    const path = `/api/applications/${ownerApplication.id}/borrowers/1/identity`;
    const result = await GET<{ ordinal: number; identity: Record<string, unknown> }>(path, {
      session: sessions.borrower,
    });
    const body = expectOk(result, `GET ${path}`, 200);
    assert.equal(body.ordinal, 1);
    assert.ok(body.identity, "the identity payload must be present");
  });
});

describe("§7.7 data scoping — staff access follows assignment (S-2, INV-026)", () => {
  let application: Application;
  let owner: Session;

  before(async () => {
    owner = (await registerBorrower(sessions.supervisor, `${PREFIX}-b3`)).session;
    const draft = await buildSubmittableDraft(owner);
    application = await transitionOk(owner, draft.id, {
      toState: "application_received",
      versionStamp: draft.versionStamp,
    });
  });

  test("an unassigned caseworker cannot read the full application detail", async () => {
    const path = `/api/applications/${application.id}`;
    const result = await GET(path, { session: sessions.caseworker });
    assert.equal(result.status, 403, result.text.slice(0, 200));
  });

  test("the unassigned queue exposes only the summary field set for the same file", async () => {
    const result = await GET<{ rows: Array<Record<string, unknown>> }>("/api/queue/unassigned?pageSize=100", {
      session: sessions.caseworker,
    });
    const body = expectOk(result, "GET /api/queue/unassigned", 200);
    const row = body.rows.find((entry) => entry.applicationId === application.id);
    assert.ok(row, "the submitted application must appear in the unassigned queue");
    // QueueRow is the S-2 summary field set: no borrower SSN/DOB, no application data.
    for (const forbidden of ["ssn", "ssnMasked", "dateOfBirth", "dateOfBirthDisplay", "borrowers", "data"]) {
      assert.equal(row[forbidden], undefined, `QueueRow must not carry ${forbidden}`);
    }
  });

  test("after claiming, the same caseworker can read the file", async () => {
    const claimed = await claim(sessions.caseworker, application.id);
    assert.equal(claimed.status, 201, claimed.text.slice(0, 200));
    const detail = await getApplication(sessions.caseworker, application.id);
    assert.equal(detail.id, application.id);
  });

  test("the owner sees the caseworker's display name but never a staff user id (S-6)", async () => {
    const detail = await getApplication(owner, application.id);
    assert.ok(detail.assignedCaseworkerName, "the owner must see who is handling the file");
    const serialized = JSON.stringify(detail);
    assert.ok(
      !serialized.includes(sessions.caseworker.userId),
      "a staff User.id must never appear on a borrower-visible payload",
    );
  });
});

describe("§7.7 data scoping — notes visibility (S-7)", () => {
  test("borrowers receive only formal notes; internal and chatter are staff-only", { timeout: 300000 }, async () => {
    const borrower = (await registerBorrower(sessions.supervisor, `${PREFIX}-notes`)).session;
    const draft = await buildSubmittableDraft(borrower);
    const application = await transitionOk(borrower, draft.id, {
      toState: "application_received",
      versionStamp: draft.versionStamp,
    });
    await claim(sessions.caseworker, application.id);

    const notesPath = `/api/applications/${application.id}/notes`;
    for (const [type, content] of [
      ["internal", "Internal reviewer note."],
      ["formal", "Formal note visible to the borrower."],
      ["chatter", "Chatter message between staff."],
    ] as Array<[string, string]>) {
      const created = await POST(notesPath, { session: sessions.caseworker, body: { type, content } });
      assert.equal(created.status, 201, `${type}: ${created.text.slice(0, 200)}`);
    }

    const staffView = await GET<{ rows: Array<{ type: string }> }>(notesPath, { session: sessions.caseworker });
    const staffTypes = new Set(expectOk(staffView, "staff notes", 200).rows.map((row) => row.type));
    assert.ok(staffTypes.has("internal") && staffTypes.has("formal") && staffTypes.has("chatter"));

    const borrowerView = await GET<{ rows: Array<{ type: string }> }>(notesPath, { session: borrower });
    const borrowerTypes = new Set(expectOk(borrowerView, "borrower notes", 200).rows.map((row) => row.type));
    assert.deepEqual([...borrowerTypes].sort(), ["formal"], "borrowers must see formal notes only");
  });
});
