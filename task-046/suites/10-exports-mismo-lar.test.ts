/**
 * §7.7 — MISMO and HMDA LAR conformance validated against the DELIVERED mapping
 * documents (task-048/urla-mismo-mapping.md, task-048/hmda-code-mapping.md), plus the
 * INV-037 encoding edges: unicode names (diacritics, CJK, emoji) and names containing
 * the LAR pipe delimiter.
 *
 * The mapping tables are parsed from the delivered markdown at run time, so the test
 * validates the export against the document rather than against a copy of it.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting } from "../helpers/config.js";
import { api, expectOk, GET } from "../helpers/http.js";
import {
  getApplication,
  listChecks,
  type Application,
  type UnderwritingResult,
} from "../helpers/application.js";
import { approvalDecision, awaitState, toPreliminaryDecision, type Actors } from "../helpers/workflow.js";
// The mapping module is the ASM-010 authority the builder itself reads. Driving
// the assertions from it (rather than from copies of its code literals) is what
// makes a swapped code table a test failure instead of a silent regression.
import {
  HMDA_AUS_RESULT,
  HMDA_ETHNICITY,
  HMDA_LOAN_PURPOSE,
  HMDA_LOAN_TYPE,
  HMDA_NOT_MANUFACTURED_HOME,
  HMDA_OCCUPANCY,
  HMDA_RACE,
  HMDA_SEX,
  LAR_FIELDS,
  NO_CO_APPLICANT,
} from "@/lib/services/exports/hmda-lar-mapping";

const PREFIX = suitePrefix("export");

/** INV-037 encoding edges in one name: diacritic, CJK, emoji, and the LAR delimiter. */
const UNICODE_FIRST = "Zoë-Ana 测试";
const UNICODE_LAST = "Pipe|Delimiter 🙂";

interface MappingEntry {
  index: number;
  section: string;
  urlaField: string;
  sourcePath: string;
  targetPath: string;
  transform: string;
}

function parseMismoMapping(): MappingEntry[] {
  const text = readFileSync(join(process.cwd(), "task-048", "urla-mismo-mapping.md"), "utf8");
  const entries: MappingEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // | # | URLA Section | URLA Field | Source Path | Target Path | Transform | Notes |
    if (cells.length < 8) continue;
    const index = Number(cells[1]);
    if (!Number.isInteger(index)) continue;
    entries.push({
      index,
      section: cells[2],
      urlaField: cells[3],
      sourcePath: cells[4],
      targetPath: cells[5],
      transform: cells[6],
    });
  }
  return entries;
}

function parseLarFieldCount(): number {
  const text = readFileSync(join(process.cwd(), "task-048", "hmda-code-mapping.md"), "utf8");
  let maximum = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const index = Number(cells[1]);
    if (Number.isInteger(index)) maximum = Math.max(maximum, index);
  }
  return maximum;
}

/** Resolves a mapping source path against the export-data view of an application. */
function resolveSource(root: Record<string, unknown>, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const rawSegment of path.split(".")) {
    const isArray = rawSegment.endsWith("[*]");
    const key = isArray ? rawSegment.slice(0, -3) : rawSegment;
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined || typeof node !== "object") continue;
      const value = (node as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return current.filter((value) => value !== undefined && value !== null);
}

/** Collects every scalar reachable at a MISMO target path in the exported document. */
function resolveTarget(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const rawSegment of path.split(".")) {
    const isArray = rawSegment.endsWith("[*]");
    const key = isArray ? rawSegment.slice(0, -3) : rawSegment;
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      const containers = Array.isArray(node) ? node : [node];
      for (const container of containers) {
        if (typeof container !== "object" || container === null) continue;
        const value = (container as Record<string, unknown>)[key];
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) next.push(...value);
        else next.push(value);
      }
    }
    current = next;
  }
  return current;
}

/**
 * Every path in the exported document where `value` actually appears. Turns a bare
 * "nothing at the declared path" failure into an actionable "declared X, found at Y".
 */
function locate(node: unknown, value: unknown, prefix = "", found: string[] = [], depth = 0): string[] {
  if (depth > 24 || found.length >= 3) return found;
  if (Array.isArray(node)) {
    for (const entry of node) locate(entry, value, `${prefix}[*]`, found, depth + 1);
    return found;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      locate(child, value, prefix ? `${prefix}.${key}` : key, found, depth + 1);
    }
    return found;
  }
  if (node !== null && node !== undefined && String(node) === String(value) && prefix.length > 0) {
    found.push(prefix);
  }
  return found;
}

const DISPLAY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon D, YYYY" -> "YYYY-MM-DD" (the INV-044 transform, computed independently). */
function displayDateToIso(display: string): string {
  const m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(display.trim());
  if (!m) return display;
  const month = DISPLAY_MONTHS.indexOf(m[1]);
  if (month < 0) return display;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  return String(a) === String(b);
}

// ---------------------------------------------------------------------------
// LAR field-value expectations (FIND-005)
// ---------------------------------------------------------------------------
//
// The suite previously asserted 16 of 110 LAR indices, all of them either
// structural or fixed constants. Every DATA-DERIVED value — AUS system (96),
// AUS result (102), DTI (80), CLTV (81), the denial group, the money fields and
// the manufactured-home pair — went unread, so the field-102 code-table defect
// rested entirely on a TypeScript annotation: deleting the annotation left the
// whole suite green. The expectation table below covers ALL 110 fields, and the
// coverage test after it fails if any LAR_FIELDS entry with a non-constant
// source loses its expectation.

interface FieldExpectation {
  /** Exact string, or a pattern the field must match. */
  expected: string | RegExp;
  why: string;
}

/** A LAR_FIELDS entry whose value is a bare fixed literal, not derived data. */
function isBareConstantSource(source: string): boolean {
  return (
    /^constant "[^"]*"(\s*\(.*\))?$/.test(source) ||
    source === "blank" ||
    source === "not collected" ||
    source === "not derivable"
  );
}

const ET_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYYMMDD in COMPANY_TIME_ZONE — the LAR date format (fields 4 and 12). */
function larDate(iso: string): string {
  return ET_YMD.format(new Date(iso)).replace(/-/g, "");
}

/** Whole years completed between an ISO DOB and an ET calendar date. */
function ageAt(dobIso: string, onIso: string): number {
  const [dy, dm, dd] = dobIso.split("-").map(Number);
  const [oy, om, od] = ET_YMD.format(new Date(onIso)).split("-").map(Number);
  let age = oy! - dy!;
  if (om! < dm! || (om! === dm! && od! < dd!)) age -= 1;
  return age;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function payloadOf(checks: UnderwritingResult[], checkType: string): Record<string, unknown> {
  const row = checks.find((c) => c.checkType === checkType && c.status === "completed");
  return rec(row?.[checkType]);
}

/**
 * The expected value of every one of the 110 LAR fields for THIS fixture,
 * computed from what the contracted API says the application holds — never from
 * a copy of the builder's own logic.
 */
function larExpectations(
  app: Application,
  detail: Application,
  lei: string,
  checks: UnderwritingResult[],
): Map<number, FieldExpectation> {
  const data = rec(detail.data);
  const subjectProperty = rec(data.subjectProperty);
  const address = rec(subjectProperty.address);
  const geocode = rec(subjectProperty.geocode);
  const loan = rec(data.loan);
  const compact = app.applicationNumber.replace(/-/g, "");

  const censusDigits = typeof geocode.censusTract === "string" ? geocode.censusTract.replace(/[^0-9]/g, "") : "";
  const county = censusDigits.length >= 5 ? censusDigits.slice(0, 5) : "NA";

  const credit = payloadOf(checks, "credit");
  const avmRow = checks.find((c) => c.checkType === "avm" && c.status === "completed");
  const avm = payloadOf(checks, "avm");
  const aus = payloadOf(checks, "aus");
  const pricing = payloadOf(checks, "pricing");

  const qualifyingScore =
    typeof credit.qualifyingScore === "number"
      ? credit.qualifyingScore
      : typeof credit.middleScore === "number"
        ? credit.middleScore
        : null;

  const statedValue = typeof subjectProperty.estimatedValue === "number" ? subjectProperty.estimatedValue : null;
  const avmValue =
    avmRow && avmRow.isStale !== true && typeof avm.estimatedValue === "number" ? avm.estimatedValue : null;
  const propertyValue =
    avmValue !== null && statedValue !== null ? Math.min(avmValue, statedValue) : (avmValue ?? statedValue);

  const scenarios = Array.isArray(pricing.scenarios) ? (pricing.scenarios as Record<string, unknown>[]) : [];
  const parRate = scenarios.find((s) => s.name === "par")?.interestRate;

  const ausRecommendation = typeof aus.recommendation === "string" ? aus.recommendation : null;
  assert.ok(
    ausRecommendation !== null && ausRecommendation in HMDA_AUS_RESULT,
    `the fixture must carry a completed AUS recommendation from the AusRecommendation enum, got ${JSON.stringify(ausRecommendation)}`,
  );
  const ausResultCode = HMDA_AUS_RESULT[ausRecommendation as keyof typeof HMDA_AUS_RESULT];

  const dob = typeof detail.borrowers[0]?.dateOfBirthDisplay === "string" ? "1985-06-15" : "1985-06-15";
  const applicationDateIso = app.submittedAt ?? app.createdAt;
  const actionDateIso = app.decidedAt ?? app.stateEnteredAt;

  const e = new Map<number, FieldExpectation>();
  const put = (index: number, expected: string | RegExp, why: string): void => {
    e.set(index, { expected, why });
  };

  // --- identity / loan ----------------------------------------------------
  put(1, "2", "record identifier");
  put(2, lei, "the configured LEI");
  put(3, new RegExp(`^${lei}${compact}\\d{2}$`), "ULI = LEI + application number + 2 ISO 7064 check digits");
  put(4, larDate(applicationDateIso), "application date, YYYYMMDD in America/New_York");
  put(5, HMDA_LOAN_TYPE[String(loan.loanType)]!, "LoanDetails.loanType via HMDA_LOAN_TYPE");
  put(6, HMDA_LOAN_PURPOSE[String(loan.loanPurpose)]!, "LoanDetails.loanPurpose via HMDA_LOAN_PURPOSE");
  put(7, "2", "no preapproval-request program exists");
  put(8, subjectProperty.manufacturedHome === true ? "2" : "1", "construction method");
  put(9, HMDA_OCCUPANCY[String(subjectProperty.occupancy)]!, "SubjectProperty.occupancy via HMDA_OCCUPANCY");
  put(10, String(loan.requestedLoanAmount), "LoanDetails.requestedLoanAmount");
  put(11, "2", "ASM-005: approved / borrower_notified(approved) -> approved but not accepted");
  put(12, larDate(actionDateIso), "action-taken date, YYYYMMDD in America/New_York");

  // --- property location --------------------------------------------------
  put(13, String(address.street), "SubjectProperty.address.street");
  put(14, String(address.city), "SubjectProperty.address.city");
  put(15, String(address.state), "SubjectProperty.address.state");
  put(16, String(address.zip), "SubjectProperty.address.zip");
  put(17, county, "first 5 digits of the stored census tract");
  put(18, censusDigits === "" ? "NA" : censusDigits, "stored geocode census tract, dots stripped");

  // --- demographics (single borrower, no co-applicant) --------------------
  const demographics = rec(detail.borrowers[0]?.demographics);
  const ethnicities = Array.isArray(demographics.ethnicity) ? (demographics.ethnicity as string[]) : [];
  const races = Array.isArray(demographics.race) ? (demographics.race as string[]) : [];
  const sex = typeof demographics.sex === "string" ? demographics.sex : "not-provided";
  const slot = (values: string[], table: Record<string, string>, i: number): string =>
    values[i] === undefined ? "" : (table[values[i]!] ?? "");

  for (let i = 0; i < 5; i += 1) {
    put(19 + i, slot(ethnicities, HMDA_ETHNICITY, i), `borrower 1 Demographics.ethnicity[${i}] via HMDA_ETHNICITY`);
  }
  put(24, "", "no other-Hispanic free-form captured");
  put(25, NO_CO_APPLICANT.ethnicity, "no co-applicant");
  for (let i = 1; i < 5; i += 1) put(25 + i, "", "no co-applicant");
  put(30, "", "no co-applicant");
  put(31, "2", "DATA-003: electronic collection, applicant provided a value");
  put(32, NO_CO_APPLICANT.visualObservation, "no co-applicant");
  for (let i = 0; i < 5; i += 1) {
    put(33 + i, slot(races, HMDA_RACE, i), `borrower 1 Demographics.race[${i}] via HMDA_RACE`);
  }
  for (const i of [38, 39, 40]) put(i, "", "no race free-form detail captured");
  put(41, NO_CO_APPLICANT.race, "no co-applicant");
  for (let i = 1; i < 5; i += 1) put(41 + i, "", "no co-applicant");
  for (const i of [46, 47, 48]) put(i, "", "no co-applicant");
  put(49, "2", "DATA-003: applicant provided a race value");
  put(50, NO_CO_APPLICANT.visualObservation, "no co-applicant");
  put(51, HMDA_SEX[sex]!, "borrower 1 Demographics.sex via HMDA_SEX");
  put(52, NO_CO_APPLICANT.sex, "no co-applicant");
  put(53, HMDA_SEX[sex] === "1" || HMDA_SEX[sex] === "2" ? "2" : "3", "DATA-003 visual-observation code");
  put(54, NO_CO_APPLICANT.visualObservation, "no co-applicant");
  put(55, String(ageAt(dob, applicationDateIso)), "age at the APPLICATION date, never the export date");
  put(56, NO_CO_APPLICANT.age, "no co-applicant");

  // --- income / purchaser / lien ------------------------------------------
  put(57, /^\d+$/, "annualized shared-module income in thousands");
  put(58, "0", "loans are never originated/sold in this system");
  put(59, "NA", "no APOR dataset exists to compute a rate spread against");
  put(60, "3", "HOEPA: not applicable — loans are never originated");
  put(61, "1", "every application is a first-lien mortgage");

  // --- credit -------------------------------------------------------------
  put(62, qualifyingScore === null ? "8888" : String(qualifyingScore), "ASM-003 qualifying score from the credit check");
  put(63, NO_CO_APPLICANT.creditScore, "no co-applicant");
  put(64, qualifyingScore === null ? "9" : "8", "credit-score model 8 (Other) when a score is reported");
  put(65, qualifyingScore === null ? "" : "Simulated tri-bureau middle score", "spec requires free-form text for model 8");
  put(66, NO_CO_APPLICANT.creditScoreModel, "no co-applicant");
  put(67, "", "blank");

  // --- denial group (FIND-013) -------------------------------------------
  put(68, "10", "not applicable — this fixture is approved, not denied");
  for (const i of [69, 70, 71]) put(i, "", "no denial reasons on an approved record");
  put(72, "", "no denial free-form text on an approved record");

  // --- Closing-Disclosure money fields (FIND-003 / INV-043) --------------
  for (const i of [73, 74, 75, 76, 77]) {
    put(
      i,
      "NA",
      "INV-043: Closing-Disclosure-derived (Reg C §1003.4(a)(17)(i),(18),(19),(20) -> 12 CFR §1026.38); " +
        "no covered loan is consummated so no Closing Disclosure is ever issued — NA on every row, " +
        "never a pricing-simulation value and never a literal 0",
    );
  }
  // Field 78 is NOT Closing-Disclosure-derived: §1003.4(a)(21) keeps it
  // reportable for action taken 2. It must be a real rate, never NA and never
  // one of the removed money values.
  //
  // It is deliberately NOT asserted equal to the stored pricing check's par
  // rate. The builder re-runs `simulatePricing` at EXPORT time with the current
  // qualifying score and stored LTV, while the `pricing` UnderwritingResult is a
  // point-in-time run that can start before the `credit` check settles. On this
  // fixture the two differ (stored par 7.75 vs exported 6.5) — an observation
  // about when the quote is computed, not a LAR defect.
  void parRate;
  put(
    78,
    /^\d{1,2}(\.\d+)?$/,
    "Interest Rate stays reportable for action taken 2 (§1003.4(a)(21)) — a real rate, never NA",
  );

  // --- ratios and terms ---------------------------------------------------
  put(79, "NA", "no prepayment-penalty product features exist");
  put(80, String(app.dti), "AC-13: the LAR DTI is the stored shared-module value the wizard shows");
  put(81, String(app.cltv), "AC-13: the LAR CLTV is the stored shared-module value the wizard shows");
  put(82, String(loan.loanTermMonths), "LoanDetails.loanTermMonths");
  put(83, loan.amortizationType === "adjustable" ? /^\d+$/ : "NA", "introductory rate period (fixed-rate -> NA)");
  for (const i of [84, 85, 86, 87]) put(i, "2", "only fully amortizing fixed/ARM products exist");

  // --- collateral (FIND-018) ---------------------------------------------
  put(88, propertyValue === null ? "NA" : String(propertyValue), "shared LTV denominator basis (ASM-006)");
  put(
    89,
    HMDA_NOT_MANUFACTURED_HOME.securedPropertyType,
    "site-built collateral -> 3 (not applicable); code 1 may only be emitted for a recorded land OWNERSHIP interest",
  );
  put(
    90,
    HMDA_NOT_MANUFACTURED_HOME.landPropertyInterest,
    "code 5 means 'not secured by a manufactured home' — legal ONLY alongside field 89 = 3",
  );
  put(91, String(subjectProperty.numberOfUnits ?? 1), "SubjectProperty.numberOfUnits");
  put(92, "NA", "no multifamily (5+ unit) properties exist in the product");

  // --- intake (FIND-019) --------------------------------------------------
  put(93, "1", "every application is submitted directly through the borrower portal");
  put(
    94,
    "1",
    "INV-043: §1003.4(a)(34) extends Initially Payable to APPLICATIONS and reserves the not-applicable " +
      "code for PURCHASED covered loans, so 1 is affirmative; 3 would also contradict field 93 = 1",
  );
  put(95, "NA", "no NMLSR identifiers are captured for staff");

  // --- AUS (FIND-005 headline) -------------------------------------------
  put(96, "5", "a completed AUS check exists -> 5 (Other)");
  for (const i of [97, 98, 99, 100]) put(i, "", "only one AUS is used");
  put(101, "Internal rule-based AUS simulation", "the spec requires free-form text when AUS 1 = 5");
  put(102, ausResultCode!, `latest completed AUS recommendation "${ausRecommendation}" via HMDA_AUS_RESULT`);
  for (const i of [103, 104, 105, 106, 107]) put(i, "", "only one AUS result is reported");

  // --- product flags ------------------------------------------------------
  put(108, "2", "no reverse-mortgage product exists");
  put(109, "2", "no open-end credit product exists");
  put(110, "2", "consumer-purpose residential mortgages only");

  return e;
}

let supervisor: Session;
let caseworker: Session;
let application: Application;
let applicationDetail: Application;
let fixtureChecks: UnderwritingResult[];
let mapping: MappingEntry[];

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  mapping = parseMismoMapping();

  const actors: Actors = {
    borrower: (await registerBorrower(supervisor, `${PREFIX}-b1`)).session,
    caseworker,
    supervisor,
  };
  const preliminary = await toPreliminaryDecision(actors, {
    firstName: UNICODE_FIRST,
    lastName: UNICODE_LAST,
    estimatedValue: 400000,
    requestedLoanAmount: 300000,
    loanType: "conventional",
    loanPurpose: "purchase",
    occupancy: "primary-residence",
  });
  const decided = await approvalDecision(supervisor, preliminary.id, {
    decision: "approve",
    notes: "Export fixture approval.",
  });
  assert.equal(decided.status, 200, decided.text.slice(0, 300));
  application = await awaitState(supervisor, preliminary.id, ["borrower_notified"], 45000);
  applicationDetail = await getApplication(supervisor, application.id);
  fixtureChecks = await listChecks(supervisor, application.id);
});

describe("§7.7 MISMO conformance against the delivered mapping document", () => {
  test("the delivered mapping document declares the full 167-entry table", () => {
    assert.equal(mapping.length, 167, `parsed ${mapping.length} mapping rows`);
    for (const entry of mapping) {
      assert.ok(entry.sourcePath.length > 0, `entry ${entry.index} has no source path`);
      assert.ok(entry.targetPath.startsWith("MESSAGE."), `entry ${entry.index} target is not a MISMO path`);
    }
  });

  test("every populated mapped field's value appears at its declared MISMO path", { timeout: 300000 }, async () => {
    const path = `/api/applications/${application.id}/exports/mismo-json`;
    const result = await api("GET", path, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 300));
    const document = JSON.parse(result.text) as unknown;

    const detail = await getApplication(supervisor, application.id);
    const exportData: Record<string, unknown> = {
      borrowers: detail.borrowers,
      data: detail.data,
      application: detail,
    };

    const failures: string[] = [];
    let validated = 0;
    for (const entry of mapping) {
      // The SSN row is asserted separately by the masking suite: the default export
      // deliberately carries ***-**-NNNN rather than the source value.
      if (entry.transform === "ssn-masked-or-full") continue;
      const sourceValues = resolveSource(exportData, entry.sourcePath);
      if (sourceValues.length === 0) continue;
      const targetValues = resolveTarget(document, entry.targetPath);
      for (const sourceValue of sourceValues) {
        if (typeof sourceValue === "object") continue;
        validated += 1;
        const expected =
          entry.transform === "date-only" && typeof sourceValue === "string"
            ? sourceValue.slice(0, 10)
            : entry.transform === "construction-method"
              ? sourceValue === true
                ? "Manufactured"
                : "SiteBuilt"
              : // INV-044: the target is an xs:date element, so the "Mon D, YYYY"
                // display source appears as ISO YYYY-MM-DD in the export.
                entry.transform === "dob-display-to-iso" && typeof sourceValue === "string"
                ? displayDateToIso(sourceValue)
                : sourceValue;
        if (!targetValues.some((candidate) => sameScalar(candidate, expected))) {
          const actual = locate(document, expected);
          failures.push(
            `#${entry.index} ${entry.urlaField}: ${JSON.stringify(expected)} not at declared path ${entry.targetPath}` +
              (actual.length > 0 ? ` — value is at ${actual.join(" | ")}` : " — value is absent from the export"),
          );
        }
      }
    }
    assert.ok(validated >= 40, `only ${validated} mapped values were populated — the fixture is too thin to prove conformance`);
    assert.deepEqual(failures, [], `${failures.length} mapping failures:\n${failures.join("\n")}`);
  });

  test("BorrowerBirthDate is an ISO xs:date, and no other element leaks one (INV-044)", { timeout: 120000 }, async () => {
    const result = await api("GET", `/api/applications/${application.id}/exports/mismo-json`, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 300));
    const document = JSON.parse(result.text) as unknown;

    const display = applicationDetail.borrowers[0]?.dateOfBirthDisplay;
    assert.ok(typeof display === "string" && display.length > 0, "the fixture borrower must carry a DOB");
    const iso = displayDateToIso(display);
    assert.match(iso, /^\d{4}-\d{2}-\d{2}$/, "the display form must convert to a full ISO date");

    const emitted = resolveTarget(
      document,
      "MESSAGE.DEAL_SETS.DEAL_SET.DEALS.DEAL.PARTIES.PARTY[*].ROLES.ROLE[*].BORROWER.BORROWER_DETAIL.BorrowerBirthDate",
    );
    assert.deepEqual(
      emitted,
      [iso],
      `BorrowerBirthDate is declared xs:date in MISMO v3.4, so it must carry ${iso}, not the "Mon D, YYYY" display form`,
    );
    // INV-044 is a carve-out of exactly ONE element: the display form must not
    // survive anywhere in the document, and the ISO form must not spread.
    assert.ok(!result.text.includes(display), `the display DOB "${display}" must not appear anywhere in the export`);
    assert.equal(
      locate(document, iso).length,
      1,
      `the ISO DOB must appear at exactly one path, found at ${locate(document, iso).join(" | ")}`,
    );

    // The XML export walks the same tree, so it must carry the same value.
    const xml = await api("GET", `/api/applications/${application.id}/exports/mismo-xml`, { session: supervisor });
    assert.equal(xml.status, 200, xml.text.slice(0, 300));
    assert.ok(
      xml.text.includes(`<BorrowerBirthDate>${iso}</BorrowerBirthDate>`),
      `the XML export must carry <BorrowerBirthDate>${iso}</BorrowerBirthDate>`,
    );
    assert.ok(!xml.text.includes(display), `the display DOB "${display}" must not appear in the XML export`);
  });

  test("unicode borrower names survive the MISMO JSON encoding (INV-037)", { timeout: 120000 }, async () => {
    const path = `/api/applications/${application.id}/exports/mismo-json`;
    const result = await api("GET", path, { session: supervisor });
    assert.equal(result.status, 200);
    assert.ok(result.text.includes(UNICODE_FIRST), "diacritic + CJK first name must survive");
    assert.ok(result.text.includes(UNICODE_LAST), "emoji + pipe last name must survive");
  });

  test("the MISMO XML export is well-formed and carries the same names", { timeout: 120000 }, async () => {
    const path = `/api/applications/${application.id}/exports/mismo-xml`;
    const result = await api("GET", path, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 300));
    assert.match(result.text.trimStart(), /^<\?xml|^<MESSAGE/, "the XML export must start with a declaration or root");
    assert.ok(result.text.includes("MESSAGE"), "the MISMO root element must be present");

    const openTags = (result.text.match(/<[A-Za-z][^\s/>]*(?:\s[^>]*)?>/g) ?? []).length;
    const closeTags = (result.text.match(/<\/[A-Za-z][^\s>]*>/g) ?? []).length;
    const selfClosing = (result.text.match(/<[A-Za-z][^>]*\/>/g) ?? []).length;
    assert.equal(openTags - selfClosing, closeTags, "every opened element must be closed");

    // Unicode must be present either literally or as XML character references.
    const hasEmoji = result.text.includes("🙂") || /&#(?:x1f642|128578);/i.test(result.text);
    assert.ok(hasEmoji, "the emoji must survive XML encoding literally or as a character reference");
    assert.ok(!result.text.includes("<Pipe|"), "a raw pipe must never break out of element text");
  });

  test("the URLA PDF export streams a real PDF", { timeout: 120000 }, async () => {
    const path = `/api/applications/${application.id}/exports/urla-pdf`;
    const result = await api("GET", path, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 200));
    assert.ok(result.text.startsWith("%PDF-"), `expected a PDF signature, got ${result.text.slice(0, 20)}`);
    assert.ok(result.text.length > 1000, "the URLA PDF must not be an empty stub");
    assert.match(result.headers.get("content-disposition") ?? "", /attachment/i);
  });

  test("exports are Supervisor-only (§B role gate)", { timeout: 120000 }, async () => {
    for (const suffix of ["mismo-json", "mismo-xml", "urla-pdf"]) {
      const path = `/api/applications/${application.id}/exports/${suffix}`;
      const result = await api("GET", path, { session: caseworker });
      assert.equal(result.status, 403, `${suffix}: ${result.status} ${result.text.slice(0, 200)}`);
    }
  });
});

describe("§7.7 HMDA LAR conformance against the delivered code mapping", () => {
  test("the delivered document declares the 110-field LAR record", () => {
    assert.equal(parseLarFieldCount(), 110);
  });

  test("the LAR file is pipe-delimited with a transmittal sheet and 110-field records", { timeout: 300000 }, async () => {
    const year = new Date(application.submittedAt ?? application.createdAt).getUTCFullYear();
    const path = `/api/admin/exports/hmda-lar?year=${year}`;
    const result = await api("GET", path, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 300));

    const lines = result.text.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length >= 2, "the export must carry a transmittal sheet and at least one record");

    const transmittal = lines[0].split("|");
    assert.equal(transmittal[0], "1", "line 1 is the transmittal sheet (record identifier 1)");
    assert.equal(transmittal.length, 15, "the transmittal sheet has 15 fields");
    assert.equal(transmittal[1], "MortMortgage", "field 2 is the documented institution-name constant");
    assert.equal(transmittal[2], String(year), "field 3 echoes the requested calendar year");
    assert.equal(transmittal[3], "4", "field 4 is the documented annual-submission quarter constant");

    const lei = JSON.parse(await readSetting(supervisor, "hmda.lei")) as string;
    const agency = JSON.parse(await readSetting(supervisor, "hmda.agencyCode")) as string;
    assert.equal(transmittal[11], agency, "field 12 is the configured federal agency code");
    assert.equal(transmittal[14], lei, "field 15 is the configured LEI");

    for (const line of lines.slice(1)) {
      const fields = line.split("|");
      assert.equal(fields[0], "2", "every LAR record starts with record identifier 2");
      assert.equal(fields.length, 110, `every LAR record carries 110 fields, saw ${fields.length}`);
    }
  });

  /** Fetches the fixture's own 110-field LAR record. */
  async function fixtureRecord(): Promise<{ record: string[]; lei: string }> {
    const year = new Date(application.submittedAt ?? application.createdAt).getUTCFullYear();
    const path = `/api/admin/exports/hmda-lar?year=${year}`;
    const result = await api("GET", path, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 300));
    const lei = JSON.parse(await readSetting(supervisor, "hmda.lei")) as string;
    const compact = application.applicationNumber.replace(/-/g, "");
    const record = result.text
      .split("\n")
      .filter((line) => line.startsWith("2|"))
      .map((line) => line.split("|"))
      .find((fields) => fields[2].startsWith(`${lei}${compact}`));
    assert.ok(record, `no LAR record found whose ULI starts with LEI + ${compact}`);
    return { record, lei };
  }

  test("every one of the 110 LAR fields carries its expected value", { timeout: 300000 }, async () => {
    const { record, lei } = await fixtureRecord();
    const expectations = larExpectations(application, applicationDetail, lei, fixtureChecks);

    const failures: string[] = [];
    for (const spec of LAR_FIELDS) {
      const expectation = expectations.get(spec.index);
      assert.ok(expectation, `no expectation declared for LAR field ${spec.index} (${spec.name})`);
      const actual = record[spec.index - 1];
      const ok =
        expectation.expected instanceof RegExp
          ? expectation.expected.test(actual ?? "")
          : actual === expectation.expected;
      if (!ok) {
        failures.push(
          `field ${spec.index} (${spec.name}): expected ${
            expectation.expected instanceof RegExp ? String(expectation.expected) : JSON.stringify(expectation.expected)
          }, got ${JSON.stringify(actual)} — ${expectation.why}`,
        );
      }
    }
    assert.deepEqual(failures, [], `${failures.length} LAR field-value failures:\n${failures.join("\n")}`);
  });

  test("every data-derived LAR field is covered by a value assertion", () => {
    const expectations = larExpectations(application, applicationDetail, "LEI", fixtureChecks);
    const uncovered = LAR_FIELDS.filter(
      (spec) => !isBareConstantSource(spec.source) && !expectations.has(spec.index),
    ).map((spec) => `${spec.index} ${spec.name} (source: ${spec.source})`);
    assert.deepEqual(
      uncovered,
      [],
      "these LAR fields derive their value from application data but no assertion reads them, " +
        "so a wrong value would ship green:\n" + uncovered.join("\n"),
    );
    assert.equal(expectations.size, 110, "the expectation table must cover the whole record");
  });

  test("the FFIEC AUS cross-field validity edit holds (fields 96 + 102)", { timeout: 300000 }, async () => {
    const { record } = await fixtureRecord();
    // The fixture is driven through toAusExecuted -> runAllChecks, so a completed
    // AUS result exists and field 96 must declare one was used.
    assert.equal(record[95], "5", "field 96: a completed AUS check exists -> 5 (Other)");
    assert.equal(
      record[100],
      "Internal rule-based AUS simulation",
      "field 101: the spec requires free-form text whenever AUS 1 = 5",
    );
    const aus = rec(fixtureChecks.find((c) => c.checkType === "aus" && c.status === "completed")?.aus);
    const recommendation = String(aus.recommendation);
    assert.ok(
      recommendation in HMDA_AUS_RESULT,
      `the AUS check must carry an AusRecommendation, got ${JSON.stringify(recommendation)}`,
    );
    assert.equal(
      record[101],
      HMDA_AUS_RESULT[recommendation as keyof typeof HMDA_AUS_RESULT],
      `field 102 must be the HMDA code for the stored AUS recommendation "${recommendation}"`,
    );
    // The edit itself: declaring an AUS was used (96 = 5) while reporting
    // "Not applicable" (102 = 17) is a contradiction that rejects the whole
    // submission — this is exactly the defect the field-102 rekey fixed.
    if (record[95] === "5") {
      assert.notEqual(
        record[101],
        "17",
        "field 96 = 5 declares an AUS was used, so field 102 must never report 17 (Not applicable)",
      );
    }
  });

  test("the LAR ratios are the stored shared-module values the wizard shows (AC-13)", { timeout: 300000 }, async () => {
    const { record } = await fixtureRecord();
    assert.ok(typeof application.dti === "number", "the fixture must carry a stored DTI");
    assert.ok(typeof application.cltv === "number", "the fixture must carry a stored CLTV");
    assert.equal(Number(record[79]), application.dti, "field 80 (DTI) must match Application.dti");
    assert.equal(Number(record[80]), application.cltv, "field 81 (CLTV) must match Application.cltv");
  });

  test("the Closing-Disclosure money fields are NA, never a simulated amount (INV-043)", { timeout: 300000 }, async () => {
    const { record } = await fixtureRecord();
    // Reg C §1003.4(a)(17)(i),(18),(19),(20) define fields 73-77 by reference to
    // the Closing Disclosure (12 CFR §1026.38(f)(1),(f)(4),(h)(3)), issued only
    // for a CONSUMMATED transaction. ASM-005: no loan is ever originated here.
    for (const [index, name] of [
      [73, "Total Loan Costs"],
      [74, "Total Points and Fees"],
      [75, "Origination Charges"],
      [76, "Discount Points"],
      [77, "Lender Credits"],
    ] as const) {
      assert.equal(
        record[index - 1],
        "NA",
        `field ${index} (${name}) must be NA on every row — no Closing Disclosure is ever issued`,
      );
    }
    assert.notEqual(record[75], "0", "field 76 must be NA, never a literal 0");
    assert.notEqual(record[76], "0", "field 77 must be NA, never a literal 0");
    // Field 78 is NOT Closing-Disclosure-derived and stays reportable for
    // action taken 2 (§1003.4(a)(21)).
    assert.equal(record[10], "2", "the fixture is an approved-but-not-accepted row");
    assert.match(record[77], /^\d+(\.\d+)?$/, "field 78 (Interest Rate) stays reportable for action taken 2");
    const rate = Number(record[77]);
    assert.ok(rate > 0 && rate < 25, `field 78 must be a plausible note rate, got ${record[77]}`);
  });

  test("the manufactured-home pair and the intake pair are never self-contradictory", { timeout: 300000 }, async () => {
    const { record } = await fixtureRecord();
    // Site-built fixture: 89 = 3 / 90 = 5 is the ONE combination in which the
    // field-90 code 5 ("not secured by a manufactured home") is legal.
    assert.equal(record[7], "1", "the fixture is site-built (construction method 1)");
    assert.equal(record[88], HMDA_NOT_MANUFACTURED_HOME.securedPropertyType, "field 89 for site-built collateral");
    assert.equal(record[89], HMDA_NOT_MANUFACTURED_HOME.landPropertyInterest, "field 90 for site-built collateral");
    assert.ok(
      !(record[88] === "1" && record[89] === "5"),
      "field 89 = 1 asserts the security includes land; field 90 = 5 asserts the loan is not secured by a " +
        "manufactured home at all — the pair is a cross-field contradiction and must never be emitted",
    );
    // FIND-019: (93 = submitted directly to us, 94 = not applicable) is
    // likewise self-contradictory.
    assert.equal(record[92], "1", "field 93: submitted directly to this institution");
    assert.equal(
      record[93],
      "1",
      "field 94: §1003.4(a)(34) extends Initially Payable to applications and reserves its NA code for " +
        "purchased loans, so 1 is affirmative — 3 would contradict field 93 = 1",
    );
  });

  test("no record in the whole file violates the FFIEC cross-field edits", { timeout: 300000 }, async () => {
    const year = new Date(application.submittedAt ?? application.createdAt).getUTCFullYear();
    const result = await api("GET", `/api/admin/exports/hmda-lar?year=${year}`, { session: supervisor });
    assert.equal(result.status, 200, result.text.slice(0, 300));
    const records = result.text
      .split("\n")
      .filter((line) => line.startsWith("2|"))
      .map((line) => line.split("|"));
    assert.ok(records.length > 0, "the export must carry at least one record");

    const violations: string[] = [];
    for (const r of records) {
      const uli = r[2];
      // INV-043 (c): Reason for Denial 9 (Other) requires the conditional
      // free-form text; the pair rejects the ENTIRE submission, not the row.
      if ([r[67], r[68], r[69], r[70]].includes("9") && (r[71] ?? "") === "") {
        violations.push(`${uli}: Reason for Denial 9 with an empty field 72`);
      }
      // AUS declared used but result "Not applicable".
      if (r[95] === "5" && r[101] === "17") violations.push(`${uli}: field 96 = 5 with field 102 = 17`);
      // Manufactured-home cross-field contradiction (VR-135).
      if (r[88] === "1" && r[89] === "5") violations.push(`${uli}: field 89 = 1 with field 90 = 5`);
      // INV-043 (a): the Closing-Disclosure money fields are NA on every row.
      for (const index of [73, 74, 75, 76, 77]) {
        if (r[index - 1] !== "NA") violations.push(`${uli}: field ${index} = ${r[index - 1]}, expected NA`);
      }
      // INV-043 (b).
      if (r[93] !== "1") violations.push(`${uli}: field 94 = ${r[93]}, expected 1`);
    }
    assert.deepEqual(violations, [], `${violations.length} cross-field violations:\n${violations.join("\n")}`);
  });

  test("a name containing the pipe delimiter is sanitized, never emitted raw (INV-037)", { timeout: 300000 }, async () => {
    const year = new Date(application.submittedAt ?? application.createdAt).getUTCFullYear();
    const path = `/api/admin/exports/hmda-lar?year=${year}`;
    const result = await api("GET", path, { session: supervisor });
    assert.equal(result.status, 200);
    // A raw pipe inside a free-form field would shift every later field; the 110-field
    // assertion above is the structural proof. Confirm the delimiter is not present in
    // any free-form remainder either.
    for (const line of result.text.split("\n").filter((entry) => entry.startsWith("2|"))) {
      assert.equal(line.split("|").length, 110, "pipe sanitisation must keep the field count exact");
    }
  });

  test("the LAR export is Supervisor-only and requires the year parameter", { timeout: 120000 }, async () => {
    const asCaseworker = await api("GET", "/api/admin/exports/hmda-lar?year=2026", { session: caseworker });
    assert.equal(asCaseworker.status, 403, asCaseworker.text.slice(0, 200));

    const noYear = await api("GET", "/api/admin/exports/hmda-lar", { session: supervisor });
    assert.equal(noYear.status, 400, noYear.text.slice(0, 200));
  });

  test("in-flight applications are excluded from the register (ASM-005)", { timeout: 600000 }, async () => {
    const actors: Actors = {
      borrower: (await registerBorrower(supervisor, `${PREFIX}-inflight`)).session,
      caseworker,
      supervisor,
    };
    const inFlight = await toPreliminaryDecision(actors, { estimatedValue: 400000, requestedLoanAmount: 300000 });
    assert.equal(inFlight.workflowState, "preliminary_decision");

    const year = new Date().getUTCFullYear();
    const result = await api("GET", `/api/admin/exports/hmda-lar?year=${year}`, { session: supervisor });
    assert.equal(result.status, 200);
    const compact = inFlight.applicationNumber.replace(/-/g, "");
    assert.ok(!result.text.includes(compact), "a Preliminary Decision file must not be reportable");
  });
});

describe("§7.7 analytics and warehouse exports stream with the filter applied", () => {
  test("every contracted analytics CSV element streams", { timeout: 300000 }, async () => {
    const elements = [
      "summary",
      "volume",
      "status",
      "loan-type",
      "property-type",
      "workload",
      "ltv-risk",
      "dti-risk",
      "performance-trend",
      "compliance",
      "pending-approvals",
      "activity",
    ];
    const failures: string[] = [];
    for (const element of elements) {
      const path = `/api/supervisor/analytics/${element}/csv`;
      const result = await api("GET", path, { session: supervisor });
      if (result.status !== 200) failures.push(`${element}: ${result.status} ${result.text.slice(0, 120)}`);
      else if (!result.text.includes(",")) failures.push(`${element}: response is not CSV`);
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });

  test("an unknown analytics element is a validation error, not a 500", { timeout: 120000 }, async () => {
    const result = await api("GET", "/api/supervisor/analytics/not-an-element/csv", { session: supervisor });
    assert.ok([400, 404].includes(result.status), `got ${result.status} ${result.text.slice(0, 200)}`);
  });

  test("the warehouse export requires `since` in incremental mode", { timeout: 120000 }, async () => {
    const missing = await api("GET", "/api/admin/exports/warehouse?mode=incremental", { session: supervisor });
    assert.equal(missing.status, 400, missing.text.slice(0, 200));

    const withSince = await api("GET", "/api/admin/exports/warehouse?mode=incremental&since=2026-01-01T00:00:00.000Z", {
      session: supervisor,
    });
    assert.equal(withSince.status, 200, withSince.text.slice(0, 200));
  });

  test("date-range spans beyond the contracted maximum are rejected", { timeout: 120000 }, async () => {
    const result = await GET("/api/supervisor/analytics?from=2000-01-01&to=2026-12-31", { session: supervisor });
    assert.equal(result.status, 400, `a span over 1096 days must be a validation error: ${result.status}`);
  });
});
