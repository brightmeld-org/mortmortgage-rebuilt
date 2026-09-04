/**
 * Automated WCAG 2.1 AA sweep across every page in RFP §8 (AC-60).
 *
 * The engine is a vendored axe-core build loaded from disk — no CDN, no API key. Each
 * page is a separate test so the report reads as "page x violations". Serious and
 * critical findings fail; the complete violation list is attached either way, because a
 * moderate finding is still worth reading.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  SUITE_PASSWORD,
  gotoAs,
  requireState,
  runAxe,
  safeGoto,
  signInExpectingRedirect,
  storagePath,
  type AxeViolation,
} from "./support/journey";

/** Scans whatever is currently on screen and fails on serious/critical findings. */
async function scan(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  // Let client-rendered panels settle so the scan covers the real screen, not a spinner.
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(6000);

  const violations = await runAxe(page);
  await testInfo.attach(`axe-${label}`, {
    body: JSON.stringify({ url: page.url(), violations }, null, 2),
    contentType: "application/json",
  });

  const blocking = violations.filter((violation: AxeViolation) =>
    ["serious", "critical"].includes(String(violation.impact)),
  );
  expect(
    blocking,
    `WCAG 2.1 AA serious/critical violations on ${label} (${page.url()}): ` +
      blocking.map((v) => `${v.id} [${v.impact}] x${v.nodes} → ${v.targets.join(", ")}`).join(" | "),
  ).toEqual([]);
}

async function scanRoute(page: Page, testInfo: TestInfo, route: string, ready?: string): Promise<void> {
  await safeGoto(page, route);
  if (ready) {
    await page.getByTestId(ready).waitFor({ timeout: 300_000 });
  }
  await scan(page, testInfo, route);
}

/** Same, for a signed-in role — re-authenticates if the stored session has idled out. */
async function scanRouteAs(
  page: Page,
  testInfo: TestInfo,
  role: "borrower" | "caseworker" | "supervisor",
  route: string,
  ready?: string,
): Promise<void> {
  await gotoAs(page, role, route);
  if (ready) {
    await page.getByTestId(ready).waitFor({ timeout: 300_000 });
  }
  // Panels that fetch after mount get a chance to finish so the scan covers real content.
  await page.waitForTimeout(8000);
  await scan(page, testInfo, route);
}

test.describe("public pages", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const publicRoutes: Array<[string, string]> = [
    ["landing", "/"],
    ["pre-qualification calculator", "/pre-qualify"],
    ["loan comparison", "/compare"],
    ["sign in", "/sign-in"],
    ["create account", "/sign-up"],
    ["verify email", "/verify-email?token=e2e-invalid-token"],
    ["forgot password", "/forgot-password"],
    ["reset password", "/reset-password?token=e2e-invalid-token"],
    ["not found", "/e2e-no-such-page"],
  ];

  for (const [name, route] of publicRoutes) {
    test(`${name} (${route}) has no serious or critical WCAG 2.1 AA violations`, async ({ page }, testInfo) => {
      await scanRoute(page, testInfo, route);
    });
  }
});

test.describe("MFA enrollment page", () => {
  // The enrollment window is scoped to a fresh sign-in, so this signs in rather than
  // reusing a stored session that may have aged out of its window.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("MFA enrollment has no serious or critical WCAG 2.1 AA violations", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    await safeGoto(page, "/sign-in");
    await expect(page.getByTestId("signin-email")).toBeVisible({ timeout: 300_000 });
    await page.waitForTimeout(3000);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await signInExpectingRedirect(page, requireState("preMfaEmail"), SUITE_PASSWORD);
      await page.waitForURL("**/mfa/enroll", { waitUntil: "domcontentloaded", timeout: 300_000 }).catch(() => {});
      await page.getByTestId("mfa-enroll-loading").waitFor({ state: "detached", timeout: 300_000 }).catch(() => {});
      if ((await page.getByTestId("mfa-qr").count()) > 0) break;
      await page.waitForTimeout(5000);
    }
    await expect(page.getByTestId("mfa-qr")).toBeVisible({ timeout: 300_000 });
    await scan(page, testInfo, "/mfa/enroll");
  });
});

test.describe("MFA challenge page", () => {
  // An enrolled account signing in fresh is challenged for its TOTP code.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("MFA challenge has no serious or critical WCAG 2.1 AA violations", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    await safeGoto(page, "/sign-in");
    await expect(page.getByTestId("signin-email")).toBeVisible({ timeout: 300_000 });
    await page.waitForTimeout(3000);
    await signInExpectingRedirect(page, requireState("borrowerEmail"), SUITE_PASSWORD);
    await page.waitForURL("**/mfa/verify", { waitUntil: "domcontentloaded", timeout: 300_000 });
    await expect(page.getByTestId("mfa-code-input")).toBeVisible({ timeout: 300_000 });
    await scan(page, testInfo, "/mfa/verify");
  });
});

test.describe("borrower pages", () => {
  test.use({ storageState: storagePath("borrower") });

  const borrowerRoutes: Array<[string, string, string]> = [
    ["borrower dashboard", "/dashboard", "start-new-application-btn"],
    ["new application", "/applications/new", "create-application-btn"],
    ["profile", "/profile", "profile-personal-card"],
    ["notifications", "/notifications", "notif-page-list"],
  ];

  for (const [name, route, ready] of borrowerRoutes) {
    test(`${name} (${route}) has no serious or critical WCAG 2.1 AA violations`, async ({ page }, testInfo) => {
      await scanRouteAs(page, testInfo, "borrower", route, ready);
    });
  }

  test("application wizard has no serious or critical WCAG 2.1 AA violations", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    await gotoAs(page, "borrower", "/applications/new");
    await page.getByTestId("new-app-mode-blank").check();
    await page.getByTestId("create-application-btn").click();
    await page.waitForURL(/\/applications\/[0-9a-f-]{36}/, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await expect(page.getByTestId("wizard-step-1")).toBeVisible({ timeout: 300_000 });
    await scan(page, testInfo, "/applications/:id (wizard)");
  });

  test("application view has no serious or critical WCAG 2.1 AA violations", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    await gotoAs(page, "borrower", "/dashboard");
    const row = page.locator('[data-testid^="application-row-"]').first();
    await expect(row).toBeVisible({ timeout: 300_000 });
    const applicationId = String(await row.getAttribute("data-testid")).replace("application-row-", "");
    await safeGoto(page, `/applications/${applicationId}/view`);
    await expect(page.getByTestId("view-status-strip")).toBeVisible({ timeout: 300_000 });
    await scan(page, testInfo, "/applications/:id/view");
  });
});

test.describe("caseworker pages", () => {
  test.use({ storageState: storagePath("caseworker") });

  test("caseworker queue has no serious or critical WCAG 2.1 AA violations", async ({ page }, testInfo) => {
    await scanRouteAs(page, testInfo, "caseworker", "/caseworker/queue", "queue-tab-unassigned");
  });

  test("completion history has no serious or critical WCAG 2.1 AA violations", async ({ page }, testInfo) => {
    await scanRouteAs(page, testInfo, "caseworker", "/caseworker/history");
  });
});

test.describe("supervisor pages", () => {
  test.use({ storageState: storagePath("supervisor") });

  const supervisorRoutes: Array<[string, string, string]> = [
    ["all applications", "/supervisor", "supervisor-applications"],
    ["analytics", "/supervisor/analytics", "analytics-summary-total"],
    ["caseworker management", "/supervisor/caseworkers", "staff-add-btn"],
    ["audit log", "/supervisor/audit-log", "audit-filter-actionType"],
    ["configuration", "/supervisor/settings", "config-escalation-ltvThresholdPercent"],
    ["outbound messages", "/supervisor/outbound", "nav-sup-audit-log"],
    ["system status", "/supervisor/system", "sysstatus-refresh-btn"],
    ["demo data", "/supervisor/demo-data", "seed-btn"],
    ["exports", "/supervisor/exports", "exports-lar-download"],
  ];

  for (const [name, route, ready] of supervisorRoutes) {
    test(`${name} (${route}) has no serious or critical WCAG 2.1 AA violations`, async ({ page }, testInfo) => {
      test.setTimeout(900_000);
      await scanRouteAs(page, testInfo, "supervisor", route, ready);
    });
  }

  test("staff application detail has no serious or critical WCAG 2.1 AA violations", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    await gotoAs(page, "supervisor", "/supervisor");
    const row = page.locator('[data-testid^="sup-row-"]').first();
    await expect(row).toBeVisible({ timeout: 300_000 });
    const applicationId = String(await row.getAttribute("data-testid")).replace("sup-row-", "");
    await safeGoto(page, `/staff/applications/${applicationId}`);
    await expect(page.getByTestId("staff-application-detail")).toBeVisible({ timeout: 300_000 });
    await page.getByTestId("detail-loading").waitFor({ state: "detached", timeout: 300_000 }).catch(() => {});
    await scan(page, testInfo, "/staff/applications/:id");
  });
});
