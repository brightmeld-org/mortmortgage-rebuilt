/**
 * FLOW-003 — Borrower completes the 10-step URLA wizard with a co-borrower and submits.
 *
 * Runs against the draft the public pre-fill hand-off created in 01, so the journey
 * is continuous: calculator → hand-off → wizard → documents → signatures → submit.
 * §7.7 borrower items covered here: all 10 steps with co-borrower, upload and replace
 * a document, link a bank account, sign, submit.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectAutoSaved,
  gotoUntilReady,
  gotoAsFreshBorrower,
  pdfBuffer,
  pickAddressSuggestion,
  readState,
  requireState,
  runTag,
  storagePath,
  uniqueSsn,
  writeState,
} from "./support/journey";

test.describe.configure({ mode: "serial" });
test.use({ storageState: storagePath("fresh-borrower") });

const applicationId = () => requireState("handoffApplicationId");

const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function openStep(page: Page, step: number): Promise<void> {
  const url = `/applications/${applicationId()}?step=${step}`;
  await gotoAsFreshBorrower(page, url);
  await gotoUntilReady(page, url, `wizard-step-${step}`);
}

/** Fills a field only when the form actually renders it (some are conditional). */
async function fillIfPresent(page: Page, testId: string, value: string): Promise<void> {
  if ((await page.getByTestId(testId).count()) > 0) {
    await fill(page, testId, value);
  }
}

async function fill(scope: Page | Locator, testId: string, value: string): Promise<void> {
  const field = scope.getByTestId(testId);
  await field.fill(value);
  await field.blur();
}

async function choose(scope: Page | Locator, testId: string, value: string): Promise<void> {
  await scope.getByTestId(testId).selectOption(value);
}

async function answer(scope: Page | Locator, testId: string, value: "yes" | "no"): Promise<void> {
  await scope.getByTestId(`${testId}-${value}`).click();
}

/** Steps 1, 2, 3, 8 and 9 exist per borrower; the tab picks whose data is on screen. */
async function selectBorrower(page: Page, ordinal: 1 | 2): Promise<void> {
  await page.getByTestId(`borrower-tab-${ordinal}`).click();
  await expect(page.getByTestId(`borrower-tab-${ordinal}`)).toHaveAttribute("aria-selected", "true");
}

async function fillIdentity(
  page: Page,
  data: { first: string; last: string; ssn: string; dob: string; email: string; creditType: string },
): Promise<void> {
  await fill(page, "field-firstName", data.first);
  await fill(page, "field-lastName", data.last);
  await fill(page, "field-ssn", data.ssn);
  await fill(page, "field-dateOfBirth", data.dob);
  await choose(page, "field-citizenship", "us-citizen");
  await choose(page, "field-maritalStatus", "married");
  await fill(page, "field-dependentsCount", "0");
  await fill(page, "field-cellPhone", "5555550188");
  await fill(page, "field-email", data.email);
  await choose(page, "field-creditType", data.creditType);
  await answer(page, "field-militaryService-served", "no");
}

async function fillAddressHistory(page: Page): Promise<string> {
  const picked = await pickAddressSuggestion(page, "field-currentAddress-street", "123 Ma");
  await choose(page, "field-housingStatus", "rent");
  await fill(page, "field-yearsAtAddress", "6");
  await fill(page, "field-monthsAtAddress", "0");
  await fillIfPresent(page, "field-monthlyRent", "2200");
  return picked;
}

/** Repeatable sections start empty on a blank borrower; add the first row when needed. */
async function ensureRow(page: Page, addTestId: string, probeTestId: string): Promise<void> {
  if ((await page.getByTestId(probeTestId).count()) === 0) {
    await page.getByTestId(addTestId).click();
    await expect(page.getByTestId(probeTestId)).toBeVisible({ timeout: 120_000 });
  }
}

async function fillEmployment(page: Page, employer: string, income: string): Promise<void> {
  await choose(page, "field-employmentType", "employed");
  await ensureRow(page, "employments-add", "field-employments-0-employerName");
  await fill(page, "field-employments-0-employerName", employer);
  await fill(page, "field-employments-0-employerPhone", "5555550100");
  await fill(page, "field-employments-0-position", "Operations Lead");
  await fill(page, "field-employments-0-startDate", "2016-02-01");
  await fill(page, "field-employments-0-yearsInLineOfWork", "9");
  await fill(page, "field-employments-0-employerAddress-street", "400 Commerce Way");
  await fill(page, "field-employments-0-employerAddress-city", "Raleigh");
  await fill(page, "field-employments-0-employerAddress-state", "NC");
  await fill(page, "field-employments-0-employerAddress-zip", "27601");
  await fill(page, "field-employments-0-baseMonthlyIncome", income);
  await fill(page, "field-employments-0-overtime", "0");
  await fill(page, "field-employments-0-bonus", "0");
  await fill(page, "field-employments-0-commission", "0");
  await fill(page, "field-employments-0-otherMonthlyIncome", "0");
}

const DECLARATION_ANSWERS: Array<[string, "yes" | "no"]> = [
  ["field-aOccupyPrimary", "yes"],
  ["field-a1PriorOwnership", "no"],
  ["field-bSellerRelationship", "no"],
  ["field-cUndisclosedBorrowing", "no"],
  ["field-d1OtherMortgageApplication", "no"],
  ["field-d2NewCreditApplication", "no"],
  ["field-ePriorityLien", "no"],
  ["field-fCosignerUndisclosed", "no"],
  ["field-gOutstandingJudgments", "no"],
  ["field-hFederalDebtDelinquent", "no"],
  ["field-iPartyToLawsuit", "no"],
  ["field-jConveyedTitleInLieu", "no"],
  ["field-kPreForeclosureSale", "no"],
  ["field-lForeclosed", "no"],
  ["field-mBankruptcy", "no"],
];

async function fillDeclarations(page: Page): Promise<void> {
  for (const [testId, value] of DECLARATION_ANSWERS) {
    await answer(page, testId, value);
  }
}

async function fillDemographics(page: Page): Promise<void> {
  await page.getByTestId("field-ethnicity-not-hispanic-or-latino").check();
  await page.getByTestId("field-race-white").check();
  await page.getByTestId("field-sex-not-provided").check();
}

/** Draws a stroke on the signature canvas of one borrower's panel. */
async function drawSignature(page: Page, panel: Locator): Promise<void> {
  const canvas = panel.getByTestId("signature-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box, "signature canvas is rendered and measurable").toBeTruthy();
  const { x, y, width, height } = box!;

  await page.mouse.move(x + width * 0.15, y + height * 0.65);
  await page.mouse.down();
  for (const [fx, fy] of [
    [0.25, 0.35],
    [0.35, 0.7],
    [0.45, 0.3],
    [0.55, 0.7],
    [0.65, 0.35],
    [0.78, 0.6],
  ] as const) {
    await page.mouse.move(x + width * fx, y + height * fy, { steps: 8 });
    await page.waitForTimeout(80);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

test("step 1 — identity for the primary borrower and a co-borrower", async ({ page }) => {
  await openStep(page, 1);

  await fillIdentity(page, {
    first: "Journey",
    last: "Borrower",
    ssn: uniqueSsn(`${runTag()}-b1`),
    dob: "1985-04-12",
    email: requireState("borrowerEmail"),
    creditType: "joint",
  });
  await expectAutoSaved(page);

  // Add the co-borrower and fill its own Step 1 tab (§4.2.4 / REQ-034). The toggle is
  // replaced by a remove control once a co-borrower exists, so a re-run of this journey
  // against an already-extended draft still ends in the same asserted state.
  if ((await page.getByTestId("coborrower-add-toggle").count()) > 0) {
    await page.getByTestId("coborrower-add-toggle").click();
  }
  await expect(page.getByTestId("borrower-tab-2")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("coborrower-remove-btn")).toBeVisible();

  await selectBorrower(page, 2);
  await fillIdentity(page, {
    first: "Avery",
    last: "Coborrower",
    ssn: uniqueSsn(`${runTag()}-b2`),
    dob: "1987-09-30",
    email: `${runTag()}-co@e2e.example`,
    creditType: "joint",
  });
  await expectAutoSaved(page);
});

test("step 2 — address history uses autocomplete for both borrowers", async ({ page }) => {
  await openStep(page, 2);

  await selectBorrower(page, 1);
  const primaryPick = await fillAddressHistory(page);
  // Selecting a suggestion fills every address part, not just the street line.
  await expect(page.getByTestId("field-currentAddress-city")).not.toHaveValue("");
  await expect(page.getByTestId("field-currentAddress-state")).not.toHaveValue("");
  await expect(page.getByTestId("field-currentAddress-zip")).not.toHaveValue("");
  expect(primaryPick.length).toBeGreaterThan(5);
  await expectAutoSaved(page);

  await selectBorrower(page, 2);
  await fillAddressHistory(page);
  await expectAutoSaved(page);
});

test("step 3 — employment and income, including the simulated bank link", async ({ page }) => {
  await openStep(page, 3);

  await selectBorrower(page, 1);
  await fillEmployment(page, "Northwind Logistics", "11500");
  await expectAutoSaved(page);

  await selectBorrower(page, 2);
  await fillEmployment(page, "Harborline Analytics", "4200");
  await expectAutoSaved(page);
});

test("step 4 — assets, and a bank link that imports accounts as asset rows", async ({ page }) => {
  await openStep(page, 4);

  await ensureRow(page, "assets-add", "field-assets-0-accountType");
  await choose(page, "field-assets-0-accountType", "checking");
  await fill(page, "field-assets-0-financialInstitution", "Copperfield Community Bank");
  await fill(page, "field-assets-0-accountNumber", "10024417");
  await fill(page, "field-assets-0-cashOrMarketValue", "185000");
  await expectAutoSaved(page);

  const assetRowsBefore = await page.locator('[data-testid^="assets-remove-"]').count();

  await page.getByTestId("bank-link-btn").click();
  await expect(page.getByTestId("bank-link-dialog")).toBeVisible();

  const institution = page.locator('[data-testid^="bank-link-institution-"]').first();
  await expect(institution).toBeVisible({ timeout: 120_000 });
  await institution.click();

  // The simulation stands in for the aggregator's hosted credential step.
  await page.getByTestId("bank-link-username").fill("journey-user");
  await page.getByTestId("bank-link-password").fill("journey-pass");
  await page.getByTestId("bank-link-auth-submit").click();

  await expect(page.getByTestId("bank-link-import-btn"), "linked accounts are offered for import").toBeVisible({
    timeout: 300_000,
  });
  const accounts = page.locator('[data-testid^="bank-link-account-"]');
  const accountCount = await accounts.count();
  expect(accountCount, "the simulated aggregator returns 2-4 accounts (REQ-039)").toBeGreaterThanOrEqual(2);
  expect(accountCount).toBeLessThanOrEqual(4);

  await page.getByTestId("bank-link-import-btn").click();

  // Imported accounts land as asset rows on Step 4 (AC-18).
  await expect
    .poll(async () => page.locator('[data-testid^="assets-remove-"]').count(), {
      timeout: 300_000,
      intervals: [5_000],
    })
    .toBeGreaterThan(assetRowsBefore);
  await expectAutoSaved(page);
});

test("steps 5 to 7 — liabilities, subject property, loan details with live DTI and LTV", async ({ page }) => {
  await openStep(page, 5);
  await expect(page.getByTestId("dti-badge")).toBeVisible();
  await expect(page.getByTestId("dti-badge")).not.toHaveText("");

  await openStep(page, 6);
  await pickAddressSuggestion(page, "field-address-street", "789 El");
  await fill(page, "field-numberOfUnits", "1");
  await choose(page, "field-propertyType", "single-family-detached");
  await choose(page, "field-occupancy", "primary-residence");
  await fill(page, "field-estimatedValue", "500000");
  await answer(page, "field-mixedUse", "no");
  await answer(page, "field-manufacturedHome", "no");
  await fill(page, "field-titleNames", "Journey Borrower and Avery Coborrower");
  await choose(page, "field-titleManner", "joint-tenancy-right-of-survivorship");
  await choose(page, "field-estate", "fee-simple");
  await fill(page, "field-targetClosingDate", isoDaysFromNow(45));
  await expectAutoSaved(page);

  await openStep(page, 7);
  await choose(page, "field-loanPurpose", "purchase");
  await choose(page, "field-loanType", "conventional");
  await choose(page, "field-amortizationType", "fixed");
  await choose(page, "field-loanTermMonths", "360");
  await fill(page, "field-requestedLoanAmount", "350000");
  await fill(page, "field-downPaymentAmount", "150000");
  await choose(page, "field-downPaymentSource", "checking");
  await fill(page, "field-proposedHousingExpense-firstMortgagePi", "2213");
  await fill(page, "field-proposedHousingExpense-subordinateLiens", "0");
  await fill(page, "field-proposedHousingExpense-homeownersInsurance", "145");
  await fill(page, "field-proposedHousingExpense-supplementalInsurance", "0");
  await fill(page, "field-proposedHousingExpense-propertyTaxes", "420");
  await fill(page, "field-proposedHousingExpense-mortgageInsurance", "0");
  await fill(page, "field-proposedHousingExpense-hoaDues", "0");
  await fill(page, "field-proposedHousingExpense-other", "0");
  await expectAutoSaved(page);

  // 350,000 / 500,000 = 70% — comfortably under the submission block and the warning band.
  await expect(page.getByTestId("ltv-badge")).toContainText("70%");
});

test("steps 8 and 9 — declarations and demographics for both borrowers", async ({ page }) => {
  await openStep(page, 8);
  await selectBorrower(page, 1);
  await fillDeclarations(page);
  await expectAutoSaved(page);
  await selectBorrower(page, 2);
  await fillDeclarations(page);
  await expectAutoSaved(page);

  await openStep(page, 9);
  await selectBorrower(page, 1);
  await fillDemographics(page);
  await expectAutoSaved(page);
  await selectBorrower(page, 2);
  await fillDemographics(page);
  await expectAutoSaved(page);
});

/** Maps a §4.2.4 checklist key to the document type that satisfies it. */
function documentTypeForChecklistKey(key: string): string {
  if (key.startsWith("government-id")) return "government-id";
  if (key.startsWith("pay-stubs")) return "pay-stub";
  if (key.startsWith("w2")) return "w2";
  if (key.startsWith("bank-statements")) return "bank-statement";
  if (key.startsWith("purchase-agreement")) return "purchase-agreement";
  if (key.startsWith("tax-return")) return "tax-return-1040";
  if (key.startsWith("homeowners")) return "homeowners-insurance-quote";
  return "other";
}

test("step 10 — upload a document for every outstanding checklist item", async ({ page }) => {
  test.setTimeout(900_000);
  await openStep(page, 10);

  const items = page.locator('[data-testid^="doc-item-"]');
  const missing = page.locator('[data-testid^="checklist-item-"]', { hasText: /Missing/i });

  // Fill the checklist slot by slot: the app matches an upload to the first outstanding
  // slot of that type, so driving off the checklist keeps this correct for any borrower count.
  for (let guard = 0; guard < 15; guard += 1) {
    if ((await missing.count()) === 0) break;
    const before = await items.count();
    const key = String(await missing.first().getAttribute("data-testid")).replace("checklist-item-", "");
    const type = documentTypeForChecklistKey(key);
    await page.getByTestId("doc-type-select").selectOption(type);
    await page.getByTestId("doc-file-input").setInputFiles({
      name: `journey-${key}.pdf`,
      mimeType: "application/pdf",
      buffer: pdfBuffer(key),
    });
    await expect(items).toHaveCount(before + 1, { timeout: 300_000 });
  }

  // No checklist row is left unsatisfied before the caseworker sees the file.
  await expect(missing).toHaveCount(0, { timeout: 300_000 });

  const target = items.first();
  const docTestId = String(await target.getAttribute("data-testid"));
  writeState({ liveDocumentId: docTestId.replace("doc-item-", "") });
  await expect(page.getByTestId(docTestId)).toContainText("v1");
});

test("step 10 — sign for both borrowers and submit into Application Received", async ({ page }) => {
  test.setTimeout(900_000);

  // Re-running this journey against an already-submitted draft must land in the same
  // asserted state rather than trying to sign a read-only application again.
  await gotoAsFreshBorrower(page, "/dashboard");
  const stateBadge = page.getByTestId(`application-state-${applicationId()}`);
  await expect(stateBadge).toBeVisible({ timeout: 300_000 });
  const alreadySubmitted = (await stateBadge.innerText()).trim() !== "Draft";

  if (!alreadySubmitted) {
    await openStep(page, 10);

    // The certification statement gates the ceremony — signing is disabled until it is
    // acknowledged, so the attestation goes first.
    await page.getByTestId("attestation-checkbox").check();

    // Primary borrower signs by drawing; the co-borrower types their name (AC-15).
    const primaryPanel = page.getByTestId("signature-panel-1");
    await primaryPanel.getByTestId("signature-mode-drawn").click();
    await drawSignature(page, primaryPanel);
    const primarySave = primaryPanel.getByTestId("signature-save-btn");
    await expect(primarySave, "a drawn stroke enables the save action").toBeEnabled({ timeout: 60_000 });
    await primarySave.click();

    const coPanel = page.getByTestId("signature-panel-2");
    await coPanel.getByTestId("signature-mode-typed").click();
    await coPanel.getByTestId("signature-typed-input").fill("Avery Coborrower");
    const coSave = coPanel.getByTestId("signature-save-btn");
    await expect(coSave, "a typed name enables the save action").toBeEnabled({ timeout: 60_000 });
    await coSave.click();

    // Nothing outstanding may remain — the wizard states its own blockers verbatim.
    const outstanding = page.getByTestId("review-outstanding-issues");
    if (await outstanding.isVisible().catch(() => false)) {
      expect(await outstanding.innerText(), "no validation issues remain before submission").toBe("");
    }

    await page.getByTestId("submit-application-btn").click();

    // A refused submission surfaces the API message verbatim (NFR-025); nothing may appear.
    await page.waitForTimeout(8000);
    const submitError = page.getByTestId("submit-error-banner");
    if (await submitError.isVisible().catch(() => false)) {
      throw new Error(`submission was refused: ${await submitError.innerText()}`);
    }
  }

  await gotoAsFreshBorrower(page, "/dashboard");
  const row = page.getByTestId(`application-row-${applicationId()}`);
  await expect(row).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId(`application-state-${applicationId()}`)).toHaveText("Application Received", {
    timeout: 300_000,
  });

  const applicationNumber = (await row.innerText()).match(/MM-\d{4}-\d{6}/)?.[0];
  expect(applicationNumber, "the submitted application carries a human-readable number").toBeTruthy();
  writeState({ liveApplicationId: applicationId(), liveApplicationNumber: applicationNumber });
});

test("a second submission while one is in underwriting is refused with the contracted message", async ({ page }) => {
  // The one-active rule (REQ-022 / AC-11) is surfaced verbatim in the wizard.
  expect(readState().liveApplicationId, "the first application reached Application Received").toBeTruthy();

  await gotoAsFreshBorrower(page, "/applications/new");
  await page.getByTestId("new-app-mode-blank").check();
  await page.getByTestId("create-application-btn").click();
  try {
    await page.waitForURL(/\/applications\/[0-9a-f-]{36}/, { waitUntil: "domcontentloaded", timeout: 300_000 });
  } catch (error) {
    // A second *draft* is allowed — it is submission that the one-active rule refuses. If
    // the entry point never opens one, report what the screen said rather than a bare
    // navigation timeout: an unavailability notice here means the create call was refused
    // by the server, and that distinction is the whole finding.
    const notice = await page
      .getByRole("alert")
      .filter({ hasText: /\S/ })
      .first()
      .innerText()
      .catch(() => "");
    throw new Error(
      `creating a second draft never opened the wizard. Screen message: ${notice || "(none)"} — ` +
        `${(error as Error).message.slice(0, 200)}`,
    );
  }
  const secondId = new URL(page.url()).pathname.split("/")[2];

  const secondStepTen = `/applications/${secondId}?step=10`;
  await gotoAsFreshBorrower(page, secondStepTen);
  await gotoUntilReady(page, secondStepTen, "wizard-step-10");
  await expect(page.getByTestId("submit-error-banner")).toContainText(
    /already have an application/i,
    { timeout: 180_000 },
  );
});
