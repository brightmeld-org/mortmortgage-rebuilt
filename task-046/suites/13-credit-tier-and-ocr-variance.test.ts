/**
 * §7.7 — two rules that only misbehave on shapes the rest of the suite never
 * builds, so they are exercised here directly against their PURE modules:
 *
 *   INV-040 — CreditCheckResult.riskTier is derived from the FILE-level
 *     qualifyingScore (ASM-003, the lower of the borrowers' middle scores),
 *     never from the primary borrower's middleScore. A single-borrower fixture
 *     cannot tell the two apart; every fixture elsewhere in task-046 runs the
 *     credit check on one borrower.
 *
 *   VR-134 / XBR-017 — variancePct = |extracted − entered| ÷ |entered| × 100
 *     with the borrower-ENTERED value as the denominator, strict (>) thresholds
 *     at 20% (income) and 25% (balance), and an INFINITE variance when entered
 *     is 0 against a non-zero extracted value (a stated $0 against a documented
 *     amount is always material). 04-audit-route-coverage asserts only that
 *     "some open flag exists" — no threshold, boundary, denominator, type or
 *     severity is pinned anywhere.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { composeCreditCheckResult, type BorrowerCreditReport } from "@/lib/pure/simulations/credit";
import {
  ocrMaterialFindings,
  ocrMismatchCandidate,
  OCR_BALANCE_VARIANCE_THRESHOLD_PCT,
  OCR_INCOME_VARIANCE_THRESHOLD_PCT,
  type OcrFieldLike,
} from "@/lib/services/fraud";
import type { BureauScore } from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// INV-040 — file-level risk tier
// ---------------------------------------------------------------------------

function scores(a: number, b: number, c: number): BureauScore[] {
  return [
    { bureau: "Bureau A", score: a },
    { bureau: "Bureau B", score: b },
    { bureau: "Bureau C", score: c },
  ];
}

/** A borrower report carrying only what composeCreditCheckResult consumes. */
function report(bureauScores: BureauScore[], middleScore: number): BorrowerCreditReport {
  return {
    bureauScores,
    middleScore,
    // Deliberately the PER-BORROWER tier: the composer must not pass it through.
    riskTier: middleScore >= 700 ? "good" : middleScore >= 640 ? "fair" : "poor",
    tradelines: [],
    totalUtilizationPct: 20,
    collections: [],
    inquiries12mo: 1,
    reportDate: "2026-08-31",
  };
}

describe("INV-040 riskTier follows the qualifying score, not the primary borrower", () => {
  test("a good primary with a poor co-borrower is a POOR file", () => {
    // Primary {750, 743, 755} → middle 750 (good).
    // Co-borrower {585, 578, 590} → middle 585 (poor).
    // ASM-003 qualifying = min(750, 585) = 585 → the file is poor.
    const result = composeCreditCheckResult(
      report(scores(750, 743, 755), 750),
      report(scores(585, 578, 590), 585),
    );
    assert.equal(result.qualifyingScore, 585, "ASM-003: the lower of the middle scores");
    assert.equal(result.middleScore, 750, "middleScore stays the primary's, for display");
    assert.equal(
      result.riskTier,
      "poor",
      "a 585 qualifying score must never be badged good off the primary's 750",
    );
  });

  test("a poor primary with a good co-borrower is still a POOR file", () => {
    const result = composeCreditCheckResult(
      report(scores(585, 578, 590), 585),
      report(scores(750, 743, 755), 750),
    );
    assert.equal(result.qualifyingScore, 585);
    assert.equal(result.riskTier, "poor");
  });

  test("a single-borrower file qualifies at its own middle score", () => {
    const result = composeCreditCheckResult(report(scores(750, 743, 755), 750), null);
    assert.equal(result.qualifyingScore, 750);
    assert.equal(result.riskTier, "good");
  });

  test("the §4.6.5 band boundaries are 700 and 640, inclusive at the floor", () => {
    const cases: Array<[number, string]> = [
      [700, "good"],
      [699, "fair"],
      [640, "fair"],
      [639, "poor"],
    ];
    for (const [middle, tier] of cases) {
      const result = composeCreditCheckResult(report(scores(middle, middle, middle), middle), null);
      assert.equal(result.riskTier, tier, `qualifying score ${middle} must be ${tier}`);
    }
  });

  test("the co-borrower's tri-bureau middle (not its lowest bureau) is what qualifies", () => {
    // Co-borrower {710, 645, 702} → middle 702, NOT 645.
    const result = composeCreditCheckResult(
      report(scores(750, 743, 755), 750),
      report(scores(710, 645, 702), 702),
    );
    assert.equal(result.qualifyingScore, 702);
    assert.equal(result.riskTier, "good");
  });
});

// ---------------------------------------------------------------------------
// VR-134 — variance denominator, boundaries, and the zero case
// ---------------------------------------------------------------------------

function incomeField(extracted: string, entered: string): OcrFieldLike {
  return { fieldPath: "employments[0].baseMonthlyIncome", extractedValue: extracted, enteredValue: entered };
}

function balanceField(extracted: string, entered: string): OcrFieldLike {
  return { fieldPath: "assets[0].balance", extractedValue: extracted, enteredValue: entered };
}

describe("VR-134 OCR variance thresholds are strict and entered-denominated", () => {
  test("the contract thresholds are 20% (income) and 25% (balance)", () => {
    assert.equal(OCR_INCOME_VARIANCE_THRESHOLD_PCT, 20);
    assert.equal(OCR_BALANCE_VARIANCE_THRESHOLD_PCT, 25);
  });

  test("income: exactly 20% does NOT flag, 20.1% does", () => {
    // entered 10,000 → 12,000 is exactly 20%.
    assert.deepEqual(ocrMaterialFindings([incomeField("12000", "10000")]), []);
    // 12,010 is 20.1%.
    const over = ocrMaterialFindings([incomeField("12010", "10000")]);
    assert.equal(over.length, 1, "20.1% must flag");
    assert.equal(over[0]!.kind, "income");
    assert.equal(over[0]!.identityMismatch, false);
  });

  test("balance: exactly 25% does NOT flag, 25.1% does", () => {
    assert.deepEqual(ocrMaterialFindings([balanceField("12500", "10000")]), []);
    const over = ocrMaterialFindings([balanceField("12510", "10000")]);
    assert.equal(over.length, 1, "25.1% must flag");
    assert.equal(over[0]!.kind, "balance");
  });

  test("the ENTERED value is the denominator, not the extracted one", () => {
    // extracted 100, entered 80 → 25% of 80. Over the 20% income threshold.
    assert.equal(ocrMaterialFindings([incomeField("100", "80")]).length, 1);
    // extracted 80, entered 100 → 20% of 100. Exactly at the threshold, no flag.
    // (Denominated on the extracted 80 it would be 25% and would wrongly flag.)
    assert.deepEqual(ocrMaterialFindings([incomeField("80", "100")]), []);
  });

  test("a stated $0 against a documented non-zero amount is ALWAYS material", () => {
    // The reviewer's counterexample: a bank statement extracting $42,318.55
    // against an entered $0.00. A null-on-zero-denominator guard produces no
    // finding at all; VR-134 makes the variance infinite so the threshold fires.
    const findings = ocrMaterialFindings([balanceField("$42,318.55", "0")]);
    assert.equal(findings.length, 1, "entered 0 vs extracted 42318.55 must flag");
    assert.equal(findings[0]!.kind, "balance");

    const candidate = ocrMismatchCandidate(findings, "doc-version-fixture");
    assert.ok(candidate);
    assert.equal(candidate.type, "ocr-mismatch");
    assert.equal(candidate.severity, "medium", "a value variance is medium; identity mismatches are high");
    assert.equal(candidate.sourceDocumentVersionId, "doc-version-fixture");
    assert.match(candidate.details, /entered value is 0/, "the detail must be legible, not 'Infinity%'");
  });

  test("both zero is 0% variance and never flags", () => {
    assert.deepEqual(ocrMaterialFindings([balanceField("0", "0")]), []);
    assert.deepEqual(ocrMaterialFindings([incomeField("$0.00", "0")]), []);
  });

  test("a stored FINITE variancePct short-circuits; an ABSENT one falls through", () => {
    // Stored and finite: used as-is (30% > 25% balance threshold).
    const stored: OcrFieldLike = { ...balanceField("1", "1"), variancePct: 30 };
    assert.equal(ocrMaterialFindings([stored]).length, 1, "a stored 30% must flag on its own");
    // Absent (the infinite case is not JSON-representable, so the wire omits
    // it): the evaluator must recompute from extracted/entered.
    const absent: OcrFieldLike = balanceField("42318.55", "0");
    assert.equal(absent.variancePct, undefined);
    assert.equal(ocrMaterialFindings([absent]).length, 1, "an absent variancePct must not suppress the flag");
  });

  test("an unmapped field or a missing entered counterpart is tolerated silently", () => {
    assert.deepEqual(ocrMaterialFindings([{ ...balanceField("42318.55", "0"), mapped: false }]), []);
    assert.deepEqual(
      ocrMaterialFindings([{ fieldPath: "assets[0].balance", extractedValue: "42318.55" }]),
      [],
    );
  });

  test("an identity mismatch escalates the candidate to high severity", () => {
    const findings = ocrMaterialFindings([
      { fieldPath: "borrower.dateOfBirth", extractedValue: "1984-03-05", enteredValue: "1984-03-06" },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.identityMismatch, true);
    assert.equal(ocrMismatchCandidate(findings, "doc-version-fixture")!.severity, "high");
  });
});
