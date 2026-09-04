/**
 * §7.7 — the URLA 2020 submission gate (src/lib/pure/urla-validation.ts).
 *
 * The module is THE single authority for required-field validation and the
 * §E-preamble conditional rules, and it gates T1/T36. It is a PURE module, so
 * these are unit tests against it directly — no server, no database.
 *
 * Focus: §E `24-month coverage` (VR-132 address, VR-133 employment), which is
 * the UNION of the covered intervals measured back from the application date
 * with NO gap. Overlapping intervals count once; summing durations is NOT
 * coverage. Two shapes that a duration-sum implementation wrongly accepts are
 * asserted to FAIL here, and a legitimately gap-free 24 months to PASS.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collectValidationIssues,
  coversTrailingWindow,
  coverageInterval,
  type ApplicationValidationInput,
  type BorrowerValidationInput,
  type ValidationIssue,
} from "@/lib/pure/urla-validation";

/** Every fixture is evaluated at this application date (§E window anchor). */
const APPLICATION_DATE = "2026-08-31";

type Rec = Record<string, unknown>;

/**
 * A borrower whose identity/declarations/demographics are irrelevant here —
 * the assertions target one fieldPath at a time, never the overall `ok`.
 */
function borrower(overrides: Partial<BorrowerValidationInput> = {}): BorrowerValidationInput {
  return {
    ordinal: 1,
    firstName: "Ada",
    lastName: "Lovelace",
    hasSsn: true,
    dateOfBirth: "1984-03-05",
    citizenship: "us-citizen",
    maritalStatus: "unmarried",
    cellPhone: "614-555-0100",
    email: "ada@example.com",
    creditType: "individual",
    militaryService: { served: false },
    currentAddress: { street: "1 Main St", city: "Columbus", state: "OH", zip: "43215" },
    housingStatus: "own",
    yearsAtAddress: 3,
    monthsAtAddress: 0,
    previousAddresses: [],
    employmentType: "employed",
    employments: [],
    previousEmployments: [],
    ...overrides,
  };
}

function input(b: BorrowerValidationInput): ApplicationValidationInput {
  return {
    borrowers: [b],
    data: null,
    ltv: null,
    ltvWarningPercent: 90,
    ltvSubmissionBlockPercent: 97,
    applicationDate: APPLICATION_DATE,
    signedOrdinals: [],
  };
}

function issuesFor(b: BorrowerValidationInput, fieldPath: string): ValidationIssue[] {
  return collectValidationIssues(input(b)).filter((i) => i.fieldPath === fieldPath);
}

/**
 * Every address-history issue whose fieldPath is rooted at previousAddresses —
 * the generic gap message (`previousAddresses`) AND the per-row missing-date
 * errors (`previousAddresses[0].fromDate`) VR-132 raises after CH-016.
 */
function addressCoverageIssues(b: BorrowerValidationInput): ValidationIssue[] {
  return collectValidationIssues(input(b)).filter(
    (i) => i.section === "address-history" && i.fieldPath.startsWith("previousAddresses"),
  );
}

/** One current employment starting on `startDate`, with income filled in. */
function job(startDate: string, employerName = "Union Fixture Co"): Rec {
  return { employerName, startDate, selfEmployed: false, baseMonthlyIncome: 8000 };
}

describe("§E 24-month EMPLOYMENT coverage is a gap-free union (VR-133)", () => {
  test("two CONCURRENT jobs are not 26 months of history — the union is 14", () => {
    // Both started 2025-07-01; a duration SUM reads 13 + 13 = 26 >= 24 and
    // passes. The union back from 2026-08-31 is 14 months — a hole from
    // 2024-08-31 to 2025-07-01 remains.
    const b = borrower({ employments: [job("2025-07-01", "Job A"), job("2025-07-01", "Job B")] });
    const found = issuesFor(b, "previousEmployments");
    assert.equal(found.length, 1, "overlapping concurrent jobs must not satisfy 24-month coverage");
    assert.equal(found[0]!.severity, "error");
    assert.equal(found[0]!.section, "employment-income");
  });

  test("a 23-year hole is not covered by 26 summed months", () => {
    // 2 current months + a 24-month span that ended in 2003: a duration SUM
    // reads 26 >= 24 and passes; the union leaves 2024-08-31 → 2026-07-01 open.
    const b = borrower({
      employments: [job("2026-07-01")],
      previousEmployments: [
        {
          employerName: "Ancient History Inc",
          startDate: "2001-01-01",
          endDate: "2003-01-01",
        },
      ],
    });
    const found = issuesFor(b, "previousEmployments");
    assert.equal(found.length, 1, "a gap anywhere in the trailing 24 months must fail the gate");
  });

  test("a genuinely gap-free 24 months passes", () => {
    // Current job from 2025-01-01 → application date (20 months), preceded by
    // 2023-06-01 → 2025-01-01. The union reaches back past 2024-08-31.
    const b = borrower({
      employments: [job("2025-01-01")],
      previousEmployments: [
        { employerName: "Prior Employer LLC", startDate: "2023-06-01", endDate: "2025-01-01" },
      ],
    });
    assert.deepEqual(issuesFor(b, "previousEmployments"), []);
  });

  test("adjoining spans that touch exactly leave no gap", () => {
    const b = borrower({
      employments: [job("2026-02-28")],
      previousEmployments: [
        { employerName: "Prior Employer LLC", startDate: "2024-01-01", endDate: "2026-02-28" },
      ],
    });
    assert.deepEqual(issuesFor(b, "previousEmployments"), []);
  });

  test("a single current job of 24+ months covers the window on its own", () => {
    assert.deepEqual(issuesFor(borrower({ employments: [job("2024-01-01")] }), "previousEmployments"), []);
  });

  test("a single current job one month short fails", () => {
    const found = issuesFor(borrower({ employments: [job("2024-09-15")] }), "previousEmployments");
    assert.equal(found.length, 1, "a partial month at the far end of the window is still a gap");
  });
});

describe("§E 24-month ADDRESS coverage (VR-132)", () => {
  const ADDRESS = { street: "9 Prior Ln", city: "Columbus", state: "OH", zip: "43201" };

  test("fully dated history with a gap fails", () => {
    const b = borrower({
      yearsAtAddress: 0,
      monthsAtAddress: 2, // current address anchored 2026-06-30 → 2026-08-31
      previousAddresses: [
        // Ends long before the current address begins.
        { address: ADDRESS, fromDate: "2001-01-01", toDate: "2003-01-01" },
      ],
    });
    const found = issuesFor(b, "previousAddresses");
    assert.equal(found.length, 1, "a dated address history with a hole must fail the gate");
  });

  test("fully dated, gap-free history passes", () => {
    const b = borrower({
      yearsAtAddress: 1,
      monthsAtAddress: 0, // 2025-08-31 → 2026-08-31
      previousAddresses: [{ address: ADDRESS, fromDate: "2023-01-01", toDate: "2025-08-31" }],
    });
    assert.deepEqual(issuesFor(b, "previousAddresses"), []);
  });

  test("fully dated CONCURRENT previous addresses do not sum to coverage", () => {
    const b = borrower({
      yearsAtAddress: 0,
      monthsAtAddress: 1,
      previousAddresses: [
        { address: ADDRESS, fromDate: "2025-07-31", toDate: "2026-07-31" },
        { address: ADDRESS, fromDate: "2025-07-31", toDate: "2026-07-31" },
      ],
    });
    const found = issuesFor(b, "previousAddresses");
    assert.equal(found.length, 1, "two overlapping 12-month spans are 12 months of coverage, not 24");
  });

  test("no previous addresses: 24+ months at the current address covers the window", () => {
    assert.deepEqual(
      issuesFor(borrower({ yearsAtAddress: 2, monthsAtAddress: 0 }), "previousAddresses"),
      [],
    );
    assert.equal(
      issuesFor(borrower({ yearsAtAddress: 1, monthsAtAddress: 11 }), "previousAddresses").length,
      1,
    );
  });
});

/**
 * LENS-005 / CH-016: the duration-sum fallback is GONE. Previously, any
 * previousAddresses row missing fromDate or toDate sent the whole history down
 * a `sum(yearsAtAddress*12 + monthsAtAddress) >= 24` path with no overlap or
 * gap detection — a bypass reachable by any new submission that left the dates
 * blank, because both fields are `.optional()` on the wire. VR-132 now has one
 * path: the gap-free union, plus a named field error per undatable row.
 */
describe("VR-132 after CH-016: no duration-sum fallback (LENS-005)", () => {
  const ADDRESS = { street: "9 Prior Ln", city: "Columbus", state: "OH", zip: "43201" };

  test("(a) two OVERLAPPING 24-month prior addresses fail — 24 + 24 is not 48", () => {
    // Identical 24-month spans that both END 12 months before the application
    // date. The old duration sum read 48 >= 24 and passed; the union covers
    // only 2025-08-31 → 2026-08-31 (12 months) plus the 1-month current
    // address, leaving 2024-08-31 → 2025-08-31 open.
    const b = borrower({
      yearsAtAddress: 0,
      monthsAtAddress: 1,
      previousAddresses: [
        { address: ADDRESS, fromDate: "2023-08-31", toDate: "2025-08-31", yearsAtAddress: 2, monthsAtAddress: 0 },
        { address: ADDRESS, fromDate: "2023-08-31", toDate: "2025-08-31", yearsAtAddress: 2, monthsAtAddress: 0 },
      ],
    });
    const found = addressCoverageIssues(b);
    assert.equal(found.length, 1, "overlapping 24-month spans are 24 months of coverage, not 48");
    assert.equal(found[0]!.fieldPath, "previousAddresses");
    assert.equal(found[0]!.severity, "error");
    assert.match(found[0]!.message, /no gaps/);
  });

  test("(b) an INTERIOR gap fails even though every span is dated", () => {
    // Current address covers the last 6 months; the prior span ends 12 months
    // before the application date. The hole is 2025-08-31 → 2026-02-28 —
    // interior to the window, with covered months on BOTH sides of it. The old
    // duration sum read 6 + 24 = 30 >= 24 and passed.
    const b = borrower({
      yearsAtAddress: 0,
      monthsAtAddress: 6,
      previousAddresses: [
        { address: ADDRESS, fromDate: "2023-08-31", toDate: "2025-08-31", yearsAtAddress: 2, monthsAtAddress: 0 },
      ],
    });
    const found = addressCoverageIssues(b);
    assert.equal(found.length, 1, "a hole between two covered stretches must fail the gate");
    assert.equal(found[0]!.fieldPath, "previousAddresses");
  });

  test("(c) an UNDATABLE row fails with a field error naming the missing dates", () => {
    // The exact bypass LENS-005 reported: durations only, no fromDate/toDate.
    // 12 + 12 = 24 used to pass. It now fails, and the message says which
    // dates are missing rather than the generic "add previous addresses".
    const b = borrower({
      yearsAtAddress: 1,
      monthsAtAddress: 0,
      previousAddresses: [{ address: ADDRESS, yearsAtAddress: 1, monthsAtAddress: 0 }],
    });
    const found = addressCoverageIssues(b);
    assert.equal(found.length, 2, "one error for the missing move-in date, one for the move-out");
    assert.deepEqual(
      found.map((i) => i.fieldPath).sort(),
      ["previousAddresses[0].fromDate", "previousAddresses[0].toDate"],
    );
    for (const i of found) {
      assert.equal(i.severity, "error");
      assert.equal(i.section, "address-history");
      assert.equal(i.borrowerOrdinal, 1);
      assert.match(i.message, /Previous address 1 is missing its move-(in|out) date/);
    }
    // The generic gap message is NOT stacked on top of the named ones.
    assert.deepEqual(issuesFor(b, "previousAddresses"), []);
  });

  test("(c2) a row missing only ONE endpoint names just that endpoint", () => {
    const missingTo = borrower({
      yearsAtAddress: 1,
      monthsAtAddress: 0,
      previousAddresses: [{ address: ADDRESS, fromDate: "2023-01-01" }],
    });
    const found = addressCoverageIssues(missingTo);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.fieldPath, "previousAddresses[0].toDate");
    assert.match(found[0]!.message, /missing its move-out date/);

    const missingFrom = borrower({
      yearsAtAddress: 1,
      monthsAtAddress: 0,
      previousAddresses: [{ address: ADDRESS, toDate: "2025-08-31" }],
    });
    const found2 = addressCoverageIssues(missingFrom);
    assert.equal(found2.length, 1);
    assert.equal(found2[0]!.fieldPath, "previousAddresses[0].fromDate");
    assert.match(found2[0]!.message, /missing its move-in date/);
  });

  test("(c3) an undatable row contributes NO coverage even when the rest of the history is fine", () => {
    // A fully-dated, gap-free history plus one stray durations-only row. The
    // stray row must still fail the gate — "any undatable row fails".
    const b = borrower({
      yearsAtAddress: 1,
      monthsAtAddress: 0,
      previousAddresses: [
        { address: ADDRESS, fromDate: "2023-01-01", toDate: "2025-08-31" },
        { address: ADDRESS, yearsAtAddress: 5, monthsAtAddress: 0 },
      ],
    });
    const found = addressCoverageIssues(b);
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((i) => i.fieldPath).sort(),
      ["previousAddresses[1].fromDate", "previousAddresses[1].toDate"],
    );
  });

  test("(d) a genuinely gap-free, fully dated history still passes", () => {
    const b = borrower({
      yearsAtAddress: 1,
      monthsAtAddress: 0, // current address 2025-08-31 → 2026-08-31
      previousAddresses: [
        { address: ADDRESS, fromDate: "2022-06-01", toDate: "2024-03-01" },
        { address: ADDRESS, fromDate: "2024-03-01", toDate: "2025-08-31" },
      ],
    });
    assert.deepEqual(addressCoverageIssues(b), []);
  });

  test("(e) zero previous addresses and 24+ months at the current address passes", () => {
    const b = borrower({ yearsAtAddress: 2, monthsAtAddress: 3, previousAddresses: [] });
    assert.deepEqual(addressCoverageIssues(b), []);
    // ...and the same borrower with previousAddresses absent entirely.
    const b2 = borrower({ yearsAtAddress: 2, monthsAtAddress: 3, previousAddresses: null });
    assert.deepEqual(addressCoverageIssues(b2), []);
  });

  test("VR-132 and VR-133 are now symmetrical: neither has a duration-sum path", () => {
    // The same fixture shape that used to pass VR-132 via durations fails, and
    // the employment sibling never had the fallback to begin with.
    const b = borrower({
      yearsAtAddress: 1,
      monthsAtAddress: 0,
      previousAddresses: [{ address: ADDRESS, yearsAtAddress: 1, monthsAtAddress: 0 }],
      employments: [job("2025-08-31")],
      previousEmployments: [{ employerName: "Prior", yearsInLineOfWork: 1 }],
    });
    assert.ok(addressCoverageIssues(b).length > 0, "address history fails without dates");
    assert.equal(issuesFor(b, "previousEmployments").length, 1, "employment history fails without dates");
  });
});

describe("§E coverage primitives", () => {
  const APP_MS = new Date(APPLICATION_DATE).getTime();

  test("an absent end date anchors at the application date", () => {
    const span = coverageInterval("2025-07-01", null, APP_MS);
    assert.ok(span);
    assert.equal(span.end, APP_MS);
  });

  test("inverted and zero-length spans cover nothing", () => {
    assert.equal(coverageInterval("2025-07-01", "2025-07-01", APP_MS), null);
    assert.equal(coverageInterval("2025-07-01", "2024-07-01", APP_MS), null);
    assert.equal(coverageInterval(undefined, null, APP_MS), null);
  });

  test("overlapping intervals count once", () => {
    const a = coverageInterval("2025-07-01", null, APP_MS)!;
    const b2 = coverageInterval("2025-07-01", null, APP_MS)!;
    assert.equal(coversTrailingWindow([a, b2], APPLICATION_DATE), false);
  });

  test("an empty interval set never covers the window", () => {
    assert.equal(coversTrailingWindow([], APPLICATION_DATE), false);
  });
});
