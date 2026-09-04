/**
 * §7.7 — INV-045 / VR-136 (contract delta CH-015, ASM-001): the company time
 * zone is a runtime-configurable SystemConfig setting, not a compile-time
 * constant.
 *
 * Three obligations, checked here:
 *
 *  1. REGISTRY — `company.timeZone` is present in the SystemConfig registry with
 *     the default `America/New_York`, and is genuinely writable through the
 *     config endpoints (the failure mode Lens found on `password.minLength` was
 *     "documented as configurable but not registered", so presence alone is not
 *     enough: the key must round-trip through PUT).
 *
 *  2. VR-136 — the accepted form of `value` for this key is an IANA identifier
 *     the runtime's zone database accepts. Unknown names and fixed-offset
 *     aliases (UTC, GMT, Etc/GMT±n, "+05:00") are rejected with a validation
 *     error naming the field.
 *
 *  3. NO COMPILE-TIME CONSTANT — the source guard: a grep for a hardcoded IANA
 *     zone literal anywhere under src/ outside the registry default returns
 *     nothing, and no module exports the zone as a string constant. This is the
 *     regression that CH-015 exists to prevent: the previous build shipped
 *     `export const COMPANY_TIME_ZONE = "America/New_York"` in sla.ts, so a
 *     rebuild would reproduce it unless something fails when it comes back.
 *
 * Plus a behavioural check that the setting actually reaches a date-rendering
 * surface: flipping the zone changes the day buckets of the analytics volume
 * series. The value is restored in a finally block and in after().
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { after, before, describe, test } from "node:test";
import { demoLogin, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting, writeSetting } from "../helpers/config.js";
import { PUT, GET, expectOk } from "../helpers/http.js";

/** The contract default (INV-045). */
const DEFAULT_ZONE = "America/New_York";
const KEY = "company.timeZone";

let supervisor: Session;

before(async () => {
  supervisor = await demoLogin("supervisor");
  await ensureAuthHeadroom(supervisor);
});

after(async () => {
  // Belt and braces: whatever happened above, the shared setting goes back.
  await writeSetting(supervisor, KEY, JSON.stringify(DEFAULT_ZONE));
});

describe("INV-045 — company.timeZone is a registered, writable SystemConfig setting", () => {
  test("the key is served by GET /api/admin/config with the contract default", async () => {
    const value = await readSetting(supervisor, KEY);
    assert.equal(value, JSON.stringify(DEFAULT_ZONE), "company.timeZone default");
  });

  test("the key round-trips through PUT (registered, not merely documented)", async () => {
    try {
      await writeSetting(supervisor, KEY, JSON.stringify("America/Chicago"));
      assert.equal(await readSetting(supervisor, KEY), JSON.stringify("America/Chicago"));
    } finally {
      await writeSetting(supervisor, KEY, JSON.stringify(DEFAULT_ZONE));
    }
    assert.equal(await readSetting(supervisor, KEY), JSON.stringify(DEFAULT_ZONE));
  });
});

describe("VR-136 — accepted form of company.timeZone", () => {
  const accepted = ["America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney"];
  const rejected = [
    "Not/AZone", // unknown name
    "America/Nowhere", // unknown name with a real region
    "UTC", // fixed-offset alias
    "GMT", // fixed-offset alias
    "Etc/GMT+5", // fixed-offset alias
    "+05:00", // offset string
    "-0800", // offset string
    "", // blank
  ];

  for (const zone of accepted) {
    test(`accepts the IANA identifier ${zone}`, async () => {
      try {
        await writeSetting(supervisor, KEY, JSON.stringify(zone));
        assert.equal(await readSetting(supervisor, KEY), JSON.stringify(zone));
      } finally {
        await writeSetting(supervisor, KEY, JSON.stringify(DEFAULT_ZONE));
      }
    });
  }

  for (const zone of rejected) {
    test(`rejects ${zone === "" ? "(blank)" : zone} with a validation error naming the field`, async () => {
      const result = await PUT<{ code?: string; details?: string[] }>("/api/admin/config", {
        session: supervisor,
        body: { key: KEY, value: JSON.stringify(zone) },
      });
      assert.equal(result.status, 400, `expected 400 for ${zone || "(blank)"}, got ${result.status}`);
      assert.equal(result.body?.code, "validation_error");
      const details = result.body?.details ?? [];
      assert.ok(
        details.some((d) => d.startsWith("value:")),
        `validation error must name the field: ${JSON.stringify(result.body)}`,
      );
      // And nothing was written.
      assert.equal(await readSetting(supervisor, KEY), JSON.stringify(DEFAULT_ZONE));
    });
  }
});

describe("INV-045 — no module holds the company time zone as a compile-time constant", () => {
  /**
   * The registry default is the ONE place an IANA literal may appear. Anything
   * else — a formatter default, a fallback, a re-exported constant — is the
   * defect CH-015 ratified away.
   */
  const REGISTRY_FILE = join("src", "lib", "services", "config.ts");
  const IANA_LITERAL =
    /["'`](Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Brazil|Canada|Chile|Etc|Europe|Indian|Mexico|Pacific|US)\/[A-Za-z0-9_+-]+["'`]/;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  test("a grep for a hardcoded IANA zone literal outside the registry default returns nothing", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const rel = relative(process.cwd(), file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!IANA_LITERAL.test(line)) return;
        const trimmed = line.trim();
        // Comments and the VR-136 error message quote the default as prose.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        const isRegistryDefault =
          file.split(sep).join(sep).endsWith(REGISTRY_FILE) &&
          (trimmed.startsWith("defaultValue:") || trimmed.includes("must be an IANA time zone identifier"));
        if (isRegistryDefault) return;
        offenders.push(`${rel}:${i + 1}: ${trimmed}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `hardcoded IANA zone literal(s) found — the company zone must come from the config registry (INV-045):\n${offenders.join("\n")}`,
    );
  });

  test("no module exports the company time zone as a string constant", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const text = readFileSync(file, "utf8");
      if (/export\s+const\s+COMPANY_TIME_ZONE\b/.test(text)) {
        offenders.push(relative(process.cwd(), file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `COMPANY_TIME_ZONE is exported as a constant in: ${offenders.join(", ")} — INV-045 requires an async resolver`,
    );
  });
});

describe("INV-045 — the setting reaches the date-rendering surfaces", () => {
  test("changing the zone changes the analytics day buckets", { timeout: 120000 }, async () => {
    const seriesFor = async (): Promise<string> => {
      const result = await GET<{ volume: Array<{ period: string; count: number }> }>(
        "/api/supervisor/analytics",
        { session: supervisor },
      );
      const body = expectOk(result, "GET /api/supervisor/analytics", 200);
      return JSON.stringify(body.volume);
    };

    const eastern = await seriesFor();
    let shifted: string;
    try {
      // +14:00 — the largest offset in the database, so every stored instant
      // lands on a different local calendar day than it does in New York.
      await writeSetting(supervisor, KEY, JSON.stringify("Pacific/Kiritimati"));
      shifted = await seriesFor();
    } finally {
      await writeSetting(supervisor, KEY, JSON.stringify(DEFAULT_ZONE));
    }

    assert.notEqual(
      shifted,
      eastern,
      "the analytics volume series must change when company.timeZone changes",
    );
    assert.equal(await seriesFor(), eastern, "restoring the zone restores the series");
  });
});
