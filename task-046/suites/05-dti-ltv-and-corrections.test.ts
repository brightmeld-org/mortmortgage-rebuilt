/**
 * §7.7 — DTI and LTV with every income source and with corrections.
 *
 * The expected values are computed in-test from the §E algorithmic-precision formulas,
 * never read back from the app. AC-13: one shared module must produce the identical
 * figure on the wizard save response, the application detail, and the qualification card.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting } from "../helpers/config.js";
import { GET, POST, expectOk } from "../helpers/http.js";
import { enums } from "../helpers/contract.js";
import {
  buildSubmittableDraft,
  createDraft,
  fillDraft,
  getApplication,
  saveSection,
  transitionOk,
  claim,
  type Application,
} from "../helpers/application.js";
import { toAusExecuted, type Actors } from "../helpers/workflow.js";

const PREFIX = suitePrefix("ratio");

/** Housing expense used by every fixture: 1900 + 110 + 400 = 2410/month. */
const HOUSING_TOTAL = 2410;
/** The single installment liability in the fixture. */
const LIABILITY_PAYMENT = 350;

function expectedDti(monthlyIncome: number, extraLiabilities = 0): number {
  const numerator = LIABILITY_PAYMENT + extraLiabilities + HOUSING_TOTAL;
  return Number(((numerator / monthlyIncome) * 100).toFixed(3));
}

let supervisor: Session;
let caseworker: Session;
let borrower: Session;
let draft: Application;
let stamp: number;

/** Saves the employment section with exactly one income component populated. */
async function saveIncome(fields: Record<string, number>, otherIncome: Array<{ source: string; monthlyAmount: number }> = []): Promise<{ dti?: number; ltv?: number; cltv?: number }> {
  const result = await saveSection(
    borrower,
    draft.id,
    "employment-income",
    {
      employmentIncome: {
        employmentType: "employed",
        employments: [
          {
            employerName: "Ratio Fixture LLC",
            position: "Analyst",
            startDate: "2016-03-01",
            selfEmployed: false,
            baseMonthlyIncome: 0,
            overtime: 0,
            bonus: 0,
            commission: 0,
            militaryEntitlements: 0,
            otherMonthlyIncome: 0,
            selfEmployedMonthlyIncome: 0,
            ...fields,
          },
        ],
        otherIncome,
      },
    },
    stamp,
    1,
  );
  const body = expectOk(result, "PUT sections/employment-income", 200);
  stamp = body.versionStamp;
  return body;
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  borrower = (await registerBorrower(supervisor, `${PREFIX}-b1`)).session;
  draft = await createDraft(borrower);
  draft = await fillDraft(borrower, draft);
  stamp = draft.versionStamp;
});

describe("§7.7 DTI counts every income source in the §E denominator", () => {
  const EMPLOYMENT_INCOME_FIELDS = [
    "baseMonthlyIncome",
    "overtime",
    "bonus",
    "commission",
    "militaryEntitlements",
    "otherMonthlyIncome",
    "selfEmployedMonthlyIncome",
  ] as const;

  for (const field of EMPLOYMENT_INCOME_FIELDS) {
    test(`${field} alone drives the denominator`, { timeout: 60000 }, async () => {
      const saved = await saveIncome({ [field]: 8000 });
      assert.equal(saved.dti, expectedDti(8000), `${field}: DTI mismatch`);
    });
  }

  test("every OtherIncomeSource value counts toward the denominator", { timeout: 180000 }, async () => {
    const sources = enums.OtherIncomeSource;
    assert.equal(sources.length, 13, "the contract declares 13 other-income sources");
    const failures: string[] = [];
    for (const source of sources) {
      const saved = await saveIncome({ baseMonthlyIncome: 8000 }, [{ source, monthlyAmount: 1000 }]);
      const expected = expectedDti(9000);
      if (saved.dti !== expected) failures.push(`${source}: expected ${expected}, got ${saved.dti}`);
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });

  test("net rental income from owned real estate counts (ASM-002)", { timeout: 60000 }, async () => {
    await saveIncome({ baseMonthlyIncome: 8000 });
    const withReo = await saveSection(
      borrower,
      draft.id,
      "assets-reo",
      {
        assetsReo: {
          assets: [
            {
              accountType: "checking",
              financialInstitution: "Ratio Bank",
              accountNumber: "123456789012",
              cashOrMarketValue: 120000,
              source: "manual",
            },
          ],
          otherCredits: [],
          realEstateOwned: [
            {
              address: { street: "22 Rental Rd", city: "Columbus", state: "OH", zip: "43201" },
              propertyValue: 250000,
              status: "retained",
              intendedOccupancy: "investment-property",
              monthlyInsuranceTaxesHoa: 400,
              monthlyRentalIncome: 1400,
              netMonthlyRentalIncome: 1000,
              mortgages: [],
            },
          ],
        },
      },
      stamp,
    );
    const body = expectOk(withReo, "PUT sections/assets-reo", 200);
    stamp = body.versionStamp;
    assert.equal(body.dti, expectedDti(9000), "REO net rental income must join the denominator");

    // Remove the rental property again so the remaining tests reason about an 8,000
    // denominator; dropping it must take the rental income back out.
    const withoutReo = await saveSection(
      borrower,
      draft.id,
      "assets-reo",
      {
        assetsReo: {
          assets: [
            {
              accountType: "checking",
              financialInstitution: "Ratio Bank",
              accountNumber: "123456789012",
              cashOrMarketValue: 120000,
              source: "manual",
            },
          ],
          otherCredits: [],
          realEstateOwned: [],
        },
      },
      stamp,
    );
    const cleared = expectOk(withoutReo, "PUT sections/assets-reo (cleared)", 200);
    stamp = cleared.versionStamp;
    assert.equal(cleared.dti, expectedDti(8000), "removing the rental property must remove its income again");
  });

  test("subject-property expected rental income is EXCLUDED from the denominator (ASM-002)", { timeout: 60000 }, async () => {
    const before = await saveIncome({ baseMonthlyIncome: 8000 });
    const withExpectedRent = await saveSection(
      borrower,
      draft.id,
      "subject-property",
      {
        subjectProperty: {
          address: { street: "500 Subject St", city: "Columbus", state: "OH", zip: "43215", county: "Franklin" },
          numberOfUnits: 1,
          propertyType: "single-family-detached",
          occupancy: "investment-property",
          mixedUse: false,
          manufacturedHome: false,
          estimatedValue: 400000,
          expectedMonthlyRentalIncome: 5000,
          titleNames: "Fixture Borrower",
          titleManner: "sole-ownership",
          estate: "fee-simple",
          targetClosingDate: "2027-01-15",
        },
      },
      stamp,
    );
    const body = expectOk(withExpectedRent, "PUT sections/subject-property", 200);
    stamp = body.versionStamp;
    assert.equal(body.dti, before.dti, "expected rent on the subject property must not change DTI");
  });

  test("liabilities marked paid off at closing leave the numerator", { timeout: 60000 }, async () => {
    await saveIncome({ baseMonthlyIncome: 8000 });
    const paidOff = await saveSection(
      borrower,
      draft.id,
      "liabilities",
      {
        liabilities: {
          liabilities: [
            {
              accountType: "installment",
              companyName: "Ratio Auto Finance",
              accountNumber: "998877665544",
              unpaidBalance: 12000,
              monthlyPayment: LIABILITY_PAYMENT,
              monthsLeft: 36,
              paidOffAtClosing: true,
            },
          ],
          otherLiabilities: [],
        },
      },
      stamp,
    );
    const body = expectOk(paidOff, "PUT sections/liabilities", 200);
    stamp = body.versionStamp;
    assert.equal(body.dti, Number(((HOUSING_TOTAL / 8000) * 100).toFixed(3)));

    // Restore the liability for the remaining tests.
    const restored = await saveSection(
      borrower,
      draft.id,
      "liabilities",
      {
        liabilities: {
          liabilities: [
            {
              accountType: "installment",
              companyName: "Ratio Auto Finance",
              accountNumber: "998877665544",
              unpaidBalance: 12000,
              monthlyPayment: LIABILITY_PAYMENT,
              monthsLeft: 36,
              paidOffAtClosing: false,
            },
          ],
          otherLiabilities: [],
        },
      },
      stamp,
    );
    stamp = expectOk(restored, "restore liabilities", 200).versionStamp;
  });

  test("otherLiabilities join the numerator", { timeout: 60000 }, async () => {
    await saveIncome({ baseMonthlyIncome: 8000 });
    const result = await saveSection(
      borrower,
      draft.id,
      "liabilities",
      {
        liabilities: {
          liabilities: [
            {
              accountType: "installment",
              companyName: "Ratio Auto Finance",
              accountNumber: "998877665544",
              unpaidBalance: 12000,
              monthlyPayment: LIABILITY_PAYMENT,
              monthsLeft: 36,
              paidOffAtClosing: false,
            },
          ],
          otherLiabilities: [{ type: "child-support", monthlyPayment: 500 }],
        },
      },
      stamp,
    );
    const body = expectOk(result, "PUT sections/liabilities", 200);
    stamp = body.versionStamp;
    assert.equal(body.dti, expectedDti(8000, 500));
  });
});

describe("§7.7 LTV and CLTV", () => {
  test("LTV is the loan over the stated value while no valuation exists", { timeout: 60000 }, async () => {
    const result = await saveSection(
      borrower,
      draft.id,
      "loan-details",
      {
        loanDetails: {
          loanPurpose: "purchase",
          loanType: "conventional",
          amortizationType: "fixed",
          loanTermMonths: 360,
          requestedLoanAmount: 320000,
          downPaymentAmount: 80000,
          downPaymentSource: "checking",
          otherNewMortgages: [],
          proposedHousingExpense: {
            firstMortgagePi: 1900,
            subordinateLiens: 0,
            homeownersInsurance: 110,
            supplementalInsurance: 0,
            propertyTaxes: 400,
            mortgageInsurance: 0,
            hoaDues: 0,
            other: 0,
          },
        },
      },
      stamp,
    );
    const body = expectOk(result, "PUT sections/loan-details", 200);
    stamp = body.versionStamp;
    assert.equal(body.ltv, 80);
    assert.equal(body.cltv, 80, "with no subordinate lien CLTV equals LTV");
  });

  test("CLTV adds subordinate lien amounts over the same denominator", { timeout: 60000 }, async () => {
    const result = await saveSection(
      borrower,
      draft.id,
      "loan-details",
      {
        loanDetails: {
          loanPurpose: "purchase",
          loanType: "conventional",
          amortizationType: "fixed",
          loanTermMonths: 360,
          requestedLoanAmount: 320000,
          downPaymentAmount: 80000,
          downPaymentSource: "checking",
          otherNewMortgages: [
            {
              creditor: "Ratio Second Lien Co",
              lienType: "subordinate-lien",
              monthlyPayment: 200,
              amount: 40000,
              creditLimit: 40000,
            },
          ],
          proposedHousingExpense: {
            firstMortgagePi: 1900,
            subordinateLiens: 0,
            homeownersInsurance: 110,
            supplementalInsurance: 0,
            propertyTaxes: 400,
            mortgageInsurance: 0,
            hoaDues: 0,
            other: 0,
          },
        },
      },
      stamp,
    );
    const body = expectOk(result, "PUT sections/loan-details", 200);
    stamp = body.versionStamp;
    assert.equal(body.ltv, 80);
    assert.equal(body.cltv, 90, "(320000 + 40000) / 400000");
  });

  test("submission is blocked above the configured LTV cap (INV-025)", { timeout: 300000 }, async () => {
    const cap = Number(await readSetting(supervisor, "ltv.submissionBlockPercent"));
    assert.equal(cap, 97, "fixture assumes the §4.6.11 default submission cap");
    const capBorrower = (await registerBorrower(supervisor, `${PREFIX}-cap`)).session;
    const overCap = await buildSubmittableDraft(capBorrower, {
      estimatedValue: 400000,
      requestedLoanAmount: 392000, // 98%
    });
    assert.equal(overCap.ltv, 98);
    const path = `/api/applications/${overCap.id}/transition`;
    const blocked = await POST(path, {
      session: capBorrower,
      body: { toState: "application_received", versionStamp: overCap.versionStamp },
    });
    assert.ok([400, 409].includes(blocked.status), `expected rejection, got ${blocked.status} ${blocked.text.slice(0, 300)}`);
    assert.equal((await getApplication(capBorrower, overCap.id)).workflowState, "draft");
  });
});

describe("§7.7 AC-13 — one shared module feeds every surface", () => {
  let actors: Actors;
  let application: Application;

  before(async () => {
    actors = {
      borrower: (await registerBorrower(supervisor, `${PREFIX}-ac13`)).session,
      caseworker,
      supervisor,
    };
    application = await toAusExecuted(actors, { estimatedValue: 400000, requestedLoanAmount: 300000 });
  });

  test("the wizard save, application detail, and qualification card agree", { timeout: 120000 }, async () => {
    const detail = await getApplication(supervisor, application.id);
    const path = `/api/applications/${application.id}/qualification`;
    const qualification = expectOk(
      await GET<{ dti?: number; ltv?: number; cltv?: number }>(path, { session: supervisor }),
      path,
      200,
    );
    assert.equal(qualification.dti, detail.dti, "qualification DTI must match the stored application DTI");
    assert.equal(qualification.ltv, detail.ltv, "qualification LTV must match the stored application LTV");
    assert.equal(qualification.cltv, detail.cltv, "qualification CLTV must match the stored application CLTV");
  });

  test("a correction recalculates the ratios and marks the AUS result stale (XBR-004)", { timeout: 180000 }, async () => {
    const before = await getApplication(supervisor, application.id);
    const path = `/api/applications/${application.id}/corrections`;
    const correction = await POST(path, {
      session: caseworker,
      body: {
        // INV-039: corrections carry the current versionStamp.
        versionStamp: before.versionStamp,
        fieldPath: "employments[0].baseMonthlyIncome",
        borrowerOrdinal: 1,
        newValue: "4500",
        reason: "Verification of employment showed a lower base salary.",
      },
    });
    assert.equal(correction.status, 201, correction.text.slice(0, 300));

    const after = await getApplication(supervisor, application.id);
    assert.notEqual(after.dti, before.dti, "halving income must change DTI");
    assert.equal(after.dti, expectedDti(4500), "the corrected DTI must follow the §E formula");
    assert.equal(after.ausStale, true, "a correction after AUS Executed marks the AUS result stale");

    const checksPath = `/api/applications/${application.id}/checks`;
    const checks = expectOk(
      await GET<{ rows: Array<{ checkType: string; isStale?: boolean }> }>(checksPath, { session: caseworker }),
      checksPath,
      200,
    );
    const aus = checks.rows.find((row) => row.checkType === "aus");
    assert.ok(aus, "an AUS result must exist after T11");
    assert.equal(aus.isStale, true, "the AUS result itself must be flagged stale");

    // T15 stays blocked while the AUS result is stale (XBR-008/WF-017).
    const transitionPath = `/api/applications/${application.id}/transition`;
    const blocked = await POST(transitionPath, {
      session: caseworker,
      body: {
        toState: "preliminary_decision",
        versionStamp: after.versionStamp,
        recommendation: "approve",
        note: "Attempted while stale.",
      },
    });
    assert.equal(blocked.status, 409, blocked.text.slice(0, 300));
  });

  test("a correction is recorded with before/after and a reason (REQ-050, NFR-007)", { timeout: 60000 }, async () => {
    const path = `/api/applications/${application.id}/corrections`;
    const page = expectOk(
      await GET<{
        rows: Array<{
          fieldPath: string;
          beforeValue?: string;
          afterValue: string;
          correctedByName: string;
          correctedByRole: string;
          reason: string;
        }>;
      }>(path, { session: caseworker }),
      path,
      200,
    );
    assert.ok(page.rows.length > 0, "the correction must be listed");
    const entry = page.rows[0];
    assert.equal(entry.fieldPath, "employments[0].baseMonthlyIncome");
    assert.equal(entry.afterValue, "4500");
    assert.ok(entry.beforeValue, "a correction must record the prior value");
    assert.ok(entry.correctedByName.length > 0);
    assert.ok(entry.reason.length > 0, "a correction must carry its reason");
  });
});
