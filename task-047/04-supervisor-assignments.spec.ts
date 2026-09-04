/**
 * FLOW-009 — Supervisor assignment operations.
 * §7.7 supervisor items: assign / bulk / auto / reassign, plus priority override and
 * suspend-resume on the same list surface.
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

/** Reads the application id out of the first row that offers `prefix`-{id}. */
async function firstIdWithControl(page: Page, prefix: string): Promise<string> {
  const control = page.locator(`[data-testid^="${prefix}-"]`).first();
  await expect(control, `at least one row offers ${prefix}`).toBeVisible({ timeout: 180_000 });
  return String(await control.getAttribute("data-testid")).replace(`${prefix}-`, "");
}

async function filterToUnassigned(page: Page): Promise<void> {
  await page.getByTestId("sup-filter-caseworkerId").selectOption("unassigned");
  await expect(page.locator('[data-testid^="sup-row-"]').first()).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(4000);
}

/**
 * Waits for a dialog to close, which is how the app reports the write completed —
 * reissuing the confirmation if the first press was dropped before hydration.
 */
async function waitForDialogToClose(page: Page, confirmTestId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.getByTestId(confirmTestId).waitFor({ state: "detached", timeout: 90_000 });
      return;
    } catch {
      if ((await page.getByTestId(confirmTestId).count()) === 0) return;
      await page.getByTestId(confirmTestId).click().catch(() => {});
    }
  }
  await expect(
    page.getByTestId(confirmTestId),
    "the dialog closes once the server has accepted the action",
  ).toHaveCount(0, { timeout: 300_000 });
}

/** Application number out of a row, for looking the same file up again after a filter change. */
async function applicationNumberOf(page: Page, applicationId: string): Promise<string> {
  const text = await page.getByTestId(`sup-row-${applicationId}`).innerText();
  const match = text.match(/MM-\d{4}-\d{6}/);
  expect(match, `row ${applicationId} shows its application number`).toBeTruthy();
  return String(match?.[0]);
}

/** Clears the caseworker filter and finds one application by number. */
async function findByNumber(page: Page, applicationNumber: string): Promise<void> {
  await openSupervisorList(page);
  await page.getByTestId("sup-search").fill(applicationNumber);
  await page.waitForTimeout(9000);
}

test("manually assigns one application with a reason", async ({ page }) => {
  await openSupervisorList(page);
  await filterToUnassigned(page);

  const applicationId = await firstIdWithControl(page, "assign-btn");
  const applicationNumber = await applicationNumberOf(page, applicationId);

  await page.getByTestId(`assign-btn-${applicationId}`).click();
  await expect(page.getByTestId("assign-caseworker-select")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByTestId("assign-caseworker-select").selectOption({ index: 1 });
  await page.getByTestId("assign-reason").fill("Manual assignment — capacity available on this desk.");
  await expect(page.getByTestId("assign-confirm-btn")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("assign-confirm-btn").click();
  // Navigating before the write lands would abort it, so wait for the dialog to close.
  await waitForDialogToClose(page, "assign-confirm-btn");

  // Looked up again without the unassigned filter, the file now offers reassignment
  // rather than assignment — it has an active owner.
  await findByNumber(page, applicationNumber);
  await expect(page.getByTestId(`reassign-btn-${applicationId}`)).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId(`assign-btn-${applicationId}`)).toHaveCount(0);
});

test("bulk-assigns several applications in one confirmation", async ({ page }) => {
  await openSupervisorList(page);
  await filterToUnassigned(page);

  const checkboxes = page.locator('[data-testid^="bulk-select-"]:not([data-testid="bulk-select-all"])');
  await expect(checkboxes.first()).toBeVisible({ timeout: 180_000 });
  const available = await checkboxes.count();
  const picks = Math.min(3, available);
  expect(picks, "the seeded dataset leaves unassigned applications to bulk-assign").toBeGreaterThan(0);

  const chosen: Array<{ id: string; number: string }> = [];
  for (let index = 0; index < picks; index += 1) {
    const box = checkboxes.nth(index);
    const id = String(await box.getAttribute("data-testid")).replace("bulk-select-", "");
    chosen.push({ id, number: await applicationNumberOf(page, id) });
    await box.check();
  }

  // The action reports how many rows it will act on; if a background refetch cleared the
  // selection, this is where it shows up rather than in a silent no-op assignment.
  await expect(page.getByTestId("bulk-assign-btn")).toContainText(`${picks} selected`, {
    timeout: 120_000,
  });

  await page.getByTestId("bulk-assign-btn").click();
  await expect(page.getByTestId("assign-caseworker-select")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByTestId("assign-caseworker-select").selectOption({ index: 1 });
  await page.getByTestId("assign-reason").fill("Bulk assignment — rebalancing the intake backlog.");
  await expect(page.getByTestId("bulk-confirm-btn")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("bulk-confirm-btn").click();
  await waitForDialogToClose(page, "bulk-confirm-btn");

  // Each selected file now has an owner; looked up by number they offer reassignment.
  for (const { id, number } of chosen) {
    await findByNumber(page, number);
    await expect(page.getByTestId(`reassign-btn-${id}`), `${number} was bulk-assigned`).toBeVisible({
      timeout: 300_000,
    });
  }
});

test("auto-assigns the remaining unassigned set", async ({ page }) => {
  test.setTimeout(900_000);
  await openSupervisorList(page);
  await filterToUnassigned(page);

  const before = await page.locator('[data-testid^="assign-btn-"]').count();
  expect(before, "there is unassigned work for auto-assign to place").toBeGreaterThan(0);

  await page.getByTestId("auto-assign-btn").click();

  // Auto-assign places the unassigned set; re-reading the filtered list shows fewer
  // applications still offering an Assign action.
  await expect
    .poll(
      async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByTestId("supervisor-applications").waitFor({ timeout: 300_000 });
        await page.getByTestId("sup-filter-caseworkerId").selectOption("unassigned");
        await page.waitForTimeout(5000);
        return page.locator('[data-testid^="assign-btn-"]').count();
      },
      { timeout: 600_000, intervals: [15_000] },
    )
    .toBeLessThan(before);
});

test("reassigns an application with a required reason", async ({ page }) => {
  await openSupervisorList(page);

  const applicationId = await firstIdWithControl(page, "reassign-btn");
  await page.getByTestId(`reassign-btn-${applicationId}`).click();

  await expect(page.getByTestId("assign-caseworker-select")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByTestId("assign-caseworker-select").selectOption({ index: 2 });
  await page.getByTestId("assign-reason").fill("Reassigned — original owner is on planned leave.");
  await expect(page.getByTestId("assign-confirm-btn")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("assign-confirm-btn").click();
  await waitForDialogToClose(page, "assign-confirm-btn");

  await expect(page.getByTestId(`reassign-btn-${applicationId}`)).toBeVisible({ timeout: 300_000 });
});

test("overrides an application's priority", async ({ page }) => {
  await openSupervisorList(page);

  const applicationId = await firstIdWithControl(page, "priority-select");
  const badge = page.getByTestId(`sup-priority-badge-${applicationId}`);
  const before = await badge.innerText();
  const target = before.trim().toLowerCase() === "urgent" ? "low" : "urgent";

  await page.getByTestId(`priority-select-${applicationId}`).selectOption(target);
  await expect(badge).toHaveText(new RegExp(target, "i"), { timeout: 300_000 });
});

test("suspends an application with a reason and resumes it to the same state", async ({ page }) => {
  await openSupervisorList(page);

  const applicationId = await firstIdWithControl(page, "suspend-btn");
  const stateBefore = await page.getByTestId(`sup-row-${applicationId}`).innerText();

  await page.getByTestId(`suspend-btn-${applicationId}`).click();
  await expect(page.getByTestId("suspend-reason")).toBeVisible();
  await page.getByTestId("suspend-reason").fill("Awaiting an updated appraisal from the vendor.");
  await expect(page.getByTestId("suspend-confirm-btn")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("suspend-confirm-btn").click();
  await waitForDialogToClose(page, "suspend-confirm-btn");

  await expect(page.getByTestId(`resume-btn-${applicationId}`)).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId(`sup-row-${applicationId}`)).toContainText("Suspended");

  await page.getByTestId(`resume-btn-${applicationId}`).click();
  await expect(page.getByTestId(`suspend-btn-${applicationId}`)).toBeVisible({ timeout: 300_000 });

  // Resume returns to exactly the pre-suspension state (T38).
  const priorState = stateBefore.match(
    /(Draft|Application Received|Completeness[^\n]*Validated|Supporting Documents Received|AUS Executed|Preliminary Decision|Escalated Review|Conditional Approval)/,
  )?.[0];
  expect(priorState, "the row exposed a human-readable pre-suspension state").toBeTruthy();
  await expect(page.getByTestId(`sup-row-${applicationId}`)).toContainText(String(priorState));
});
