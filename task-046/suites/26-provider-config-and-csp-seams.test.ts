/**
 * CH-025 — REAL-PROVIDER SEAM SURFACE, deterministic unit half
 * (INV-051 / INV-052 / INV-053 / INV-054 unit facets; INT-023).
 *
 * This file is the unit-test half the ratified delta's verificationHints call
 * for by name ("deterministic unit tests" against the module-load config
 * guards and the CSP builder) — the endpoint-level half lives in
 * `27-bank-token-flow.test.ts`. It deliberately imports the seam modules
 * directly (the one sanctioned exception to the suite's HTTP-only rule): the
 * facts under test are module-load configuration guards and provider-slot
 * outcomes that have no HTTP surface in the default keyless posture.
 *
 * No server, no DB, no network — everything here is pure and keyless:
 *   INV-051  unset env → simulation everywhere, zero keys required; invalid
 *            selector values throw at load; each real selection with missing
 *            keys throws naming EXACTLY the missing variables (names only,
 *            never values); OCR_PROVIDER_KIND=claude needs only the API key.
 *   INV-052  the real address provider covers suggest ONLY and any fault
 *            silently degrades to []; geocodeAddress/withServerGeocode carry
 *            NO provider branch (byte-identical across ADDRESS_PROVIDER
 *            values, and a source-scan ratchet on geocoding.ts).
 *   INV-053  buildCsp admits https://cdn.plaid.com in script-src AND
 *            frame-src iff BANK_PROVIDER=real; under simulation (unset,
 *            explicit, or invalid) the header is BYTE-IDENTICAL to the
 *            delivered baseline; nonce + strict-dynamic in both modes. The
 *            mode cookie (the INV-054 server-exposed flag) is set iff real.
 *   INV-054  the unwired real bank slot fail-softs retryable; the simulation
 *            slot returns the not-available outcome (the endpoints' 503s);
 *            the unwired claude OCR slot returns the fail-soft retryable
 *            OCR outcome.
 *
 * FT-121 revert-simulation (proven at introduction, recorded in
 * changes/CH-025-real-provider-seams/verification/): no-op'ing the fail-fast
 * helpers reds the INV-051 tests; inverting the CSP gate reds BOTH INV-053
 * directions; re-throwing in the suggest wrapper, branching geocodeAddress on
 * env, and ignoring the claude kind red the INV-052/OCR tests.
 */
import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseProviderSelection,
  requireProviderKeys,
  ProviderConfigError,
} from "../../src/lib/services/provider-config.js";
import {
  validateOcrProviderConfig,
  ocrProviderKind,
  getDocumentOcrProvider,
  OcrProviderConfigError,
  SIMULATED_OCR_PROVIDER_NAME,
} from "../../src/lib/services/ocr/index.js";
import {
  validateAddressProviderConfig,
  suggestAddressesViaProvider,
  realAddressSuggestProvider,
  type AddressSuggestProvider,
} from "../../src/lib/services/address/index.js";
import {
  validateBankProviderConfig,
  bankProviderMode,
  simulatedBankAggregatorProvider,
  realBankAggregatorProvider,
} from "../../src/lib/services/bank/index.js";
import { geocodeAddress, withServerGeocode } from "../../src/lib/services/geocoding.js";
import { buildCsp, middleware } from "../../src/middleware.js";
import { NextRequest } from "next/server";

const PLACEHOLDER = "test-placeholder-not-a-key";

/** Mutated-process.env tests restore through this (suggest/geocode/OCR read process.env). */
const ENV_KEYS = [
  "OCR_PROVIDER",
  "OCR_PROVIDER_KIND",
  "OCR_PROVIDER_BASE_URL",
  "OCR_PROVIDER_API_KEY",
  "ADDRESS_PROVIDER",
  "GOOGLE_PLACES_API_KEY",
  "BANK_PROVIDER",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_ENV",
] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("INV-051 — unified fail-fast provider selectors (CH-025)", () => {
  test("unset env selects simulation everywhere and requires zero keys", () => {
    const env = {};
    assert.equal(parseProviderSelection(env, "OCR_PROVIDER"), "simulation");
    assert.equal(parseProviderSelection(env, "ADDRESS_PROVIDER"), "simulation");
    assert.equal(parseProviderSelection(env, "BANK_PROVIDER"), "simulation");
    assert.equal(ocrProviderKind(env), "http");
    assert.equal(bankProviderMode(env), "simulation");
    // Zero-key rule: none of the validators may throw with NOTHING configured.
    validateOcrProviderConfig(env);
    validateAddressProviderConfig(env);
    validateBankProviderConfig(env);
  });

  test("an invalid selector value throws at load for every selector", () => {
    assert.throws(
      () => parseProviderSelection({ ADDRESS_PROVIDER: "banana" }, "ADDRESS_PROVIDER"),
      (err: unknown) =>
        err instanceof ProviderConfigError && /ADDRESS_PROVIDER/.test((err as Error).message),
    );
    assert.throws(() => validateBankProviderConfig({ BANK_PROVIDER: "yes" }), ProviderConfigError);
    assert.throws(
      () => validateOcrProviderConfig({ OCR_PROVIDER: "enabled" }),
      OcrProviderConfigError,
    );
    // The kind sub-selector follows the same rule — even under simulation.
    assert.throws(
      () => ocrProviderKind({ OCR_PROVIDER_KIND: "vision" }),
      (err: unknown) =>
        err instanceof OcrProviderConfigError && /OCR_PROVIDER_KIND/.test((err as Error).message),
    );
    assert.throws(() => validateOcrProviderConfig({ OCR_PROVIDER_KIND: "vision" }));
  });

  test("ADDRESS_PROVIDER=real with no key throws naming GOOGLE_PLACES_API_KEY", () => {
    assert.throws(
      () => validateAddressProviderConfig({ ADDRESS_PROVIDER: "real" }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderConfigError);
        assert.match((err as Error).message, /GOOGLE_PLACES_API_KEY/);
        assert.match((err as Error).message, /ADDRESS_PROVIDER=real/);
        return true;
      },
    );
    // With the key present, validation passes.
    validateAddressProviderConfig({ ADDRESS_PROVIDER: "real", GOOGLE_PLACES_API_KEY: PLACEHOLDER });
  });

  test("BANK_PROVIDER=real names EVERY missing variable — and only the missing ones", () => {
    assert.throws(
      () => validateBankProviderConfig({ BANK_PROVIDER: "real" }),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.ok(err instanceof ProviderConfigError);
        assert.match(message, /PLAID_CLIENT_ID/);
        assert.match(message, /PLAID_SECRET/);
        assert.match(message, /PLAID_ENV/);
        return true;
      },
    );
    // Partial configuration: only the genuinely-missing name appears.
    assert.throws(
      () =>
        validateBankProviderConfig({
          BANK_PROVIDER: "real",
          PLAID_CLIENT_ID: PLACEHOLDER,
          PLAID_ENV: "sandbox",
        }),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /PLAID_SECRET/);
        assert.doesNotMatch(message, /PLAID_CLIENT_ID/);
        assert.doesNotMatch(message, /PLAID_ENV\b/);
        // Names only — never credential values (INV-051).
        assert.doesNotMatch(message, new RegExp(PLACEHOLDER));
        return true;
      },
    );
    validateBankProviderConfig({
      BANK_PROVIDER: "real",
      PLAID_CLIENT_ID: PLACEHOLDER,
      PLAID_SECRET: PLACEHOLDER,
      PLAID_ENV: "sandbox",
    });
  });

  test("OCR real/http keeps today's rule; real/claude requires the API key ONLY", () => {
    // http kind (default): both variables required, both named when absent.
    assert.throws(
      () => validateOcrProviderConfig({ OCR_PROVIDER: "real" }),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.ok(err instanceof OcrProviderConfigError);
        assert.match(message, /OCR_PROVIDER_BASE_URL/);
        assert.match(message, /OCR_PROVIDER_API_KEY/);
        return true;
      },
    );
    // claude kind: API key alone passes validation (no BASE_URL required)…
    validateOcrProviderConfig({
      OCR_PROVIDER: "real",
      OCR_PROVIDER_KIND: "claude",
      OCR_PROVIDER_API_KEY: PLACEHOLDER,
    });
    // …and without it, the failure names exactly the API key.
    assert.throws(
      () =>
        validateOcrProviderConfig({
          OCR_PROVIDER: "real",
          OCR_PROVIDER_KIND: "claude",
          OCR_PROVIDER_BASE_URL: "http://localhost:9",
        }),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /OCR_PROVIDER_API_KEY/);
        assert.doesNotMatch(message, /OCR_PROVIDER_BASE_URL/);
        return true;
      },
    );
  });
});

describe("INV-054/INV-051 — unwired real slots fail soft, never crash (CH-025)", () => {
  test("simulation bank slot returns the not-available outcome (the endpoints' 503)", async () => {
    const token = await simulatedBankAggregatorProvider.createLinkToken("app-1");
    assert.equal(token.ok, false);
    assert.ok(!token.ok && token.code === "not_available" && token.retryable === false);
    const exchange = await simulatedBankAggregatorProvider.exchangePublicToken({
      publicToken: "public-x",
      institutionId: null,
      institutionName: null,
      applicationId: "app-1",
    });
    assert.ok(!exchange.ok && exchange.code === "not_available");
  });

  test("real bank slot returns the RETRYABLE 503 outcome when keyless (no network call)", async () => {
    const token = await realBankAggregatorProvider.createLinkToken("app-1");
    assert.ok(!token.ok && token.code === "provider_unavailable" && token.retryable === true);
    const exchange = await realBankAggregatorProvider.exchangePublicToken({
      publicToken: "public-x",
      institutionId: null,
      institutionName: null,
      applicationId: "app-1",
    });
    assert.ok(!exchange.ok && exchange.code === "provider_unavailable" && exchange.retryable === true);
  });

  test("OCR real/claude selects the claude slot with the fail-soft retryable outcome", async () => {
    process.env.OCR_PROVIDER = "real";
    process.env.OCR_PROVIDER_KIND = "claude";
    process.env.OCR_PROVIDER_API_KEY = PLACEHOLDER;
    const provider = getDocumentOcrProvider();
    assert.equal(provider.name, "claude-ocr-provider");
    const outcome = await provider.run({} as never);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.failure.code === "unavailable");
    assert.ok(!outcome.ok && outcome.failure.retryable === true);
  });

  test("OCR default env still selects the delivered simulation provider", () => {
    for (const key of ["OCR_PROVIDER", "OCR_PROVIDER_KIND", "OCR_PROVIDER_API_KEY"]) {
      delete process.env[key];
    }
    assert.equal(getDocumentOcrProvider().name, SIMULATED_OCR_PROVIDER_NAME);
  });
});

describe("INV-052 — real address provider is suggest-only and silently degrades (CH-025)", () => {
  test("a throwing real provider degrades to [] — never a surfaced error", async () => {
    const throwing: AddressSuggestProvider = {
      name: "throwing-test-provider",
      async suggestAddresses() {
        throw new Error("provider blew up");
      },
    };
    assert.deepEqual(await suggestAddressesViaProvider("100 Main", throwing), []);
  });

  test("the real slot returns [] when keyless (manual-entry degrade, no network call)", async () => {
    assert.deepEqual(await realAddressSuggestProvider.suggestAddresses("100 Main"), []);
  });

  test("geocodeAddress/withServerGeocode are byte-identical across ADDRESS_PROVIDER values", () => {
    const address = {
      street: "742 Evergreen Terrace",
      city: "Springfield",
      state: "IL",
      zip: "62704",
    };
    const subject = { address, geocode: { latitude: 1, longitude: 2 } };

    delete process.env.ADDRESS_PROVIDER;
    delete process.env.GOOGLE_PLACES_API_KEY;
    const simGeo = geocodeAddress(address);
    const simSubject = withServerGeocode(structuredClone(subject));

    process.env.ADDRESS_PROVIDER = "real";
    process.env.GOOGLE_PLACES_API_KEY = PLACEHOLDER;
    const realGeo = geocodeAddress(address);
    const realSubject = withServerGeocode(structuredClone(subject));

    // AVM/HMDA/subject-property inputs must not move with the provider mode.
    assert.deepEqual(realGeo, simGeo);
    assert.deepEqual(realSubject, simSubject);
  });

  test("source ratchet: the deterministic geocoder carries NO provider branch", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "lib", "services", "geocoding.ts"),
      "utf8",
    );
    // The seam lives in src/lib/services/address/ — geocoding.ts must never
    // read the selector or the seam interface (INV-052: "geocodeAddress()/
    // withServerGeocode() take no provider branch").
    assert.doesNotMatch(source, /ADDRESS_PROVIDER/);
    assert.doesNotMatch(source, /AddressSuggestProvider/);
    assert.doesNotMatch(source, /GOOGLE_PLACES_API_KEY/);
  });
});

describe("INV-053 — CSP admits cdn.plaid.com iff BANK_PROVIDER=real (CH-025)", () => {
  const NONCE = "TESTNONCE0000000000000==";
  /** The delivered default (pre-CH-025) production CSP, nonce substituted —
   *  byte-for-byte. If this string drifts, the default posture changed. */
  const DELIVERED_DEFAULT_CSP =
    "default-src 'self'; " +
    `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'; ` +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' blob: data: https://tile.openstreetmap.org; " +
    "font-src 'self'; connect-src 'self'; object-src 'none'; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

  test("default (unset), explicit simulation, and INVALID values emit the byte-identical delivered CSP", () => {
    assert.equal(buildCsp(NONCE, {}), DELIVERED_DEFAULT_CSP);
    assert.equal(buildCsp(NONCE, { BANK_PROVIDER: "simulation" }), DELIVERED_DEFAULT_CSP);
    // Biconditional: ONLY the exact value "real" admits the widget origin.
    assert.equal(buildCsp(NONCE, { BANK_PROVIDER: "banana" }), DELIVERED_DEFAULT_CSP);
    assert.doesNotMatch(buildCsp(NONCE, {}), /cdn\.plaid\.com/);
    assert.doesNotMatch(buildCsp(NONCE, {}), /frame-src/);
  });

  test("BANK_PROVIDER=real admits https://cdn.plaid.com in script-src AND frame-src", () => {
    const csp = buildCsp(NONCE, { BANK_PROVIDER: "real" });
    const directives = csp.split("; ");
    const scriptSrc = directives.find((d) => d.startsWith("script-src "));
    const frameSrc = directives.find((d) => d.startsWith("frame-src "));
    assert.ok(scriptSrc, `no script-src in: ${csp}`);
    assert.ok(frameSrc, `no frame-src in: ${csp}`);
    assert.match(scriptSrc!, /https:\/\/cdn\.plaid\.com/);
    assert.equal(frameSrc, "frame-src 'self' https://cdn.plaid.com");
  });

  test("nonce + strict-dynamic posture is unchanged in BOTH modes (INV-050 untouched)", () => {
    for (const env of [{}, { BANK_PROVIDER: "real" }]) {
      const csp = buildCsp(NONCE, env);
      assert.match(csp, new RegExp(`'nonce-${NONCE.replace(/[+=]/g, "\\$&")}'`));
      assert.match(csp, /'strict-dynamic'/);
      assert.doesNotMatch(csp, /'unsafe-inline'.*script-src|script-src[^;]*'unsafe-inline'/);
      assert.match(csp, /frame-ancestors 'none'/);
    }
  });

  test("mode cookie (INV-054 server-exposed flag): set iff real; default emits NO Set-Cookie", () => {
    delete process.env.BANK_PROVIDER;
    const simResponse = middleware(new NextRequest("http://localhost:3083/pre-qualify"));
    assert.equal(simResponse.headers.get("set-cookie"), null); // delivered posture byte-identical

    process.env.BANK_PROVIDER = "real";
    const realResponse = middleware(new NextRequest("http://localhost:3083/pre-qualify"));
    assert.match(realResponse.headers.get("set-cookie") ?? "", /mm_bank_mode=real/);
    // The flag is a bare mode word — never key material.
    assert.doesNotMatch(realResponse.headers.get("set-cookie") ?? "", /PLAID|secret|key/i);

    // Switching back to simulation clears a stale flag — but ONLY when present.
    delete process.env.BANK_PROVIDER;
    const stale = middleware(
      new NextRequest("http://localhost:3083/pre-qualify", {
        headers: { cookie: "mm_bank_mode=real" },
      }),
    );
    assert.match(stale.headers.get("set-cookie") ?? "", /mm_bank_mode=;/);
  });
});
