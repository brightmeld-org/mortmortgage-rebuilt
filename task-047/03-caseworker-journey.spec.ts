/**
 * FLOW-006 / FLOW-007 — Caseworker claims the freshly submitted application and works
 * it to Preliminary Decision, then reviews OCR on a seeded document.
 *
 * §7.7 caseworker items: demo login (the session minted in setup), claim, correct a
 * field, notes and chatter, document review and OCR, run checks and AUS, preliminary
 * decision, request revision.
 */
import { expect, test, type Page } from "@playwright/test";
import { awaitHydrated, gotoAs, gotoUntilReady, requireState, sessionExpired, storagePath } from "./support/journey";

test.describe.configure({ mode: "serial" });
test.use({ storageState: storagePath("caseworker") });

const liveId = () => requireState("liveApplicationId");
const liveNumber = () => requireState("liveApplicationNumber");

const STATE_LABEL: Record<string, RegExp> = {
  completeness_validated: /Completeness/i,
  documents_received: /Supporting Documents Received/i,
  aus_executed: /AUS Executed/i,
  preliminary_decision: /Preliminary Decision/i,
  revision_requested: /Revision Requested/i,
};

async function openDetail(page: Page, applicationId: string): Promise<void> {
  await gotoAs(page, "caseworker", `/staff/applications/${applicationId}`);
  await gotoUntilReady(page, `/staff/applications/${applicationId}`, "staff-application-detail");
  await page.getByTestId("detail-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
  // Let the client bundle finish wiring before the first interaction.
  await page.waitForTimeout(3000);
}

/**
 * Drives one whitelisted transition through the workflow action panel and asserts the
 * state badge afterwards. Any API refusal is surfaced verbatim (NFR-025) in
 * `workflow-error-banner`, so a blocked transition fails with the server's own reason.
 */
async function advance(page: Page, toState: keyof typeof STATE_LABEL, note: string): Promise<void> {
  const badge = page.getByTestId("detail-state-badge");
  if (STATE_LABEL[toState].test(await badge.innerText())) return;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const action = page.getByTestId(`workflow-action-${toState}`);
    await expect(action, `${toState} is offered as a valid transition from the current state`).toBeVisible({
      timeout: 180_000,
    });
    await action.click();
    await page.getByTestId("workflow-note-input").waitFor({ timeout: 120_000 });
    await page.getByTestId("workflow-note-input").fill(note);

    // Transitions that carry a recommendation render a select inside the panel, and the
    // confirmation stays disabled until it is answered.
    const recommendation = page.getByTestId("workflow-recommendation-select");
    if ((await recommendation.count()) > 0) {
      await recommendation
        .selectOption("approve")
        .catch(() => recommendation.selectOption({ label: "Approve" }));
    }

    const confirm = page.getByTestId("workflow-confirm-btn");
    await expect(confirm, `the ${toState} confirmation is enabled once the panel is answered`).toBeEnabled({
      timeout: 120_000,
    });
    await confirm.click();

    // Any refusal is surfaced verbatim (NFR-025) rather than retried blindly.
    const banner = page.getByTestId("workflow-error-banner");
    if (await banner.isVisible().catch(() => false)) {
      throw new Error(`transition to ${toState} was refused: ${await banner.innerText()}`);
    }

    try {
      await expect(badge).toHaveText(STATE_LABEL[toState], { timeout: 120_000 });
      return;
    } catch {
      // A confirmation that landed before the handler was wired leaves the state untouched.
      await openDetail(page, liveId());
    }
  }

  await expect(badge, `the application reaches ${toState}`).toHaveText(STATE_LABEL[toState], {
    timeout: 180_000,
  });
}

async function runCheck(page: Page, checkType: "credit" | "income" | "avm" | "pricing" | "aus"): Promise<void> {
  await awaitHydrated(page, "detail-tab-underwriting");
  await page.getByTestId(`detail-tab-underwriting`).click();
  const section = page.getByTestId(`check-section-${checkType}`);
  await expect(section, `${checkType} check section renders`).toBeVisible({ timeout: 180_000 });
  // The underwriting panel is a client component inside a tab: its markup is server-
  // rendered, so the section is visible before its own chunk has loaded and attached
  // handlers. A Run pressed in that window is swallowed with no request and no error,
  // and the badge wait below then burns its whole budget on a check never started.
  await awaitHydrated(page, `check-run-${checkType}`);
  await page.getByTestId(`check-run-${checkType}`).click();

  // The simulation is asynchronous; the badge appears once the result is recorded.
  //
  // Some inputs deterministically model a RETRYABLE transient — the §6.3 fault table's
  // "503 on attempt 1, good on retry" row, keyed on the applicant's own data (INV-037:
  // legitimate data can collide with a trigger). The panel answers that by swapping Run
  // for Retry, so the journey drives Retry rather than treating a contracted transient
  // as a dead end. A fault that never clears still fails, with the bureau's own words.
  const badge = page.getByTestId(`check-badge-${checkType}`);
  const settled = page.locator(
    `[data-testid="check-badge-${checkType}"], [data-testid="check-retry-${checkType}"]`,
  );
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await settled.first().waitFor({ state: "visible", timeout: 300_000 }).catch(() => undefined);
    if (await badge.isVisible().catch(() => false)) break;
    const retry = page.getByTestId(`check-retry-${checkType}`);
    if (!(await retry.isVisible().catch(() => false))) break;
    await awaitHydrated(page, `check-retry-${checkType}`);
    await retry.click();
  }
  if (!(await badge.isVisible().catch(() => false))) {
    const reason = await page
      .getByTestId(`check-section-${checkType}-error`)
      .innerText()
      .catch(() => "");
    throw new Error(
      `the ${checkType} check never produced a risk badge${reason ? `: ${reason.replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
    );
  }
  await expect(badge).toBeVisible({ timeout: 300_000 });
  await expect(badge).not.toHaveText("");
}

test("claims the newly submitted application from the unassigned queue", async ({ page }) => {
  await gotoAs(page, "caseworker", "/caseworker/queue");
  await expect(page.getByTestId("queue-tab-unassigned")).toBeVisible({ timeout: 180_000 });

  // The stats strip shows the five §4.4.2 figures.
  for (const metric of [
    "queue-size",
    "completed-this-month",
    "avg-days-to-decision",
    "approval-rate",
    "overdue",
  ]) {
    await expect(page.getByTestId(`stats-${metric}`)).toBeVisible();
  }

  // The rows are server-rendered before the page hydrates; interacting with the tab or
  // the search box before then is silently dropped. Waiting for a row on the unfiltered
  // landing list proves the data arrived and the client bundle is live.
  await expect(page.locator('[data-testid^="queue-row-"]').first()).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(4000);

  const searchFor = async (tab: "unassigned" | "mine"): Promise<void> => {
    await page.getByTestId(`queue-tab-${tab}`).click();
    await page.waitForTimeout(4000);
    await page.getByTestId("queue-search").fill(liveNumber());
    // The list refetches on a debounce; give it time to replace the previous tab's rows.
    await page.waitForTimeout(9000);
  };

  // A re-run against an already-claimed application still ends in the asserted state.
  await searchFor("mine");
  if ((await page.getByTestId(`queue-row-${liveId()}`).count()) > 0) {
    await expect(page.getByTestId(`queue-row-${liveId()}`)).toBeVisible();
    return;
  }

  await searchFor("unassigned");
  const row = page.getByTestId(`queue-row-${liveId()}`);
  await expect(row, "the submitted application is claimable from the unassigned queue").toBeVisible({
    timeout: 300_000,
  });
  // Unassigned rows carry human-readable state labels, never a raw enum (AC-23).
  await expect(row).toContainText("Application Received");

  // Reissue the claim if the first press was dropped before the handler was wired: the
  // row leaving Unassigned is the app's own confirmation that the claim landed.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if ((await row.count()) === 0) break;
    await page.getByTestId(`queue-claim-${liveId()}`).click();
    try {
      await expect(row).toHaveCount(0, { timeout: 120_000 });
      break;
    } catch {
      await page.waitForTimeout(5000);
    }
  }
  await expect(row, "a claimed application leaves the unassigned queue").toHaveCount(0, {
    timeout: 300_000,
  });

  // …and turns up in My Queue.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await searchFor("mine");
    if ((await page.getByTestId(`queue-row-${liveId()}`).count()) > 0) break;
  }
  await expect(
    page.getByTestId(`queue-row-${liveId()}`),
    "the claimed application appears in My Queue",
  ).toBeVisible({ timeout: 300_000 });
});

test("validates completeness so the file becomes staff-editable", async ({ page }) => {
  // Corrections are permitted from Completeness Validated onwards (AC-25), so the file is
  // moved there before anything is edited.
  await openDetail(page, liveId());
  const badge = page.getByTestId("detail-state-badge");
  if ((await badge.innerText()).trim() === "Application Received") {
    await advance(page, "completeness_validated", "Sections complete and internally consistent.");
  }
  await expect(badge).toHaveText(/Completeness/i, { timeout: 300_000 });
});

test("corrects a field with a reason and records the correction provenance", async ({ page }) => {
  await openDetail(page, liveId());
  await page.getByTestId("detail-tab-identity").click();

  await page.getByTestId("correction-edit-b1-dependentsCount").click();
  await expect(page.getByTestId("correction-reason-input")).toBeVisible({ timeout: 120_000 });

  // The inline editor hydrates after it renders; refill and reissue until the editor
  // closes, which is how the app reports the correction was accepted.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if ((await page.getByTestId("correction-save-btn").count()) === 0) break;
    await page.getByTestId("correction-value-input").fill("2");
    await page.getByTestId("correction-reason-input").fill("Verified two dependents against the tax return.");
    await expect(page.getByTestId("correction-reason-input")).toHaveValue(/Verified/);
    await page.getByTestId("correction-save-btn").click();
    try {
      await expect(page.getByTestId("correction-save-btn")).toHaveCount(0, { timeout: 90_000 });
      break;
    } catch {
      await page.waitForTimeout(3000);
    }
  }

  await expect(page.locator('[data-testid^="correction-indicator-"]').first()).toBeVisible({
    timeout: 180_000,
  });

  // SSN stays masked and the date of birth stays U.S.-formatted on every staff screen (AC-29).
  await expect(page.getByTestId("ssn-masked-1")).toHaveText(/^\*\*\*-\*\*-\d{4}$/);
  await expect(page.getByTestId("dob-display-1")).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
});

test("records an internal note and a chatter message", async ({ page }) => {
  await openDetail(page, liveId());
  await page.getByTestId("detail-tab-notes").click();

  const internalNote = "Income and assets reconcile with the linked accounts.";
  const chatterMessage = "Picking this one up now.";

  // Composer submissions are round trips; reissue until the posted note appears.
  await expect(page.getByTestId("note-input")).toBeVisible({ timeout: 180_000 });
  await page.waitForTimeout(3000);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if ((await page.getByTestId("internal-notes").innerText()).includes(internalNote)) break;
    await page.getByTestId("note-type-internal").click();
    await page.getByTestId("note-input").fill(internalNote);
    await page.getByTestId("note-submit").click();
    try {
      await expect(page.getByTestId("internal-notes")).toContainText(internalNote, { timeout: 90_000 });
      break;
    } catch {
      await page.waitForTimeout(3000);
    }
  }
  await expect(page.getByTestId("internal-notes"), "the internal note is recorded").toContainText(
    internalNote,
    { timeout: 120_000 },
  );

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if ((await page.getByTestId("chatter-list").innerText()).includes(chatterMessage)) break;
    await page.getByTestId("chatter-input").fill(chatterMessage);
    await page.getByTestId("chatter-send").click();
    try {
      await expect(page.getByTestId("chatter-list")).toContainText(chatterMessage, { timeout: 90_000 });
      break;
    } catch {
      await page.waitForTimeout(3000);
    }
  }
  await expect(page.getByTestId("chatter-list"), "the chatter message is posted").toContainText(
    chatterMessage,
    { timeout: 120_000 },
  );
});

test("accepts every checklist document and advances to Supporting Documents Received", async ({ page }) => {
  test.setTimeout(1_200_000);
  await openDetail(page, liveId());
  await page.getByTestId("detail-tab-documents").click();
  await expect(page.getByTestId("documents-checklist")).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-testid^="doc-status-badge-"]').first()).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(5000);

  // Every checklist item must be Accepted or Waived before T7 is permitted. The panel
  // re-renders after each status write, so the loop is driven off whatever is still
  // outstanding rather than off a list of ids captured up front.
  const outstanding = () =>
    page.locator('[data-testid^="doc-status-badge-"]', { hasText: /pending|insufficient/i });

  await expect(page.locator('[data-testid^="doc-status-accept-"]').first()).toBeVisible({
    timeout: 180_000,
  });
  expect(await outstanding().count(), "the borrower uploaded documents for the checklist").toBeGreaterThan(0);

  // Accepting a whole checklist is a burst of writes against a rate-limited API on a
  // session that can idle out mid-loop. Either puts a blocking modal over the panel, so
  // the loop clears it (waiting the limiter out, or re-authenticating) and carries on.
  const blocked = page
    .locator('[role="presentation"]')
    .filter({ hasText: /not available right now|session has expired/i });

  const reopenDocuments = async (): Promise<void> => {
    await openDetail(page, liveId());
    await page.getByTestId("detail-tab-documents").click();
    await expect(page.getByTestId("documents-checklist")).toBeVisible({ timeout: 180_000 });
    await page.waitForTimeout(4000);
  };

  for (let guard = 0; guard < 30; guard += 1) {
    if ((await blocked.count()) > 0) {
      await page.waitForTimeout(30_000);
      await reopenDocuments();
    } else if (await sessionExpired(page)) {
      await reopenDocuments();
    }

    if ((await outstanding().count()) === 0) break;
    const badgeTestId = String(await outstanding().first().getAttribute("data-testid"));
    const documentId = badgeTestId.replace("doc-status-badge-", "");

    // Accepting opens a confirmation dialog; the write only happens on confirm.
    await page.getByTestId(`doc-status-accept-${documentId}`).click();
    await page.getByTestId("doc-status-confirm-btn").waitFor({ timeout: 90_000 });
    await page.getByTestId("doc-status-confirm-btn").click();
    await page.getByTestId("doc-status-confirm-btn").waitFor({ state: "detached", timeout: 120_000 }).catch(() => {});
    // Stay under the 60-per-minute general rate limit while working through the checklist.
    await page.waitForTimeout(6000);
  }

  await expect(outstanding(), "every checklist document is accepted").toHaveCount(0, { timeout: 300_000 });

  await advance(page, "documents_received", "All checklist items accepted.");
});

test("runs the four underwriting checks and AUS, then records the preliminary decision", async ({ page }) => {
  test.setTimeout(900_000);
  await openDetail(page, liveId());

  for (const checkType of ["credit", "income", "avm", "pricing"] as const) {
    await runCheck(page, checkType);
  }

  // The AVM renders a keyless map with the subject plus comparable markers (AC-37).
  await expect(page.getByTestId("avm-map")).toBeVisible();
  await expect(page.getByTestId("avm-map-marker-subject")).toBeVisible();
  await expect(page.locator('[data-testid^="avm-map-marker-comp-"]')).toHaveCount(4);
  await expect(page.getByTestId("avm-comparables-table")).toBeVisible();

  await runCheck(page, "aus");
  await expect(page.getByTestId("qualification-card")).toBeVisible();
  await expect(page.getByTestId("qualification-dti")).not.toHaveText("");
  await expect(page.getByTestId("qualification-ltv")).not.toHaveText("");

  await page.getByTestId("detail-tab-summary").click();
  await advance(page, "aus_executed", "All four checks completed; AUS recorded.");

  // An open high-severity flag blocks the preliminary decision until it is resolved
  // (AC-38); the caseworker clears it before recording the recommendation.
  await expect(page.getByTestId("fraud-flags-open-count")).toBeVisible({ timeout: 300_000 });
  const openFlags = page.locator('[data-testid^="fraud-resolve-"]');
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await openFlags.count()) === 0) break;
    const resolveId = String(await openFlags.first().getAttribute("data-testid"));
    await page.getByTestId(resolveId).click();
    await page.waitForTimeout(6000);
  }
  await expect(page.getByTestId("fraud-flags-open-count")).toContainText("0 open", { timeout: 300_000 });

  await advance(page, "preliminary_decision", "Recommend approval — strong credit, 70% LTV.");
});

test("requests a revision on a seeded application in Application Received", async ({ page }) => {
  await gotoAs(page, "caseworker", "/caseworker/queue");
  // Wait for hydration before switching tabs — a pre-hydration click is dropped.
  await expect(page.locator('[data-testid^="queue-row-"]').first()).toBeVisible({ timeout: 300_000 });
  await page.getByTestId("queue-tab-mine").click();
  await page.waitForTimeout(6000);
  await expect(page.locator('[data-testid^="queue-row-"]').first()).toBeVisible({ timeout: 300_000 });

  const candidate = page
    .locator('[data-testid^="queue-row-"]', { hasText: "Application Received" })
    .filter({ hasNotText: liveNumber() })
    .first();
  await expect(candidate, "a seeded assigned application sits in Application Received").toBeVisible({
    timeout: 180_000,
  });
  const applicationId = String(await candidate.getAttribute("data-testid")).replace("queue-row-", "");

  await openDetail(page, applicationId);
  await advance(page, "revision_requested", "Please provide the two most recent bank statements.");

  // The formal note the borrower will read is recorded alongside the transition.
  await page.getByTestId("detail-tab-notes").click();
  await expect(page.getByTestId("formal-notes")).toContainText("two most recent bank statements", {
    timeout: 180_000,
  });
});

test("reviews OCR on a seeded document and applies a suggestion", async ({ page, browser }) => {
  test.setTimeout(1_200_000);
  // FLOW-007 runs against seeded documents whose OCR jobs have already completed.
  await gotoAs(page, "caseworker", "/caseworker/queue");
  // Wait for hydration before switching tabs — a pre-hydration click is dropped.
  await expect(page.locator('[data-testid^="queue-row-"]').first()).toBeVisible({ timeout: 300_000 });
  await page.getByTestId("queue-tab-mine").click();
  await page.waitForTimeout(6000);
  await expect(page.locator('[data-testid^="queue-row-"]').first()).toBeVisible({ timeout: 300_000 });

  const candidate = page
    .locator('[data-testid^="queue-row-"]', { hasText: "Supporting Documents Received" })
    .filter({ hasNotText: liveNumber() })
    .first();
  await expect(candidate, "a seeded application sits in a staff-editable state with documents").toBeVisible({
    timeout: 180_000,
  });
  const applicationId = String(await candidate.getAttribute("data-testid")).replace("queue-row-", "");
  const applicationNumber = String((await candidate.innerText()).match(/MM-\d{4}-\d{6}/)?.[0]);
  expect(applicationNumber, "the queue row shows the application number").toMatch(/^MM-\d{4}-\d{6}$/);

  // The server's own answer to the apply-suggestion call is the audited correction record
  // (§B CorrectionInfo). It is captured here so the assertions can be made against what was
  // actually persisted, and so a refusal can be reported verbatim rather than as a missing
  // element somewhere downstream.
  interface ApplyCall {
    status: number;
    request: string | null;
    body: string;
  }
  const applyCalls: ApplyCall[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/ocr/apply-suggestion")) return;
    void response
      .text()
      .catch(() => "")
      .then((body) => {
        applyCalls.push({ status: response.status(), request: response.request().postData(), body });
      });
  });

  await openDetail(page, applicationId);
  await page.getByTestId("detail-tab-documents").click();

  const panel = page.locator('[data-testid^="ocr-panel-"]').first();
  await expect(panel, "a completed OCR extraction is presented for review").toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("ocr-provider-attribution").first()).toBeVisible();
  await expect(page.getByTestId("ocr-job-status").first()).toContainText(/OCR/i);
  await expect(page.locator('[data-testid^="ocr-confidence-"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="ocr-compare-"]').first()).toBeVisible();

  const applyControls = page.locator('[data-testid^="ocr-apply-"]');
  await expect(applyControls.first(), "at least one extracted value is offered as a suggestion").toBeVisible();
  const offered = await applyControls.count();

  // XBR-018 lets the app refuse an apply "when the state does not permit corrections", so a
  // refusal on one suggestion is a contracted outcome rather than a defect — the journey
  // moves to the next offered suggestion. What is *not* optional is that a suggestion the
  // app offers on a correctable file can be applied: if every one of them is refused, the
  // test fails with the server's own ErrorResponse attached.
  let applied: ApplyCall | undefined;
  let lastRefusal: ApplyCall | undefined;
  for (let index = 0; index < offered; index += 1) {
    const control = applyControls.nth(index);
    if ((await control.count()) === 0) continue;
    if (!(await control.isEnabled().catch(() => false))) continue;
    const before = applyCalls.length;
    await control.click();
    try {
      await expect
        .poll(() => applyCalls.length, { timeout: 120_000, intervals: [1000] })
        .toBeGreaterThan(before);
    } catch {
      continue;
    }
    const call = applyCalls[applyCalls.length - 1];
    if (call.status === 200) {
      applied = call;
      break;
    }
    lastRefusal = call;
    await page.waitForTimeout(4000);
  }

  expect(
    applied,
    `no offered OCR suggestion could be applied on a correctable file. ` +
      `Last refusal: ${lastRefusal?.status ?? "(no response)"} ${lastRefusal?.body ?? ""} ` +
      `(request ${lastRefusal?.request ?? "(none)"})`,
  ).toBeTruthy();

  // The 200 body is the audited correction itself (§B CorrectionInfo): it names the field
  // path it changed, carries the before/after values, records who made it, and cites the
  // document the value came from (XBR-018).
  const correction = JSON.parse(String(applied?.body)) as {
    id: string;
    applicationId: string;
    fieldPath: string;
    afterValue: string;
    correctedByName: string;
    correctedByRole: string;
    reason: string;
  };
  expect(correction.applicationId, "the correction is recorded against this application").toBe(applicationId);
  expect(correction.fieldPath, "the correction names the field path it changed").toBeTruthy();
  expect(correction.afterValue, "the correction records the value that was applied").toBeTruthy();
  expect(correction.correctedByRole, "the correction records who made it").toBe("CASEWORKER");
  expect(correction.reason, "the correction cites the source document it came from").toMatch(
    /\.(pdf|png|jpe?g|tiff?)\b/i,
  );

  // It survives a reload: the panel it came from is still there against the same file.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("detail-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
  await page.getByTestId("detail-tab-documents").click();
  await expect(page.locator('[data-testid^="ocr-panel-"]').first()).toBeVisible({ timeout: 300_000 });

  // …and it is in the audit log as a Correction naming this application and field, which is
  // the FLOW-007 success state. The audit viewer is a Supervisor screen, so it is read in a
  // Supervisor context rather than by the caseworker who made the correction.
  const leafField = correction.fieldPath.split(".").pop() ?? correction.fieldPath;
  const supervisorContext = await browser.newContext({ storageState: storagePath("supervisor") });
  try {
    const supervisorPage = await supervisorContext.newPage();
    await gotoAs(supervisorPage, "supervisor", "/supervisor/audit-log");
    await gotoUntilReady(supervisorPage, "/supervisor/audit-log", "audit-filter-actionType");
    await supervisorPage.locator('[data-testid^="audit-row-"]').first().waitFor({ timeout: 300_000 });
    await supervisorPage.waitForTimeout(3000);
    await supervisorPage.getByTestId("audit-filter-actionType").selectOption("correction");
    await supervisorPage.waitForTimeout(8000);

    await expect(
      supervisorPage
        .locator('[data-testid^="audit-row-"]', { hasText: applicationNumber })
        .filter({ hasText: new RegExp(leafField) })
        .first(),
      `the applied suggestion is audited as a correction to ${leafField} on ${applicationNumber}`,
    ).toBeVisible({ timeout: 300_000 });
  } finally {
    await supervisorContext.close();
  }
});
