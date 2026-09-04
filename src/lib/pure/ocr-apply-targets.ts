// OCR apply-suggestion target catalog (task-035 — REQ-067, NFR-017, XBR-018).
//
// Maps an OcrFieldResult.fieldPath (the extraction-token paths emitted by
// src/lib/pure/simulations/ocr.ts) onto the ONE application scalar field a
// §4.4.4 correction can write. Shared by the server (target resolution in
// src/lib/services/ocr-suggestions.ts) and the client (which fieldPaths render
// an Apply button in the OcrPanel) so the two can never disagree.
//
// PURE — no DB, no env, no framework imports (client-importable).
//
// Documented interpretation (contract-silent): "borrower.name" and
// "taxreturn.filerName" are comparison-view fields (§4.7 "name") but have NO
// single-scalar application target — a full name spans firstName + lastName,
// and a correction targets exactly one scalar (VR-091). They are therefore
// compare-only: the server rejects apply for them with a targeted validation
// message and the panel offers no Apply button. Gift donor/amount ARE
// applyable (single scalars on the first gift-type other-credit record), which
// is additive to the §4.7 five-field comparison list but consistent with
// SEC-16 "accepting an extracted value persists it as a correction".

/** Where the target scalar lives and how the record index is resolved live. */
export type OcrApplyScope =
  /** Primary borrower's first employment record with an employer name (the
   *  same record the extraction's entered data was assembled from). */
  | "employment"
  /** Primary borrower's encrypted date of birth (scalar root). */
  | "borrower-dob"
  /** First asset record carrying an institution or balance. */
  | "asset"
  /** First gift-type (gift-of-cash / gift-of-equity) other-credit record. */
  | "gift";

export type OcrApplyValueKind = "text" | "currency" | "iso-date";

export interface OcrApplyTarget {
  scope: OcrApplyScope;
  /** Leaf field name on the target record (corrections fieldPath leaf). */
  leaf: string;
  valueKind: OcrApplyValueKind;
}

/** OcrFieldResult.fieldPath → the one application scalar Apply writes. */
export const OCR_APPLY_TARGETS: Readonly<Record<string, OcrApplyTarget>> = {
  "employment.employerName": { scope: "employment", leaf: "employerName", valueKind: "text" },
  "employment.baseMonthlyIncome": {
    scope: "employment",
    leaf: "baseMonthlyIncome",
    valueKind: "currency",
  },
  "account.endingBalance": { scope: "asset", leaf: "cashOrMarketValue", valueKind: "currency" },
  "bank.institution": { scope: "asset", leaf: "financialInstitution", valueKind: "text" },
  "borrower.dateOfBirth": { scope: "borrower-dob", leaf: "dateOfBirth", valueKind: "iso-date" },
  "gift.donorName": { scope: "gift", leaf: "sourceOrDonor", valueKind: "text" },
  "gift.amount": { scope: "gift", leaf: "value", valueKind: "currency" },
};

/** Compare-only name fields — mapped for comparison, not applyable (see header). */
export const OCR_NAME_SPANNING_PATHS: ReadonlySet<string> = new Set([
  "borrower.name",
  "taxreturn.filerName",
]);

export type ParsedOcrValue =
  | { ok: true; value: string | number }
  | { ok: false; message: string };

/** Lower-cased month abbreviations of the "Mon D, YYYY" DOB display form. */
const DOB_MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/**
 * Parse an OcrFieldResult.extractedValue string into the JSON scalar the
 * correction stores: currency "$7,600.00" → 7600; iso-date validated
 * YYYY-MM-DD; text passed through trimmed.
 *
 * NFR-003 / SEC-2: the only `iso-date` target is borrower.dateOfBirth, and a DOB
 * now egresses in the "Mon D, YYYY" DISPLAY form (the raw ISO DOB never leaves
 * the identity-own endpoint, and OcrExtraction.fields is an unencrypted column).
 * The display form is therefore accepted here and normalised back to YYYY-MM-DD
 * for the correction write. This is a WIDENING, not a swap — a literal
 * YYYY-MM-DD is still accepted, so extractions stored before the change keep
 * applying unchanged. Normalising for a WRITE into the encrypted borrower record
 * is not an egress.
 */
export function parseOcrExtractedValue(kind: OcrApplyValueKind, raw: string): ParsedOcrValue {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "the extracted value is empty and cannot be applied" };
  }
  if (kind === "currency") {
    const numeric = Number(trimmed.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(numeric)) {
      return { ok: false, message: `the extracted value "${raw}" is not a currency amount` };
    }
    return { ok: true, value: numeric };
  }
  if (kind === "iso-date") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: true, value: trimmed };
    const display = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(trimmed);
    if (display) {
      const monthIndex = DOB_MONTHS.indexOf(
        display[1]!.toLowerCase() as (typeof DOB_MONTHS)[number],
      );
      const day = Number(display[2]);
      if (monthIndex >= 0 && day >= 1 && day <= 31) {
        const mm = String(monthIndex + 1).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        return { ok: true, value: `${display[3]}-${mm}-${dd}` };
      }
    }
    return {
      ok: false,
      message: `the extracted value "${raw}" is not a YYYY-MM-DD or "Mon D, YYYY" date`,
    };
  }
  return { ok: true, value: trimmed };
}
