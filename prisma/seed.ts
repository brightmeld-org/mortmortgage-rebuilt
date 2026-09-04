// prisma/seed.ts — invoked by `npx prisma db seed` (task-043, REQ-066, §4.6.12).
//
// Base seed ALWAYS (any DEMO_MODE): the three demo accounts (isDemo=true,
// email pre-verified, MFA pre-enrolled — exactly the identities the demo-login
// service provisions) + idempotent SystemConfig defaults (create-if-missing;
// HMDA identifiers stay blank per §4.6.11).
//
// Full §4.6.12 demo dataset ONLY when DEMO_MODE=true: ≥50 applications with
// every §9 entity represented, persona staging, staff roster, time-relative
// dates. Re-running removes the prior seed set first (idempotent, ASYNC-006).
// CLI runs are audited with the SYSTEM actor (no session exists here);
// endpoint runs audit the triggering Supervisor.
//
// App modules are loaded via runtime-computed dynamic-import specifiers:
// lens-check typechecks prisma/ standalone (outside the app tsconfig, so the
// `@/` path alias used throughout src/ cannot resolve there, and with CJS
// output where import.meta is disallowed — the same FP class as its
// rule-tests/verification carve-outs). Passing the specifier through this
// identity function keeps it non-literal, so standalone tsc does not try to
// resolve the module graph; the imported modules are fully typechecked by
// typecheck:src, and tsx resolves the relative specifiers at runtime.

const appModule = (relPath: string): string => relPath;

async function main(): Promise<void> {
  const { demoModeEnabled } = await import(appModule("../src/lib/services/demo-login.ts"));
  const { ensureBaseSeed, runDemoSeed, SYSTEM_SEED_ACTOR } = await import(
    appModule("../src/lib/services/demo-seed/index.ts")
  );

  const demo: boolean = demoModeEnabled();
  console.log(`[seed] base seed starting (DEMO_MODE=${process.env.DEMO_MODE ?? "unset"})`);
  await ensureBaseSeed();
  console.log("[seed] base seed complete: demo accounts + SystemConfig defaults ensured");

  if (!demo) {
    console.log("[seed] DEMO_MODE is not 'true' — skipping the full demo dataset");
    return;
  }

  console.log("[seed] full demo dataset starting (removal-first re-seed)…");
  const { run, seconds } = await runDemoSeed(SYSTEM_SEED_ACTOR);
  console.log(`[seed] full demo dataset complete in ${seconds.toFixed(1)}s (SeedRun ${run.id})`);
  console.log(`[seed] recordCounts: ${JSON.stringify(run.recordCounts)}`);
}

async function disconnect(): Promise<void> {
  const { prisma } = await import(appModule("../src/lib/prisma.ts"));
  await prisma.$disconnect();
}

main()
  .then(async () => {
    await disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed] FAILED:", err);
    await disconnect();
    process.exit(1);
  });
