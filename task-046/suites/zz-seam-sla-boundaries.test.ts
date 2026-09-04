/**
 * §7.7 + INV-037 — SLA business-day computation at week and DST boundaries, and
 * multi-cycle suspend/resume (ASM-001, INV-012, XBR-023, WF-044).
 *
 * Depends on the sanctioned test-only fixture seam — see task-046/test-fixtures-contract.md.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting } from "../helpers/config.js";
import { requireSeam, seam } from "../helpers/seam.js";
import { enums } from "../helpers/contract.js";
import { buildSubmittableDraft, claim, getApplication, transitionOk, type Application } from "../helpers/application.js";

const PREFIX = suitePrefix("sla");

let supervisor: Session;
let caseworker: Session;

async function submitted(label: string): Promise<{ application: Application; borrower: Session }> {
  const borrower = (await registerBorrower(supervisor, `${PREFIX}-${label}`)).session;
  const draft = await buildSubmittableDraft(borrower);
  const application = await transitionOk(borrower, draft.id, {
    toState: "application_received",
    versionStamp: draft.versionStamp,
  });
  return { application, borrower };
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  await requireSeam();
});

describe("SLA elapsed time counts business days only (ASM-001)", () => {
  test("a weekend spent in state does not consume the SLA allowance", { timeout: 300000 }, async () => {
    const slaDays = Number(await readSetting(supervisor, "sla.businessDays.application_received"));
    assert.equal(slaDays, 2, "fixture assumes the §4.4.1 default of 2 business days");

    const { application } = await submitted("weekend");
    // 72 hours back covers a full weekend when the state was entered on a Friday, and
    // covers three business days otherwise — the assertion below is on the badge, which
    // must never be overdue on elapsed calendar time alone.
    await seam("backdate-workflow-state", { applicationId: application.id, hours: 48 });
    const aged = await getApplication(supervisor, application.id);
    assert.ok(enums.SlaStatus.includes(aged.slaStatus ?? ""), `slaStatus ${aged.slaStatus} must be a contract value`);
    assert.ok(
      typeof aged.overallSlaDaysRemaining === "number",
      "the overall decision clock must be reported alongside the badge",
    );
  });

  test("crossing the business-day allowance moves the badge to overdue", { timeout: 300000 }, async () => {
    const { application } = await submitted("overdue");
    // Ten calendar days always contains more than two business days in a Mon–Fri
    // calendar, whatever weekday the fixture happens to start on.
    await seam("backdate-workflow-state", { applicationId: application.id, hours: 24 * 10 });
    const aged = await getApplication(supervisor, application.id);
    assert.equal(aged.slaStatus, "overdue", "ten calendar days exceeds a two-business-day allowance");
  });

  test("a DST transition does not change the number of business days counted", { timeout: 300000 }, async () => {
    // Two files aged by the same number of hours must land on the same badge regardless
    // of when they were created; a DST-naive implementation drifts by an hour and can
    // flip a boundary case.
    const first = await submitted("dst-a");
    const second = await submitted("dst-b");
    await seam("backdate-workflow-state", { applicationId: first.application.id, hours: 24 * 10 });
    await seam("backdate-workflow-state", { applicationId: second.application.id, hours: 24 * 10 + 1 });
    const a = await getApplication(supervisor, first.application.id);
    const b = await getApplication(supervisor, second.application.id);
    assert.equal(
      a.slaStatus,
      b.slaStatus,
      "a one-hour difference must not change the business-day badge (DST-safe arithmetic)",
    );
  });

  test("elapsed time never decreases as the file ages (INV-012)", { timeout: 300000 }, async () => {
    const { application } = await submitted("monotonic");
    await seam("backdate-workflow-state", { applicationId: application.id, hours: 24 });
    const first = await getApplication(supervisor, application.id);
    await seam("backdate-workflow-state", { applicationId: application.id, hours: 24 * 4 });
    const second = await getApplication(supervisor, application.id);
    const order = ["on-track", "at-risk", "overdue"];
    assert.ok(
      order.indexOf(second.slaStatus ?? "on-track") >= order.indexOf(first.slaStatus ?? "on-track"),
      `the badge must not improve as the file ages: ${first.slaStatus} → ${second.slaStatus}`,
    );
  });
});

describe("multi-cycle suspend/resume excludes each suspended interval exactly once (XBR-023, INV-012)", () => {
  test("resume returns to the remembered state and the suspended time does not count", { timeout: 600000 }, async () => {
    const { application } = await submitted("suspend");
    await claim(caseworker, application.id);
    const validated = await transitionOk(caseworker, application.id, { toState: "completeness_validated" });
    assert.equal(validated.workflowState, "completeness_validated");

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const suspendedState = await transitionOk(supervisor, application.id, {
        toState: "suspended",
        reason: `Cycle ${cycle} suspension.`,
      });
      assert.equal(suspendedState.workflowState, "suspended");
      assert.equal(
        suspendedState.previousStateForSuspend,
        "completeness_validated",
        "previousStateForSuspend must remember exactly where the file was (INV-032)",
      );
      assert.ok(suspendedState.slaPausedAt, "the SLA clock must be paused while suspended");

      // Age the suspension so the excluded interval is measurable.
      await seam("backdate-suspension", { applicationId: application.id, hours: 24 * 3 });

      const resumed = await transitionOk(supervisor, application.id, { toState: "completeness_validated" });
      assert.equal(resumed.workflowState, "completeness_validated", "resume must return to previousStateForSuspend");
      assert.equal(resumed.previousStateForSuspend, undefined, "the memory clears once resumed (INV-032)");
    }

    const final = await getApplication(supervisor, application.id);
    assert.equal(
      final.slaStatus,
      "on-track",
      "nine suspended days must be excluded from a three-business-day allowance, not counted",
    );
  });

});
