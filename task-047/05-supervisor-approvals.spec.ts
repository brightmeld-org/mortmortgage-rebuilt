/**
 * FLOW-008 — Supervisor Level-1 decision, escalation, the different-approver rule, and
 * denial with HMDA reasons.
 *
 * §7.7 supervisor items: Level-1 and Level-2 approval by different supervisors, denial.
 */
import { expect, test, type Page } from "@playwright/test";
import { gotoAs, gotoUntilReady, storagePath } from "./support/journey";

test.describe.configure({ mode: "serial" });
test.use({ storageState: storagePath("supervisor") });

async function openSupervisorList(page: Page): Promise<void> {
  // The list container renders before its rows arrive, and a rate-limited fetch leaves it
  // empty; reload rather than assert against a list that was never populated.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await gotoAs(page, "supervisor", "/supervisor");
    await gotoUntilReady(page, "/supervisor", "supervisor-applications");
    try {
      await page.locator('[data-testid^="sup-row-"]').first().waitFor({ timeout: 120_000 });
      await page.waitForTimeout(3000);
      return;
    } catch {
      await page.waitForTimeout(15_000);
    }
  }
  await expect(
    page.locator('[data-testid^="sup-row-"]').first(),
    "the all-applications list returns rows",
  ).toBeVisible({ timeout: 300_000 });
}

async function openDetail(page: Page, applicationId: string): Promise<void> {
  await gotoAs(page, "supervisor", `/staff/applications/${applicationId}`);
  await gotoUntilReady(page, `/staff/applications/${applicationId}`, "staff-application-detail");
  await page.getByTestId("detail-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
  await expect(
    page.getByTestId("approval-panel"),
    `application ${applicationId} presents an approval panel for this supervisor`,
  ).toBeVisible({ timeout: 300_000 });
  // Let the client bundle finish wiring before the first interaction.
  await page.waitForTimeout(3000);
}

/**
 * Tries to carry a Level-2 approval all the way through on the application on screen and
 * reports what the application did with the attempt.
 *
 * INV-001 puts two obligations on this screen: the UI states *why* the current user is
 * ineligible, and the Level-2 decision cannot be completed by them — the authority for the
 * rule is the server-side approval gate. *How* the screen withholds the decision is not
 * contracted, and all three shapes are conformant: the control is absent, the control is
 * present but not actionable, or the submission is made and the gate refuses it. So the
 * outcome is what gets asserted, not the widget.
 */
type DecisionAttempt = "unavailable" | "refused" | "completed";

async function attemptLevel2Approval(page: Page, notes: string): Promise<DecisionAttempt> {
  const approve = page.getByTestId("approval-approve-btn");
  if ((await approve.count()) === 0) return "unavailable";
  if (await approve.first().isDisabled()) return "unavailable";

  await approve.first().click();
  const notesField = page.getByTestId("approval-notes");
  await notesField.waitFor({ timeout: 60_000 }).catch(() => {});
  if ((await notesField.count()) === 0) return "unavailable";
  await notesField.fill(notes);

  const submit = page.getByTestId("approval-submit-btn");
  if ((await submit.count()) === 0) return "unavailable";
  if (await submit.isDisabled()) return "unavailable";
  await submit.click();

  // Either the file moves on — which would mean the decision was completed — or the gate
  // refuses it. A refusal is surfaced verbatim (NFR-025) rather than silently swallowed.
  const badge = page.getByTestId("detail-state-badge");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (/Approved|Borrower Notified/i.test(await badge.innerText())) return "completed";
    await page.waitForTimeout(3000);
  }
  return "refused";
}

async function recordApproval(page: Page, notes: string): Promise<void> {
  await page.getByTestId("approval-approve-btn").click();
  await page.getByTestId("approval-notes").waitFor({ timeout: 120_000 });
  await page.getByTestId("approval-notes").fill(notes);
  await expect(page.getByTestId("approval-submit-btn")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("approval-submit-btn").click();
  // The panel closes its form once the decision is recorded.
  await page.getByTestId("approval-submit-btn").waitFor({ state: "detached", timeout: 300_000 }).catch(() => {});
}

test("a Level-1 approval on an escalating file routes to Escalated Review", async ({ page }) => {
  await openSupervisorList(page);

  // Government-backed loan types require two-level approval per the §4.6.11 default.
  await page.getByTestId("sup-filter-loanType").selectOption("fha");
  await page.getByTestId("sup-filter-pendingApprovalLevel").selectOption("1");
  // The filters auto-apply and refetch; reading a row before the refetch lands would pick
  // one from the unfiltered list.
  await page.waitForTimeout(12_000);

  const row = page.locator('[data-testid^="sup-row-"]', { hasText: /Preliminary Decision/ }).first();
  await expect(row, "a seeded FHA file awaits Level-1").toBeVisible({ timeout: 300_000 });
  const applicationId = String(await row.getAttribute("data-testid")).replace("sup-row-", "");

  await openDetail(page, applicationId);
  await expect(page.getByTestId("approval-escalation")).toContainText("Escalation required: Yes");
  await recordApproval(page, "Level-1 approval recorded; escalating for second-level review.");

  await expect(page.getByTestId("detail-state-badge")).toHaveText(/Escalated Review/, { timeout: 300_000 });
});

test("the supervisor who recorded Level-1 is refused Level-2 with a stated reason", async ({ page }) => {
  await openSupervisorList(page);

  // "Needs my Level-2" is the eligibility filter: it lists the files this supervisor may
  // still decide, which by WF-024 excludes every file they themselves decided at Level 1.
  await page.getByTestId("sup-filter-needsMyLevel2").click();
  await page.waitForTimeout(12_000);

  const row = page.locator('[data-testid^="sup-row-"]').first();
  await expect(row, "the needs-my-Level-2 filter surfaces escalated files").toBeVisible({ timeout: 300_000 });
  await expect(
    page.locator('[data-testid^="sup-row-"]', { hasText: /you recorded Level-1/i }),
    "the eligibility filter withholds the files this supervisor decided at Level-1",
  ).toHaveCount(0);

  // The refusal itself is proved on one of those withheld files, so reopen the list
  // unfiltered, widen to every file pending a Level-2 decision, and take the one carrying
  // this supervisor's own Level-1.
  await openSupervisorList(page);
  await page.getByTestId("sup-filter-pendingApprovalLevel").selectOption("2");
  await page.waitForTimeout(12_000);

  const ownRow = page
    .locator('[data-testid^="sup-row-"]', { hasText: /you recorded Level-1/i })
    .first();
  await expect(ownRow, "one escalated file carries this supervisor's own Level-1 record").toBeVisible({
    timeout: 300_000,
  });
  const applicationId = String(await ownRow.getAttribute("data-testid")).replace("sup-row-", "");

  await openDetail(page, applicationId);

  // Obligation one: the screen says why this supervisor may not decide.
  const reason = page.getByTestId("approval-ineligible-reason");
  await expect(reason, "the panel states why the current user is ineligible").toBeVisible();
  await expect(reason).toContainText(/Level-1/i);
  await expect(reason).toContainText(/different Supervisor/i);
  // The Level-1 record it is talking about is on screen.
  await expect(page.locator('[data-testid^="approval-prior-"]').first()).toBeVisible();

  // Obligation two: the Level-2 decision cannot be completed by this supervisor.
  const outcome = await attemptLevel2Approval(
    page,
    "Attempting a second-level decision on a file this supervisor already decided.",
  );
  expect(
    outcome,
    "the supervisor who recorded Level-1 cannot complete the Level-2 decision (INV-001)",
  ).not.toBe("completed");

  // …and nothing was written: the file is still awaiting a Level-2 decision after a reload,
  // with no second approval record against it.
  await openDetail(page, applicationId);
  await expect(page.getByTestId("detail-state-badge")).toHaveText(/Escalated Review/, { timeout: 300_000 });
  await expect(
    page.locator('[data-testid^="approval-prior-"]', { hasText: /Level 2/i }),
    "no Level-2 approval record was written by the Level-1 approver",
  ).toHaveCount(0);
  await expect(page.getByTestId("approval-ineligible-reason")).toBeVisible();
});

test("a different supervisor records Level-2 and the file reaches Approved", async ({ page }) => {
  test.setTimeout(900_000);
  await openSupervisorList(page);
  await page.getByTestId("sup-filter-pendingApprovalLevel").selectOption("2");
  await page.waitForTimeout(12_000);

  const eligible = page
    .locator('[data-testid^="sup-row-"]', { hasText: /Escalated Review/ })
    .filter({ hasNotText: /you recorded Level-1/i })
    .first();
  await expect(eligible, "a file whose Level-1 was recorded by another supervisor awaits Level-2").toBeVisible({
    timeout: 300_000,
  });
  const applicationId = String(await eligible.getAttribute("data-testid")).replace("sup-row-", "");

  await openDetail(page, applicationId);
  await expect(page.getByTestId("approval-level")).toContainText("Level 2");
  await expect(page.locator('[data-testid^="approval-prior-"]').first()).toBeVisible();

  await recordApproval(page, "Level-2 concurrence. Two distinct supervisors have now approved.");

  await expect(page.getByTestId("detail-state-badge")).toHaveText(/Approved|Borrower Notified/, {
    timeout: 300_000,
  });
});

test("a denial records the selected HMDA reasons and reaches Denied", async ({ page }) => {
  test.setTimeout(900_000);
  await openSupervisorList(page);
  await page.getByTestId("sup-filter-pendingApprovalLevel").selectOption("1");
  await page.waitForTimeout(12_000);

  const row = page.locator('[data-testid^="sup-row-"]', { hasText: /Preliminary Decision/ }).first();
  await expect(row, "a seeded file awaits a Level-1 decision").toBeVisible({ timeout: 300_000 });
  const applicationId = String(await row.getAttribute("data-testid")).replace("sup-row-", "");

  await openDetail(page, applicationId);
  await page.getByTestId("approval-deny-btn").click();

  await page.getByTestId("denial-reason-dti").check();
  await page.getByTestId("denial-reason-credit-history").check();
  await page.getByTestId("approval-notes").fill("Debt load and credit history do not support the request.");
  await expect(page.getByTestId("approval-submit-btn")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("approval-submit-btn").click();

  await expect(page.getByTestId("detail-state-badge")).toHaveText(/Denied|Borrower Notified/, {
    timeout: 300_000,
  });
});
