/**
 * AC-60 — keyboard-only completion of registration, the full wizard, a document upload,
 * and a queue claim.
 *
 * Every interaction below goes through page.keyboard: Tab / Shift+Tab to move focus,
 * Enter or Space to activate, Arrow keys to change a select. There is not a single
 * mouse click in this file. File choosing is the one unavoidable exception — the OS
 * file dialog cannot be driven from the page — so the input is *focused with the
 * keyboard* and then handed its file, which still proves the control is reachable.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  SUITE_PASSWORD,
  credentialSignIn,
  focusedTestId,
  gotoAs,
  keyboardActivate,
  keyboardDate,
  keyboardFill,
  keyboardSelect,
  outboundVerificationHref,
  pdfBuffer,
  safeGoto,
  sessionExpired,
  storagePath,
  tabTo,
  totpCode,
  uniqueSsn,
} from "./support/journey";

test.describe.configure({ mode: "serial" });

const keyboardTag = `e2e-kbd-${randomUUID().slice(0, 8)}`;
const keyboardEmail = `${keyboardTag}@e2e.example`;
const keyboardState = { applicationId: "", totpSecret: "" };

const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Tab to a checkbox and toggle it with Space. */
async function keyboardCheck(page: Page, testId: string): Promise<void> {
  await tabTo(page, testId);
  if (!(await page.getByTestId(testId).isChecked())) {
    await page.keyboard.press("Space");
  }
  await expect(page.getByTestId(testId)).toBeChecked();
}

/** Tab to one half of a Yes/No button pair and press Enter. */
async function keyboardAnswer(page: Page, testId: string, answer: "yes" | "no"): Promise<void> {
  await keyboardActivate(page, `${testId}-${answer}`);
}

/**
 * Chooses one option inside a radio/checkbox group with the keyboard. Radio groups are a
 * single tab stop, so the group is entered with Tab and traversed with arrow keys;
 * checkboxes are toggled with Space once focused.
 */
async function keyboardChoose(page: Page, groupTestIds: string[], target: string): Promise<void> {
  const control = page.getByTestId(target);
  const kind = await control.evaluate((element) => (element as HTMLInputElement).type);

  // Checkboxes are each their own tab stop; radios share one and move with arrow keys.
  if (kind === "checkbox") {
    await tabTo(page, target, { maxTabs: 200 });
    if (!(await control.isChecked())) {
      await page.keyboard.press("Space");
    }
    await expect(control).toBeChecked();
    return;
  }

  let entered = false;
  for (const testId of groupTestIds) {
    try {
      await tabTo(page, testId, { maxTabs: 150 });
      entered = true;
      break;
    } catch {
      // The group's other members are not focus stops when a radio is already selected.
    }
  }
  expect(entered, `the ${target} group is reachable with the Tab key`).toBe(true);

  for (let attempt = 0; attempt <= groupTestIds.length + 1; attempt += 1) {
    if (await control.isChecked()) return;
    const focused = await focusedTestId(page);
    await page.keyboard.press(focused === target ? "Space" : "ArrowDown");
    await page.waitForTimeout(120);
  }
  await expect(control).toBeChecked();
}

/**
 * Types into an address field and takes the first suggestion with the keyboard. Accepts
 * either accessible pattern: an ARIA combobox driven from the input with ArrowDown/Enter,
 * or a list whose options are themselves focus stops.
 */
async function keyboardPickAddress(page: Page, streetTestId: string, filledTestId: string): Promise<void> {
  await tabTo(page, streetTestId);
  await page.keyboard.type("123 Ma", { delay: 110 });
  await expect(page.getByTestId("address-suggest-list")).toBeVisible({ timeout: 300_000 });

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);

  if ((await page.getByTestId(filledTestId).inputValue()) === "") {
    await keyboardActivate(page, "address-suggest-item-0");
  }
  await expect(
    page.getByTestId(filledTestId),
    "selecting an address suggestion with the keyboard fills the rest of the address",
  ).not.toHaveValue("");
}

test("registration, verification and MFA enrollment complete with the keyboard alone", async ({
  browser,
}) => {
  test.setTimeout(1_200_000);
  const context = await browser.newContext();
  const page = await context.newPage();

  await safeGoto(page, "/sign-up");
  await expect(page.getByTestId("signup-first-name")).toBeVisible({ timeout: 300_000 });

  await keyboardFill(page, "signup-first-name", "Keyboard");
  await keyboardFill(page, "signup-last-name", "Borrower");
  await keyboardFill(page, "signup-email", keyboardEmail);
  await keyboardFill(page, "signup-password", SUITE_PASSWORD);
  await keyboardFill(page, "signup-password-confirmation", SUITE_PASSWORD);
  await keyboardCheck(page, "signup-accept-terms");
  await keyboardActivate(page, "signup-submit");
  // Wait for the registration acknowledgement before reading the outbound log:
  // the (argon2-slow) registration commits the verification email inside its
  // transaction, and the outbound view fetches once on open without live refresh —
  // reading before the ack races ahead of the row's commit.
  await expect(
    page.getByTestId("signup-success"),
    "keyboard registration never produced the acknowledgement",
  ).toBeVisible({ timeout: 120_000 });

  // Read the verification link from the simulated outbound log in a separate session.
  const supervisorContext = await browser.newContext({ storageState: storagePath("supervisor") });
  const supervisor = await supervisorContext.newPage();
  const href = await outboundVerificationHref(supervisor, keyboardEmail);
  await supervisorContext.close();

  await safeGoto(page, href);
  await page.getByTestId("verify-status-loading").waitFor({ state: "detached", timeout: 300_000 }).catch(() => {});
  await expect(page.getByTestId("verify-success")).toBeVisible({ timeout: 300_000 });

  await safeGoto(page, "/sign-in");
  await keyboardFill(page, "signin-email", keyboardEmail);
  await keyboardFill(page, "signin-password", SUITE_PASSWORD);
  await keyboardActivate(page, "signin-submit");
  await page.waitForURL("**/mfa/enroll", { waitUntil: "domcontentloaded", timeout: 300_000 });

  await page.getByTestId("mfa-enroll-loading").waitFor({ state: "detached", timeout: 300_000 }).catch(() => {});
  await keyboardActivate(page, "mfa-secret-toggle");
  const secret = (await page.getByTestId("mfa-secret").innerText()).replace(/\s+/g, "");
  keyboardState.totpSecret = secret;
  await keyboardFill(page, "mfa-code-input", totpCode(secret));
  await keyboardActivate(page, "mfa-verify-btn");

  await expect(page.getByTestId("recovery-codes-list")).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("recovery-code-item")).toHaveCount(10);
  await keyboardActivate(page, "recovery-codes-continue");
  await page.waitForURL("**/dashboard", { waitUntil: "domcontentloaded", timeout: 300_000 });

  await context.storageState({ path: storagePath("keyboard-borrower") });
  await context.close();
});

test.describe("keyboard-only wizard and upload", () => {
  test.use({ storageState: storagePath("keyboard-borrower") });

  test("all ten wizard steps, a document upload and submission complete with the keyboard alone", async ({
    page,
  }) => {
    test.setTimeout(2_400_000);

    // Create the application without a mouse.
    await safeGoto(page, "/applications/new");
    await expect(page.getByTestId("create-application-btn")).toBeVisible({ timeout: 300_000 });
    await keyboardChoose(page, ["new-app-mode-blank", "new-app-mode-copy"], "new-app-mode-blank");
    await keyboardActivate(page, "create-application-btn");
    await page.waitForURL(/\/applications\/[0-9a-f-]{36}/, { waitUntil: "domcontentloaded", timeout: 300_000 });
    keyboardState.applicationId = new URL(page.url()).pathname.split("/")[2];

    const openStep = async (step: number): Promise<void> => {
      const url = `/applications/${keyboardState.applicationId}?step=${step}`;
      await safeGoto(page, url);
      // This journey runs longer than the configured idle timeout; re-authenticate rather
      // than assert against an expiry notice.
      if (new URL(page.url()).pathname.startsWith("/sign-in") || (await sessionExpired(page))) {
        await credentialSignIn(page, keyboardEmail, SUITE_PASSWORD, keyboardState.totpSecret);
        await safeGoto(page, url);
      }
      await expect(page.getByTestId(`wizard-step-${step}`)).toBeVisible({ timeout: 300_000 });
      await page.keyboard.press("Home");
    };

    // Step 1 — identity.
    await openStep(1);
    await keyboardFill(page, "field-firstName", "Keyboard");
    await keyboardFill(page, "field-lastName", "Borrower");
    await keyboardFill(page, "field-ssn", uniqueSsn(keyboardTag));
    await keyboardDate(page, "field-dateOfBirth", "1984-07-19");
    await keyboardSelect(page, "field-citizenship", "us-citizen");
    await keyboardSelect(page, "field-maritalStatus", "unmarried");
    await keyboardFill(page, "field-dependentsCount", "0");
    await keyboardFill(page, "field-cellPhone", "5555550142");
    await keyboardFill(page, "field-email", keyboardEmail);
    await keyboardSelect(page, "field-creditType", "individual");
    await keyboardAnswer(page, "field-militaryService-served", "no");
    await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 300_000 });

    // Step 2 — address history, including the autocomplete list.
    await openStep(2);
    // The suggestion list is reachable and selectable without a pointer.
    await keyboardPickAddress(page, "field-currentAddress-street", "field-currentAddress-city");
    await keyboardSelect(page, "field-housingStatus", "rent");
    // Renting makes the monthly rent a required cross-field value ("Monthly rent
    // is required when renting"), and Step 10 refuses submission while it is
    // missing — so the keyboard journey has to supply it to reach the ceremony.
    await keyboardFill(page, "field-monthlyRent", "2200");
    await keyboardFill(page, "field-yearsAtAddress", "7");
    await keyboardFill(page, "field-monthsAtAddress", "0");
    await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 300_000 });

    // Step 3 — employment and income.
    await openStep(3);
    await keyboardSelect(page, "field-employmentType", "employed");
    if ((await page.getByTestId("field-employments-0-employerName").count()) === 0) {
      await keyboardActivate(page, "employments-add");
      await expect(page.getByTestId("field-employments-0-employerName")).toBeVisible({ timeout: 300_000 });
    }
    await keyboardFill(page, "field-employments-0-employerName", "Meridian Freight");
    await keyboardFill(page, "field-employments-0-employerPhone", "5555550111");
    await keyboardFill(page, "field-employments-0-position", "Dispatch Manager");
    await keyboardDate(page, "field-employments-0-startDate", "2015-06-01");
    await keyboardFill(page, "field-employments-0-yearsInLineOfWork", "10");
    await keyboardFill(page, "field-employments-0-employerAddress-street", "88 Depot Road");
    await keyboardFill(page, "field-employments-0-employerAddress-city", "Durham");
    await keyboardFill(page, "field-employments-0-employerAddress-state", "NC");
    await keyboardFill(page, "field-employments-0-employerAddress-zip", "27701");
    await keyboardFill(page, "field-employments-0-baseMonthlyIncome", "10500");
    await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 300_000 });

    // Step 4 — assets.
    await openStep(4);
    if ((await page.getByTestId("field-assets-0-accountType").count()) === 0) {
      await keyboardActivate(page, "assets-add");
      await expect(page.getByTestId("field-assets-0-accountType")).toBeVisible({ timeout: 300_000 });
    }
    await keyboardSelect(page, "field-assets-0-accountType", "savings");
    await keyboardFill(page, "field-assets-0-financialInstitution", "Granite Peak National Bank");
    await keyboardFill(page, "field-assets-0-accountNumber", "77120043");
    await keyboardFill(page, "field-assets-0-cashOrMarketValue", "160000");
    await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 300_000 });

    // Step 5 — liabilities are optional; the live DTI badge is still shown.
    await openStep(5);
    await expect(page.getByTestId("dti-badge")).toBeVisible();

    // Step 6 — subject property.
    await openStep(6);
    await keyboardPickAddress(page, "field-address-street", "field-address-city");
    await keyboardFill(page, "field-numberOfUnits", "1");
    await keyboardSelect(page, "field-propertyType", "single-family-detached");
    await keyboardSelect(page, "field-occupancy", "primary-residence");
    await keyboardFill(page, "field-estimatedValue", "480000");
    await keyboardAnswer(page, "field-mixedUse", "no");
    await keyboardAnswer(page, "field-manufacturedHome", "no");
    await keyboardFill(page, "field-titleNames", "Keyboard Borrower");
    await keyboardSelect(page, "field-titleManner", "sole-ownership");
    await keyboardSelect(page, "field-estate", "fee-simple");
    await keyboardDate(page, "field-targetClosingDate", isoDaysFromNow(50));
    await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 300_000 });

    // Step 7 — loan details.
    await openStep(7);
    await keyboardSelect(page, "field-loanPurpose", "purchase");
    await keyboardSelect(page, "field-loanType", "conventional");
    await keyboardSelect(page, "field-amortizationType", "fixed");
    await keyboardSelect(page, "field-loanTermMonths", "360");
    await keyboardFill(page, "field-requestedLoanAmount", "336000");
    await keyboardFill(page, "field-downPaymentAmount", "144000");
    await keyboardSelect(page, "field-downPaymentSource", "savings");
    await keyboardFill(page, "field-proposedHousingExpense-firstMortgagePi", "2124");
    await keyboardFill(page, "field-proposedHousingExpense-subordinateLiens", "0");
    await keyboardFill(page, "field-proposedHousingExpense-homeownersInsurance", "140");
    await keyboardFill(page, "field-proposedHousingExpense-supplementalInsurance", "0");
    await keyboardFill(page, "field-proposedHousingExpense-propertyTaxes", "400");
    await keyboardFill(page, "field-proposedHousingExpense-mortgageInsurance", "0");
    await keyboardFill(page, "field-proposedHousingExpense-hoaDues", "0");
    await keyboardFill(page, "field-proposedHousingExpense-other", "0");
    await expect(page.getByTestId("ltv-badge")).toContainText("70%", { timeout: 300_000 });

    // Step 8 — declarations.
    await openStep(8);
    await keyboardAnswer(page, "field-aOccupyPrimary", "yes");
    for (const testId of [
      "field-a1PriorOwnership",
      "field-bSellerRelationship",
      "field-cUndisclosedBorrowing",
      "field-d1OtherMortgageApplication",
      "field-d2NewCreditApplication",
      "field-ePriorityLien",
      "field-fCosignerUndisclosed",
      "field-gOutstandingJudgments",
      "field-hFederalDebtDelinquent",
      "field-iPartyToLawsuit",
      "field-jConveyedTitleInLieu",
      "field-kPreForeclosureSale",
      "field-lForeclosed",
      "field-mBankruptcy",
    ]) {
      await keyboardAnswer(page, testId, "no");
    }
    await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 300_000 });

    // Step 9 — demographics.
    await openStep(9);
    await keyboardChoose(
      page,
      ["field-ethnicity-hispanic-or-latino", "field-ethnicity-not-hispanic-or-latino", "field-ethnicity-not-provided"],
      "field-ethnicity-not-provided",
    );
    await keyboardChoose(
      page,
      [
        "field-race-american-indian-or-alaska-native",
        "field-race-asian",
        "field-race-black-or-african-american",
        "field-race-native-hawaiian-or-pacific-islander",
        "field-race-white",
        "field-race-not-provided",
      ],
      "field-race-not-provided",
    );
    await keyboardChoose(
      page,
      ["field-sex-female", "field-sex-male", "field-sex-not-provided"],
      "field-sex-not-provided",
    );
    await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 300_000 });

    // Step 10 — a keyboard-reachable upload, then the signature ceremony and submit.
    await openStep(10);
    await keyboardSelect(page, "doc-type-select", "government-id");

    // §4.2.9 puts the keyboard requirement on the drop zone — "the drop zone is keyboard
    // accessible" — and `doc-dropzone` is the §C selector for it. The file input behind it
    // is not a contracted selector, and a bare file input sitting in the tab order would
    // be the anti-pattern rather than the requirement (the same reasoning 02b applies to
    // the Replace control). So the assertion is that the drop zone takes focus and can be
    // operated from the keyboard alone, and the file is supplied through the picker it opens.
    await tabTo(page, "doc-dropzone");
    expect(await focusedTestId(page), "the upload drop zone takes keyboard focus").toBe("doc-dropzone");

    const openPicker = async (key: string, timeout: number) =>
      Promise.all([page.waitForEvent("filechooser", { timeout }), page.keyboard.press(key)]).then(
        ([picker]) => picker,
      );
    // Enter and Space are both keyboard activation; a drop zone may answer either.
    const chooser = await openPicker("Enter", 30_000).catch(() => openPicker("Space", 120_000));
    await chooser.setFiles({
      name: "keyboard-government-id.pdf",
      mimeType: "application/pdf",
      buffer: pdfBuffer("keyboard upload"),
    });
    await expect(page.locator('[data-testid^="doc-item-"]').first()).toBeVisible({ timeout: 300_000 });

    // The certification statement gates signing; acknowledge it first.
    await keyboardCheck(page, "attestation-checkbox");

    const panel = page.getByTestId("signature-panel-1");
    await keyboardActivate(page, "signature-mode-typed");
    await tabTo(page, "signature-typed-input");
    await page.keyboard.type("Keyboard Borrower", { delay: 15 });
    await keyboardActivate(page, "signature-save-btn");
    await expect(panel).toBeVisible();

    await keyboardActivate(page, "submit-application-btn");

    // Wait for the submission to RESOLVE before judging it. `toBeHidden` on the error
    // banner passes the instant it is asserted — the banner is legitimately absent while
    // the POST is still in flight — so a refusal used to slip past here and only surface
    // as a stale "Draft" badge on the dashboard with no reason attached. Race the
    // wizard's submitted state against its error banner and report the server's words.
    const submitError = page.getByTestId("submit-error-banner");
    await page
      .locator('[data-testid="submit-success-banner"], [data-testid="submit-error-banner"]')
      .first()
      .waitFor({ state: "visible", timeout: 300_000 })
      .catch(() => undefined);
    if (await submitError.isVisible().catch(() => false)) {
      throw new Error(
        `keyboard submission was refused: ${(await submitError.innerText()).replace(/\s+/g, " ").slice(0, 400)}`,
      );
    }
    await expect(page.getByTestId("submit-success-banner")).toBeVisible({ timeout: 300_000 });
    await safeGoto(page, "/dashboard");
    await expect(page.getByTestId(`application-state-${keyboardState.applicationId}`)).toHaveText(
      "Application Received",
      { timeout: 300_000 },
    );
  });
});

test.describe("keyboard-only claim", () => {
  test.use({ storageState: storagePath("caseworker") });

  test("a caseworker claims an application from the queue with the keyboard alone", async ({ page }) => {
    test.setTimeout(900_000);
    await gotoAs(page, "caseworker", "/caseworker/queue");
    await expect(page.getByTestId("queue-tab-unassigned")).toBeVisible({ timeout: 300_000 });

    await keyboardActivate(page, "queue-tab-unassigned");
    await tabTo(page, "queue-search");
    await page.keyboard.type("Keyboard", { delay: 25 });

    const row = page.locator('[data-testid^="queue-row-"]').first();
    await expect(row, "the keyboard-submitted application is waiting in the unassigned queue").toBeVisible({
      timeout: 300_000,
    });
    const applicationId = String(await row.getAttribute("data-testid")).replace("queue-row-", "");

    await keyboardActivate(page, `queue-claim-${applicationId}`);

    await keyboardActivate(page, "queue-tab-mine");
    await tabTo(page, "queue-search");
    await page.keyboard.type("Keyboard", { delay: 25 });
    await expect(page.getByTestId(`queue-row-${applicationId}`)).toBeVisible({ timeout: 300_000 });
  });
});
