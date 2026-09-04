/**
 * §7.7 — the audit entry is written IN-TRANSACTION: when the audit write fails the
 * action it accompanies must roll back entirely (XBR-013, AC-26, INV-037).
 * Depends on the sanctioned test-only fixture seam — see task-046/test-fixtures-contract.md.
 *
 * This file covers the transition and note paths. The four remaining audited
 * state-changing endpoints — the two notification-retry endpoints and the two
 * demo-data endpoints — are covered by the sibling
 * zz-seam-audit-rollback-extra.test.ts (LENS-011).
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { requireSeam, seam } from "../helpers/seam.js";
import { GET, POST, expectOk } from "../helpers/http.js";
import { auditEntries } from "../helpers/audit.js";
import {
  buildSubmittableDraft,
  claim,
  getApplication,
  transitionOk,
  type Application,
} from "../helpers/application.js";

const PREFIX = suitePrefix("rollback");

let supervisor: Session;
let caseworker: Session;

async function submitted(label: string): Promise<Application> {
  const borrower = (await registerBorrower(supervisor, `${PREFIX}-${label}`)).session;
  const draft = await buildSubmittableDraft(borrower);
  const application = await transitionOk(borrower, draft.id, {
    toState: "application_received",
    versionStamp: draft.versionStamp,
  });
  expectOk(await claim(caseworker, application.id), "claim", 201);
  return application;
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  await requireSeam();
});

describe("§7.7 audit-write failure rolls the action back (XBR-013)", () => {
  test("a transition whose audit write fails leaves the workflow state unchanged", { timeout: 300000 }, async () => {
    const application = await submitted("transition");
    const before = await getApplication(caseworker, application.id);
    assert.equal(before.workflowState, "application_received");

    await seam("fail-next-audit-write", { armed: true });
    try {
      const result = await POST(`/api/applications/${application.id}/transition`, {
        session: caseworker,
        body: { toState: "completeness_validated", versionStamp: before.versionStamp },
      });
      assert.ok(result.status >= 400, `the transition must be rejected, got ${result.status}`);
    } finally {
      await seam("fail-next-audit-write", { armed: false });
    }

    const after = await getApplication(caseworker, application.id);
    assert.equal(after.workflowState, "application_received", "the state change must have rolled back");
    assert.equal(after.versionStamp, before.versionStamp, "the version stamp must not have advanced");

    const historyPath = `/api/applications/${application.id}/workflow-history`;
    const history = expectOk(
      await GET<{ rows: Array<{ toState: string }> }>(historyPath, { session: caseworker }),
      historyPath,
      200,
    );
    assert.ok(
      !history.rows.some((row) => row.toState === "completeness_validated"),
      "no WorkflowHistory row may survive a rolled-back transition",
    );

    // The same transition must succeed once the audit write is healthy again.
    const retried = await transitionOk(caseworker, application.id, { toState: "completeness_validated" });
    assert.equal(retried.workflowState, "completeness_validated");
  });

  test("a note whose audit write fails is not persisted", { timeout: 300000 }, async () => {
    const application = await submitted("note");
    const path = `/api/applications/${application.id}/notes`;
    const marker = `${PREFIX}-rolled-back-note`;

    await seam("fail-next-audit-write", { armed: true });
    try {
      const result = await POST(path, { session: caseworker, body: { type: "internal", content: marker } });
      assert.ok(result.status >= 400, `the note must be rejected, got ${result.status}`);
    } finally {
      await seam("fail-next-audit-write", { armed: false });
    }

    const page = expectOk(
      await GET<{ rows: Array<{ content: string }> }>(path, { session: caseworker }),
      path,
      200,
    );
    assert.ok(!page.rows.some((row) => row.content === marker), "the note must have rolled back with its audit row");
  });

  test("the failed attempt leaves no partial audit entry behind (INV-009)", { timeout: 300000 }, async () => {
    const application = await submitted("partial");
    const before = new Set((await auditEntries(supervisor, 100)).map((row) => row.id));

    await seam("fail-next-audit-write", { armed: true });
    try {
      await POST(`/api/applications/${application.id}/transition`, {
        session: caseworker,
        body: {
          toState: "revision_requested",
          versionStamp: (await getApplication(caseworker, application.id)).versionStamp,
          note: "This transition must roll back.",
        },
      });
    } finally {
      await seam("fail-next-audit-write", { armed: false });
    }

    const after = await auditEntries(supervisor, 100);
    const added = after.filter((row) => !before.has(row.id));
    assert.ok(
      !added.some((row) => row.applicationNumber === application.applicationNumber),
      `a rolled-back action must leave no audit row: ${JSON.stringify(added.map((row) => row.actionType))}`,
    );
  });
});
