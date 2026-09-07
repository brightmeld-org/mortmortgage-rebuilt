/**
 * CH-025 — BANK TOKEN-FLOW ENDPOINTS over HTTP (INV-054, VR-137, INT-023;
 * contracts §B POST /api/applications/:id/bank-links/link-token and
 * POST /api/applications/:id/bank-links/exchange).
 *
 * Runs against the DEFAULT keyless server (BANK_PROVIDER unset → simulation),
 * proving the Layer-A surface end to end:
 *
 *   1. Under simulation BOTH token-flow endpoints return the contracted 503
 *      not-available error — the token flow does not exist in this mode.
 *   2. VR-137: an empty or missing publicToken is a 400 validation error —
 *      never forwarded to the aggregator (the 400 outranks the mode 503) —
 *      and the strict schema rejects unknown fields (SEC-18).
 *   3. Role gates (the generated authz stubs' facts, hand-written here with
 *      seeded ids as the stubs instruct): unauthenticated → 401; staff roles
 *      (caseworker, supervisor) → 403; a NON-OWNER borrower and an unknown
 *      application id → 404 (INV-027 — no existence disclosure).
 *   4. Read-back through GET /api/applications/:id: the 503/400/authz paths
 *      changed NOTHING (versionStamp, bankLinks, assets all byte-stable) and
 *      no response ever echoes the submitted public token.
 *
 * Also covers the authz stub files the rule-test generator left fail-closed:
 *   authz-tests/post_api_applications_by_bank_links_link_token.authz.stub.txt
 *   authz-tests/post_api_applications_by_bank_links_exchange.authz.stub.txt
 *   rule-tests/VR-137.stub.txt
 *
 * FT-121 revert-simulation (proven at introduction, recorded in
 * changes/CH-025-real-provider-seams/verification/): un-gating the simulation
 * provider (returning an ok token/exchange) reds the 503 and read-back tests;
 * widening the roleGate reds the 403s; dropping the schema's min(1) reds the
 * VR-137 test.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { GET, POST, expectOk, type ApiResult, type ErrorResponse } from "../helpers/http.js";
import { createDraft, getApplication, type Application } from "../helpers/application.js";

const PREFIX = suitePrefix("tokflow");

let supervisor: Session;
let caseworker: Session;
let owner: Session;
let otherBorrower: Session;
let app: Application;
let baseline: Application;

/** A public token that must NEVER appear in any response body (posture check). */
const PUBLIC_TOKEN = `${PREFIX}-public-token-never-echoed`;

function linkTokenPath(id: string): string {
  return `/api/applications/${id}/bank-links/link-token`;
}
function exchangePath(id: string): string {
  return `/api/applications/${id}/bank-links/exchange`;
}

function expectError(result: ApiResult<unknown>, status: number, what: string): ErrorResponse {
  assert.equal(result.status, status, `${what}: expected ${status}, got ${result.status} — ${result.text.slice(0, 300)}`);
  const body = result.body as ErrorResponse;
  assert.equal(typeof body.code, "string", `${what}: ErrorResponse.code missing`);
  assert.equal(typeof body.message, "string", `${what}: ErrorResponse.message missing`);
  return body;
}

describe("CH-025 — bank token-flow endpoints (INV-054, VR-137)", () => {
  before(async () => {
    supervisor = await demoLogin("supervisor");
    await ensureAuthHeadroom(supervisor);
    caseworker = await demoLogin("caseworker");
    otherBorrower = await demoLogin("borrower");
    ({ session: owner } = await registerBorrower(supervisor, `${PREFIX}-owner`));
    app = await createDraft(owner);
    baseline = await getApplication(owner, app.id);
  });

  test("link-token under simulation returns the contracted 503 not-available", async () => {
    const result = await POST(linkTokenPath(app.id), { session: owner });
    const body = expectError(result, 503, "POST link-token (simulation)");
    assert.equal(body.code, "not_available");
    assert.match(body.message, /simulation/i);
    // The delivered token posture: no token material of any kind in the body.
    assert.doesNotMatch(result.text, /linkToken|accessToken|sim-tok-/);
  });

  test("exchange under simulation returns the contracted 503 and never echoes the token", async () => {
    const result = await POST(exchangePath(app.id), {
      session: owner,
      body: { publicToken: PUBLIC_TOKEN },
    });
    const body = expectError(result, 503, "POST exchange (simulation)");
    assert.equal(body.code, "not_available");
    assert.match(body.message, /simulation/i);
    assert.ok(!result.text.includes(PUBLIC_TOKEN), "response echoed the submitted public token");
  });

  test("VR-137: empty publicToken is a 400 validation error — it outranks the mode 503", async () => {
    const empty = await POST(exchangePath(app.id), {
      session: owner,
      body: { publicToken: "" },
    });
    const emptyBody = expectError(empty, 400, "POST exchange publicToken=''");
    assert.equal(emptyBody.code, "validation_error");
    assert.match((emptyBody.details ?? []).join(" | "), /publicToken/);

    const missing = await POST(exchangePath(app.id), { session: owner, body: {} });
    const missingBody = expectError(missing, 400, "POST exchange no publicToken");
    assert.equal(missingBody.code, "validation_error");
    assert.match((missingBody.details ?? []).join(" | "), /publicToken/);
  });

  test("exchange body is strict (SEC-18): unknown fields are rejected", async () => {
    const result = await POST(exchangePath(app.id), {
      session: owner,
      body: { publicToken: PUBLIC_TOKEN, surprise: true },
    });
    const body = expectError(result, 400, "POST exchange unknown field");
    assert.equal(body.code, "validation_error");
  });

  test("optional institution metadata is accepted (still 503 under simulation)", async () => {
    const result = await POST(exchangePath(app.id), {
      session: owner,
      body: {
        publicToken: PUBLIC_TOKEN,
        institutionId: `${PREFIX}-inst`,
        institutionName: "Fixture Institution",
      },
    });
    expectError(result, 503, "POST exchange with institution metadata");
  });

  test("authz: unauthenticated requests are denied 401 on both endpoints", async () => {
    for (const path of [linkTokenPath(app.id), exchangePath(app.id)]) {
      const result = await POST(path, { body: { publicToken: PUBLIC_TOKEN } });
      const body = expectError(result, 401, `POST ${path} unauthenticated`);
      assert.equal(body.code, "unauthorized");
    }
  });

  test("authz: staff roles (caseworker, supervisor) are denied 403 on both endpoints", async () => {
    for (const session of [caseworker, supervisor]) {
      for (const path of [linkTokenPath(app.id), exchangePath(app.id)]) {
        const result = await POST(path, { session, body: { publicToken: PUBLIC_TOKEN } });
        const body = expectError(result, 403, `POST ${path} as ${session.role}`);
        assert.equal(body.code, "forbidden");
      }
    }
  });

  test("authz: a non-owner borrower and an unknown application id both read 404 (INV-027)", async () => {
    for (const path of [linkTokenPath(app.id), exchangePath(app.id)]) {
      const result = await POST(path, {
        session: otherBorrower,
        body: { publicToken: PUBLIC_TOKEN },
      });
      const body = expectError(result, 404, `POST ${path} as non-owner`);
      assert.equal(body.code, "not_found");
    }
    const bogusId = randomUUID();
    const unknown = await POST(linkTokenPath(bogusId), {
      session: owner,
      body: undefined,
    });
    expectError(unknown, 404, "POST link-token unknown application");
  });

  test("read-back: none of the denied/unavailable calls changed the application (INV-054 additive)", async () => {
    const after = await getApplication(owner, app.id);
    assert.equal(after.versionStamp, baseline.versionStamp, "versionStamp moved");
    assert.deepEqual(
      (after as unknown as { bankLinks?: unknown[] }).bankLinks ?? [],
      (baseline as unknown as { bankLinks?: unknown[] }).bankLinks ?? [],
      "bankLinks changed",
    );
    assert.deepEqual(after.data?.assets ?? [], baseline.data?.assets ?? [], "assets changed");
    // The pre-existing credentials flow is untouched and still reachable
    // (institution roster responds for the borrower role) — INV-054's
    // "existing POST /api/applications/:id/bank-links flow untouched" facet is
    // fully exercised by suites 06/20; this is the cheap liveness cross-check.
    const institutions = await GET<{ rows: unknown[] }>("/api/bank-link/institutions", {
      session: owner,
    });
    const roster = expectOk(institutions, "GET /api/bank-link/institutions", 200);
    assert.ok(roster.rows.length >= 6, "institution roster shrank");
  });
});
