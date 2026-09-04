/**
 * FLOW-001 — Anonymous pre-qualification, loan comparison, and the pre-fill hand-off.
 * §7.7 "Public — calculator, comparison, pre-fill flow".
 */
import { expect, test } from "@playwright/test";
import {
  SUITE_PASSWORD,
  gotoUntilReady,
  safeGoto,
  requireState,
  signInHere,
  storagePath,
  writeState,
} from "./support/journey";

test.describe("public tools (anonymous)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("pre-qualification calculator recalculates live and states a qualification verdict", async ({ page }) => {
    await safeGoto(page, "/pre-qualify");

    // Outputs start empty — nothing is computed until the visitor supplies inputs.
    await expect(page.getByTestId("prequal-output-maxLoanAmount")).toHaveText("—");

    await page.getByTestId("prequal-input-grossMonthlyIncome").fill("10000");
    await page.getByTestId("prequal-input-monthlyDebtPayments").fill("800");
    await page.getByTestId("prequal-input-creditTier").selectOption("excellent");
    await page.getByTestId("prequal-input-downPaymentAmount").fill("100000");
    await page.getByTestId("prequal-input-termYears").selectOption("30");

    await expect(page.getByTestId("prequal-output-maxLoanAmount")).not.toHaveText("—");
    await expect(page.getByTestId("prequal-output-estimatedRate")).not.toHaveText("—");
    await expect(page.getByTestId("prequal-output-estimatedMonthlyPiti")).not.toHaveText("—");
    await expect(page.getByTestId("prequal-output-maxPurchasePrice")).not.toHaveText("—");
    await expect(page.getByTestId("prequal-qualify-indicator")).toBeVisible();

    // Changing one input recalculates without a submit action (REQ-043).
    const before = await page.getByTestId("prequal-output-maxLoanAmount").innerText();
    await page.getByTestId("prequal-input-grossMonthlyIncome").fill("4000");
    await expect(page.getByTestId("prequal-output-maxLoanAmount")).not.toHaveText(before);
  });

  test("comparison tool prices three scenarios, applies presets, and highlights the best value", async ({ page }) => {
    await safeGoto(page, "/compare");

    for (const n of [1, 2, 3]) {
      await expect(page.getByTestId(`compare-scenario-${n}`)).toBeVisible();
    }

    await page.getByTestId("compare-preset-15-vs-30-year").click();

    for (const n of [1, 2, 3]) {
      await expect(page.getByTestId(`compare-result-${n}-monthlyPrincipalInterest`)).not.toHaveText("—");
      await expect(page.getByTestId(`compare-result-${n}-monthlyPiti`)).not.toHaveText("—");
      await expect(page.getByTestId(`compare-result-${n}-totalInterest`)).not.toHaveText("—");
      await expect(page.getByTestId(`compare-result-${n}-ltv`)).not.toHaveText("—");
      await expect(page.getByTestId(`compare-result-${n}-totalCost`)).not.toHaveText("—");
    }

    // Exactly one scenario carries the best-value marker.
    await expect(page.getByTestId("compare-best-value")).toHaveCount(1);

    // A different preset repopulates the grid and recomputes.
    const firstTotal = await page.getByTestId("compare-result-1-totalCost").innerText();
    await page.getByTestId("compare-preset-5-vs-20-down").click();
    await expect(page.getByTestId("compare-result-1-totalCost")).not.toHaveText(firstTotal);
    await expect(page.getByTestId("compare-best-value")).toHaveCount(1);
  });

  test("an anonymous visitor is sent to sign in before any application is created", async ({ page }) => {
    await safeGoto(page, "/pre-qualify");
    await page.getByTestId("prequal-input-grossMonthlyIncome").fill("9000");
    await page.getByTestId("prequal-input-monthlyDebtPayments").fill("400");
    await page.getByTestId("prequal-input-downPaymentAmount").fill("120000");
    await expect(page.getByTestId("prequal-output-maxLoanAmount")).not.toHaveText("—");

    await page.getByTestId("start-application-btn").click();
    await page.waitForURL(/\/sign-in|\/sign-up/, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await expect(page.getByTestId("signin-email").or(page.getByTestId("signup-email"))).toBeVisible();
  });
});

test.describe("pre-fill hand-off into a new draft", () => {
  // FLOW-001 runs anonymously: the visitor prices a loan, chooses to apply, then
  // signs in, and only then does a Draft come into existence.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("calculator inputs pre-fill Steps 3, 5 and 7 of a brand-new draft", async ({ page }) => {
    await safeGoto(page, "/pre-qualify");

    await page.getByTestId("prequal-input-grossMonthlyIncome").fill("11500");
    await page.getByTestId("prequal-input-monthlyDebtPayments").fill("650");
    await page.getByTestId("prequal-input-creditTier").selectOption("excellent");
    await page.getByTestId("prequal-input-downPaymentAmount").fill("150000");
    await page.getByTestId("prequal-input-termYears").selectOption("30");
    await expect(page.getByTestId("prequal-output-maxLoanAmount")).not.toHaveText("—");

    await page.getByTestId("start-application-btn").click();

    // The hand-off routes an anonymous visitor through authentication first.
    await page.waitForURL(/\/sign-in/, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await signInHere(
      page,
      requireState("borrowerEmail"),
      SUITE_PASSWORD,
      requireState("borrowerTotpSecret"),
    );
    await page.waitForURL(/\/applications\/[0-9a-f-]{36}/, { waitUntil: "domcontentloaded", timeout: 300_000 });

    const applicationId = new URL(page.url()).pathname.split("/")[2];
    expect(applicationId).toMatch(/^[0-9a-f-]{36}$/);
    writeState({ handoffApplicationId: applicationId });

    // Step 3 — income carried across from the calculator.
    await gotoUntilReady(page, `/applications/${applicationId}?step=3`, "wizard-step-3");
    await expect(page.getByTestId("field-employments-0-baseMonthlyIncome")).toHaveValue(/\d/);

    // Step 5 — a single itemizable other-liability standing in for the stated monthly debt.
    await gotoUntilReady(page, `/applications/${applicationId}?step=5`, "wizard-step-5");
    await expect(page.getByTestId("field-otherLiabilities-0-monthlyPayment")).toHaveValue(/\d/);

    // Step 7 — loan values.
    await gotoUntilReady(page, `/applications/${applicationId}?step=7`, "wizard-step-7");
    await expect(page.getByTestId("field-downPaymentAmount")).toHaveValue(/\d/);
    await expect(page.getByTestId("field-loanTermMonths")).toHaveValue("360");
  });

});

test.describe("tampered hand-off token", () => {
  test.use({ storageState: storagePath("fresh-borrower") });

  test("yields a plain draft entry point rather than an error", async ({ page }) => {
    await safeGoto(page, "/applications/new?handoff=not-a-real-token");
    await expect(page.getByTestId("new-app-mode-blank")).toBeVisible();
    await expect(page.getByTestId("create-application-btn")).toBeEnabled();
  });
});
