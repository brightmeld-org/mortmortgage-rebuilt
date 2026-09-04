/**
 * §7.7 / REQ-022 — section copy from an application older than the configured
 * staleness threshold must carry a persistent advisory (XBR-020).
 * Depends on the sanctioned test-only fixture seam — see task-046/test-fixtures-contract.md.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting } from "../helpers/config.js";
import { requireSeam, seam } from "../helpers/seam.js";
import { POST, expectOk } from "../helpers/http.js";
import { createDraft, fillDraft, saveSection, type Application } from "../helpers/application.js";

const PREFIX = suitePrefix("stalecopy");

let supervisor: Session;
let borrower: Session;
let source: Application;
let thresholdDays: number;

before(async () => {
  supervisor = await demoLogin("supervisor");
  await ensureAuthHeadroom(supervisor);
  await requireSeam();
  thresholdDays = Number(await readSetting(supervisor, "application.staleCopyThresholdDays"));
  assert.equal(thresholdDays, 90, "fixture assumes the §4.6.11 default staleness threshold");

  borrower = (await registerBorrower(supervisor, `${PREFIX}-b1`)).session;
  source = await fillDraft(borrower, await createDraft(borrower));
});

describe("§7.7 copied-section staleness advisory (REQ-022, XBR-020)", () => {
  test("a copy from a recent application carries no advisory", { timeout: 300000 }, async () => {
    const created = expectOk(
      await POST<Application>("/api/applications", {
        session: borrower,
        body: {
          requestToken: randomUUID(),
          copyFromApplicationId: source.id,
          copySections: ["identity", "address-history"],
        },
      }),
      "copy from recent source",
      201,
    );
    const saved = expectOk(
      await saveSection(
        borrower,
        created.id,
        "identity",
        { identity: { firstName: "Fresh", lastName: "Copy" } },
        created.versionStamp,
        1,
      ),
      "section save",
      200,
    );
    assert.deepEqual(saved.staleCopyAdvisories ?? [], [], "a fresh copy source produces no advisory");
  });

  test("a copy from a source older than the threshold carries a persistent advisory", { timeout: 300000 }, async () => {
    await seam("age-application", { applicationId: source.id, days: thresholdDays + 1 });

    const created = expectOk(
      await POST<Application>("/api/applications", {
        session: borrower,
        body: {
          requestToken: randomUUID(),
          copyFromApplicationId: source.id,
          copySections: ["identity", "address-history", "employment-income"],
        },
      }),
      "copy from aged source",
      201,
    );

    const saved = expectOk(
      await saveSection(
        borrower,
        created.id,
        "liabilities",
        { liabilities: { liabilities: [], otherLiabilities: [] } },
        created.versionStamp,
      ),
      "section save",
      200,
    );
    assert.ok(
      (saved.staleCopyAdvisories ?? []).length > 0,
      "a copy older than the threshold must raise a staleness advisory",
    );

    // The advisory persists until the borrower confirms the section (VR-068).
    const confirmed = expectOk(
      await saveSection(
        borrower,
        created.id,
        "identity",
        { identity: { firstName: "Aged", lastName: "Copy" }, confirmCopiedSection: true },
        saved.versionStamp,
        1,
      ),
      "confirm copied section",
      200,
    );
    assert.ok(
      !(confirmed.staleCopyAdvisories ?? []).includes("identity"),
      "confirming a section clears its advisory without requiring an edit",
    );
  });

  test("a copy source belonging to another borrower is refused (XBR-020)", { timeout: 300000 }, async () => {
    const other = (await registerBorrower(supervisor, `${PREFIX}-b2`)).session;
    const result = await POST("/api/applications", {
      session: other,
      body: {
        requestToken: randomUUID(),
        copyFromApplicationId: source.id,
        copySections: ["identity"],
      },
    });
    assert.ok([400, 403, 404].includes(result.status), `got ${result.status} ${result.text.slice(0, 200)}`);
  });
});
