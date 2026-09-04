/**
 * Final file of the §7.7 run: restores the §4.6.11 SystemConfig defaults that the
 * suites raised in order to build fixtures, and asserts the app is left as delivered.
 *
 * The suites raise `rateLimit.authAttempts` to a working headroom because every fixture
 * account needs register + verify + sign-in + MFA calls, all of which sit behind the
 * 10-per-15-minute auth limiter. Restoring here — rather than per file — keeps the
 * limiter out of the way for the whole serial run and still leaves the delivered
 * configuration intact at the end.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { demoLogin, type Session } from "../helpers/auth.js";
import { DEFAULT_AUTH_ATTEMPTS, readConfig, writeSetting } from "../helpers/config.js";

/** Every §4.6.11 setting this suite set touches, with its delivered default. */
const DEFAULTS: Record<string, string> = {
  "rateLimit.authAttempts": DEFAULT_AUTH_ATTEMPTS,
  "rateLimit.authWindowMinutes": "15",
  "escalation.ltvThresholdPercent": "80",
  "escalation.dtiThresholdPercent": "43",
  "workload.capacityYellow": "9",
};

let supervisor: Session;

before(async () => {
  supervisor = await demoLogin("supervisor");
});

describe("run teardown — SystemConfig is left at its delivered defaults", () => {
  test("every setting the suite adjusts is restored", { timeout: 120000 }, async () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      await writeSetting(supervisor, key, value);
    }
    const settings = await readConfig(supervisor);
    const drift: string[] = [];
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const actual = settings.get(key);
      if (actual !== value) drift.push(`${key}: expected ${value}, found ${actual}`);
    }
    assert.deepEqual(drift, [], drift.join("\n"));
  });

  test("the auth limiter is back at the documented 10-per-15-minute policy", { timeout: 120000 }, async () => {
    const settings = await readConfig(supervisor);
    assert.equal(settings.get("rateLimit.authAttempts"), DEFAULT_AUTH_ATTEMPTS);
    assert.equal(settings.get("rateLimit.authWindowMinutes"), "15");
  });
});
