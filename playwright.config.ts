import { defineConfig, devices } from "@playwright/test";

/**
 * task-047 — §7.7 end-to-end browser suite.
 *
 * The app server is externally managed (as it is in CI against the deployed demo
 * instance), so no `webServer` block: the suite assumes http://localhost:3083 is
 * already serving with DEMO_MODE=true and the §4.6.12 demo seed applied.
 *
 * One worker, no parallelism: every journey shares a single application dataset —
 * claims, assignments, configuration changes and the seed/remove cycle interfere
 * with each other if run concurrently.
 *
 * Zero retries: a flaky role journey is a finding, not something to paper over.
 */
export default defineConfig({
  testDir: "./task-047",
  outputDir: "./task-047/artifacts",
  // Restores the §4.6.11 request-budget default the setup project raises for the run.
  // A teardown rather than a trailing spec so `10-demo-data-cycle` stays the last spec
  // and the fresh seed it leaves behind is the state the instance is left in.
  globalTeardown: "./task-047/support/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // Journeys are long and the dev server serves a 600+ application dataset:
  // analytics, the audit viewer and the underwriting panel each take tens of
  // seconds to settle. Individual specs tighten or extend this per test.
  timeout: 600_000,
  expect: { timeout: 90_000 },
  reporter: [["list"], ["json", { outputFile: "task-047/results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3083",
    actionTimeout: 90_000,
    navigationTimeout: 180_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    viewport: { width: 1400, height: 1100 },
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1100 } },
    },
    {
      name: "journeys",
      // 11-production-mode is CH-024's `next start` spec; it runs under its own
      // config (playwright.production.config.ts) against port 3084, not here.
      testIgnore: [/.*\.setup\.ts/, /11-production-mode\.spec\.ts/],
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1100 } },
    },
  ],
});
