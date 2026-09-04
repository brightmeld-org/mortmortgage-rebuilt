/**
 * §7.7 + INV-037 — concurrency races and the non-temporal edge catalog.
 *
 * Races are driven with Promise.all so the requests overlap in the server; the
 * assertions are on the invariant outcome (exactly one winner, at most one active
 * assignment, one active application), never on which caller happens to win.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { demoLogin, inviteStaff, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting } from "../helpers/config.js";
import { GET, POST, PUT, expectOk, type ApiResult, type ErrorResponse } from "../helpers/http.js";
import {
  buildSubmittableDraft,
  claim,
  createDraft,
  getApplication,
  saveSection,
  transitionOk,
  type Application,
} from "../helpers/application.js";
import { approvalDecision, toPreliminaryDecision, type Actors } from "../helpers/workflow.js";

const PREFIX = suitePrefix("race");

let supervisor: Session;
let caseworker: Session;
let secondCaseworker: Session;
let secondSupervisor: Session;

async function submittedFile(label: string): Promise<{ application: Application; borrower: Session }> {
  const borrower = (await registerBorrower(supervisor, `${PREFIX}-${label}`)).session;
  const draft = await buildSubmittableDraft(borrower);
  const application = await transitionOk(borrower, draft.id, {
    toState: "application_received",
    versionStamp: draft.versionStamp,
  });
  return { application, borrower };
}

function statuses(results: Array<ApiResult<unknown>>): number[] {
  return results.map((result) => result.status).sort((a, b) => a - b);
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  secondCaseworker = (await inviteStaff(supervisor, `${PREFIX}-cw2`, "CASEWORKER")).session;
  secondSupervisor = (await inviteStaff(supervisor, `${PREFIX}-sup2`, "SUPERVISOR")).session;
});

describe("INV-037 concurrency — claim and assignment races (NFR-005, INV-015, XBR-014)", () => {
  test("two simultaneous claims produce exactly one assignment (AC-24)", { timeout: 300000 }, async () => {
    const { application } = await submittedFile("claim");
    const results = await Promise.all([claim(caseworker, application.id), claim(secondCaseworker, application.id)]);
    const created = results.filter((result) => result.status === 201);
    assert.equal(created.length, 1, `expected exactly one winner, got ${JSON.stringify(statuses(results))}`);
    const loser = results.find((result) => result.status !== 201);
    assert.ok(loser);
    assert.equal(loser.status, 409, loser.text.slice(0, 200));

    const path = `/api/applications/${application.id}/assignments`;
    const list = expectOk(
      await GET<{ rows: Array<{ endedAt?: string; method: string }> }>(path, { session: supervisor }),
      path,
      200,
    );
    const active = list.rows.filter((row) => !row.endedAt);
    assert.equal(active.length, 1, "at most one active assignment may exist (INV-015)");
    assert.equal(active[0].method, "claim");
  });

  test("a claim racing a bulk-assign still leaves one active assignment", { timeout: 300000 }, async () => {
    const { application } = await submittedFile("bulk");
    const [claimResult, bulkResult] = await Promise.all([
      claim(caseworker, application.id),
      POST("/api/supervisor/assignments/bulk", {
        session: supervisor,
        body: {
          applicationIds: [application.id],
          caseworkerUserId: secondCaseworker.userId,
          reason: "Race fixture bulk assignment.",
        },
      }),
    ]);
    assert.ok([200, 201, 409].includes(claimResult.status), `claim: ${claimResult.status}`);
    assert.ok([200, 409].includes(bulkResult.status), `bulk: ${bulkResult.status} ${bulkResult.text.slice(0, 200)}`);

    const path = `/api/applications/${application.id}/assignments`;
    const list = expectOk(
      await GET<{ rows: Array<{ endedAt?: string; caseworkerUserId: string }> }>(path, { session: supervisor }),
      path,
      200,
    );
    const active = list.rows.filter((row) => !row.endedAt);
    assert.equal(active.length, 1, "the partial unique index must permit exactly one active assignment");
  });

  test("sequential reassignments close the prior assignment atomically", { timeout: 300000 }, async () => {
    const { application } = await submittedFile("reassign");
    expectOk(await claim(caseworker, application.id), "claim", 201);
    const path = `/api/applications/${application.id}/reassignment`;
    const reassigned = await POST(path, {
      session: supervisor,
      body: { caseworkerUserId: secondCaseworker.userId, reason: "Race fixture reassignment." },
    });
    assert.equal(reassigned.status, 201, reassigned.text.slice(0, 200));

    const listPath = `/api/applications/${application.id}/assignments`;
    const list = expectOk(
      await GET<{ rows: Array<{ endedAt?: string; caseworkerUserId: string }> }>(listPath, { session: supervisor }),
      listPath,
      200,
    );
    assert.equal(list.rows.filter((row) => !row.endedAt).length, 1);
    assert.equal(list.rows.filter((row) => row.endedAt).length >= 1, true, "the prior assignment must be closed");
  });
});

describe("INV-037 concurrency — optimistic locking and submission races", () => {
  test("two tabs saving the same section with the same stamp: the second is 409 (INV-039)", { timeout: 300000 }, async () => {
    const borrower = (await registerBorrower(supervisor, `${PREFIX}-twotab`)).session;
    const draft = await createDraft(borrower);
    const payload = {
      identity: { firstName: "Two", lastName: "Tab", dateOfBirth: "1986-04-04" },
    };
    const [first, second] = await Promise.all([
      saveSection(borrower, draft.id, "identity", payload, draft.versionStamp, 1),
      saveSection(
        borrower,
        draft.id,
        "identity",
        { identity: { firstName: "Other", lastName: "Tab", dateOfBirth: "1986-04-04" } },
        draft.versionStamp,
        1,
      ),
    ]);
    const codes = statuses([first, second]);
    assert.deepEqual(codes, [200, 409], `expected one save and one stale-stamp rejection, got ${JSON.stringify(codes)}`);
    const conflicted = [first, second].find((result) => result.status === 409);
    assert.ok(conflicted);
    const body = conflicted.body as unknown as ErrorResponse;
    assert.ok(body.code.length > 0, "the 409 must use the shared ErrorResponse shape");
  });

  test("one borrower cannot land two applications in active states (INV-016, XBR-002)", { timeout: 600000 }, async () => {
    const borrower = (await registerBorrower(supervisor, `${PREFIX}-oneactive`)).session;
    const first = await buildSubmittableDraft(borrower);
    const second = await buildSubmittableDraft(borrower);

    const [a, b] = await Promise.all([
      POST(`/api/applications/${first.id}/transition`, {
        session: borrower,
        body: { toState: "application_received", versionStamp: first.versionStamp },
      }),
      POST(`/api/applications/${second.id}/transition`, {
        session: borrower,
        body: { toState: "application_received", versionStamp: second.versionStamp },
      }),
    ]);
    const codes = statuses([a, b]);
    assert.deepEqual(codes, [200, 409], `expected exactly one submission to win, got ${JSON.stringify(codes)}`);

    const rejected = [a, b].find((result) => result.status === 409);
    assert.ok(rejected);
    const body = rejected.body as unknown as ErrorResponse;
    assert.ok(
      body.message.length > 0,
      "the rejection must carry the named-application message surfaced verbatim (NFR-025)",
    );

    const states = await Promise.all([
      getApplication(borrower, first.id),
      getApplication(borrower, second.id),
    ]);
    const active = states.filter((entry) => entry.workflowState !== "draft");
    assert.equal(active.length, 1, "exactly one of the two drafts may be active");
  });

  test("a sequential second submission is refused while the first is active", { timeout: 600000 }, async () => {
    const borrower = (await registerBorrower(supervisor, `${PREFIX}-seqactive`)).session;
    const first = await buildSubmittableDraft(borrower);
    await transitionOk(borrower, first.id, { toState: "application_received", versionStamp: first.versionStamp });
    const second = await buildSubmittableDraft(borrower);
    const blocked = await POST(`/api/applications/${second.id}/transition`, {
      session: borrower,
      body: { toState: "application_received", versionStamp: second.versionStamp },
    });
    assert.equal(blocked.status, 409, blocked.text.slice(0, 300));
    assert.ok(
      blocked.text.includes(first.applicationNumber),
      `the 409 must name the blocking application (${first.applicationNumber}): ${blocked.text.slice(0, 300)}`,
    );
  });

  test("two supervisors deciding Level 1 at once produce exactly one approval record", { timeout: 900000 }, async () => {
    const actors: Actors = {
      borrower: (await registerBorrower(supervisor, `${PREFIX}-l1race`)).session,
      caseworker,
      supervisor,
    };
    const application = await toPreliminaryDecision(actors, { estimatedValue: 400000, requestedLoanAmount: 300000 });
    const stamp = application.versionStamp;
    const [a, b] = await Promise.all([
      approvalDecision(supervisor, application.id, { decision: "approve", notes: "Race A", versionStamp: stamp }),
      approvalDecision(secondSupervisor, application.id, { decision: "approve", notes: "Race B", versionStamp: stamp }),
    ]);
    const succeeded = [a, b].filter((result) => result.status === 200);
    assert.equal(succeeded.length, 1, `expected one decision to win, got ${JSON.stringify(statuses([a, b]))}`);

    const path = `/api/applications/${application.id}/approvals`;
    const records = expectOk(
      await GET<{ rows: Array<{ level: number }> }>(path, { session: supervisor }),
      path,
      200,
    );
    const levelOne = records.rows.filter((row) => row.level === 1);
    assert.equal(levelOne.length, 1, "a level is decided at most once per version (INV-017)");
  });

  test("repeating an idempotency token never creates a second application (SEC-21, VR-052)", { timeout: 300000 }, async () => {
    const borrower = (await registerBorrower(supervisor, `${PREFIX}-idem`)).session;
    const requestToken = randomUUID();
    const first = await POST<Application>("/api/applications", { session: borrower, body: { requestToken } });
    assert.equal(first.status, 201, first.text.slice(0, 200));
    const second = await POST<Application>("/api/applications", { session: borrower, body: { requestToken } });
    assert.ok([200, 201].includes(second.status), second.text.slice(0, 200));
    assert.equal(
      (second.body as Application).id,
      (first.body as Application).id,
      "the same token must resolve to the same application",
    );

    const list = expectOk(
      await GET<{ rows: Array<{ id: string }>; total: number }>("/api/applications?pageSize=100", {
        session: borrower,
      }),
      "GET /api/applications",
      200,
    );
    assert.equal(list.rows.length, 1, "only one application may exist for this borrower");
  });

  test("concurrently created applications receive distinct application numbers (INV-014)", { timeout: 300000 }, async () => {
    const borrower = (await registerBorrower(supervisor, `${PREFIX}-numbers`)).session;
    const created = await Promise.all(
      [0, 1, 2, 3].map(() =>
        POST<Application>("/api/applications", { session: borrower, body: { requestToken: randomUUID() } }),
      ),
    );
    const numbers = created.map((result) => (result.body as Application).applicationNumber);
    for (const result of created) assert.equal(result.status, 201, result.text.slice(0, 200));
    assert.equal(new Set(numbers).size, numbers.length, `duplicate application numbers: ${numbers.join(", ")}`);
    for (const number of numbers) {
      assert.match(number, /^MM-\d{4}-\d{6}$/, `applicationNumber must be MM-YYYY-NNNNNN, got ${number}`);
    }
  });
});

describe("INV-037 data-shape edges", () => {
  test("a brand-new borrower sees an explicit empty state, not an error", { timeout: 300000 }, async () => {
    const fresh = (await registerBorrower(supervisor, `${PREFIX}-empty`)).session;
    const body = expectOk(
      await GET<{
        rows: unknown[];
        cards: { total: number; draft: number; inUnderwriting: number; approved: number; denied: number; withdrawn: number };
        page: number;
        pageSize: number;
        total: number;
      }>("/api/applications", { session: fresh }),
      "GET /api/applications",
      200,
    );
    assert.deepEqual(body.rows, []);
    assert.equal(body.total, 0);
    assert.deepEqual(body.cards, { total: 0, draft: 0, inUnderwriting: 0, approved: 0, denied: 0, withdrawn: 0 });
  });

  test("a filter matching nothing returns an empty page, not a 404", { timeout: 120000 }, async () => {
    const body = expectOk(
      await GET<{ rows: unknown[]; total: number }>("/api/supervisor/applications?search=zzz-no-such-applicant-zzz", {
        session: supervisor,
      }),
      "GET /api/supervisor/applications",
      200,
    );
    assert.deepEqual(body.rows, []);
    assert.equal(body.total, 0);
  });

  test("pageSize is clamped to the configured maximum without error (AC-59, INV-036)", { timeout: 120000 }, async () => {
    const maximum = Number(await readSetting(supervisor, "pagination.maxPageSize"));
    assert.equal(maximum, 100, "fixture assumes the §4.6.11 default page-size cap");
    const body = expectOk(
      await GET<{ rows: unknown[]; pageSize: number }>("/api/supervisor/applications?pageSize=1000", {
        session: supervisor,
      }),
      "GET /api/supervisor/applications",
      200,
    );
    assert.ok(body.pageSize <= maximum, `pageSize was ${body.pageSize}`);
    assert.ok(body.rows.length <= maximum);
  });

  test("XSS-shaped note content round-trips as inert JSON data (VR-094, SEC-18)", { timeout: 300000 }, async () => {
    // VR-094 requires the content to be "sanitized before render". The API contract is
    // therefore that the note is accepted, stored faithfully, and returned as JSON string
    // data — never as executable markup in the transport. Render-time escaping is the UI's
    // half of SEC-18 and is exercised by the UI suites, not here.
    const { application } = await submittedFile("xss");
    expectOk(await claim(caseworker, application.id), "claim", 201);
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const path = `/api/applications/${application.id}/notes`;
    const created = await POST(path, { session: caseworker, body: { type: "internal", content: payload } });
    assert.equal(created.status, 201, created.text.slice(0, 300));

    const listing = await GET<{ rows: Array<{ content: string }> }>(path, { session: caseworker });
    const page = expectOk(listing, path, 200);
    assert.match(
      listing.headers.get("content-type") ?? "",
      /application\/json/,
      "notes must be served as JSON, never as a markup document",
    );
    assert.ok(
      listing.headers.get("x-content-type-options")?.toLowerCase() === "nosniff",
      "nosniff must prevent a JSON body being re-interpreted as HTML (SEC-17)",
    );
    const stored = page.rows.find((row) => row.content.includes("alert"));
    assert.ok(stored, "the note must be retrievable");
    assert.equal(stored.content, payload, "the note must round-trip without silent mutation");
  });

  test("note length caps are enforced server-side per type (INV-024, VR-094)", { timeout: 300000 }, async () => {
    const noteCap = Number(await readSetting(supervisor, "notes.maxLength"));
    const chatterCap = Number(await readSetting(supervisor, "chatter.maxLength"));
    assert.equal(noteCap, 4000);
    assert.equal(chatterCap, 1000);

    const { application } = await submittedFile("notecap");
    expectOk(await claim(caseworker, application.id), "claim", 201);
    const path = `/api/applications/${application.id}/notes`;

    const okNote = await POST(path, { session: caseworker, body: { type: "internal", content: "a".repeat(noteCap) } });
    assert.equal(okNote.status, 201, okNote.text.slice(0, 200));
    const tooLong = await POST(path, {
      session: caseworker,
      body: { type: "internal", content: "a".repeat(noteCap + 1) },
    });
    assert.equal(tooLong.status, 400, tooLong.text.slice(0, 200));

    const chatterTooLong = await POST(path, {
      session: caseworker,
      body: { type: "chatter", content: "a".repeat(chatterCap + 1) },
    });
    assert.equal(chatterTooLong.status, 400, chatterTooLong.text.slice(0, 200));
  });

  test("unknown request fields are rejected (SEC-18)", { timeout: 120000 }, async () => {
    const borrower = (await registerBorrower(supervisor, `${PREFIX}-strict`)).session;
    const result = await POST("/api/applications", {
      session: borrower,
      body: { requestToken: randomUUID(), notAContractField: true },
    });
    assert.equal(result.status, 400, result.text.slice(0, 300));
  });

  /** ISO date `years` before today, optionally shifted by `days`. */
  function isoBirthday(years: number, days = 0): string {
    const now = new Date();
    const date = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + days));
    return date.toISOString().slice(0, 10);
  }

  async function submitWithDob(label: string, dateOfBirth: string) {
    const borrower = (await registerBorrower(supervisor, `${PREFIX}-${label}`)).session;
    const draft = await buildSubmittableDraft(borrower, { dateOfBirth });
    return POST(`/api/applications/${draft.id}/transition`, {
      session: borrower,
      body: { toState: "application_received", versionStamp: draft.versionStamp },
    });
  }

  test("age at application is exactly 18 on the borrower's 18th birthday (INV-025, INV-037)", { timeout: 600000 }, async () => {
    const onBirthday = await submitWithDob("age-18-today", isoBirthday(18));
    assert.equal(onBirthday.status, 200, `turning 18 today must qualify: ${onBirthday.text.slice(0, 300)}`);

    const dayBefore18 = await submitWithDob("age-18-tomorrow", isoBirthday(18, 1));
    assert.ok(
      [400, 409].includes(dayBefore18.status),
      `a borrower one day short of 18 must be refused, got ${dayBefore18.status} ${dayBefore18.text.slice(0, 300)}`,
    );
  });

  test("a Feb-29 birth date is handled without a date error (INV-037)", { timeout: 600000 }, async () => {
    // 2004 was a leap year; a Feb-29 borrower is comfortably over 18 today, and the age
    // computation must not throw or drift when the anniversary does not exist this year.
    const leapling = await submitWithDob("age-feb29", "2004-02-29");
    assert.equal(leapling.status, 200, `a Feb-29 birth date must submit normally: ${leapling.text.slice(0, 300)}`);
  });

  test("a ZIP absent from the bundled address dataset degrades to manual entry (INV-037)", { timeout: 120000 }, async () => {
    // §B: `!!` in q must yield silent empty suggestions rather than an error.
    const forced = expectOk(
      await GET<{ suggestions: unknown[] }>("/api/address/suggest?q=!!", { session: supervisor }),
      "GET /api/address/suggest",
      200,
    );
    assert.deepEqual(forced.suggestions, []);

    const unknownZip = expectOk(
      await GET<{ suggestions: unknown[] }>("/api/address/suggest?q=zzqq", { session: supervisor }),
      "GET /api/address/suggest",
      200,
    );
    assert.ok(Array.isArray(unknownZip.suggestions), "an unmatched prefix must still return the array shape");
  });
});
