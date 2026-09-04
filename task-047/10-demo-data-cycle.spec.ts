/**
 * FLOW-012 — Supervisor seeds and removes demonstration data.
 *
 * This journey rewrites the shared dataset every other spec reads, so it runs last and
 * finishes with a fresh seed in place, leaving the instance demonstration-ready.
 */
import { expect, test, type Page } from "@playwright/test";
import { demoSignIn, gotoAs, gotoUntilReady, requireState, storagePath } from "./support/journey";

test.describe.configure({ mode: "serial" });
test.use({ storageState: storagePath("supervisor") });

const SEED_TIMEOUT = 900_000;

async function openDemoData(page: Page): Promise<void> {
  await gotoAs(page, "supervisor", "/supervisor/demo-data");
  await gotoUntilReady(page, "/supervisor/demo-data", "seed-btn");
}

/**
 * Press one of the Demo Data actions and confirm the run actually started.
 *
 * Seed and Remove are client-side handlers, and the app server compiles a
 * route's client chunk on demand — a freshly opened page can paint its markup
 * seconds before React attaches handlers. A press that lands in that window is
 * swallowed with no request, no progress affordance and no error, and the long
 * wait that follows then times out on a run that was never started. So press
 * until the page shows the run under way (`seed-progress`) or already settled
 * (`seed-summary` / `seed-removed-banner` / `seed-error`). A swallowed press
 * started nothing, so re-pressing cannot run the operation twice.
 */
async function startDemoDataAction(page: Page, button: string, confirmButton: string): Promise<void> {
  const settled = page.locator(
    '[data-testid="seed-progress"], [data-testid="seed-summary"], ' +
      '[data-testid="seed-removed-banner"], [data-testid="seed-error"]',
  );
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await page.getByTestId(button).click();
    const confirm = page.getByTestId(confirmButton);
    if (await confirm.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await confirm.click();
    }
    const started = await settled
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (started) return;
  }
  throw new Error(`[data-testid="${button}"] never started a run — the page reported no progress, result or error`);
}

/** Fails fast (with the server's own words) instead of waiting out the seed budget. */
async function failOnSeedError(page: Page): Promise<void> {
  const banner = page.getByTestId("seed-error");
  if (await banner.isVisible().catch(() => false)) {
    throw new Error(`the demo-data run was refused: ${(await banner.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

async function totalApplications(page: Page): Promise<number> {
  await gotoAs(page, "supervisor", "/supervisor");
  await gotoUntilReady(page, "/supervisor", "supervisor-applications");
  // The summary cards arrive with their own aggregation query, after the container.
  await expect(page.getByTestId("sup-card-total")).toBeVisible({ timeout: 300_000 });
  const text = await page.getByTestId("sup-card-total").innerText();
  return Number(text.replace(/[^0-9]/g, ""));
}

test("the Demo Data page is available and the instance reports demonstration mode", async ({ page }) => {
  await gotoAs(page, "supervisor", "/supervisor/system");
  await expect(page.getByTestId("sysstatus-demo-indicator")).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("sysstatus-demo-indicator")).toContainText(/DEMO_MODE/i);

  await openDemoData(page);
  await expect(page.getByTestId("seed-btn")).toBeVisible();
  await expect(page.getByTestId("seed-remove-btn")).toBeVisible();
});

test("seeding produces at least fifty applications and reports a run summary", async ({ page }) => {
  test.setTimeout(SEED_TIMEOUT * 2);
  await openDemoData(page);

  await startDemoDataAction(page, "seed-btn", "seed-confirm-btn");
  await failOnSeedError(page);

  await expect(page.getByTestId("seed-summary"), "the seed run reports its record counts").toBeVisible({
    timeout: SEED_TIMEOUT,
  });
  await expect(page.getByTestId("seed-summary")).toContainText(/\d/);

  expect(await totalApplications(page), "the demonstration dataset meets the §4.6.12 floor").toBeGreaterThanOrEqual(
    50,
  );
});

test("each demo persona signs in and lands on a populated role home", async ({ browser }) => {
  test.setTimeout(SEED_TIMEOUT);

  for (const [role, home, marker] of [
    ["borrower", "/dashboard", "dashboard-summary-total"],
    ["caseworker", "/caseworker/queue", "stats-queue-size"],
    ["supervisor", "/supervisor", "sup-card-total"],
  ] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await demoSignIn(page, role);
    expect(new URL(page.url()).pathname, `${role} lands on its role home after re-seeding`).toBe(home);
    await expect(page.getByTestId(marker)).toBeVisible({ timeout: 300_000 });
    await context.storageState({ path: storagePath(role) });
    await context.close();
  }
});

test("removing demo data deletes only seed-flagged records", async ({ page }) => {
  test.setTimeout(SEED_TIMEOUT * 2);
  const before = await totalApplications(page);
  const liveNumber = requireState("liveApplicationNumber");

  await openDemoData(page);
  await startDemoDataAction(page, "seed-remove-btn", "seed-remove-confirm-btn");
  await failOnSeedError(page);

  await expect
    .poll(async () => totalApplications(page), { timeout: SEED_TIMEOUT, intervals: [20_000] })
    .toBeLessThan(before);

  // The application this suite created is not seed-flagged, so it survives removal.
  await gotoAs(page, "supervisor", "/supervisor");
  await gotoUntilReady(page, "/supervisor", "supervisor-applications");
  await page.getByTestId("sup-search").fill(liveNumber);
  await expect(
    page.locator('[data-testid^="sup-row-"]', { hasText: liveNumber }).first(),
    "non-seed data survives Remove Demo Data",
  ).toBeVisible({ timeout: 300_000 });
});

test("re-seeding restores the demonstration dataset for the next run", async ({ page }) => {
  test.setTimeout(SEED_TIMEOUT * 2);
  await openDemoData(page);

  await startDemoDataAction(page, "seed-btn", "seed-confirm-btn");
  await failOnSeedError(page);
  await expect(page.getByTestId("seed-summary")).toBeVisible({ timeout: SEED_TIMEOUT });

  expect(await totalApplications(page), "the instance is demonstration-ready again").toBeGreaterThanOrEqual(50);
});
