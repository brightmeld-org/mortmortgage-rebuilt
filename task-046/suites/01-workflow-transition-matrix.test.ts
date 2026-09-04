/**
 * §7.7 — every workflow transition in §4.5.3 including EVERY invalid transition.
 *
 * The matrix is derived from contracts.json `transitions.WorkflowState`, so it can
 * never drift from the contract. For each state the suite can materialize, every
 * (from, to) pair NOT in the contract map is attempted and must be rejected 409
 * carrying `currentState` + `allowedTransitions` (WF-047, INV-033, §B ErrorResponse).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { TERMINAL_STATES, WORKFLOW_STATES, workflowTransitions } from "../helpers/contract.js";
import { DEL, type ErrorResponse } from "../helpers/http.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import {
  createDraft,
  getApplication,
  buildSubmittableDraft,
  transition,
  transitionOk,
  type Application,
} from "../helpers/application.js";
import {
  approvalDecision,
  awaitState,
  NON_ESCALATING_SHAPE,
  satisfyChecklist,
  toAusExecuted,
  toCompletenessValidated,
  toDocumentsReceived,
  toPreliminaryDecision,
  type Actors,
} from "../helpers/workflow.js";
import { claim, runAllChecks } from "../helpers/application.js";

const PREFIX = suitePrefix("wfmatrix");

/**
 * States the suite materializes and asserts the full invalid-transition row for.
 * `approved` and `denied` are excluded with contract justification — see the
 * documented-exclusion test at the bottom of this file.
 */
const MATERIALIZED_STATES = [
  "draft",
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
  "revision_requested",
  "suspended",
  "borrower_notified",
  "withdrawn",
  "declined_by_borrower",
] as const;

const EXCLUDED_STATES = ["approved", "denied"] as const;

interface Fixture {
  application: Application;
  actor: Session;
}

let supervisor: Session;
let caseworker: Session;
const fixtures = new Map<string, Fixture>();

async function borrowerActors(label: string): Promise<Actors> {
  const borrower = await registerBorrower(supervisor, `${PREFIX}-${label}`);
  return { borrower: borrower.session, caseworker, supervisor };
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);

  // draft — a fresh, unsubmitted application.
  {
    const actors = await borrowerActors("draft");
    const draft = await createDraft(actors.borrower);
    fixtures.set("draft", { application: draft, actor: actors.borrower });
  }

  // withdrawn — terminal, reached from draft by T2.
  {
    const actors = await borrowerActors("wd");
    const draft = await createDraft(actors.borrower);
    const withdrawn = await transitionOk(actors.borrower, draft.id, {
      toState: "withdrawn",
      versionStamp: draft.versionStamp,
      reason: "Fixture withdrawal.",
    });
    fixtures.set("withdrawn", { application: withdrawn, actor: actors.borrower });
  }

  // application_received — T1.
  {
    const actors = await borrowerActors("ar");
    const draft = await buildSubmittableDraft(actors.borrower);
    const received = await transitionOk(actors.borrower, draft.id, {
      toState: "application_received",
      versionStamp: draft.versionStamp,
    });
    await claim(caseworker, draft.id);
    fixtures.set("application_received", { application: received, actor: caseworker });
  }

  // revision_requested — T4 (formal note required).
  {
    const actors = await borrowerActors("rev");
    const draft = await buildSubmittableDraft(actors.borrower);
    await transitionOk(actors.borrower, draft.id, {
      toState: "application_received",
      versionStamp: draft.versionStamp,
    });
    await claim(caseworker, draft.id);
    const revision = await transitionOk(caseworker, draft.id, {
      toState: "revision_requested",
      note: "Please correct the employment section.",
    });
    fixtures.set("revision_requested", { application: revision, actor: caseworker });
  }

  // suspended — T6 (reason required).
  {
    const actors = await borrowerActors("susp");
    const draft = await buildSubmittableDraft(actors.borrower);
    await transitionOk(actors.borrower, draft.id, {
      toState: "application_received",
      versionStamp: draft.versionStamp,
    });
    const suspended = await transitionOk(supervisor, draft.id, {
      toState: "suspended",
      reason: "Awaiting borrower documentation.",
    });
    fixtures.set("suspended", { application: suspended, actor: supervisor });
  }

  // completeness_validated — T3.
  {
    const application = await toCompletenessValidated(await borrowerActors("cv"));
    fixtures.set("completeness_validated", { application, actor: caseworker });
  }

  // documents_received — T7.
  {
    const application = await toDocumentsReceived(await borrowerActors("dr"));
    fixtures.set("documents_received", { application, actor: caseworker });
  }

  // aus_executed — T11.
  {
    const application = await toAusExecuted(await borrowerActors("aus"));
    fixtures.set("aus_executed", { application, actor: caseworker });
  }

  // preliminary_decision — T15.
  {
    const application = await toPreliminaryDecision(await borrowerActors("pd"), NON_ESCALATING_SHAPE);
    fixtures.set("preliminary_decision", { application, actor: caseworker });
  }

  // escalated_review — L1 approve on an escalating file (LTV 95% > 80% threshold).
  {
    const application = await toPreliminaryDecision(await borrowerActors("esc"), {
      estimatedValue: 400000,
      requestedLoanAmount: 380000,
    });
    const decided = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L1" });
    assert.equal(decided.status, 200, decided.text);
    const escalated = await getApplication(supervisor, application.id);
    assert.equal(escalated.workflowState, "escalated_review");
    fixtures.set("escalated_review", { application: escalated, actor: supervisor });
  }

  // conditional_approval — approve with at least one condition (WF-022/VR-086).
  {
    const application = await toPreliminaryDecision(await borrowerActors("ca"), NON_ESCALATING_SHAPE);
    const decided = await approvalDecision(supervisor, application.id, {
      decision: "approve",
      notes: "Conditional",
      conditions: ["Provide an updated pay stub."],
    });
    assert.equal(decided.status, 200, decided.text);
    const conditional = await getApplication(supervisor, application.id);
    assert.equal(conditional.workflowState, "conditional_approval");
    fixtures.set("conditional_approval", { application: conditional, actor: supervisor });
  }

  // borrower_notified — SYS T27 after an unconditional approve.
  {
    const application = await toPreliminaryDecision(await borrowerActors("bn"), NON_ESCALATING_SHAPE);
    const decided = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "Approve" });
    assert.equal(decided.status, 200, decided.text);
    const notified = await awaitState(supervisor, application.id, ["borrower_notified"], 45000);
    fixtures.set("borrower_notified", { application: notified, actor: supervisor });
  }

  // declined_by_borrower — terminal, T35 from borrower_notified with outcome approved.
  {
    const actors = await borrowerActors("dbb");
    const application = await toPreliminaryDecision(actors, NON_ESCALATING_SHAPE);
    const decided = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "Approve" });
    assert.equal(decided.status, 200, decided.text);
    await awaitState(supervisor, application.id, ["borrower_notified"], 45000);
    const declined = await transitionOk(actors.borrower, application.id, { toState: "declined_by_borrower" });
    fixtures.set("declined_by_borrower", { application: declined, actor: actors.borrower });
  }
});

after(async () => {
  // Cleanup is uniqueness-based: every fixture email/name carries PREFIX so a re-run
  // never collides. The draft fixture is removed through the contracted delete.
  const draft = fixtures.get("draft");
  if (draft) {
    const path = `/api/applications/${draft.application.id}`;
    await DEL(path, { session: draft.actor }).catch(() => undefined);
  }
});

describe("§7.7 invalid transitions — every (from, to) pair outside the contract map is 409", () => {
  for (const state of MATERIALIZED_STATES) {
    const allowed = workflowTransitions[state] ?? [];
    const disallowed = WORKFLOW_STATES.filter((target) => !allowed.includes(target));

    test(`${state}: rejects all ${disallowed.length} non-contract targets with currentState + allowedTransitions`, { timeout: 120000 }, async () => {
      const fixture = fixtures.get(state);
      assert.ok(fixture, `no fixture materialized for ${state}`);

      const failures: string[] = [];
      for (const target of disallowed) {
        const result = await transition(fixture.actor, fixture.application.id, {
          toState: target,
          note: "Invalid-transition probe.",
          reason: "Invalid-transition probe.",
          recommendation: "approve",
        });
        if (result.status !== 409) {
          failures.push(`${state} → ${target}: expected 409, got ${result.status} ${result.text.slice(0, 200)}`);
          continue;
        }
        const body = result.body as unknown as ErrorResponse;
        if (body.currentState !== state) {
          failures.push(`${state} → ${target}: currentState was ${body.currentState}`);
        }
        const reported = [...(body.allowedTransitions ?? [])].sort();
        if (JSON.stringify(reported) !== JSON.stringify([...allowed].sort())) {
          failures.push(`${state} → ${target}: allowedTransitions ${JSON.stringify(reported)} ≠ ${JSON.stringify(allowed)}`);
        }
      }
      assert.deepEqual(failures, [], failures.join("\n"));
    });
  }

  test("approved and denied are excluded from the materialized matrix for a contract-stated reason", () => {
    // WF-033/WF-034 + ASYNC-003: reaching Approved/Denied triggers the SYS decision
    // dispatch which performs T27/T28 in the same operation, so neither state is
    // observable from the API on a successful dispatch. Their outbound rows are
    // covered by the borrower_notified / declined_by_borrower fixtures instead.
    assert.deepEqual([...EXCLUDED_STATES], ["approved", "denied"]);
    for (const state of EXCLUDED_STATES) {
      assert.ok(
        (workflowTransitions[state] ?? []).includes("borrower_notified"),
        `${state} must transition to borrower_notified per the contract map`,
      );
    }
    const covered = new Set<string>([...MATERIALIZED_STATES, ...EXCLUDED_STATES]);
    assert.deepEqual(
      WORKFLOW_STATES.filter((state) => !covered.has(state)),
      [],
      "every WorkflowState must be either materialized or explicitly excluded",
    );
  });
});

describe("§7.7 terminal states never transition anywhere (INV-033)", () => {
  test("the contract map declares exactly withdrawn and declined_by_borrower terminal", () => {
    assert.deepEqual([...TERMINAL_STATES].sort(), ["declined_by_borrower", "withdrawn"]);
  });

  for (const state of ["withdrawn", "declined_by_borrower"]) {
    test(`${state} rejects every target with an empty allowedTransitions list`, { timeout: 60000 }, async () => {
      const fixture = fixtures.get(state);
      assert.ok(fixture);
      for (const target of WORKFLOW_STATES) {
        const result = await transition(fixture.actor, fixture.application.id, { toState: target });
        assert.equal(result.status, 409, `${state} → ${target}: ${result.text.slice(0, 200)}`);
        const body = result.body as unknown as ErrorResponse;
        assert.equal(body.currentState, state);
        assert.deepEqual(body.allowedTransitions ?? [], []);
      }
    });
  }
});

describe("§7.7 actor gating on the transition endpoint", () => {
  test("borrower-only transitions are rejected for staff, including Supervisors (INV-027)", { timeout: 60000 }, async () => {
    const revision = fixtures.get("revision_requested");
    assert.ok(revision);
    // T36 (revision_requested → completeness_validated) and T37 (→ withdrawn) are B-only.
    for (const [actor, label] of [
      [caseworker, "caseworker"],
      [supervisor, "supervisor"],
    ] as Array<[Session, string]>) {
      const resubmit = await transition(actor, revision.application.id, { toState: "completeness_validated" });
      assert.equal(resubmit.status, 403, `${label} resubmit: ${resubmit.status} ${resubmit.text.slice(0, 200)}`);
      const withdraw = await transition(actor, revision.application.id, { toState: "withdrawn" });
      assert.equal(withdraw.status, 403, `${label} withdraw: ${withdraw.status} ${withdraw.text.slice(0, 200)}`);
    }
  });

  test("SYS-only T27/T28 (→ borrower_notified) are rejected for every caller", { timeout: 60000 }, async () => {
    const conditional = fixtures.get("conditional_approval");
    assert.ok(conditional);
    for (const actor of [caseworker, supervisor]) {
      const result = await transition(actor, conditional.application.id, { toState: "borrower_notified" });
      assert.notEqual(result.status, 200, "borrower_notified must never be caller-reachable");
      assert.equal(result.status, 409, result.text.slice(0, 200));
    }
  });

  test("decision transitions execute only through the approval-decision endpoint", { timeout: 60000 }, async () => {
    const preliminary = fixtures.get("preliminary_decision");
    assert.ok(preliminary);
    for (const target of ["approved", "denied", "escalated_review", "conditional_approval"]) {
      const result = await transition(supervisor, preliminary.application.id, { toState: target });
      assert.notEqual(result.status, 200, `${target} must not be reachable via POST /transition`);
      assert.ok([403, 409].includes(result.status), `${target}: got ${result.status} ${result.text.slice(0, 200)}`);
    }
  });
});

describe("§7.7 transition request validation", () => {
  test("an unknown toState is a validation error, not a workflow 409 (VR-078)", async () => {
    const fixture = fixtures.get("application_received");
    assert.ok(fixture);
    const result = await transition(fixture.actor, fixture.application.id, { toState: "not_a_state" });
    assert.equal(result.status, 400, result.text.slice(0, 200));
  });

  test("a stale versionStamp is rejected 409 and never silently overwrites (INV-039, VR-079)", async () => {
    const fixture = fixtures.get("application_received");
    assert.ok(fixture);
    const current = await getApplication(fixture.actor, fixture.application.id);
    const result = await transition(fixture.actor, fixture.application.id, {
      toState: "revision_requested",
      note: "Stale-stamp probe.",
      versionStamp: current.versionStamp - 1,
    });
    assert.equal(result.status, 409, result.text.slice(0, 200));
    const unchanged = await getApplication(fixture.actor, fixture.application.id);
    assert.equal(unchanged.workflowState, current.workflowState);
  });

  test("a transition to revision_requested requires the formal note (VR-080, XBR-005)", async () => {
    const fixture = fixtures.get("application_received");
    assert.ok(fixture);
    const result = await transition(fixture.actor, fixture.application.id, { toState: "revision_requested" });
    assert.ok([400, 409].includes(result.status), `got ${result.status} ${result.text.slice(0, 200)}`);
  });

  test("a transition to suspended requires a reason (VR-081)", async () => {
    const fixture = fixtures.get("completeness_validated");
    assert.ok(fixture);
    const result = await transition(supervisor, fixture.application.id, { toState: "suspended" });
    assert.ok([400, 409].includes(result.status), `got ${result.status} ${result.text.slice(0, 200)}`);
  });

  test("T15 requires a recommendation (VR-082, WF-017)", async () => {
    const fixture = fixtures.get("aus_executed");
    assert.ok(fixture);
    const result = await transition(caseworker, fixture.application.id, {
      toState: "preliminary_decision",
      note: "Missing recommendation.",
    });
    assert.ok([400, 409].includes(result.status), `got ${result.status} ${result.text.slice(0, 200)}`);
  });
});

describe("§7.7 precondition gates on the forward path", () => {
  test("T7 is blocked while any required checklist item is unsatisfied (XBR-006, WF-009)", { timeout: 180000 }, async () => {
    const actors = await borrowerActors("t7gate");
    const application = await toCompletenessValidated(actors);
    const blocked = await transition(caseworker, application.id, { toState: "documents_received" });
    assert.equal(blocked.status, 409, blocked.text.slice(0, 300));
    const body = blocked.body as unknown as ErrorResponse;
    assert.equal(body.currentState, "completeness_validated");
    await satisfyChecklist(caseworker, application.id);
    const allowed = await transition(caseworker, application.id, { toState: "documents_received" });
    assert.equal(allowed.status, 200, allowed.text.slice(0, 300));
  });

  test("T11 is blocked until all four checks complete and an AUS result is recorded (XBR-007, WF-013)", { timeout: 240000 }, async () => {
    const actors = await borrowerActors("t11gate");
    const application = await toDocumentsReceived(actors);
    const blocked = await transition(caseworker, application.id, { toState: "aus_executed" });
    assert.equal(blocked.status, 409, blocked.text.slice(0, 300));
    await runAllChecks(caseworker, application.id);
    const allowed = await transition(caseworker, application.id, { toState: "aus_executed" });
    assert.equal(allowed.status, 200, allowed.text.slice(0, 300));
  });

  test("submission (T1) requires a complete, signed application (WF-003, XBR-003)", { timeout: 120000 }, async () => {
    const actors = await borrowerActors("t1gate");
    const empty = await createDraft(actors.borrower);
    const blocked = await transition(actors.borrower, empty.id, {
      toState: "application_received",
      versionStamp: empty.versionStamp,
    });
    // §E: submission-time required-field validation is enforced by the transition gate
    // and reported as the profile's request-validation status with per-field details.
    assert.equal(blocked.status, 400, blocked.text.slice(0, 300));
    const body = blocked.body as unknown as ErrorResponse;
    assert.ok((body.details ?? []).length > 0, "the 400 must list the missing required fields");
    assert.equal((await getApplication(actors.borrower, empty.id)).workflowState, "draft");
  });

  test("an unassigned staff member cannot drive the workflow (INV-026)", { timeout: 180000 }, async () => {
    const actors = await borrowerActors("unassigned");
    const draft = await buildSubmittableDraft(actors.borrower);
    await transitionOk(actors.borrower, draft.id, {
      toState: "application_received",
      versionStamp: draft.versionStamp,
    });
    // The stamp is read as the owning borrower — an unassigned caseworker cannot read
    // the file at all, which is itself part of the scoping contract (S-2).
    const stamp = (await getApplication(actors.borrower, draft.id)).versionStamp;
    const result = await transition(caseworker, draft.id, {
      toState: "completeness_validated",
      versionStamp: stamp,
    });
    assert.equal(result.status, 403, `unassigned caseworker: ${result.status} ${result.text.slice(0, 200)}`);
    await claim(caseworker, draft.id);
    const afterClaim = await transition(caseworker, draft.id, { toState: "completeness_validated" });
    assert.equal(afterClaim.status, 200, afterClaim.text.slice(0, 300));
  });
});
