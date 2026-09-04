/**
 * Run teardown — restores every §4.6.11 SystemConfig default the setup project raised, so
 * the instance is left exactly as delivered.
 *
 * The setup project raises `rateLimit.generalPerMinute` and `rateLimit.authAttempts` to
 * run headroom because the whole suite drives one browser from one client IP for an hour,
 * and the delivered 60-per-minute and 10-per-15-minute budgets are production policies,
 * not harness budgets. This is the mirror of those raises: it runs after every spec (so
 * `10-demo-data-cycle` remains the last spec and the freshly seeded dataset it leaves
 * behind is untouched), writes each delivered default back, and reads them all back to
 * assert the restores actually landed. Any drift fails the run rather than leaving a
 * silently reconfigured instance behind.
 *
 * The writes are audited with before/after values (§4.6.11) — expected, same as the raises.
 */
import { request as playwrightRequest, type APIRequestContext, type FullConfig } from "@playwright/test";
import {
  BASE_URL,
  RUN_CONFIG_RAISES,
  readConfig,
  storagePath,
  supervisorApiContext,
  writeConfig,
} from "./journey";

/**
 * A supervisor API context. Prefers the storage state minted by the run; if that session
 * has idled out (a long suite can outlive the configured idle timeout) it mints a new one
 * through the contracted demo-login endpoint.
 */
async function teardownContext(): Promise<APIRequestContext> {
  const stored = await playwrightRequest
    .newContext({ baseURL: BASE_URL, storageState: storagePath("supervisor") })
    .catch(() => null);

  if (stored) {
    const probe = await stored.get("/api/admin/config").catch(() => null);
    if (probe && probe.ok()) return stored;
    await stored.dispose();
  }

  return supervisorApiContext();
}

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  const request = await teardownContext();
  try {
    for (const { key, delivered } of RUN_CONFIG_RAISES) {
      await writeConfig(request, key, delivered);
    }

    const settings = await readConfig(request);
    const drifted = RUN_CONFIG_RAISES.filter(({ key, delivered }) => settings.get(key) !== delivered);
    if (drifted.length > 0) {
      throw new Error(
        `SystemConfig was not restored: ${drifted
          .map(({ key, delivered }) => `${key} is "${settings.get(key)}", expected the delivered default "${delivered}"`)
          .join("; ")}.`,
      );
    }
    console.log(
      `[task-047 teardown] restored to delivered defaults: ${RUN_CONFIG_RAISES.map(
        ({ key, delivered }) => `${key}=${delivered}`,
      ).join(", ")}.`,
    );
  } finally {
    await request.dispose();
  }
}
