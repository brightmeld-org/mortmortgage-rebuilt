/**
 * §7.7 — INV-044 / SEC-2 / task-002 AC-4: OcrExtraction.fields must NEVER carry a
 * raw ISO DOB (LENS-017).
 *
 * OcrExtraction.fields is an UNENCRYPTED column served verbatim to staff via
 * GET /api/documents/:id/ocr → toOcrExtractionInfo. INV-044 permits raw ISO DOB
 * at exactly ONE boundary — the MISMO xs:date export — and nowhere else; every
 * other API/UI surface carries the "Mon D, YYYY" display form. The production
 * path (document-ocr.ts assembleEnteredData) decrypts and formatDobDisplay's the
 * value, but the demo seed writer diverged and wrote raw ISO into the OCR
 * extraction (LENS-017), leaking DOB on the staff OCR panel. The seed writer is
 * fixed (dataset.ts wraps dobFor in formatDobDisplay) and the existing rows were
 * backfilled; this guard is READ-ONLY and fails if either regresses — a reseed
 * that re-introduces raw ISO DOB is exactly what it catches.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prisma } from "@/lib/prisma";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The mandated display form, e.g. "Jun 6, 1991". */
const DISPLAY_DOB = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;

interface OcrField {
  fieldPath?: string;
  extractedValue?: unknown;
  enteredValue?: unknown;
}

describe("INV-044 OcrExtraction.fields never carries a raw ISO DOB (LENS-017)", () => {
  test("no DOB field value in any OcrExtraction row is raw ISO YYYY-MM-DD", async () => {
    const rows = await prisma.ocrExtraction.findMany({ select: { id: true, fields: true } });
    assert.ok(rows.length > 0, "expected seeded OcrExtraction rows to check");

    const offenders: string[] = [];
    let dobFieldsSeen = 0;
    for (const row of rows) {
      const fields = row.fields as unknown;
      if (!Array.isArray(fields)) continue;
      for (const f of fields as OcrField[]) {
        if (typeof f.fieldPath !== "string" || !f.fieldPath.toLowerCase().includes("dateofbirth")) continue;
        dobFieldsSeen++;
        for (const key of ["extractedValue", "enteredValue"] as const) {
          const v = f[key];
          if (typeof v !== "string") continue;
          if (ISO_DATE.test(v)) {
            offenders.push(`OcrExtraction ${row.id} ${f.fieldPath}.${key} = "${v}" (raw ISO DOB)`);
          } else {
            // A present DOB string that is not ISO must be the display form.
            assert.match(
              v,
              DISPLAY_DOB,
              `OcrExtraction ${row.id} ${f.fieldPath}.${key}="${v}" is neither ISO nor the Mon D, YYYY display form`,
            );
          }
        }
      }
    }

    assert.ok(dobFieldsSeen > 0, "expected at least one DOB field across seeded OCR extractions");
    assert.deepEqual(
      offenders,
      [],
      "raw ISO DOB is served verbatim on the staff OCR panel — INV-044 forbids it outside the MISMO carve-out " +
        "(LENS-017). The seed writer must emit formatDobDisplay(...):\n  " +
        offenders.join("\n  "),
    );
  });
});
