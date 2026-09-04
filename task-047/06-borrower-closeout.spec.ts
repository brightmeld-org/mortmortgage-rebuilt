/**
 * FLOW-004 and FLOW-005 — the borrower side of the back half of the lifecycle.
 * §7.7 borrower items: receive a revision request, resubmit, withdraw / decline.
 *
 * The revision and withdraw journeys run against the seeded Demo Borrower positions
 * (§4.6.12 staging); the decline runs against the live application this suite drove
 * all the way to an approved outcome.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  expectAutoSaved,
  gotoAs,
  gotoAsFreshBorrower,
  clickUntilVisible,
  gotoUntilReady,
  requireState,
  storagePath,
} from "./support/journey";

test.describe.configure({ mode: "serial" });

/** Reads the application id out of a dashboard row matching `state`. */
async function dashboardRowIn(page: Page, state: RegExp): Promise<string> {
  const row = page.locator('[data-testid^="application-row-"]', { hasText: state }).first();
  await expect(row, `the dashboard lists an application in ${state}`).toBeVisible({ timeout: 300_000 });
  // Rows are server-rendered; wait for hydration before acting on their controls.
  await page.waitForTimeout(4000);
  return String(await row.getAttribute("data-testid")).replace("application-row-", "");
}

/** Re-signs both borrower panels and ticks the attestation. */
async function signAllBorrowers(page: Page): Promise<void> {
  // The certification statement gates the ceremony — acknowledge it before signing.
  await page.getByTestId("attestation-checkbox").check();

  const panels = page.locator('[data-testid^="signature-panel-"]');
  const count = await panels.count();
  expect(count, "every borrower on the application has a signature panel").toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const panel = panels.nth(index);
    // Each panel is headed with the borrower it belongs to; a typed signature has to
    // carry that borrower's own name.
    const signerName = (await panel.innerText()).split("(")[0].trim().split("\n")[0].trim();
    expect(signerName.length, "the signature panel names its borrower").toBeGreaterThan(0);
    await panel.getByTestId("signature-mode-typed").click();
    await panel.getByTestId("signature-typed-input").fill(signerName);
    await panel.getByTestId("signature-save-btn").click();
    await page.waitForTimeout(1500);
  }

  // Saving a signature can reset the acknowledgement; make sure it is ticked at the end.
  const attestation = page.getByTestId("attestation-checkbox");
  if (!(await attestation.isChecked())) {
    await attestation.check();
  }
  await expect(attestation).toBeChecked();
}

test.describe("seeded revision request and resubmission", () => {
  test.use({ storageState: storagePath("borrower") });

  test("the dashboard shows the revision banner with the caseworker's formal note", async ({ page }) => {
    await gotoAs(page, "borrower", "/dashboard");
    await expect(page.getByTestId("revision-banner")).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId("revision-banner")).toContainText(/revision/i);
  });

  test("the borrower edits, re-signs and resubmits into Completeness Validated", async ({ page }) => {
    test.setTimeout(900_000);
    await gotoAs(page, "borrower", "/dashboard");
    const applicationId = await dashboardRowIn(page, /Revision Requested/);

    // The read-only view carries the formal note the loan team attached to the request.
    await gotoUntilReady(page, `/applications/${applicationId}/view`, "view-status-strip");
    await expect(page.getByTestId("revision-banner")).toBeVisible();
    await expect(page.getByTestId("formal-notes-list")).toBeVisible();

    // Every step is editable again during a revision.
    await gotoUntilReady(page, `/applications/${applicationId}?step=3`, "wizard-step-3");
    const income = page.getByTestId("field-employments-0-baseMonthlyIncome");
    const previous = Number((await income.inputValue()).replace(/[^0-9.]/g, "")) || 6000;
    await income.fill(String(previous + 250));
    await income.blur();

    // The staged file also carries the employment-history gap the wizard reports; dating
    // the current employment correctly is part of what the revision asks the borrower for.
    const startDate = page.getByTestId("field-employments-0-startDate");
    await startDate.fill("2016-02-01");
    await startDate.blur();
    await expectAutoSaved(page);

    await gotoUntilReady(page, `/applications/${applicationId}?step=10`, "wizard-step-10");

    // The wizard states its own blockers; none may remain before resubmission.
    const outstanding = page.getByTestId("review-outstanding-issues");
    if (await outstanding.isVisible().catch(() => false)) {
      throw new Error(`validation blocks resubmission: ${await outstanding.innerText()}`);
    }

    await signAllBorrowers(page);

    // Reissue the resubmission until the state moves; a click that lands before the
    // handler is wired is dropped silently, and a refusal is reported verbatim.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.getByTestId("submit-application-btn").click();
      await page.waitForTimeout(10_000);
      const banner = page.getByTestId("submit-error-banner");
      if (await banner.isVisible().catch(() => false)) {
        throw new Error(`resubmission was refused: ${await banner.innerText()}`);
      }
      await gotoUntilReady(page, `/applications/${applicationId}/view`, "view-status-strip");
      if (/Completeness/i.test(await page.getByTestId("view-state-badge").innerText())) break;
      await gotoUntilReady(page, `/applications/${applicationId}?step=10`, "wizard-step-10");
      await signAllBorrowers(page);
    }

    // T36: Completeness Validated with a new version and the revision cycle counted.
    await gotoUntilReady(page, `/applications/${applicationId}/view`, "view-status-strip");
    await expect(page.getByTestId("view-state-badge")).toHaveText(/Completeness/i, { timeout: 300_000 });
    await expect(page.getByTestId("version-row-2")).toBeVisible({ timeout: 300_000 });

    // The two versions diff field by field, grouped by URLA section.
    await page.getByTestId("version-select-1").check();
    await page.getByTestId("version-select-2").check();
    await page.getByTestId("version-compare-btn").click();
    await expect(page.getByTestId("diff-view")).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId("diff-view")).toContainText(/Employment/i);
  });

  test("the borrower withdraws a draft application", async ({ page }) => {
    test.setTimeout(900_000);
    await gotoAs(page, "borrower", "/dashboard");

    // Withdrawal is terminal, so a re-run needs its own draft to withdraw.
    if ((await page.locator('[data-testid^="application-row-"]', { hasText: /Draft/ }).count()) === 0) {
      await gotoUntilReady(page, "/applications/new", "create-application-btn");
      await page.waitForTimeout(4000);
      await page.getByTestId("new-app-mode-blank").check();
      await page.getByTestId("create-application-btn").click();
      await page.waitForURL(/\/applications\/[0-9a-f-]{36}/, { waitUntil: "domcontentloaded", timeout: 300_000 });
      await gotoAs(page, "borrower", "/dashboard");
    }

    const applicationId = await dashboardRowIn(page, /Draft/);

    const state = page.getByTestId(`application-state-${applicationId}`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if ((await state.innerText()).trim() === "Withdrawn") break;
      await clickUntilVisible(page, `action-withdraw-${applicationId}`, "withdraw-reason-input");
      await page.getByTestId("withdraw-reason-input").fill("Decided to wait for the next rate cycle.");
      await page.getByTestId("withdraw-confirm-btn").click();
      try {
        await expect(state).toHaveText("Withdrawn", { timeout: 90_000 });
        break;
      } catch {
        await page.waitForTimeout(3000);
      }
    }
    await expect(state, "the withdrawal reaches the terminal state").toHaveText("Withdrawn", {
      timeout: 300_000,
    });
    // A terminal state offers no further borrower action beyond viewing.
    await expect(page.getByTestId(`action-withdraw-${applicationId}`)).toHaveCount(0);
    await expect(page.getByTestId(`action-view-${applicationId}`)).toBeVisible();
  });
});

test.describe("declining an approved loan", () => {
  test.use({ storageState: storagePath("fresh-borrower") });

  test("the borrower declines the approved offer and reaches Declined by Borrower", async ({ page }) => {
    test.setTimeout(900_000);
    const applicationId = requireState("liveApplicationId");

    await gotoAsFreshBorrower(page, `/applications/${applicationId}/view`);
    await gotoUntilReady(page, `/applications/${applicationId}/view`, "view-status-strip");
    await expect(page.getByTestId("view-state-badge")).toHaveText(/Approved|Borrower Notified/, {
      timeout: 300_000,
    });

    const badge = page.getByTestId("view-state-badge");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (/Declined by Borrower/.test(await badge.innerText())) break;
      await clickUntilVisible(page, `action-decline-${applicationId}`, "decline-confirm-btn");
      await page.getByTestId("decline-confirm-btn").click();
      try {
        await expect(badge).toHaveText(/Declined by Borrower/, { timeout: 90_000 });
        break;
      } catch {
        await page.waitForTimeout(3000);
      }
    }
    await expect(badge, "declining an approved offer reaches the terminal state").toHaveText(
      /Declined by Borrower/,
      { timeout: 300_000 },
    );
  });
});
