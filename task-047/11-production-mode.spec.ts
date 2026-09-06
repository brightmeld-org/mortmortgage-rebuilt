/**
 * CH-024 — PRODUCTION-MODE CLIENT-JS BOOT PROOF (INV-050, BUG-34).
 *
 * Every other task-047 spec ran its history against `next dev`, where all pages
 * render dynamically and receive their CSP nonce — which is exactly how BUG-34
 * (statically prerendered pages shipping nonce-less script tags under
 * `next start`, browser blocking every _next/static chunk) passed 87/87 specs
 * and still broke the first production serving (public repo CI run 33910740894).
 *
 * This spec re-drives the anonymous prequal calculator — the exact CI failure
 * signature — and is POINTED AT `next start`, never `next dev`:
 *
 *   npm run build
 *   npx next start -p 3084                       # scratch DB per the CH-024 plan
 *   npx playwright test -c playwright.production.config.ts
 *
 * It runs under its own config (playwright.production.config.ts) because the
 * main suite's setup project needs the /api/test/fixtures seam, which the
 * middleware makes 404-absent when NODE_ENV=production — and this spec needs
 * no session, no seed and no config raises: it is anonymous by design.
 *
 * Endpoint discipline (contracts §B): page-route GETs are HTML routes; the only
 * API traffic is the calculator's own POST /api/public/prequalify plus the
 * GET /api/health readiness poll — all contracted.
 *
 * What "pass" proves: outputs computing (not "—") means React hydrated and the
 * debounced fetch ran, i.e. the browser executed _next/static chunks under the
 * production CSP — precisely what BUG-34 made impossible.
 */
import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async ({ request }) => {
  // Readiness poll: `next start` may still be warming up when the runner begins.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const healthy = await request
      .get("/api/health")
      .then((r) => r.ok())
      .catch(() => false);
    if (healthy) return;
    if (Date.now() > deadline) throw new Error("server never became healthy at /api/health");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
});

test("under next start, the anonymous prequal calculator hydrates, computes, and calls its API", async ({ page }) => {
  await page.goto("/pre-qualify", { waitUntil: "domcontentloaded" });

  // Outputs start empty; nothing is computed until the visitor supplies inputs.
  await expect(page.getByTestId("prequal-output-maxLoanAmount")).toHaveText("—");

  // Armed BEFORE the inputs that trigger the debounced call: the fired POST is
  // the proof client JS is running — a prerendered nonce-less page renders this
  // same form but never sends it (the BUG-34 presentation).
  const prequalResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/public/prequalify") &&
      response.request().method() === "POST",
    { timeout: 90_000 },
  );

  await page.getByTestId("prequal-input-grossMonthlyIncome").fill("10000");
  await page.getByTestId("prequal-input-monthlyDebtPayments").fill("800");
  await page.getByTestId("prequal-input-creditTier").selectOption("excellent");
  await page.getByTestId("prequal-input-downPaymentAmount").fill("100000");
  await page.getByTestId("prequal-input-termYears").selectOption("30");

  const response = await prequalResponse;
  expect(response.status(), "POST /api/public/prequalify status").toBe(200);

  await expect(page.getByTestId("prequal-output-maxLoanAmount")).not.toHaveText("—");
  await expect(page.getByTestId("prequal-output-estimatedRate")).not.toHaveText("—");
  await expect(page.getByTestId("prequal-output-estimatedMonthlyPiti")).not.toHaveText("—");
  await expect(page.getByTestId("prequal-output-maxPurchasePrice")).not.toHaveText("—");
  await expect(page.getByTestId("prequal-qualify-indicator")).toBeVisible();
});
