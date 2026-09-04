/**
 * §7.7 — every simulation's deterministic mapping and its data-driven fault scenarios,
 * validated against the delivered task-048/simulation-mapping.md.
 *
 * Fault triggers that live in process environment (SIM_FAULT_*) cannot be set through
 * any contracted endpoint against a running server; those are covered by
 * zz-seam-simulation-faults.test.ts via the sanctioned test-only fixture seam.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { GET, expectOk } from "../helpers/http.js";
import { enums } from "../helpers/contract.js";
import {
  awaitCheck,
  getApplication,
  listChecks,
  makeSsn,
  runCheck,
  runChecks,
  type Application,
  type UnderwritingResult,
} from "../helpers/application.js";
import { toDocumentsReceived, type Actors } from "../helpers/workflow.js";

const PREFIX = suitePrefix("sim");

/** §6.3.1 credit scenario key: SSN last digit → tier + base score. */
function creditScenario(digit: number): { tier: string; baseScore: number } {
  if (digit <= 3) return { tier: "good", baseScore: 740 + digit * 10 };
  if (digit <= 6) return { tier: "fair", baseScore: 660 + (digit - 4) * 12 };
  if (digit <= 8) return { tier: "poor", baseScore: 585 + (digit - 7) * 25 };
  return { tier: "good", baseScore: 770 };
}

/** §6.3.1 display tier is derived from the middle (Bureau B) score. */
function riskTierFor(middleScore: number): string {
  if (middleScore >= 700) return "good";
  if (middleScore >= 640) return "fair";
  return "poor";
}

/** §6.3.3 AVM scenario key: ZIP last digit → value factor. */
const AVM_FACTORS: Record<number, number> = {
  0: 0.98,
  1: 0.99,
  2: 1.0,
  3: 1.01,
  4: 1.02,
  5: 1.03,
  6: 0.9,
  7: 0.9,
  8: 0.9,
  9: 1.0,
};

/** §6.3.3 trend by ZIP last digit. */
const AVM_TRENDS: Record<number, string> = {
  0: "rising",
  1: "declining",
  2: "rising",
  3: "declining",
  4: "rising",
  5: "stable",
  6: "rising",
  7: "stable",
  8: "declining",
  9: "stable",
};

const COMPARABLE_MULTIPLIERS = [0.94, 0.98, 1.03, 1.07];

/** §6.3.4 base rate table. */
const BASE_RATES: Record<string, number> = { conventional: 6.5, fha: 6.15, va: 6.05, usda: 6.1 };

let supervisor: Session;
let caseworker: Session;

async function fileAt(label: string, shape: Record<string, unknown>): Promise<Application> {
  const actors: Actors = {
    borrower: (await registerBorrower(supervisor, `${PREFIX}-${label}`)).session,
    caseworker,
    supervisor,
  };
  return toDocumentsReceived(actors, shape);
}

function resultOf(rows: UnderwritingResult[], checkType: string): UnderwritingResult {
  const found = rows.find((row) => row.checkType === checkType);
  assert.ok(found, `no ${checkType} result recorded`);
  return found;
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
});

describe("§6.3.1 credit simulation — deterministic mapping", () => {
  for (const digit of [0, 4, 8]) {
    test(`SSN ending in ${digit} produces the documented tier and bureau spread`, { timeout: 400000 }, async () => {
      const application = await fileAt(`credit${digit}`, { ssn: makeSsn(digit) });
      await runChecks(caseworker, application.id, ["credit"]);
      const result = resultOf(await listChecks(caseworker, application.id), "credit");
      const credit = result.credit as {
        bureauScores: Array<{ bureau: string; score?: number }>;
        middleScore?: number;
        riskTier?: string;
        tradelines?: unknown[];
      };
      const { baseScore } = creditScenario(digit);
      const scores = credit.bureauScores.map((entry) => entry.score).filter((value): value is number => value !== undefined);
      assert.deepEqual(
        [...scores].sort((a, b) => a - b),
        [baseScore - 7, baseScore, baseScore + 5].sort((a, b) => a - b),
        `bureau spread for digit ${digit}`,
      );
      assert.equal(credit.middleScore, baseScore, "the middle score is Bureau A's base score");
      assert.equal(credit.riskTier, riskTierFor(baseScore));
      assert.ok(enums.CreditRiskTier.includes(credit.riskTier ?? ""), "riskTier must be a contract CreditRiskTier");
      assert.equal(credit.tradelines?.length, 4 + (digit % 5), `tradeline count for digit ${digit}`);
    });
  }

  test("the same inputs produce the same output on a re-run (pure function)", { timeout: 400000 }, async () => {
    const application = await fileAt("creditdet", { ssn: makeSsn(2) });
    await runChecks(caseworker, application.id, ["credit"]);
    const first = resultOf(await listChecks(caseworker, application.id), "credit");
    await runChecks(caseworker, application.id, ["credit"]);
    const rows = await listChecks(caseworker, application.id);
    const reruns = rows.filter((row) => row.checkType === "credit");
    assert.ok(reruns.length >= 1);
    const latest = reruns[0];
    assert.deepEqual(
      (latest.credit as { bureauScores: unknown }).bureauScores,
      (first.credit as { bureauScores: unknown }).bureauScores,
      "a deterministic simulation must return identical bureau scores for identical inputs",
    );
  });

  test("SSN ending in 9 is the documented retry scenario (INV-037 collision)", { timeout: 400000 }, async () => {
    // §6.3.1: digit 9 errors on attempt 1 and returns the Good (770) profile on retry —
    // legitimate data colliding with a fault trigger, documented not prevented.
    const application = await fileAt("credit9", { ssn: makeSsn(9) });
    const started = await runCheck(caseworker, application.id, "credit");
    assert.equal(started.status, 202, started.text.slice(0, 200));
    const first = await awaitCheck(caseworker, application.id, "credit");
    assert.ok(["error", "completed"].includes(first.status), `unexpected status ${first.status}`);
    if (first.status === "error") {
      assert.ok(first.error, "an errored check must carry its error text");
      await runChecks(caseworker, application.id, ["credit"]);
      const retried = resultOf(await listChecks(caseworker, application.id), "credit");
      assert.equal(retried.status, "completed", "the retry must succeed per the documented mapping");
      const credit = retried.credit as { middleScore?: number };
      assert.equal(credit.middleScore, 770);
    } else {
      const credit = first.credit as { middleScore?: number };
      assert.equal(credit.middleScore, 770, "digit 9 resolves to the Good (770) profile");
    }
  });
});

describe("§6.3.3 AVM simulation — deterministic mapping", () => {
  for (const digit of [2, 7]) {
    test(`ZIP ending in ${digit} applies factor ${AVM_FACTORS[digit]} and the documented trend`, { timeout: 400000 }, async () => {
      const zip = `4321${digit}`;
      const application = await fileAt(`avm${digit}`, { zip, estimatedValue: 400000, requestedLoanAmount: 300000 });
      await runChecks(caseworker, application.id, ["avm"]);
      const result = resultOf(await listChecks(caseworker, application.id), "avm");
      const avm = result.avm as {
        estimatedValue: number;
        comparables?: Array<{ salePrice: number }>;
        marketTrend?: string;
        confidenceScore?: number;
        valueLow?: number;
        valueHigh?: number;
      };
      const expectedValue = Number((400000 * AVM_FACTORS[digit]).toFixed(2));
      assert.equal(avm.estimatedValue, expectedValue, `AVM value for ZIP digit ${digit}`);
      assert.equal(avm.marketTrend, AVM_TRENDS[digit]);
      assert.ok(enums.MarketTrend.includes(avm.marketTrend ?? ""));
      assert.equal(avm.comparables?.length, 4, "a full response carries 4 synthetic comparables");
      const prices = (avm.comparables ?? []).map((entry) => entry.salePrice).sort((a, b) => a - b);
      const expectedPrices = COMPARABLE_MULTIPLIERS.map((multiplier) =>
        Number((expectedValue * multiplier).toFixed(2)),
      ).sort((a, b) => a - b);
      assert.deepEqual(prices, expectedPrices, "comparable multipliers [0.94, 0.98, 1.03, 1.07]");
      assert.ok(
        (avm.confidenceScore ?? 0) >= 80 && (avm.confidenceScore ?? 0) <= 90,
        `full-response confidence must be 80–90, got ${avm.confidenceScore}`,
      );
      assert.equal(avm.valueLow, Number((expectedValue * 0.95).toFixed(2)));
      assert.equal(avm.valueHigh, Number((expectedValue * 1.05).toFixed(2)));
    });
  }

  test("ZIP ending in 9 is the documented partial response", { timeout: 400000 }, async () => {
    const application = await fileAt("avm9", { zip: "43219", estimatedValue: 400000, requestedLoanAmount: 300000 });
    await runChecks(caseworker, application.id, ["avm"]);
    const result = resultOf(await listChecks(caseworker, application.id), "avm");
    const avm = result.avm as {
      estimatedValue: number;
      comparables?: unknown[];
      marketTrend?: string;
      confidenceScore?: number;
      valueLow?: number;
      valueHigh?: number;
    };
    assert.equal(avm.estimatedValue, 400000, "the partial response echoes the stated value (factor 1.00)");
    assert.equal(avm.confidenceScore, 40);
    assert.ok(!avm.comparables || avm.comparables.length === 0, "the partial response carries no comparables");
    assert.equal(avm.valueLow, undefined);
    assert.equal(avm.valueHigh, undefined);
  });

  test("a low appraisal drives LTV off the AVM value on every surface (§E, ASM-006, AC-13)", { timeout: 400000 }, async () => {
    // ZIP digit 7 → factor 0.90: AVM 360,000 < stated 400,000, so min() picks the AVM.
    const application = await fileAt("avmltv", { zip: "43217", estimatedValue: 400000, requestedLoanAmount: 300000 });
    assert.equal(application.ltv, 75, "before the valuation, LTV uses the stated value");
    await runChecks(caseworker, application.id, ["avm"]);

    const expected = Number(((300000 / 360000) * 100).toFixed(3));
    const result = resultOf(await listChecks(caseworker, application.id), "avm");
    const avm = result.avm as { estimatedValue: number; recomputedLtv?: number };
    assert.equal(result.isStale, false, "a freshly-run AVM is not stale, so it IS available to the LTV formula");
    assert.equal(avm.estimatedValue, 360000);
    assert.equal(avm.recomputedLtv, expected, "the check itself recomputes LTV off the AVM value");

    const qualificationPath = `/api/applications/${application.id}/qualification`;
    const qualification = expectOk(
      await GET<{ ltv?: number; cltv?: number }>(qualificationPath, { session: supervisor }),
      qualificationPath,
      200,
    );
    assert.equal(qualification.ltv, expected, "the qualification card must use min(stated, AVM)");

    const updated = await getApplication(supervisor, application.id);
    assert.equal(
      updated.ltv,
      expected,
      "AC-13: the stored Application.ltv must equal the shared-module value the qualification card reports — " +
        "MISMO #107/#108 and HMDA LAR fields 80/81 read the stored value, so a divergence exports a wrong ratio",
    );
    assert.equal(updated.cltv, expected, "AC-13: the stored CLTV must agree too");
  });
});

describe("§6.3.2 income simulation — deterministic mapping", () => {
  test("verified income lands within ±25% of stated and sets the risk flag above 20%", { timeout: 400000 }, async () => {
    const application = await fileAt("income", { baseMonthlyIncome: 9000 });
    await runChecks(caseworker, application.id, ["income"]);
    const result = resultOf(await listChecks(caseworker, application.id), "income");
    const income = result.income as {
      employments: Array<{
        employerName: string;
        employerVerified: boolean;
        verifiedMonthlyIncome?: number;
        statedMonthlyIncome?: number;
        variancePct?: number;
      }>;
    };
    assert.equal(income.employments.length, 1);
    const row = income.employments[0];
    assert.equal(row.statedMonthlyIncome, 9000);
    assert.ok(row.verifiedMonthlyIncome !== undefined, "verified income must be reported");
    const variance = Math.abs(((row.verifiedMonthlyIncome - 9000) / 9000) * 100);
    assert.ok(variance <= 25.001, `variance ${variance} must sit inside the documented ±25% band`);
    assert.ok(Math.abs((row.variancePct ?? 0) - ((row.verifiedMonthlyIncome - 9000) / 9000) * 100) < 0.011);
  });
});

describe("§6.3.4 pricing simulation — deterministic mapping", () => {
  test("the par rate equals the base table rate plus the documented adjustments", { timeout: 400000 }, async () => {
    const application = await fileAt("pricing", {
      loanType: "conventional",
      estimatedValue: 400000,
      requestedLoanAmount: 300000, // LTV 75% → 0.00 adjustment band 60–80%
      occupancy: "primary-residence", // 0.00
      propertyType: "single-family-detached", // 0.00
      loanPurpose: "purchase",
    });
    await runChecks(caseworker, application.id, ["credit"]);
    await runChecks(caseworker, application.id, ["pricing"]);
    const credit = resultOf(await listChecks(caseworker, application.id), "credit").credit as { middleScore?: number };
    const result = resultOf(await listChecks(caseworker, application.id), "pricing");
    const pricing = result.pricing as {
      baseRate?: number;
      scenarios: Array<{ name: string; interestRate: number; pointsOrCredits?: number }>;
    };
    assert.equal(pricing.baseRate, BASE_RATES.conventional, "conventional 30-year base rate");

    const scoreAdjustment = (score: number): number => {
      if (score >= 740) return 0;
      if (score >= 700) return 0.25;
      if (score >= 660) return 0.625;
      return 1.25;
    };
    const expectedPar = Number((BASE_RATES.conventional + scoreAdjustment(credit.middleScore ?? 0)).toFixed(3));
    const par = pricing.scenarios.find((entry) => entry.name === "par");
    assert.ok(par, "a par scenario must be produced");
    assert.equal(Number(par.interestRate.toFixed(3)), expectedPar);

    const names = pricing.scenarios.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["buy-down", "lender-credit", "par"]);
    for (const name of names) {
      assert.ok(enums.PricingScenarioName.includes(name), `${name} must be a contract PricingScenarioName`);
    }

    const buyDown = pricing.scenarios.find((entry) => entry.name === "buy-down");
    const lenderCredit = pricing.scenarios.find((entry) => entry.name === "lender-credit");
    assert.ok(buyDown && lenderCredit);
    assert.equal(Number((par.interestRate - buyDown.interestRate).toFixed(3)), 0.25, "buy-down is −0.25% for 1 point");
    assert.equal(Number((lenderCredit.interestRate - par.interestRate).toFixed(3)), 0.25, "lender credit is +0.25%");
  });

  test("a $999,999 loan amount is the documented fault collision (INV-037)", { timeout: 400000 }, async () => {
    // §6.3.4: exactly $999,999 triggers the invalid-response scenario. A legitimate
    // loan of that amount hits it — documented, not prevented.
    const application = await fileAt("pricing999", {
      estimatedValue: 1400000,
      requestedLoanAmount: 999999,
    });
    const started = await runCheck(caseworker, application.id, "pricing");
    assert.equal(started.status, 202, started.text.slice(0, 200));
    const settled = await awaitCheck(caseworker, application.id, "pricing");
    assert.equal(settled.status, "error", "the documented invalid-response trigger must surface as an errored check");
    assert.ok(settled.error && settled.error.length > 0, "an errored result must carry the error text");
    assert.ok(enums.CheckStatus.includes(settled.status), "status must be a contract CheckStatus");
  });
});

/**
 * §6.3.9 AUS rules, per the delivered task-048/simulation-mapping.md:
 *   refer-with-caution  score < 620 OR DTI > 50% OR foreclosure/bankruptcy within 7 years
 *   approve-eligible    score >= 660 AND DTI <= 45% AND LTV <= 97% AND no open high fraud
 *                       flags AND no derogatories in 24 months
 *   refer               everything else
 * Refer-with-Caution triggers are evaluated first.
 */
describe("§6.3.9 AUS simulation — deterministic mapping", () => {
  async function ausFor(label: string, shape: Record<string, unknown>) {
    const application = await fileAt(label, shape);
    await runChecks(caseworker, application.id, ["credit", "income", "avm", "pricing"]);
    await runChecks(caseworker, application.id, ["aus"]);
    const result = resultOf(await listChecks(caseworker, application.id), "aus");
    return result.aus as {
      recommendation: string;
      reasons: string[];
      dtiUsed?: number;
      ltvUsed?: number;
      middleScoreUsed?: number;
    };
  }

  test("score >= 660, DTI <= 45 and LTV <= 97 with no flags recommends approve-eligible", { timeout: 400000 }, async () => {
    const aus = await ausFor("aus-approve", {
      ssn: makeSsn(0), // base 740
      estimatedValue: 500000,
      requestedLoanAmount: 350000, // LTV 70%
      baseMonthlyIncome: 12000, // DTI 23%
    });
    assert.ok(enums.AusRecommendation.includes(aus.recommendation), `${aus.recommendation} must be a contract value`);
    assert.ok((aus.middleScoreUsed ?? 0) >= 660, `fixture must clear the 660 floor, got ${aus.middleScoreUsed}`);
    assert.ok((aus.dtiUsed ?? 100) <= 45, `fixture must sit at or under 45% DTI, got ${aus.dtiUsed}`);
    assert.ok((aus.ltvUsed ?? 100) <= 97, `fixture must sit at or under 97% LTV, got ${aus.ltvUsed}`);
    assert.equal(aus.recommendation, "approve-eligible");
    assert.ok(aus.reasons.length > 0, "the recommendation must carry its itemized reasoning");
  });

  test("DTI between the 45% approve ceiling and the 50% caution trigger recommends refer", { timeout: 400000 }, async () => {
    const aus = await ausFor("aus-refer", {
      ssn: makeSsn(1), // base 750 — clear of both score thresholds
      estimatedValue: 500000,
      requestedLoanAmount: 350000, // LTV 70%
      baseMonthlyIncome: 6000, // 2760/6000 = 46% — fails approve-eligible, below the >50 trigger
    });
    assert.ok((aus.middleScoreUsed ?? 0) >= 660, `score ${aus.middleScoreUsed} must clear 660`);
    assert.ok(
      (aus.dtiUsed ?? 0) > 45 && (aus.dtiUsed ?? 0) <= 50,
      `the fixture must land strictly between the 45% ceiling and the 50% trigger, got ${aus.dtiUsed}`,
    );
    assert.equal(
      aus.recommendation,
      "refer",
      "simulation-mapping.md §6.3.9 row 3: an Approve/Eligible condition fails but no Refer-with-Caution trigger fires",
    );
    assert.ok(aus.reasons.length > 0, "refer must itemize which condition failed");
  });

  test("DTI above the 50% trigger recommends refer-with-caution", { timeout: 400000 }, async () => {
    const aus = await ausFor("aus-caution", {
      ssn: makeSsn(1), // base 750 — so the score trigger is NOT what fires
      zip: "43212", // factor 1.00 → AVM equals the stated value
      estimatedValue: 400000,
      requestedLoanAmount: 340000, // LTV 85%
      baseMonthlyIncome: 5000, // 2760/5000 = 55.2% > 50
    });
    assert.ok((aus.middleScoreUsed ?? 0) >= 620, `score ${aus.middleScoreUsed} must be above the 620 trigger`);
    assert.ok((aus.dtiUsed ?? 0) > 50, `the DTI trigger must be the one that fires, got ${aus.dtiUsed}`);
    assert.equal(aus.recommendation, "refer-with-caution");
  });

  test("a sub-620 score triggers refer-with-caution even at a comfortable DTI", { timeout: 400000 }, async () => {
    const aus = await ausFor("aus-lowscore", {
      ssn: makeSsn(7), // base 585 → below the 620 trigger
      estimatedValue: 500000,
      requestedLoanAmount: 350000, // LTV 70%
      baseMonthlyIncome: 12000, // DTI 23% — no DTI trigger
    });
    assert.ok(
      (aus.middleScoreUsed ?? 999) < 620,
      `the score trigger must be the one that fires, got ${aus.middleScoreUsed}`,
    );
    assert.ok((aus.dtiUsed ?? 0) <= 50, `DTI ${aus.dtiUsed} must not also trigger caution`);
    assert.equal(aus.recommendation, "refer-with-caution");
  });
});

describe("§6.3.7 OCR simulation — filename fault triggers (INV-037 collisions)", () => {
  test("the contract's DocumentJobStatus map matches the delivered lifecycle", () => {
    assert.deepEqual(enums.DocumentJobStatus, ["queued", "processing", "completed", "failed"]);
  });

  test("a filename containing `blurry` produces low-confidence fields", { timeout: 400000 }, async () => {
    const application = await fileAt("ocr-blurry", {});
    const { uploadDocument, pdfBytes } = await import("../helpers/application.js");
    const upload = await uploadDocument(
      caseworker,
      application.id,
      "blurry-scan.pdf",
      pdfBytes(2600),
      "pay-stub",
    );
    const document = expectOk(upload, "blurry upload", 201);
    const path = `/api/documents/${document.id}/ocr`;
    const deadline = Date.now() + 90000;
    let extraction: { fields: Array<{ confidence: number }> } | undefined;
    while (Date.now() < deadline && !extraction) {
      const panel = expectOk(
        await GET<{ extraction?: { fields: Array<{ confidence: number }> } }>(path, { session: caseworker }),
        path,
        200,
      );
      extraction = panel.extraction;
      if (!extraction) await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    assert.ok(extraction, "the OCR job must complete");
    assert.ok(extraction.fields.length > 0);
    for (const field of extraction.fields) {
      assert.ok(
        field.confidence >= 30 && field.confidence <= 55,
        `blurry files must land in the 30–55 confidence band, got ${field.confidence}`,
      );
    }
  });

  test("a filename containing `fail` errors the job and stays retryable below the attempt cap", { timeout: 400000 }, async () => {
    const application = await fileAt("ocr-fail", {});
    const { uploadDocument, pdfBytes } = await import("../helpers/application.js");
    const upload = await uploadDocument(caseworker, application.id, "fail-scan.pdf", pdfBytes(2600), "pay-stub");
    const document = expectOk(upload, "fail upload", 201);
    const path = `/api/documents/${document.id}/ocr`;
    const deadline = Date.now() + 120000;
    let job: { status: string; attempt: number; maxAttempts: number } | undefined;
    while (Date.now() < deadline) {
      const panel = expectOk(
        await GET<{ job?: { status: string; attempt: number; maxAttempts: number } }>(path, { session: caseworker }),
        path,
        200,
      );
      job = panel.job;
      if (job && ["failed", "completed"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    assert.ok(job, "a tracked DocumentJob must exist (SEC-13)");
    assert.equal(job.status, "failed", "the documented `fail` trigger must end in the failed job status");
    assert.ok(enums.DocumentJobStatus.includes(job.status));

    const retryPath = `/api/documents/${document.id}/ocr/retry`;
    const { POST } = await import("../helpers/http.js");
    const retry = await POST(retryPath, { session: caseworker });
    assert.equal(retry.status, 202, `manual retry must always be accepted: ${retry.text.slice(0, 200)}`);
  });
});
