/**
 * LENS-008 targeted data migration: repair 24-month coverage on SEEDED rows.
 *
 * WHY
 * ---
 * The delivered instance was seeded BEFORE the VR-133 employment arithmetic in
 * `src/lib/services/demo-seed/dataset.ts` was corrected, and before CH-016
 * (LENS-005) removed the duration-sum fallback from VR-132. The seeder is now
 * right; the already-persisted demo rows are not. A reseed would destroy the
 * curated demo dataset, so the live rows are repaired in place instead.
 *
 * Two defects are repaired, both on `Borrower` JSON columns:
 *
 *   VR-133 (employment) — the pre-fix formula anchored the current job's start
 *   to `now` rather than to the application date, so applications created in
 *   the past have a hole at the OLD end of their trailing 24-month window.
 *   Repair: move the earliest CURRENT employment's `startDate` back to
 *   `applicationDate - EMPLOYMENT_ANCHOR_DAYS`, mirroring dataset.ts:867
 *   (`applicationAgeDays + 800 + idx % 900`). 800 days > the 731-day maximum of
 *   24 calendar months, so the current job alone covers the window. Dates are
 *   only ever moved EARLIER — never later.
 *
 *   VR-132 (address) — the seeder never emitted `fromDate`/`toDate` on
 *   `previousAddresses` rows. Under CH-016 an undatable row contributes no
 *   coverage AND fails the check outright. Repair: date each previous address
 *   backwards from the current address's move-in date, using the row's own
 *   declared `yearsAtAddress`/`monthsAtAddress` duration. `toDate` is set one
 *   day AFTER the current address's move-in instant so the half-open intervals
 *   touch (the current-address interval carries the application timestamp's
 *   time-of-day, a date-only `toDate` on the same day would leave a sub-day
 *   hole). Overlap counts once under the union rule, so a one-day overlap is
 *   correct, not sloppy.
 *
 * SIGNATURES (INV-029 / XBR-003)
 * ------------------------------
 * `Borrower.employments` and `Borrower.previousAddresses` both feed
 * `computeApplicationDataHash`. A naive edit would invalidate every active
 * signature on the seeded corpus and break the T1 submission gate for the very
 * personas this repair exists to unblock. This is a data-integrity migration,
 * not a borrower edit, so signatures that are CURRENTLY VALID (invalidatedAt
 * null AND dataHash === the pre-repair hash) are re-stamped to the post-repair
 * hash inside the same transaction. Already-invalidated signatures, and any
 * signature whose hash had already drifted, are left untouched.
 *
 * SAFETY
 * ------
 * - Touches ONLY borrowers whose Application.isSeed = true; re-checked inside
 *   the transaction and the whole thing aborts if a non-seed row is reached.
 * - Only rows that ACTUALLY FAIL the live rule are touched.
 * - The post-image is re-validated with the shipped pure validators BEFORE the
 *   transaction commits; any row that would still fail aborts the run.
 * - Idempotent: a second run finds nothing failing and writes nothing.
 * - `Borrower.updatedAt` / `Signature.updatedAt` are restored to their original
 *   values by raw UPDATE so the curated demo timeline is preserved.
 * - Dry run is the DEFAULT. Writes require an explicit `--apply`.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/repair-seed-coverage.ts            # dry run
 *   npx tsx --env-file=.env scripts/repair-seed-coverage.ts --apply    # write
 */

import { PrismaClient, Prisma } from "@prisma/client";
import {
  COVERAGE_WINDOW_MONTHS,
  coverageInterval,
  coversTrailingWindow,
  monthsBefore,
  type CoverageInterval,
} from "../src/lib/pure/urla-validation";
import { computeApplicationDataHash } from "../src/lib/services/signature-validity";

/** Days before the application date the repaired current job is anchored to.
 *  Mirrors dataset.ts:867 (`applicationAgeDays + 800 + idx % 900`). */
const EMPLOYMENT_ANCHOR_DAYS = 800;
/** Days of deliberate overlap between a previous address and the current one. */
const ADDRESS_OVERLAP_DAYS = 1;
const DAY_MS = 86_400_000;

type Rec = Record<string, unknown>;

const asArray = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]).map((r) => ({ ...r })) : []);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// The two rules, evaluated exactly as src/lib/pure/urla-validation.ts does
// ---------------------------------------------------------------------------

function employmentCovers(b: BorrowerLike, applicationDate: Date): boolean {
  const employed = b.employmentType === "employed" || b.employmentType === "self-employed";
  if (!employed) return true;
  const applicationMs = applicationDate.getTime();
  const intervals: CoverageInterval[] = [];
  for (const e of asArray(b.employments)) {
    const s = coverageInterval(e.startDate, null, applicationMs);
    if (s) intervals.push(s);
  }
  for (const p of asArray(b.previousEmployments)) {
    const s = coverageInterval(p.startDate, p.endDate, applicationMs);
    if (s) intervals.push(s);
  }
  return coversTrailingWindow(intervals, applicationDate);
}

function addressCovers(b: BorrowerLike, applicationDate: Date): boolean {
  const applicationMs = applicationDate.getTime();
  const currentMonths = (asNum(b.yearsAtAddress) ?? 0) * 12 + (asNum(b.monthsAtAddress) ?? 0);
  const intervals: CoverageInterval[] = [];
  if (currentMonths > 0) {
    intervals.push({ start: monthsBefore(applicationMs, currentMonths), end: applicationMs });
  }
  for (const p of asArray(b.previousAddresses)) {
    const hasFrom = typeof p.fromDate === "string" && p.fromDate.trim() !== "";
    const hasTo = typeof p.toDate === "string" && p.toDate.trim() !== "";
    // CH-016: an undatable row fails the check outright and covers nothing.
    if (!hasFrom || !hasTo) return false;
    const s = coverageInterval(p.fromDate, p.toDate, applicationMs);
    if (s) intervals.push(s);
  }
  return coversTrailingWindow(intervals, applicationDate);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface BorrowerLike {
  employmentType: string | null;
  employments: unknown;
  previousEmployments: unknown;
  yearsAtAddress: number | null;
  monthsAtAddress: number | null;
  previousAddresses: unknown;
}

export interface BorrowerPlan {
  applicationId: string;
  workflowState: string;
  ownerEmail: string;
  borrowerId: string;
  ordinal: number;
  employments?: { before: Rec[]; after: Rec[] };
  previousAddresses?: { before: Rec[]; after: Rec[] };
}

/**
 * Move the earliest CURRENT employment's startDate back to
 * `applicationDate - EMPLOYMENT_ANCHOR_DAYS`. Returns null when nothing needs
 * to change (or when there is no current employment row to anchor).
 */
function planEmployments(b: BorrowerLike, applicationDate: Date): Rec[] | null {
  const rows = asArray(b.employments);
  if (rows.length === 0) return null;
  const targetMs = applicationDate.getTime() - EMPLOYMENT_ANCHOR_DAYS * DAY_MS;
  const target = isoDay(targetMs);

  // Anchor the row that already starts earliest — it is the one carrying the
  // oldest coverage; the others keep their dates.
  let earliestIdx = 0;
  let earliest = Number.POSITIVE_INFINITY;
  for (const [i, r] of rows.entries()) {
    const t = typeof r.startDate === "string" ? Date.parse(r.startDate) : NaN;
    const v = Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    if (v < earliest) {
      earliest = v;
      earliestIdx = i;
    }
  }
  // Never move a date LATER. If the row is already earlier than the anchor,
  // the failure is not this row's to fix.
  if (Number.isFinite(earliest) && earliest <= targetMs) return null;
  rows[earliestIdx] = { ...rows[earliestIdx], startDate: target };
  return rows;
}

/**
 * Date every previous address backwards from the current address's move-in,
 * using each row's own declared duration. Rows are treated as ordered
 * most-recent-first (the seeder and the wizard both emit them that way).
 */
function planPreviousAddresses(b: BorrowerLike, applicationDate: Date): Rec[] | null {
  const rows = asArray(b.previousAddresses);
  if (rows.length === 0) return null;
  const applicationMs = applicationDate.getTime();
  const currentMonths = (asNum(b.yearsAtAddress) ?? 0) * 12 + (asNum(b.monthsAtAddress) ?? 0);
  if (currentMonths <= 0) return null; // no anchor to chain from — reported, not guessed

  // The instant the borrower moved into the CURRENT address.
  let cursorMs = monthsBefore(applicationMs, currentMonths);
  const out: Rec[] = [];
  for (const row of rows) {
    // One-day overlap so the half-open intervals meet despite date-only values.
    const toMs = cursorMs + ADDRESS_OVERLAP_DAYS * DAY_MS;
    const declaredMonths = (asNum(row.yearsAtAddress) ?? 0) * 12 + (asNum(row.monthsAtAddress) ?? 0);
    // A row with no declared duration still has to reach past the window edge.
    const months = declaredMonths > 0 ? declaredMonths : COVERAGE_WINDOW_MONTHS + 1;
    const fromMs = monthsBefore(toMs, months);
    out.push({ ...row, fromDate: isoDay(fromMs), toDate: isoDay(toMs) });
    cursorMs = fromMs;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function planRepairs(prisma: PrismaClient): Promise<BorrowerPlan[]> {
  const apps = await prisma.application.findMany({
    where: { isSeed: true },
    select: {
      id: true,
      createdAt: true,
      workflowState: true,
      borrowerUser: { select: { email: true } },
      borrowers: {
        select: {
          id: true,
          ordinal: true,
          employmentType: true,
          employments: true,
          previousEmployments: true,
          yearsAtAddress: true,
          monthsAtAddress: true,
          previousAddresses: true,
        },
        orderBy: { ordinal: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const plans: BorrowerPlan[] = [];
  for (const app of apps) {
    for (const b of app.borrowers) {
      const plan: BorrowerPlan = {
        applicationId: app.id,
        workflowState: app.workflowState,
        ownerEmail: app.borrowerUser?.email ?? "(none)",
        borrowerId: b.id,
        ordinal: b.ordinal,
      };
      const post: BorrowerLike = { ...b };

      if (!employmentCovers(b, app.createdAt)) {
        const after = planEmployments(b, app.createdAt);
        if (after) {
          plan.employments = { before: asArray(b.employments), after };
          post.employments = after;
        }
      }
      if (!addressCovers(b, app.createdAt)) {
        const after = planPreviousAddresses(b, app.createdAt);
        if (after) {
          plan.previousAddresses = { before: asArray(b.previousAddresses), after };
          post.previousAddresses = after;
        }
      }
      if (!plan.employments && !plan.previousAddresses) continue;

      // Refuse to write a post-image that does not actually satisfy the rules.
      if (!employmentCovers(post, app.createdAt)) {
        throw new Error(
          `post-image still fails VR-133 for borrower ${b.id} (app ${app.id}) — refusing to write`,
        );
      }
      if (!addressCovers(post, app.createdAt)) {
        throw new Error(
          `post-image still fails VR-132 for borrower ${b.id} (app ${app.id}) — refusing to write`,
        );
      }
      plans.push(plan);
    }
  }
  return plans;
}

function describe(plan: BorrowerPlan): string {
  const parts: string[] = [];
  if (plan.employments) {
    const before = plan.employments.before.map((r) => r.startDate).join(",");
    const after = plan.employments.after.map((r) => r.startDate).join(",");
    parts.push(`employments.startDate [${before}] -> [${after}]`);
  }
  if (plan.previousAddresses) {
    const before = plan.previousAddresses.before
      .map((r) => `${r.fromDate ?? "-"}..${r.toDate ?? "-"}`)
      .join(",");
    const after = plan.previousAddresses.after
      .map((r) => `${r.fromDate}..${r.toDate}`)
      .join(",");
    parts.push(`previousAddresses[from..to] [${before}] -> [${after}]`);
  }
  return `  app ${plan.applicationId} (${plan.workflowState}, ${plan.ownerEmail}) borrower#${plan.ordinal} ${plan.borrowerId}\n    ${parts.join("\n    ")}`;
}

async function apply(prisma: PrismaClient, plans: BorrowerPlan[]) {
  const byApp = new Map<string, BorrowerPlan[]>();
  for (const p of plans) {
    const list = byApp.get(p.applicationId) ?? [];
    list.push(p);
    byApp.set(p.applicationId, list);
  }

  let borrowersUpdated = 0;
  let signaturesRestamped = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const [applicationId, appPlans] of byApp) {
        // Re-assert the seed guard INSIDE the transaction.
        const app = await tx.application.findUnique({
          where: { id: applicationId },
          select: { isSeed: true },
        });
        if (!app?.isSeed) {
          throw new Error(`application ${applicationId} is not isSeed=true — aborting entire run`);
        }

        const preHash = await computeApplicationDataHash(tx, applicationId);
        const sigs = await tx.signature.findMany({
          where: { applicationId, invalidatedAt: null, dataHash: preHash },
          select: { id: true, updatedAt: true },
        });

        for (const plan of appPlans) {
          const before = await tx.borrower.findUnique({
            where: { id: plan.borrowerId },
            select: { updatedAt: true },
          });
          const data: Prisma.BorrowerUpdateInput = {};
          if (plan.employments) data.employments = plan.employments.after as Prisma.InputJsonValue;
          if (plan.previousAddresses) {
            data.previousAddresses = plan.previousAddresses.after as Prisma.InputJsonValue;
          }
          await tx.borrower.update({ where: { id: plan.borrowerId }, data });
          borrowersUpdated += 1;
          // Preserve the curated demo timeline — @updatedAt would otherwise
          // stamp every seeded borrower with today's date.
          if (before) {
            await tx.$executeRaw`UPDATE "Borrower" SET "updatedAt" = ${before.updatedAt} WHERE "id" = ${plan.borrowerId}`;
          }
        }

        const postHash = await computeApplicationDataHash(tx, applicationId);
        if (postHash !== preHash && sigs.length > 0) {
          for (const sig of sigs) {
            await tx.signature.update({ where: { id: sig.id }, data: { dataHash: postHash } });
            await tx.$executeRaw`UPDATE "Signature" SET "updatedAt" = ${sig.updatedAt} WHERE "id" = ${sig.id}`;
            signaturesRestamped += 1;
          }
        }
      }
    },
    { maxWait: 15_000, timeout: 600_000 },
  );

  return { borrowersUpdated, signaturesRestamped };
}

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    /* rely on process environment */
  }
  const write = process.argv.includes("--apply");
  const prisma = new PrismaClient();
  try {
    console.log(`[repair-seed-coverage] mode: ${write ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
    const plans = await planRepairs(prisma);
    const apps = new Set(plans.map((p) => p.applicationId));
    const empPlans = plans.filter((p) => p.employments);
    const addrPlans = plans.filter((p) => p.previousAddresses);

    console.log(
      `[repair-seed-coverage] ${plans.length} borrower rows across ${apps.size} seeded applications need repair`,
    );
    console.log(`  VR-133 employment repairs: ${empPlans.length} borrowers`);
    console.log(`  VR-132 address repairs:    ${addrPlans.length} borrowers`);
    for (const p of plans) console.log(describe(p));

    if (plans.length === 0) {
      console.log("[repair-seed-coverage] nothing to do — corpus already satisfies VR-132/VR-133");
      return;
    }
    if (!write) {
      console.log("[repair-seed-coverage] dry run complete — re-run with --apply to write");
      return;
    }
    const counts = await apply(prisma, plans);
    console.log(`[repair-seed-coverage] committed:`);
    console.log(`  borrower rows updated:   ${counts.borrowersUpdated}`);
    console.log(`  signatures re-stamped:   ${counts.signaturesRestamped}`);

    const remaining = await planRepairs(prisma);
    console.log(`[repair-seed-coverage] post-commit re-check: ${remaining.length} failures remaining`);
    if (remaining.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const isCliEntry = process.argv[1] !== undefined && /repair-seed-coverage/.test(process.argv[1]);
if (isCliEntry) {
  main().catch((err) => {
    console.error("[repair-seed-coverage] FAILED:", err);
    process.exitCode = 1;
  });
}
