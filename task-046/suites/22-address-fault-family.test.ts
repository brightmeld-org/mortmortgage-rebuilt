/**
 * §7.7 — the §6.3.6 address-lookup / geocoding FAULT FAMILY (LENS-021).
 *
 * §6.3.6 declares one CONFIGURATION fault axis (SIM_FAULT_ADDRESS ∈
 * none|slow|timeout|unavailable) and one always-active INPUT trigger ("!!"
 * anywhere in q). It also pins the suggest latency at "150 ms ± 100",
 * deterministic from the query hash, and a documented short-query clamp
 * (< 2 normalized chars → empty). Implementation:
 * `src/lib/services/geocoding.ts` (addressSimFault / addressSuggestLatencyMs /
 * suggestAddresses) behind `GET /api/address/suggest?q=`.
 *
 * WHY THIS SUITE EXISTS: task-046 AC-4 requires an executable suite for every
 * simulation fault family. Eight of nine families had one; §6.3.6 was the gap.
 * The geocoding seam is correctly implemented — this file is a test-only
 * addition that proves each documented fault mode, not a fix.
 *
 * HOW EACH CLAIM IS PROVED
 *   - none/slow/timeout/unavailable and the "!!"/clamp degrades → the EXPORTED
 *     `suggestAddresses(q)` directly. It resolves to a plain array for every
 *     simulated-service condition (never throws), so the pure function is a
 *     complete and deterministic witness — no HTTP round trip is needed for the
 *     fault-scenario assertions, and the route (GET /api/address/suggest) only
 *     forwards `q` to it verbatim behind an auth guard.
 *   - the EXACT +2,000 ms slow-extra → a wall-clock difference of two
 *     `suggestAddresses` calls for the SAME query (fault none vs slow). Same
 *     query ⇒ identical deterministic base latency, so the delta IS the
 *     slow-extra plus scheduler noise. The lower bound is tight (the function
 *     cannot resolve early); the upper bound is deliberately loose and the
 *     tolerance is called out — mirroring suite 20's route-applies-it test.
 *   - the 150 ± 100 deterministic latency and its per-query jitter → the PURE
 *     `addressSuggestLatencyMs`, with no wall-clock at all.
 *
 * Every `process.env` mutation is restored in a `finally` (or delete-if-absent)
 * block, mirroring suite 20's discipline.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
  addressSimFault,
  addressSuggestLatencyMs,
  suggestAddresses,
  type AddressSuggestion,
} from "@/lib/services/geocoding";

/** §6.3.6 documented defaults (geocoding.ts envInt fallbacks). */
const BASE_MS = 150;
const JITTER_MS = 100;
const SLOW_EXTRA_MS = 2000;

/** The latency env keys that would move those defaults out from under the assertions. */
const LATENCY_ENV_KEYS = [
  "SIM_LATENCY_ADDRESS_BASE_MS",
  "SIM_LATENCY_ADDRESS_JITTER_MS",
  "SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS",
] as const;

/**
 * A spread of suggest queries — the latency seed is `latency|{q}`. These need
 * not match the dataset; the latency function hashes the raw query text.
 */
const QUERIES = [
  "Los Angeles",
  "Madison",
  "120 Ma",
  "San Diego",
  "Willow Rd",
  "Main St",
  "Oak Blvd",
  "Sycamore",
  "Lincoln Ln",
  "Franklin",
  "Delaware Way",
  "Highland",
];

/**
 * A broad query that matches many bundled rows (city "Los Angeles" appears on
 * dozens of dataset rows — see addresses.json), so a normal lookup must return a
 * non-empty, ranked, capped-at-10 result.
 */
const MATCHING_QUERY = "Los Angeles";

/** Run `fn` with SIM_FAULT_ADDRESS set to `value`, always restoring the prior value. */
async function withFault<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  const original = process.env.SIM_FAULT_ADDRESS;
  try {
    process.env.SIM_FAULT_ADDRESS = value;
    return await fn();
  } finally {
    if (original === undefined) delete process.env.SIM_FAULT_ADDRESS;
    else process.env.SIM_FAULT_ADDRESS = original;
  }
}

before(() => {
  // The §6.3.6 numbers under test are the documented defaults; an env override in
  // the harness process would silently redefine them, so refuse to run instead.
  for (const key of LATENCY_ENV_KEYS) {
    const raw = process.env[key];
    assert.ok(
      raw === undefined || raw.trim() === "",
      `${key} is set to "${raw}" — this suite asserts the §6.3.6 documented defaults, unset it to run`,
    );
  }
  // The default/normal path assertions require the fault axis to start at none.
  const fault = process.env.SIM_FAULT_ADDRESS;
  assert.ok(
    fault === undefined || fault.trim() === "" || fault.trim().toLowerCase() === "none",
    `SIM_FAULT_ADDRESS is set to "${fault}" — the none/normal assertions need it unset, unset it to run`,
  );
  assert.equal(addressSimFault(), "none", "baseline fault mode must be none");
});

// ---------------------------------------------------------------------------
// none / normal — a matching query returns ranked, non-empty suggestions
// ---------------------------------------------------------------------------

describe("§6.3.6 fault mode `none` — normal ranked suggestions", () => {
  test("a query that matches the bundled dataset returns 1..10 ranked suggestions", async () => {
    assert.equal(addressSimFault(), "none", "precondition: no fault configured");
    const results = await suggestAddresses(MATCHING_QUERY);
    assert.ok(Array.isArray(results), "suggestAddresses always resolves to an array");
    assert.ok(
      results.length > 0,
      `"${MATCHING_QUERY}" must match bundled rows, got ${results.length} suggestions`,
    );
    assert.ok(
      results.length <= 10,
      `§6.3.6 caps suggestions at 10, got ${results.length}`,
    );
    // Every suggestion carries the contracted §A AddressSuggestion shape.
    for (const s of results as AddressSuggestion[]) {
      assert.equal(typeof s.formatted, "string", "suggestion.formatted is a string");
      assert.ok(s.formatted.length > 0, "suggestion.formatted is non-empty");
      assert.equal(typeof s.street, "string", "suggestion.street is a string");
      assert.equal(typeof s.city, "string", "suggestion.city is a string");
      assert.match(s.state, /^[A-Z]{2}$/, "suggestion.state is a 2-letter code");
      assert.match(s.zip, /^\d{5}$/, "suggestion.zip is a 5-digit ZIP");
    }
  });

  test("suggestions are deterministic — the same query yields the same ordered result twice", async () => {
    const a = await suggestAddresses(MATCHING_QUERY);
    const b = await suggestAddresses(MATCHING_QUERY);
    assert.deepEqual(b, a, "ranking is pure — identical query ⇒ identical ordered suggestions");
  });
});

// ---------------------------------------------------------------------------
// timeout / unavailable — silent-empty degrade to manual entry
// ---------------------------------------------------------------------------

describe("§6.3.6 fault modes `timeout` and `unavailable` — silent-empty degrade", () => {
  test("timeout returns [] for a query that WOULD otherwise match", async () => {
    // Control: the query matches under `none`, so an empty result under `timeout`
    // is caused by the fault, not by the query missing the dataset.
    const control = await suggestAddresses(MATCHING_QUERY);
    assert.ok(control.length > 0, "control: the query matches under fault none");

    const results = await withFault("timeout", () => suggestAddresses(MATCHING_QUERY));
    assert.deepEqual(
      results,
      [],
      "§6.3.6 `timeout` degrades silently to empty suggestions (manual entry), never an error",
    );
    // The env must be restored the moment withFault returns.
    assert.equal(addressSimFault(), "none", "SIM_FAULT_ADDRESS restored after the timeout arm");
  });

  test("unavailable returns [] for the same otherwise-matching query", async () => {
    const results = await withFault("unavailable", () => suggestAddresses(MATCHING_QUERY));
    assert.deepEqual(
      results,
      [],
      "§6.3.6 `unavailable` degrades silently to empty suggestions (manual entry)",
    );
    assert.equal(addressSimFault(), "none", "SIM_FAULT_ADDRESS restored after the unavailable arm");
  });
});

// ---------------------------------------------------------------------------
// slow — exactly SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS (default 2,000 ms) on top
// ---------------------------------------------------------------------------

describe("§6.3.6 fault mode `slow` — adds the documented slow-extra on top of normal latency", () => {
  test("slow still returns the normal (non-empty) suggestions — it only delays them", async () => {
    // `slow` is a latency fault, not a degrade: the payload is unchanged, so the
    // two arms must be byte-identical apart from timing.
    const normal = await suggestAddresses(MATCHING_QUERY);
    const slow = await withFault("slow", () => suggestAddresses(MATCHING_QUERY));
    assert.ok(slow.length > 0, "`slow` must not empty the result — it is a latency fault");
    assert.deepEqual(slow, normal, "`slow` delays the SAME suggestions it would return under none");
  });

  test(
    "slow adds ~SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS (2,000 ms) wall-clock for a fixed query",
    { timeout: 30000 },
    async () => {
      // Same query ⇒ identical deterministic base latency, so the difference
      // between the two round trips IS the slow-extra plus scheduler noise.
      const normalStart = Date.now();
      await suggestAddresses(MATCHING_QUERY);
      const normalMs = Date.now() - normalStart;

      const slowMs = await withFault("slow", async () => {
        const start = Date.now();
        await suggestAddresses(MATCHING_QUERY);
        return Date.now() - start;
      });

      // TOLERANCE (stated deliberately): the lower bound is tight — the async
      // sleep cannot resolve early — while the upper bound is loose because
      // setTimeout scheduling adds unbounded positive noise. The EXACT number is
      // the documented default; the pure latency band is asserted separately.
      const delta = slowMs - normalMs;
      assert.ok(
        delta >= SLOW_EXTRA_MS - 500,
        `\`slow\` must add ~${SLOW_EXTRA_MS} ms: normal ${normalMs} ms, slow ${slowMs} ms (delta ${delta} ms)`,
      );
      assert.ok(
        delta <= SLOW_EXTRA_MS + 1500,
        `the slow-extra must be ~${SLOW_EXTRA_MS} ms, not unbounded: delta ${delta} ms`,
      );
      assert.ok(
        slowMs >= SLOW_EXTRA_MS,
        `the slow round trip must itself exceed the slow-extra floor, got ${slowMs} ms`,
      );
      assert.ok(
        normalMs < SLOW_EXTRA_MS,
        `the control round trip must NOT carry the slow-extra, got ${normalMs} ms`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Input trigger "!!" — always-active, service-unavailable → empty
// ---------------------------------------------------------------------------

describe("§6.3.6 input trigger — `!!` anywhere in q degrades to empty, no configuration", () => {
  test("`!!` empties a query that WOULD otherwise match, under fault none", async () => {
    assert.equal(addressSimFault(), "none", "precondition: the trigger needs no fault configured");
    // Prove the base of the query matches, then that appending "!!" empties it.
    const withoutTrigger = await suggestAddresses(MATCHING_QUERY);
    assert.ok(withoutTrigger.length > 0, "control: the bare query matches");

    for (const q of [`${MATCHING_QUERY}!!`, `${MATCHING_QUERY} !!`, `!!${MATCHING_QUERY}`, `Los !! Angeles`]) {
      const results = await suggestAddresses(q);
      assert.deepEqual(results, [], `"!!" anywhere in q must degrade to empty (q=${JSON.stringify(q)})`);
    }
  });
});

// ---------------------------------------------------------------------------
// Short-query clamp — < 2 normalized chars → empty
// ---------------------------------------------------------------------------

describe("§6.3.6 short-query clamp — < 2 normalized chars returns empty, not a 400", () => {
  test("missing, empty, single-char and punctuation-only queries all return []", async () => {
    assert.equal(addressSimFault(), "none", "precondition: no fault configured");
    // null (?q missing), "" and a single char are all < MIN_QUERY_LENGTH; "  " and
    // "#" normalize to length 0. All clamp to empty.
    for (const q of [null, "", "L", "1", " ", "  ", "#"]) {
      const results = await suggestAddresses(q);
      assert.deepEqual(
        results,
        [],
        `a query normalizing to < 2 chars must clamp to empty (q=${JSON.stringify(q)})`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Latency contract — 150 ± 100, deterministic per query, genuinely jittered
// ---------------------------------------------------------------------------

describe("§6.3.6 latency contract — 150 ms ± 100, deterministic from the query hash", () => {
  test("every query's latency is within the [50, 250] band", () => {
    for (const q of QUERIES) {
      const ms = addressSuggestLatencyMs(q);
      assert.ok(
        ms >= BASE_MS - JITTER_MS && ms <= BASE_MS + JITTER_MS,
        `§6.3.6 "150 ms ± 100": "${q}" → ${ms} ms is outside [${BASE_MS - JITTER_MS}, ${BASE_MS + JITTER_MS}]`,
      );
    }
  });

  test("latency is deterministic per query and genuinely jittered across queries", () => {
    for (const q of QUERIES) {
      const a = addressSuggestLatencyMs(q);
      const b = addressSuggestLatencyMs(q);
      const c = addressSuggestLatencyMs(q);
      assert.equal(a, b, `same query must always yield the same latency ("${q}")`);
      assert.equal(b, c, `same query must always yield the same latency ("${q}")`);
    }
    const distinct = new Set(QUERIES.map((q) => addressSuggestLatencyMs(q)));
    assert.ok(
      distinct.size >= 3,
      `the ±100 jitter must actually vary by query — ${QUERIES.length} queries produced ${distinct.size} distinct latencies`,
    );
  });
});

// ---------------------------------------------------------------------------
// Fault normalization — env value is .trim().toLowerCase(); unknown → none
// ---------------------------------------------------------------------------

describe("§6.3.6 fault normalization — SIM_FAULT_ADDRESS is trimmed/lower-cased, unknown degrades to none", () => {
  test("case/whitespace variants of a known mode normalize to that mode", async () => {
    for (const variant of ["SLOW", " slow ", "Slow", "slow"]) {
      await withFault(variant, () => {
        assert.equal(
          addressSimFault(),
          "slow",
          `SIM_FAULT_ADDRESS=${JSON.stringify(variant)} must normalize to "slow"`,
        );
      });
    }
    for (const variant of ["TIMEOUT", " Timeout ", "unAVAILable"]) {
      const expected = variant.trim().toLowerCase();
      await withFault(variant, () => {
        assert.equal(
          addressSimFault(),
          expected,
          `SIM_FAULT_ADDRESS=${JSON.stringify(variant)} must normalize to "${expected}"`,
        );
      });
    }
  });

  test("unknown and empty values degrade to none", async () => {
    for (const unknown of ["bogus", "", "  ", "partial", "yes", "slowly", "none"]) {
      await withFault(unknown, () => {
        assert.equal(
          addressSimFault(),
          "none",
          `SIM_FAULT_ADDRESS=${JSON.stringify(unknown)} must degrade to "none"`,
        );
      });
    }
    // And with an unknown fault configured, suggest behaves exactly like `none`.
    const asNone = await withFault("bogus", () => suggestAddresses(MATCHING_QUERY));
    const trueNone = await suggestAddresses(MATCHING_QUERY);
    assert.ok(asNone.length > 0, "an unknown fault must not empty the result");
    assert.deepEqual(asNone, trueNone, "an unknown fault is indistinguishable from none");
  });

  test("SIM_FAULT_ADDRESS is read at CALL time — the same process observes a change immediately", async () => {
    assert.equal(addressSimFault(), "none", "starts at none");
    await withFault("unavailable", () => {
      assert.equal(addressSimFault(), "unavailable", "the change is visible without a reload");
    });
    assert.equal(addressSimFault(), "none", "and is gone again once restored");
  });
});
