// Underwriting-result staleness marking — SHARED transactional helper
// (task-023; also intended for task-025 re-run/staleness flows).
//
// INV-030 / XBR-004 / §4.6.5: underwriting check results are marked stale by
// data corrections (and by revision loops / new versions — the workflow engine
// owns those via its own markUnderwritingStale, which marks EVERY result).
// This helper marks a SPECIFIC SET of check types stale and mirrors AUS
// staleness onto Application.ausStale exactly like the engine does: the flag
// is set only when a completed AUS result exists (nothing to re-run
// otherwise). The T15 gate (workflow-engine) blocks on either the current AUS
// result's isStale or Application.ausStale — no change needed there.
//
// TRANSACTION-ONLY: callers pass the `tx` of the same prisma.$transaction that
// performs the change causing the staleness, so the marks are atomic with the
// change (same posture as the audit service).

import type { CheckType, Prisma } from "@prisma/client";
import { persistApplicationQualification } from "@/lib/services/qualification";

export interface StalenessOutcome {
  /** Check types this call attempted to mark (input echo, deduplicated). */
  checkTypes: CheckType[];
  /** True when a completed AUS result exists and Application.ausStale was set. */
  ausMarkedStale: boolean;
}

/**
 * Mark every non-stale UnderwritingResult of the given check types stale for
 * the application (history rows included — matching the engine's behavior),
 * and mirror `ausStale` on the Application when "aus" is among them and a
 * completed AUS result exists.
 */
export async function markChecksStale(
  tx: Prisma.TransactionClient,
  applicationId: string,
  checkTypes: readonly CheckType[],
): Promise<StalenessOutcome> {
  const types = [...new Set(checkTypes)];
  if (types.length === 0) return { checkTypes: [], ausMarkedStale: false };

  await tx.underwritingResult.updateMany({
    where: { applicationId, checkType: { in: types }, isStale: false },
    data: { isStale: true },
  });

  if (types.includes("avm")) {
    // §E / ASM-006: a stale AVM result is NOT available — once "avm" is
    // marked, the stored Application.ltv/cltv must revert to the
    // estimatedValue-only basis via THE shared module, atomic with the marks.
    // (In the corrections flow this runs AFTER the correction's own recompute,
    // so the last persisted value reflects the post-staleness basis.)
    await persistApplicationQualification(applicationId, tx);
  }

  let ausMarkedStale = false;
  if (types.includes("aus")) {
    const completedAus = await tx.underwritingResult.count({
      where: { applicationId, checkType: "aus", status: "completed" },
    });
    if (completedAus > 0) {
      await tx.application.update({
        where: { id: applicationId },
        data: { ausStale: true },
      });
      ausMarkedStale = true;
    }
  }

  return { checkTypes: types, ausMarkedStale };
}
