/**
 * §7.7 — approval gates including mixed approve/deny histories, the different-approver
 * rule, and escalation criteria at boundary values (WF-002, WF-021..WF-030, XBR-009,
 * INV-001, INV-017, INV-020, INV-028).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { demoLogin, inviteStaff, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting, writeSetting } from "../helpers/config.js";
import { GET, POST, expectOk, type ErrorResponse } from "../helpers/http.js";
import { enums } from "../helpers/contract.js";
import { getApplication, transition, type Application, type DraftShape } from "../helpers/application.js";
import { approvalDecision, awaitState, toPreliminaryDecision, type Actors } from "../helpers/workflow.js";

const PREFIX = suitePrefix("approval");

/** Income 9000; housing 2410 + auto 350 = 2760 → DTI 30.667% at the default shape. */
const HOUSING_PLUS_AUTO = 2760;
const MONTHLY_INCOME = 9000;

/** otherLiabilities payment that lands DTI exactly on a target percentage. */
function otherLiabilityForDti(targetPct: number): number {
  return Number(((MONTHLY_INCOME * targetPct) / 100 - HOUSING_PLUS_AUTO).toFixed(2));
}

let supervisor: Session;
let caseworker: Session;
let secondSupervisor: Session;

async function actorsFor(label: string): Promise<Actors> {
  const borrower = await registerBorrower(supervisor, `${PREFIX}-${label}`);
  return { borrower: borrower.session, caseworker, supervisor };
}

async function preliminary(label: string, shape: DraftShape): Promise<Application> {
  return toPreliminaryDecision(await actorsFor(label), shape);
}

interface ApprovalRecord {
  id: string;
  level: number;
  decision: "approve" | "deny";
  approverName: string;
  conditions?: Array<{ id: string; text: string; status: string }>;
  denialReasons?: string[];
  denialReasonOtherText?: string;
  criteriaEvaluated?: string[];
  dtiAtDecision?: number;
  ltvAtDecision?: number;
  versionNumber: number;
}

async function approvals(session: Session, applicationId: string): Promise<ApprovalRecord[]> {
  const path = `/api/applications/${applicationId}/approvals`;
  const result = await GET<{ rows: ApprovalRecord[] }>(path, { session });
  return expectOk(result, `GET ${path}`, 200).rows ?? [];
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  secondSupervisor = (await inviteStaff(supervisor, `${PREFIX}-sup2`, "SUPERVISOR")).session;
});

describe("§7.7 escalation criteria at boundary values", () => {
  test("LTV exactly at the threshold does not escalate; one basis point above does", { timeout: 600000 }, async () => {
    const threshold = Number(await readSetting(supervisor, "escalation.ltvThresholdPercent"));
    assert.equal(threshold, 80, "fixture assumes the §4.6.11 default LTV escalation threshold");

    const atThreshold = await preliminary("ltv-at", { estimatedValue: 400000, requestedLoanAmount: 320000 });
    assert.equal(atThreshold.ltv, 80, "fixture must land exactly on the threshold");
    const atDecision = await approvalDecision(supervisor, atThreshold.id, { decision: "approve", notes: "At threshold" });
    assert.equal(atDecision.status, 200, atDecision.text);
    const atFinal = await awaitState(supervisor, atThreshold.id, ["borrower_notified"], 45000);
    assert.equal(atFinal.outcome, "approved", "LTV exactly 80% must not require a second level");

    const aboveThreshold = await preliminary("ltv-above", { estimatedValue: 400000, requestedLoanAmount: 320400 });
    assert.ok((aboveThreshold.ltv ?? 0) > 80, `expected LTV > 80, got ${aboveThreshold.ltv}`);
    const aboveDecision = await approvalDecision(supervisor, aboveThreshold.id, { decision: "approve", notes: "Above" });
    assert.equal(aboveDecision.status, 200, aboveDecision.text);
    const escalated = await getApplication(supervisor, aboveThreshold.id);
    assert.equal(escalated.workflowState, "escalated_review");
    assert.ok(
      (escalated.escalationCriteriaMet ?? []).some((entry) => entry.includes("LTV")),
      `escalationCriteriaMet should name the LTV criterion: ${JSON.stringify(escalated.escalationCriteriaMet)}`,
    );
  });

  test("DTI exactly at the threshold does not escalate; above it does", { timeout: 600000 }, async () => {
    const threshold = Number(await readSetting(supervisor, "escalation.dtiThresholdPercent"));
    assert.equal(threshold, 43, "fixture assumes the §4.6.11 default DTI escalation threshold");

    const atThreshold = await preliminary("dti-at", {
      otherLiabilityMonthlyPayment: otherLiabilityForDti(43),
    });
    assert.equal(atThreshold.dti, 43, `fixture must land exactly on 43%, got ${atThreshold.dti}`);
    const atDecision = await approvalDecision(supervisor, atThreshold.id, { decision: "approve", notes: "At DTI" });
    assert.equal(atDecision.status, 200, atDecision.text);
    const atFinal = await awaitState(supervisor, atThreshold.id, ["borrower_notified"], 45000);
    assert.equal(atFinal.outcome, "approved", "DTI exactly 43% must not require a second level");

    const aboveThreshold = await preliminary("dti-above", {
      otherLiabilityMonthlyPayment: otherLiabilityForDti(43) + 10,
    });
    assert.ok((aboveThreshold.dti ?? 0) > 43, `expected DTI > 43, got ${aboveThreshold.dti}`);
    const aboveDecision = await approvalDecision(supervisor, aboveThreshold.id, { decision: "approve", notes: "Above" });
    assert.equal(aboveDecision.status, 200, aboveDecision.text);
    const escalated = await getApplication(supervisor, aboveThreshold.id);
    assert.equal(escalated.workflowState, "escalated_review");
    assert.ok(
      (escalated.escalationCriteriaMet ?? []).some((entry) => entry.includes("DTI")),
      `escalationCriteriaMet should name the DTI criterion: ${JSON.stringify(escalated.escalationCriteriaMet)}`,
    );
  });

  test("a loan type in approval.twoLevelLoanTypes always escalates", { timeout: 600000 }, async () => {
    const configured = JSON.parse(await readSetting(supervisor, "approval.twoLevelLoanTypes")) as string[];
    assert.deepEqual(configured, ["fha", "va", "usda"]);
    for (const loanType of configured) {
      assert.ok(enums.LoanType.includes(loanType), `${loanType} must be a contract LoanType`);
    }

    const application = await preliminary("fha", {
      loanType: "va",
      estimatedValue: 400000,
      requestedLoanAmount: 300000,
    });
    assert.equal(application.ltv, 75);
    const decided = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L1 VA" });
    assert.equal(decided.status, 200, decided.text);
    const escalated = await getApplication(supervisor, application.id);
    assert.equal(escalated.workflowState, "escalated_review", "a VA loan must require two levels regardless of ratios");
  });

  test("lowering the configured LTV threshold escalates a previously-unescalated file", { timeout: 600000 }, async () => {
    const original = await readSetting(supervisor, "escalation.ltvThresholdPercent");
    try {
      await writeSetting(supervisor, "escalation.ltvThresholdPercent", "70");
      const application = await preliminary("cfg-ltv", { estimatedValue: 400000, requestedLoanAmount: 300000 });
      assert.equal(application.ltv, 75, "75% is below the default 80% but above the reconfigured 70%");
      const decided = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L1" });
      assert.equal(decided.status, 200, decided.text);
      const escalated = await getApplication(supervisor, application.id);
      assert.equal(escalated.workflowState, "escalated_review");
    } finally {
      await writeSetting(supervisor, "escalation.ltvThresholdPercent", original);
    }
  });
});

describe("§7.7 approval gate semantics", () => {
  test("escalation criteria are evaluated at the L1 moment and recorded on the record", { timeout: 600000 }, async () => {
    const application = await preliminary("record", { estimatedValue: 400000, requestedLoanAmount: 300000 });
    const decided = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L1" });
    assert.equal(decided.status, 200, decided.text);
    const [record] = await approvals(supervisor, application.id);
    assert.ok(record, "an ApprovalRecord must exist after a decision");
    assert.equal(record.level, 1);
    assert.equal(record.decision, "approve");
    assert.equal(record.versionNumber, 1);
    assert.equal(record.dtiAtDecision, application.dti);
    assert.equal(record.ltvAtDecision, application.ltv);
    assert.ok((record.criteriaEvaluated ?? []).length > 0, "criteriaEvaluated must be recorded (XBR-009)");
  });

  test("the different-approver rule blocks the L1 approver from deciding L2 (INV-001)", { timeout: 600000 }, async () => {
    const application = await preliminary("diff-approver", { estimatedValue: 400000, requestedLoanAmount: 380000 });
    const first = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L1" });
    assert.equal(first.status, 200, first.text);
    assert.equal((await getApplication(supervisor, application.id)).workflowState, "escalated_review");

    const sameApprover = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L2 same" });
    assert.equal(sameApprover.status, 403, sameApprover.text.slice(0, 300));
    assert.equal((await getApplication(supervisor, application.id)).workflowState, "escalated_review");

    const differentApprover = await approvalDecision(secondSupervisor, application.id, {
      decision: "approve",
      notes: "L2 different",
    });
    assert.equal(differentApprover.status, 200, differentApprover.text.slice(0, 300));
    const final = await awaitState(supervisor, application.id, ["borrower_notified"], 45000);
    assert.equal(final.outcome, "approved");

    const records = await approvals(supervisor, application.id);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((entry) => entry.level).sort(), [1, 2]);
    const approverNames = new Set(records.map((entry) => entry.approverName));
    assert.equal(approverNames.size, 2, "the two levels must be decided by two distinct supervisors");
  });

  test("a deny never satisfies a level — mixed approve-then-deny routes to Denied", { timeout: 600000 }, async () => {
    const application = await preliminary("mixed", { estimatedValue: 400000, requestedLoanAmount: 380000 });
    const level1 = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L1 approve" });
    assert.equal(level1.status, 200, level1.text);
    assert.equal((await getApplication(supervisor, application.id)).workflowState, "escalated_review");

    const level2 = await approvalDecision(secondSupervisor, application.id, {
      decision: "deny",
      notes: "L2 deny",
      denialReasons: ["dti", "collateral"],
    });
    assert.equal(level2.status, 200, level2.text.slice(0, 300));
    const final = await awaitState(supervisor, application.id, ["borrower_notified", "denied"], 45000);
    assert.equal(final.outcome, "denied", "any deny routes the file to Denied");

    const records = await approvals(supervisor, application.id);
    const denies = records.filter((entry) => entry.decision === "deny");
    assert.equal(denies.length, 1);
    assert.deepEqual(denies[0].denialReasons, ["dti", "collateral"]);
  });

  test("an L1 deny routes straight to Denied without a second level", { timeout: 600000 }, async () => {
    const application = await preliminary("deny-l1", { estimatedValue: 400000, requestedLoanAmount: 380000 });
    const decided = await approvalDecision(supervisor, application.id, {
      decision: "deny",
      notes: "Denied at L1",
      denialReasons: ["credit-history"],
    });
    assert.equal(decided.status, 200, decided.text.slice(0, 300));
    const final = await awaitState(supervisor, application.id, ["borrower_notified", "denied"], 45000);
    assert.equal(final.outcome, "denied");
    assert.equal((await approvals(supervisor, application.id)).length, 1);
  });

  test("approve with at least one condition routes to Conditional Approval (WF-022, VR-086)", { timeout: 600000 }, async () => {
    const application = await preliminary("cond", { estimatedValue: 400000, requestedLoanAmount: 300000 });
    const decided = await approvalDecision(supervisor, application.id, {
      decision: "approve",
      notes: "Conditional",
      conditions: ["Provide the most recent pay stub.", "Provide proof of insurance."],
    });
    assert.equal(decided.status, 200, decided.text.slice(0, 300));
    const conditional = await getApplication(supervisor, application.id);
    assert.equal(conditional.workflowState, "conditional_approval");

    const [record] = await approvals(supervisor, application.id);
    assert.equal(record.conditions?.length, 2);
    for (const condition of record.conditions ?? []) {
      assert.equal(condition.status, "open");
      assert.ok(enums.ConditionStatus.includes(condition.status));
    }

    // T30 requires every condition cleared (XBR-011, WF-036).
    const blocked = await transition(supervisor, application.id, { toState: "approved" });
    assert.notEqual(blocked.status, 200);
    for (const condition of record.conditions ?? []) {
      const path = `/api/conditions/${condition.id}/clear`;
      const cleared = await POST(path, { session: supervisor });
      assert.equal(cleared.status, 200, cleared.text.slice(0, 300));
    }
    const completed = await transition(supervisor, application.id, { toState: "approved" });
    assert.equal(completed.status, 200, completed.text.slice(0, 300));
    const final = await awaitState(supervisor, application.id, ["borrower_notified"], 45000);
    assert.equal(final.outcome, "approved");
  });

  test("a level is decided at most once per version (INV-017)", { timeout: 600000 }, async () => {
    const application = await preliminary("once", { estimatedValue: 400000, requestedLoanAmount: 380000 });
    const first = await approvalDecision(supervisor, application.id, { decision: "approve", notes: "L1" });
    assert.equal(first.status, 200, first.text);
    // The file is now in escalated_review; a second L1-style decision by the same
    // approver is refused, and by a different supervisor becomes the L2 record — never
    // a duplicate level-1 record.
    const second = await approvalDecision(secondSupervisor, application.id, { decision: "approve", notes: "L2" });
    assert.equal(second.status, 200, second.text.slice(0, 300));
    const records = await approvals(supervisor, application.id);
    const levelCounts = new Map<number, number>();
    for (const record of records) levelCounts.set(record.level, (levelCounts.get(record.level) ?? 0) + 1);
    for (const [level, count] of levelCounts) {
      assert.equal(count, 1, `level ${level} was decided ${count} times on version 1`);
    }
  });
});

describe("§7.7 approval-decision request validation and role gate", () => {
  let preliminaryApplication: Application;

  before(async () => {
    preliminaryApplication = await preliminary("validation", { estimatedValue: 400000, requestedLoanAmount: 300000 });
  });

  test("only a Supervisor may record a decision (INV-020, §B role gate)", async () => {
    const path = `/api/applications/${preliminaryApplication.id}/approval-decision`;
    const result = await POST(path, {
      session: caseworker,
      body: { decision: "approve", versionStamp: preliminaryApplication.versionStamp, notes: "nope" },
    });
    assert.equal(result.status, 403, result.text.slice(0, 300));
  });

  test("deny requires 1–4 HMDA denial reasons (VR-087)", async () => {
    const withoutReasons = await approvalDecision(supervisor, preliminaryApplication.id, {
      decision: "deny",
      notes: "no reasons",
    });
    assert.equal(withoutReasons.status, 400, withoutReasons.text.slice(0, 300));

    const tooMany = await approvalDecision(supervisor, preliminaryApplication.id, {
      decision: "deny",
      notes: "too many",
      denialReasons: ["dti", "collateral", "credit-history", "insufficient-cash", "employment-history"],
    });
    assert.equal(tooMany.status, 400, tooMany.text.slice(0, 300));
  });

  test("denialReasons are forbidden with approve (VR-087)", async () => {
    const result = await approvalDecision(supervisor, preliminaryApplication.id, {
      decision: "approve",
      notes: "mixed",
      denialReasons: ["dti"],
    });
    assert.equal(result.status, 400, result.text.slice(0, 300));
  });

  test("denialReasonOtherText is required when a reason is `other` (VR-088)", async () => {
    const result = await approvalDecision(supervisor, preliminaryApplication.id, {
      decision: "deny",
      notes: "other reason",
      denialReasons: ["other"],
    });
    assert.equal(result.status, 400, result.text.slice(0, 300));
  });

  test("every denial reason literal comes from the contract DenialReason enum", () => {
    assert.deepEqual(enums.DenialReason, [
      "dti",
      "employment-history",
      "credit-history",
      "collateral",
      "insufficient-cash",
      "unverifiable-information",
      "application-incomplete",
      "mortgage-insurance-denied",
      "other",
    ]);
  });

  test("a stale versionStamp is rejected 409 (VR-084, INV-039)", async () => {
    const current = await getApplication(supervisor, preliminaryApplication.id);
    const result = await approvalDecision(supervisor, preliminaryApplication.id, {
      decision: "approve",
      notes: "stale",
      versionStamp: current.versionStamp - 1,
    });
    assert.equal(result.status, 409, result.text.slice(0, 300));
    assert.equal((await getApplication(supervisor, preliminaryApplication.id)).workflowState, "preliminary_decision");
  });

  test("a decision on a file that is not awaiting one is rejected 409 with workflow context", async () => {
    const actors = await actorsFor("wrong-state");
    const draft = await POST<Application>("/api/applications", {
      session: actors.borrower,
      body: { requestToken: `${PREFIX}-wrong-state` },
    });
    const application = expectOk(draft, "POST /api/applications", 201);
    const result = await approvalDecision(supervisor, application.id, {
      decision: "approve",
      notes: "draft decision",
      versionStamp: application.versionStamp,
    });
    assert.equal(result.status, 409, result.text.slice(0, 300));
    const body = result.body as unknown as ErrorResponse;
    assert.equal(body.currentState, "draft");
  });
});

describe("§7.7 escalation takes precedence over conditions (VR-086, XBR-026)", () => {
  test("a Level-1 approve carrying conditions on an ESCALATING file is rejected 409 before any write", { timeout: 600000 }, async () => {
    // The only other conditions test deliberately uses a NON-escalating LTV 75%
    // shape, so this combination was never exercised. LTV 95% escalates.
    const application = await preliminary("esc-cond", { estimatedValue: 400000, requestedLoanAmount: 380000 });
    assert.equal(application.ltv, 95, "fixture must escalate on LTV");

    const rejected = await approvalDecision(supervisor, application.id, {
      decision: "approve",
      notes: "L1 approve carrying a condition on an escalating file",
      conditions: ["Provide the most recent pay stub."],
    });
    assert.equal(rejected.status, 409, rejected.text.slice(0, 300));
    const body = rejected.body as unknown as ErrorResponse;
    assert.equal(body.currentState, "preliminary_decision");
    assert.match(body.message, /final approving level/i, `the 409 must say why: ${body.message}`);

    // "before any write": no ApprovalRecord, no Condition, no state change.
    assert.deepEqual(await approvals(supervisor, application.id), []);
    assert.equal(
      (await getApplication(supervisor, application.id)).workflowState,
      "preliminary_decision",
    );

    // The same file approves cleanly once the conditions are dropped, and the
    // T21 route writes NO Condition rows (XBR-026).
    const accepted = await approvalDecision(supervisor, application.id, {
      decision: "approve",
      notes: "L1 approve, no conditions",
    });
    assert.equal(accepted.status, 200, accepted.text.slice(0, 300));
    assert.equal((await getApplication(supervisor, application.id)).workflowState, "escalated_review");
    const records = await approvals(supervisor, application.id);
    assert.equal(records.length, 1);
    assert.equal((records[0].conditions ?? []).length, 0, "T21 must write no Condition rows");
  });

  test("T30 counts every open condition across ALL approval records (XBR-011)", { timeout: 600000 }, async () => {
    // Two approving records on one file: L1 (escalating, no conditions) and L2
    // (conditional). Post-VR-086 this is the only API-reachable shape carrying
    // two approval records plus conditions — the LEGACY shape, where a condition
    // is bound to the OLDER record, is proved in
    // verification/adversarial-fixes/find-011-012-conditions-and-t30.ts.
    const application = await preliminary("t30-two-rec", { estimatedValue: 400000, requestedLoanAmount: 380000 });
    const l1 = await approvalDecision(supervisor, application.id, {
      decision: "approve",
      notes: "L1 approve, no conditions",
    });
    assert.equal(l1.status, 200, l1.text.slice(0, 300));
    assert.equal((await getApplication(supervisor, application.id)).workflowState, "escalated_review");

    const l2 = await approvalDecision(secondSupervisor, application.id, {
      decision: "approve",
      notes: "L2 conditional approve",
      conditions: ["Provide proof of hazard insurance."],
    });
    assert.equal(l2.status, 200, l2.text.slice(0, 300));
    assert.equal((await getApplication(supervisor, application.id)).workflowState, "conditional_approval");

    const records = await approvals(supervisor, application.id);
    assert.equal(records.length, 2, "the file must carry two approving records");
    const withConditions = records.filter((r) => (r.conditions ?? []).length > 0);
    assert.equal(withConditions.length, 1, "only the T26a decision creates Condition rows (XBR-026)");
    const condition = withConditions[0].conditions![0];
    assert.equal(condition.status, "open");

    const blocked = await transition(supervisor, application.id, { toState: "approved" });
    assert.equal(blocked.status, 409, blocked.text.slice(0, 300));
    assert.match(
      (blocked.body as unknown as ErrorResponse).message,
      /still open/i,
      "the T30 refusal must count the open conditions",
    );

    const clearPath = `/api/conditions/${condition.id}/clear`;
    assert.equal((await POST(clearPath, { session: supervisor })).status, 200);
    const completed = await transition(supervisor, application.id, { toState: "approved" });
    assert.equal(completed.status, 200, completed.text.slice(0, 300));
    const final = await awaitState(supervisor, application.id, ["borrower_notified"], 45000);
    assert.equal(final.outcome, "approved");
  });
});

after(async () => {
  // Uniqueness-based cleanup: every account and application created here carries PREFIX.
});
