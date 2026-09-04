/**
 * Setup project — prepares the instance for the run, mints the sessions the journeys
 * reuse, and covers the two §7.7 borrower entry points that can only be proved once per
 * account: register → verify via Outbound Messages → enroll MFA (FLOW-002 / AC-01).
 *
 * Order matters, and each step depends on the one before it:
 *   1. raise the §4.6.11 request budgets (general per-minute AND auth attempts) before
 *      anything else spends them;
 *   2. re-run the §4.6.12 demonstration seed so the staged personas the journeys start
 *      from exist regardless of what ran against this instance previously;
 *   3. mint the three demo role sessions against that freshly seeded dataset;
 *   4. register the suite's own borrower accounts.
 *
 * Sessions are minted here rather than per test because the auth endpoints are
 * rate-limited (§4.1.9), and because a role journey that re-authenticates on every step
 * is testing sign-in, not the journey.
 */
import { mkdirSync } from "node:fs";
import { expect, test as setup } from "@playwright/test";
import {
  AUTH_DIR,
  RUN_CONFIG_RAISES,
  SUITE_PASSWORD,
  demoSignIn,
  enrollMfa,
  openMfaEnrollment,
  outboundVerificationHref,
  readConfig,
  runTag,
  seedDemoData,
  setConfigAndReadBack,
  startRun,
  storagePath,
  supervisorApiContext,
  submitRegistration,
  verifyEmail,
  writeState,
} from "./support/journey";

setup.describe.configure({ mode: "serial" });

setup("the run's request budgets are raised to run headroom by a Supervisor", async () => {
  mkdirSync(AUTH_DIR, { recursive: true });
  startRun();

  // First, before anything else spends the budget it is about to raise: the general
  // per-minute budget AND the auth attempt cap. §4.6.11 makes both configurable and §B
  // routes the change through PUT /api/admin/config (Supervisor-only, audited with
  // before/after — expected). Both are restored to their delivered defaults in global
  // teardown, which fails the run if a restore does not land.
  const request = await supervisorApiContext();
  try {
    for (const { key, headroom } of RUN_CONFIG_RAISES) {
      const applied = await setConfigAndReadBack(request, key, headroom);
      expect(applied, `${key} is raised to run headroom`).toBe(headroom);
    }
  } finally {
    await request.dispose();
  }
});

setup("a fresh demonstration seed stages the personas the journeys start from", async () => {
  // §4.6.12 staging is consumed by the journeys that use it (05 takes the FHA file
  // awaiting Level-1, 06 takes the Demo Borrower's Revision Requested application), so
  // the run re-stages rather than inheriting whatever the last run left behind.
  setup.setTimeout(2_700_000);

  const request = await supervisorApiContext();
  try {
    const run = await seedDemoData(request);
    expect(run.id, "the seed run reports its identifier").toBeTruthy();
    expect(run.createdAt, "the seed run reports when it ran").toBeTruthy();
    expect(run.recordCounts, "the seed run reports what it wrote").toBeTruthy();
    expect(run.removedAt, "a freshly created seed run is not a removed one").toBeFalsy();

    // Seeding writes §4.6.11 settings of its own (the HMDA identifiers). Re-read the
    // budgets afterwards so a seed that reset them fails here, and not thirty journeys
    // later as an unexplained refusal.
    const settings = await readConfig(request);
    for (const { key, headroom } of RUN_CONFIG_RAISES) {
      expect(settings.get(key), `${key} still holds run headroom after the seed`).toBe(headroom);
    }
  } finally {
    await request.dispose();
  }
});

setup("demo quick logins sign each role in on the first click", async ({ browser }) => {
  // After the seed, so every stored session belongs to the dataset the journeys read.
  for (const role of ["borrower", "caseworker", "supervisor"] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await demoSignIn(page, role);

    // Each role lands on its own home and gets its own navigation (§C AppShell).
    const expectedHome = {
      borrower: "/dashboard",
      caseworker: "/caseworker/queue",
      supervisor: "/supervisor",
    }[role];
    expect(new URL(page.url()).pathname, `${role} demo login lands on its role home`).toBe(expectedHome);
    await expect(page.getByTestId("user-menu")).toBeVisible();

    await context.storageState({ path: storagePath(role) });
    await context.close();
  }
});

setup("borrower registers, verifies from Outbound Messages, and enrolls MFA", async ({ browser }) => {
  const tag = runTag();
  const email = `${tag}-borrower@e2e.example`;

  const borrowerContext = await browser.newContext();
  const borrower = await borrowerContext.newPage();
  const supervisorContext = await browser.newContext({ storageState: storagePath("supervisor") });
  const supervisor = await supervisorContext.newPage();

  await submitRegistration(borrower, email);

  // The verification message is observable on the Supervisor Outbound Messages page.
  const href = await outboundVerificationHref(supervisor, email);
  expect(href, "verification link points at the /verify-email landing").toContain("/verify-email?token=");
  await verifyEmail(borrower, href);

  // Signing in before enrollment routes to MFA enrollment, not the dashboard.
  await openMfaEnrollment(borrower, email, SUITE_PASSWORD);

  const { secret, recoveryCodes } = await enrollMfa(borrower);
  expect(recoveryCodes, "enrollment issues exactly ten one-time recovery codes").toHaveLength(10);

  await borrower.waitForURL("**/dashboard", { waitUntil: "domcontentloaded", timeout: 180_000 });
  await expect(borrower.getByTestId("start-new-application-btn")).toBeVisible();

  writeState({ borrowerEmail: email, borrowerTotpSecret: secret });
  await borrowerContext.storageState({ path: storagePath("fresh-borrower") });

  await supervisorContext.close();
  await borrowerContext.close();
});

setup("a second borrower registers and verifies but stops short of MFA enrollment", async ({ browser }) => {
  // Gives the accessibility sweep a real /mfa/enroll page to scan (§8 "MFA Enrollment").
  const email = `${runTag()}-premfa@e2e.example`;

  const borrowerContext = await browser.newContext();
  const borrower = await borrowerContext.newPage();
  const supervisorContext = await browser.newContext({ storageState: storagePath("supervisor") });
  const supervisor = await supervisorContext.newPage();

  await submitRegistration(borrower, email);
  const href = await outboundVerificationHref(supervisor, email);
  await verifyEmail(borrower, href);

  await openMfaEnrollment(borrower, email, SUITE_PASSWORD);

  writeState({ preMfaEmail: email });
  await borrowerContext.storageState({ path: storagePath("pre-mfa-borrower") });

  await supervisorContext.close();
  await borrowerContext.close();
});
