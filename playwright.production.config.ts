import { defineConfig, devices } from "@playwright/test";

/**
 * CH-024 — production-mode E2E config (INV-050/BUG-34).
 *
 * Runs ONLY task-047/11-production-mode.spec.ts, pointed at a `next start`
 * instance (default port 3084 per the ≥3080 rule; 3083 is the profile's dev
 * port). Separate from playwright.config.ts because the main suite's setup
 * project and global teardown authenticate through the /api/test/fixtures seam
 * and demo sessions — machinery this anonymous spec does not need, and which
 * is partly 404-absent when NODE_ENV=production. The server is externally
 * managed, exactly like the main config:
 *
 *   npm run build && npx next start -p 3084
 *   npx playwright test -c playwright.production.config.ts
 */
export default defineConfig({
  testDir: "./task-047",
  testMatch: /11-production-mode\.spec\.ts/,
  outputDir: "./task-047/artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 90_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3084",
    actionTimeout: 90_000,
    navigationTimeout: 180_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    viewport: { width: 1400, height: 1100 },
  },
  projects: [
    {
      name: "production",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1100 } },
    },
  ],
});
