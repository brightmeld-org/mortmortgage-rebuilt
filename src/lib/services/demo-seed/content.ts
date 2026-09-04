// Demo-seed content helpers (task-043, REQ-066, RFP §4.6.12 / §6.4).
//
// Pure helpers + data pools for the §4.6.12 demo dataset: realistic synthetic
// names, reserved-range SSNs whose LAST DIGIT is CHOSEN to hit the §6.3.1
// credit tiers, geocodable addresses drawn from the bundled §6.3.6 dataset,
// minimal-but-valid PDF fixture bytes (pass the task-013 magic-byte sniff and
// open in standard viewers), and a format-valid synthetic HMDA LEI with real
// ISO 17442 mod-97 check digits (the task-042 LAR export computes ULI check
// digits from it).
//
// Everything here is deterministic given its inputs — no Date.now(), no
// Math.random() (uuids/crypto randomness live in dataset.ts where identity is
// generated, not content).

import { ADDRESS_DATASET, type AddressRow } from "@/lib/data/addresses";

// ---------------------------------------------------------------------------
// Name pools (realistic synthetic names — profile Seed Data Quality Rules)
// ---------------------------------------------------------------------------

export const FIRST_NAMES = [
  "Olivia", "Liam", "Sophia", "Noah", "Ava", "Ethan", "Isabella", "Mason",
  "Mia", "Lucas", "Charlotte", "James", "Amelia", "Benjamin", "Harper",
  "Elijah", "Evelyn", "Alexander", "Abigail", "Daniel", "Emily", "Matthew",
  "Elizabeth", "Samuel", "Sofia", "Joseph", "Victoria", "Carter", "Grace",
  "Owen", "Chloe", "Wyatt", "Penelope", "Julian", "Layla", "Levi", "Zoe",
  "Isaac", "Nora", "Gabriel", "Riley", "Anthony", "Aurora", "Dylan", "Hazel",
  "Andres", "Camila", "Marcus", "Naomi", "Theo", "Priya", "Kenji", "Amara",
  "Mateo", "Ingrid", "Tobias", "Selene",
] as const;

export const LAST_NAMES = [
  "Thompson", "Garcia", "Mitchell", "Chen", "Robinson", "Patel", "Sullivan",
  "Nguyen", "Bennett", "Alvarez", "Fitzgerald", "Kim", "Harrington", "Silva",
  "Whitaker", "Osei", "Delgado", "Novak", "Pearson", "Ramirez", "Callahan",
  "Ito", "Vasquez", "Sorensen", "Blackwood", "Marchetti", "Okonkwo", "Lindgren",
  "Beaumont", "Castillo", "Draper", "Ferreira", "Galloway", "Huang", "Iverson",
  "Jankowski", "Kowalski", "Lombardi", "MacGregor", "Navarro", "Oduya",
  "Prescott", "Quintana", "Rutherford", "Santoro", "Tremblay", "Ulrich",
  "Vandenberg", "Winslow", "Xiong", "Yamada", "Zielinski", "Ashworth",
  "Brockman", "Carmichael", "Dunmore",
] as const;

/** Deterministic distinct-ish full name for a seed index. */
export function personName(i: number): { firstName: string; lastName: string } {
  const firstName = FIRST_NAMES[(i * 7 + 3) % FIRST_NAMES.length]!;
  const lastName = LAST_NAMES[(i * 11 + 5) % LAST_NAMES.length]!;
  return { firstName, lastName };
}

// ---------------------------------------------------------------------------
// Employers (income-verification §6.3.2 factor digit is (Σ char codes) mod 10;
// each pool entry's digit is pre-verified so tiers are CHOSEN, never accidental)
// ---------------------------------------------------------------------------

/** factor digit ≤ 6 → factor 1.00 (verified, clean — no income variance). */
export const CLEAN_EMPLOYERS = [
  "Northwind Traders LLC", // digit 5 — matches the OCR w2/paystub fixtures
  "Cascade Timber Works", // 5
  "Harborview Medical Group", // 5
  "Prairie Wind Energy Co", // 0
  "Ironbridge Construction", // 2
  "Gulf Coast Shipping Co", // 2
  "Maple Grove Dental", // 4
  "Copperline Robotics", // 0
  "Beacon Hill Publishing", // 6
  "Northgate Apparel Co", // 1
  "Stellar Path Aviation", // 5
  "Crescent Bay Biotech", // 3
  "Highland Trail Coffee", // 5
  "Vermilion Software Labs", // 2
  "Bristol Automotive Group", // 3
  "Keystone Rail Partners", // 3
  "Marble Arch Consulting", // 3
  "Sunfish Media Group", // 5
  "Pinehurst Financial Advisors", // 0
  "Quartz Mountain Mining", // 4
  "Driftwood Hospitality", // 6
  "Falcon Ridge Security", // 6
] as const;

/** The §6.3.2 fixture employer (digit 5) whose values the OCR fixtures carry. */
export const FIXTURE_EMPLOYER = "Northwind Traders LLC";
/** OCR fixture-aligned stated base monthly income ($7,600.00 — fixture w2/paystub). */
export const FIXTURE_MONTHLY_INCOME = 7600;
/** OCR fixture-aligned bank institution / balance / last4 (fixture-bank-contoso). */
export const FIXTURE_BANK_INSTITUTION = "Contoso Federal Savings";
export const FIXTURE_BANK_BALANCE = 42318.55;
export const FIXTURE_BANK_LAST4 = "4821";
/** OCR fixture-aligned gift donor / amount (fixture-gift-letter). */
export const FIXTURE_GIFT_DONOR = "Casey Fixture";
export const FIXTURE_GIFT_AMOUNT = 15000;

/** factor digit 9 → factor 0.70, variance 30% → income-variance fraud flag (§6.4). */
export const FRAUD_EMPLOYER = "Summit Peak Outfitters"; // digit 9 (pre-verified)
/** §6.3.2 employer-not-found trigger (name contains "UNVERIFIED"). */
export const UNVERIFIED_EMPLOYER = "UNVERIFIED Holdings Group";
/** factor digit 8 → factor 0.88 (12% variance — discrepancy shown, below the 20% flag bar). */
export const DISCREPANCY_EMPLOYER = "Redwood Analytics Corp"; // digit 8 (pre-verified)

export function cleanEmployer(i: number): string {
  return CLEAN_EMPLOYERS[i % CLEAN_EMPLOYERS.length]!;
}

// ---------------------------------------------------------------------------
// SSNs — reserved 900-999 area range; LAST digit chosen per §6.3.1 tier
// ---------------------------------------------------------------------------

/**
 * Synthetic SSN in the 900-999 area range with a CHOSEN last digit:
 * 0-3 → Good, 4-6 → Fair, 7-8 → Poor, 9 → credit-unavailable fault (avoid
 * except on the intended fault-scenario application). Formatted XXX-XX-XXXX.
 */
export function syntheticSsn(i: number, lastDigit: number): string {
  const area = 900 + ((i * 13 + 7) % 100); // 900-999
  const group = 10 + ((i * 17 + 3) % 89); // 10-98
  const serialBase = 100 + ((i * 29 + 11) % 900); // 3 digits
  return `${area}-${String(group).padStart(2, "0")}-${serialBase}${lastDigit}`;
}

// ---------------------------------------------------------------------------
// Addresses — always drawn from the bundled §6.3.6 dataset (geocodable, with
// county + census tract), optionally constrained by ZIP last digit (§6.3.3 AVM)
// ---------------------------------------------------------------------------

export interface AddressShape {
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
}

function toAddressShape(row: AddressRow): AddressShape {
  const shape: AddressShape = {
    street: row.street,
    city: row.city,
    state: row.state,
    zip: row.zip,
    county: row.county,
  };
  if (row.unit) shape.unit = row.unit;
  return shape;
}

/**
 * Deterministically pick a dataset address whose ZIP last digit is in
 * `zipLastDigits` (empty set = any). Scans from a seed offset so different
 * indices land on different rows.
 */
export function pickDatasetAddress(i: number, zipLastDigits: readonly number[] = []): AddressRow {
  const n = ADDRESS_DATASET.length;
  const start = (i * 37 + 19) % n;
  for (let k = 0; k < n; k += 1) {
    const row = ADDRESS_DATASET[(start + k) % n]!;
    const digit = row.zip.charCodeAt(row.zip.length - 1) - 48;
    if (zipLastDigits.length === 0 || zipLastDigits.includes(digit)) return row;
  }
  // The bundled dataset always contains every terminal digit; defensive only.
  return ADDRESS_DATASET[start]!;
}

export function addressShapeFor(i: number, zipLastDigits: readonly number[] = []): AddressShape {
  return toAddressShape(pickDatasetAddress(i, zipLastDigits));
}

export function formatAddressText(a: AddressShape): string {
  return `${a.street}, ${a.city}, ${a.state} ${a.zip}`;
}

// ---------------------------------------------------------------------------
// Minimal valid PDF fixture bytes (sniffable %PDF- magic + real xref structure)
// ---------------------------------------------------------------------------

/**
 * Build a small structurally valid single-page PDF whose page shows `title`
 * and `lines`. Passes the task-013 magic-byte sniff (%PDF-) and opens in
 * standard viewers. Content varies by input, so per-document SHA-256 differs.
 */
export function makeSeedPdf(title: string, lines: readonly string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const textOps = [
    "BT /F1 14 Tf 54 740 Td",
    `(${esc(title)}) Tj`,
    ...lines.map((line) => `0 -20 Td (${esc(line)}) Tj`),
    "ET",
  ].join("\n");
  const stream = `q\n${textOps}\nQ`;

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, idx) => {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

/** Tiny valid 1x1 transparent PNG (signature image bytes for seeded signatures). */
export const SEED_SIGNATURE_PNG: Buffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// ---------------------------------------------------------------------------
// Synthetic HMDA LEI (ISO 17442 shape with VALID mod-97 check digits)
// ---------------------------------------------------------------------------

/** mod 97 of the ISO 7064 numeric expansion (A=10..Z=35) of an LEI string. */
function leiMod97(input: string): number {
  let remainder = 0;
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch; // A-Z → 10..35
    for (const digit of value) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

/** Compute the two ISO 17442 check digits for an 18-char LEI base. */
export function leiWithCheckDigits(base18: string): string {
  if (!/^[A-Z0-9]{18}$/.test(base18)) {
    throw new Error("LEI base must be 18 chars A-Z0-9");
  }
  const check = 98 - leiMod97(`${base18}00`);
  return `${base18}${String(check).padStart(2, "0")}`;
}

/** True when the 20-char LEI passes the ISO 17442 mod-97 check (== 1). */
export function isValidLei(lei: string): boolean {
  return /^[A-Z0-9]{20}$/.test(lei) && leiMod97(lei) === 1;
}

/**
 * The synthetic-but-format-valid LEI the DEMO seed configures (§4.6.11 default
 * is blank; FLOW-010 precondition needs it set). Never a real institution's LEI.
 */
export const SEEDED_HMDA_LEI: string = leiWithCheckDigits("549300DEMOSEED0MTG".toUpperCase());
/** Seeded HMDA agency code (single digit 1-9 per the §4.6.11 registry pattern). */
export const SEEDED_HMDA_AGENCY_CODE = "9";

// ---------------------------------------------------------------------------
// Misc deterministic helpers
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

/** ISO date (YYYY-MM-DD) n days before/after `now`. */
export function isoDateOffset(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}
