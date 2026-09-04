// LENS-017 backfill: convert any raw ISO (YYYY-MM-DD) DOB value in existing
// OcrExtraction.fields rows to the mandated "Mon D, YYYY" display form
// (INV-044 / SEC-2). The seed writer is fixed at dataset.ts (formatDobDisplay),
// so a future reseed produces correct data; this repairs rows already persisted.
//
// SAFE BY DESIGN:
//   - IDEMPOTENT: only rows whose DOB field still matches the ISO shape are
//     touched; a second run finds none (display form fails the ISO test).
//   - DRY-RUN by default: prints the plan and writes nothing. Pass --apply to write.
//   - TRANSACTIONAL: all row updates commit in a single prisma.$transaction.
//   - OcrExtraction is NOT the audit log (AuditLogEntry) — INV-009's no-repair rule
//     does not apply here; this column is unencrypted derived OCR data.
//
// Usage:
//   npx tsx --env-file=.env scripts/backfill-lens017-ocr-dob.ts            # dry-run
//   npx tsx --env-file=.env scripts/backfill-lens017-ocr-dob.ts --apply    # write

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatDobDisplay } from "@/lib/crypto/masking";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOB_VALUE_KEYS = ["extractedValue", "enteredValue"] as const;
const APPLY = process.argv.includes("--apply");

interface OcrField {
  fieldPath?: string;
  extractedValue?: unknown;
  enteredValue?: unknown;
  [k: string]: unknown;
}

function isDobField(f: OcrField): boolean {
  return typeof f.fieldPath === "string" && f.fieldPath.toLowerCase().includes("dateofbirth");
}

async function main(): Promise<void> {
  const rows = await prisma.ocrExtraction.findMany({ select: { id: true, fields: true } });

  const updates: Prisma.PrismaPromise<unknown>[] = [];
  const plan: Array<{ id: string; changes: string[] }> = [];
  let scanned = 0;
  let fieldsToChange = 0;

  for (const row of rows) {
    scanned++;
    const fields = row.fields as unknown;
    if (!Array.isArray(fields)) continue;

    const changes: string[] = [];
    const next = (fields as OcrField[]).map((f) => {
      if (!isDobField(f)) return f;
      const nf: OcrField = { ...f };
      for (const key of DOB_VALUE_KEYS) {
        const v = nf[key];
        if (typeof v === "string" && ISO_DATE.test(v)) {
          const disp = formatDobDisplay(v);
          changes.push(`${f.fieldPath}.${key}: ${v} -> ${disp}`);
          nf[key] = disp;
          fieldsToChange++;
        }
      }
      return nf;
    });

    if (changes.length > 0) {
      plan.push({ id: row.id, changes });
      updates.push(
        prisma.ocrExtraction.update({
          where: { id: row.id },
          data: { fields: next as unknown as Prisma.InputJsonValue },
        }),
      );
    }
  }

  console.log(
    `[LENS-017 backfill] scanned=${scanned} rowsToChange=${plan.length} ` +
      `fieldsToChange=${fieldsToChange} mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  for (const p of plan.slice(0, 10)) console.log(`  ${p.id}: ${p.changes.join("; ")}`);
  if (plan.length > 10) console.log(`  … and ${plan.length - 10} more rows`);

  if (!APPLY) {
    console.log("DRY-RUN — nothing written. Re-run with --apply to commit.");
    return;
  }
  if (updates.length === 0) {
    console.log("Nothing to do — no raw ISO DOB remains. (idempotent no-op)");
    return;
  }
  await prisma.$transaction(updates);
  console.log(`APPLIED — ${updates.length} OcrExtraction rows updated in one transaction.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
