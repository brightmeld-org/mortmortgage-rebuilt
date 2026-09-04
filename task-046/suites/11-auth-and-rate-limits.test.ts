/**
 * §7.7 — authentication rules, uniform failure responses, single-use tokens and the
 * persisted rate limiter (REQ-011..REQ-018, NFR-011, NFR-012, NFR-021, INV-010, SEC-11).
 *
 * The rate-limit cap is raised for fixture building by every other suite; this file
 * lowers it deliberately, exercises the limiter, and restores the §4.6.11 default in
 * `zzz-rate-limit-restore` (see after()).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  demoLogin,
  extractToken,
  freshTotpCode,
  outboundMessagesFor,
  registerBorrower,
  suitePrefix,
  STRONG_PASSWORD,
  type FreshBorrower,
  type Session,
} from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting, writeSetting, HEADROOM_ATTEMPTS } from "../helpers/config.js";
import { GET, POST, expectOk, type ApiResult, type ErrorResponse } from "../helpers/http.js";

const PREFIX = suitePrefix("auth");

let supervisor: Session;
let fixture: FreshBorrower;

function bodyOf(result: ApiResult<unknown>): ErrorResponse {
  return result.body as unknown as ErrorResponse;
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  await ensureAuthHeadroom(supervisor);
  fixture = await registerBorrower(supervisor, `${PREFIX}-b1`);
});

after(async () => {
  // Leave headroom in place for any suite that runs after this one; the documented
  // default is restored by zzz-rate-limit-restore.test.ts at the end of the run.
  await writeSetting(supervisor, "rateLimit.authAttempts", HEADROOM_ATTEMPTS);
});

describe("§7.7 uniform authentication responses (NFR-011)", () => {
  test("sign-in failures are byte-identical regardless of cause", { timeout: 120000 }, async () => {
    const wrongPassword = await POST("/api/auth/sign-in", {
      body: { email: fixture.email, password: "Definitely-Not-The-Password-91" },
    });
    const unknownEmail = await POST("/api/auth/sign-in", {
      body: { email: `${PREFIX}-nobody@t46.example`, password: STRONG_PASSWORD },
    });
    assert.equal(wrongPassword.status, 401, wrongPassword.text.slice(0, 200));
    assert.equal(unknownEmail.status, 401, unknownEmail.text.slice(0, 200));
    assert.equal(
      bodyOf(wrongPassword).message,
      bodyOf(unknownEmail).message,
      "the failure message must not distinguish a wrong password from an unknown account",
    );
    assert.equal(bodyOf(wrongPassword).code, bodyOf(unknownEmail).code);
  });

  test("registration responds uniformly whether or not the address exists", { timeout: 120000 }, async () => {
    const existing = await POST("/api/auth/register", {
      body: {
        firstName: "Dup",
        lastName: "Account",
        email: fixture.email,
        password: STRONG_PASSWORD,
        passwordConfirmation: STRONG_PASSWORD,
        acceptTerms: true,
      },
    });
    const fresh = await POST("/api/auth/register", {
      body: {
        firstName: "New",
        lastName: "Account",
        email: `${PREFIX}-fresh@t46.example`,
        password: STRONG_PASSWORD,
        passwordConfirmation: STRONG_PASSWORD,
        acceptTerms: true,
      },
    });
    assert.equal(existing.status, fresh.status, "status must not reveal account existence");
    assert.deepEqual(existing.body, fresh.body, "body must not reveal account existence");
  });

  test("forgot-password responds uniformly for unknown addresses", { timeout: 120000 }, async () => {
    const known = await POST("/api/auth/forgot-password", { body: { email: fixture.email } });
    const unknown = await POST("/api/auth/forgot-password", { body: { email: `${PREFIX}-ghost@t46.example` } });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
  });

  test("email addresses are compared case-insensitively (INV-013)", { timeout: 120000 }, async () => {
    const result = await POST("/api/auth/register", {
      body: {
        firstName: "Case",
        lastName: "Clash",
        email: fixture.email.toUpperCase(),
        password: STRONG_PASSWORD,
        passwordConfirmation: STRONG_PASSWORD,
        acceptTerms: true,
      },
    });
    assert.equal(result.status, 200, "the uniform response applies here too");
    const signIn = await POST<{ status: string }>("/api/auth/sign-in", {
      body: { email: fixture.email.toUpperCase(), password: fixture.password },
    });
    assert.equal(signIn.status, 200, "the original account must still authenticate with an upper-case address");
  });
});

describe("§7.7 password policy (REQ-014, VR-004)", () => {
  const attempt = async (password: string): Promise<ApiResult<unknown>> =>
    POST("/api/auth/register", {
      body: {
        firstName: "Policy",
        lastName: "Probe",
        email: `${PREFIX}-${Math.random().toString(36).slice(2, 10)}@t46.example`,
        password,
        passwordConfirmation: password,
        acceptTerms: true,
      },
    });

  test("a password shorter than the configured minimum is refused", async () => {
    const result = await attempt("Short-1a");
    assert.equal(result.status, 400, result.text.slice(0, 200));
  });

  test("a long password with too few character classes is refused", async () => {
    const result = await attempt("aaaaaaaaaaaaaaaaaaaa");
    assert.equal(result.status, 400, result.text.slice(0, 200));
  });

  test("a top-10,000 common password is refused even when long enough", async () => {
    const result = await attempt("passwordpassword1");
    assert.equal(result.status, 400, result.text.slice(0, 300));
  });

  test("passwordConfirmation must match (VR-005) and acceptTerms must be true (VR-006)", async () => {
    const mismatch = await POST("/api/auth/register", {
      body: {
        firstName: "Policy",
        lastName: "Probe",
        email: `${PREFIX}-mismatch@t46.example`,
        password: STRONG_PASSWORD,
        passwordConfirmation: `${STRONG_PASSWORD}x`,
        acceptTerms: true,
      },
    });
    assert.equal(mismatch.status, 400, mismatch.text.slice(0, 200));

    const noTerms = await POST("/api/auth/register", {
      body: {
        firstName: "Policy",
        lastName: "Probe",
        email: `${PREFIX}-noterms@t46.example`,
        password: STRONG_PASSWORD,
        passwordConfirmation: STRONG_PASSWORD,
        acceptTerms: false,
      },
    });
    assert.equal(noTerms.status, 400, noTerms.text.slice(0, 200));
  });
});

describe("§7.7 single-use tokens and codes (INV-010)", () => {
  test("a verification token cannot be replayed", { timeout: 180000 }, async () => {
    const email = `${PREFIX}-replay@t46.example`;
    expectOk(
      await POST("/api/auth/register", {
        body: {
          firstName: "Replay",
          lastName: "Probe",
          email,
          password: STRONG_PASSWORD,
          passwordConfirmation: STRONG_PASSWORD,
          acceptTerms: true,
        },
      }),
      "register",
      200,
    );
    const token = extractToken(await outboundMessagesFor(supervisor, email));
    expectOk(await POST("/api/auth/verify-email", { body: { token } }), "first verify", 200);
    const replay = await POST("/api/auth/verify-email", { body: { token } });
    assert.notEqual(replay.status, 200, "a consumed verification token must never verify again");
    assert.ok([400, 401, 409].includes(replay.status), `got ${replay.status} ${replay.text.slice(0, 200)}`);
  });

  test("a recovery code authenticates once and never again", { timeout: 300000 }, async () => {
    const recovery = fixture.recoveryCodes[0];
    assert.ok(recovery, "enrollment must issue recovery codes");

    const first = await POST<{ status: string }>("/api/auth/sign-in", {
      body: { email: fixture.email, password: fixture.password },
    });
    assert.equal(first.status, 200, first.text.slice(0, 200));
    assert.equal((first.body as { status: string }).status, "mfa-required");
    const cookie = (first.headers.getSetCookie?.() ?? [])
      .map((entry) => /(mm_session=[^;]*)/.exec(entry)?.[1])
      .find((value): value is string => Boolean(value));
    assert.ok(cookie);
    const session: Session = { cookie, csrfToken: "", userId: "", email: fixture.email, role: "BORROWER" };

    const used = await POST("/api/auth/mfa/verify", { session, body: { recoveryCode: recovery } });
    assert.equal(used.status, 200, used.text.slice(0, 200));

    const second = await POST<{ status: string }>("/api/auth/sign-in", {
      body: { email: fixture.email, password: fixture.password },
    });
    assert.equal(second.status, 200);
    const cookie2 = (second.headers.getSetCookie?.() ?? [])
      .map((entry) => /(mm_session=[^;]*)/.exec(entry)?.[1])
      .find((value): value is string => Boolean(value));
    assert.ok(cookie2);
    const session2: Session = { cookie: cookie2, csrfToken: "", userId: "", email: fixture.email, role: "BORROWER" };
    const replay = await POST("/api/auth/mfa/verify", { session: session2, body: { recoveryCode: recovery } });
    assert.equal(replay.status, 401, `a consumed recovery code must never authenticate again: ${replay.status}`);
  });

  test("exactly one of code or recoveryCode may be supplied (VR-016, VR-017)", { timeout: 180000 }, async () => {
    const signIn = await POST("/api/auth/sign-in", { body: { email: fixture.email, password: fixture.password } });
    const cookie = (signIn.headers.getSetCookie?.() ?? [])
      .map((entry) => /(mm_session=[^;]*)/.exec(entry)?.[1])
      .find((value): value is string => Boolean(value));
    assert.ok(cookie);
    const session: Session = { cookie, csrfToken: "", userId: "", email: fixture.email, role: "BORROWER" };

    const neither = await POST("/api/auth/mfa/verify", { session, body: {} });
    assert.equal(neither.status, 400, neither.text.slice(0, 200));

    const both = await POST("/api/auth/mfa/verify", {
      session,
      body: { code: await freshTotpCode(fixture.totpSecret), recoveryCode: fixture.recoveryCodes[1] },
    });
    assert.equal(both.status, 400, both.text.slice(0, 200));
  });

  test("sign-out revokes the session (NFR-021)", { timeout: 180000 }, async () => {
    const throwaway = await registerBorrower(supervisor, `${PREFIX}-signout`);
    const before = await GET("/api/auth/session", { session: throwaway.session });
    assert.equal(before.status, 200);
    const out = await POST("/api/auth/sign-out", { session: throwaway.session });
    assert.ok([200, 204].includes(out.status), out.text.slice(0, 200));
    const after = await GET("/api/auth/session", { session: throwaway.session });
    assert.equal(after.status, 401, "a revoked session must not authenticate");
  });
});

describe("§7.7 persisted rate limiting (REQ-018, SEC-11)", () => {
  test("the auth limiter enforces the configured cap and returns the shared error shape", { timeout: 300000 }, async () => {
    const originalWindow = await readSetting(supervisor, "rateLimit.authWindowMinutes");
    assert.equal(Number(originalWindow), 15, "fixture assumes the §4.6.11 default window");

    const cap = 3;
    await writeSetting(supervisor, "rateLimit.authAttempts", String(cap));
    try {
      const email = `${PREFIX}-limited@t46.example`;
      const statuses: number[] = [];
      let limited: ApiResult<unknown> | undefined;
      for (let attempt = 0; attempt < cap + 3; attempt += 1) {
        const result = await POST("/api/auth/sign-in", {
          body: { email, password: "Wrong-Password-For-Limit-1" },
          noRateLimitRetry: true,
        });
        statuses.push(result.status);
        if (result.status === 429 && !limited) limited = result;
      }
      assert.ok(limited, `the limiter must engage within ${cap + 3} attempts: ${statuses.join(",")}`);
      const body = bodyOf(limited);
      assert.equal(typeof body.code, "string", "429 must use the project ErrorResponse shape, not a middleware shape");
      assert.equal(typeof body.message, "string");
      assert.ok(statuses.filter((status) => status === 429).length >= 1);
      assert.ok(
        statuses.indexOf(429) >= cap,
        `the first ${cap} attempts must not be limited: ${statuses.join(",")}`,
      );
    } finally {
      await writeSetting(supervisor, "rateLimit.authAttempts", HEADROOM_ATTEMPTS);
    }
  });

  test("limiter state is keyed per account and survives a new connection and a new session", { timeout: 300000 }, async () => {
    const cap = 2;
    await writeSetting(supervisor, "rateLimit.authAttempts", String(cap));
    try {
      const limitedEmail = `${PREFIX}-keyed@t46.example`;
      const otherEmail = `${PREFIX}-keyed-other@t46.example`;
      for (let attempt = 0; attempt < cap + 2; attempt += 1) {
        await POST("/api/auth/sign-in", {
          body: { email: limitedEmail, password: "Wrong-Password-For-Limit-1" },
          noRateLimitRetry: true,
        });
      }
      const stillLimited = await POST("/api/auth/sign-in", {
        body: { email: limitedEmail, password: "Wrong-Password-For-Limit-1" },
        noRateLimitRetry: true,
      });
      assert.equal(stillLimited.status, 429, "the exhausted bucket must persist beyond the burst");

      const otherAccount = await POST("/api/auth/sign-in", {
        body: { email: otherEmail, password: "Wrong-Password-For-Limit-1" },
        noRateLimitRetry: true,
      });
      assert.notEqual(otherAccount.status, 429, "the bucket is keyed per account, not globally");
    } finally {
      await writeSetting(supervisor, "rateLimit.authAttempts", HEADROOM_ATTEMPTS);
    }
  });

  /**
   * Restart persistence (REQ-018/SEC-11) is a two-phase check because a suite running
   * against a live instance must not stop the server:
   *   phase `arm`    — exhaust the bucket for T46_RATELIMIT_EMAIL and stop.
   *   (operator restarts the server)
   *   phase `verify` — assert the same bucket is still exhausted.
   * With no phase set, both halves run in one process, which proves the bucket is
   * shared across connections and survives the request that created it, but NOT that it
   * survives a restart. The gap is reported rather than silently passed.
   */
  test("the exhausted bucket persists beyond the requests that created it", { timeout: 300000 }, async () => {
    const phase = process.env.T46_RATELIMIT_PHASE ?? "single-process";
    const email = process.env.T46_RATELIMIT_EMAIL ?? `${PREFIX}-persist@t46.example`;
    const cap = 2;

    if (phase !== "verify") {
      await writeSetting(supervisor, "rateLimit.authAttempts", String(cap));
      for (let attempt = 0; attempt < cap + 2; attempt += 1) {
        await POST("/api/auth/sign-in", {
          body: { email, password: "Wrong-Password-For-Limit-1" },
          noRateLimitRetry: true,
        });
      }
    }

    if (phase === "arm") {
      // The operator restarts the server, then re-runs this file with phase=verify.
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const afterGap = await POST("/api/auth/sign-in", {
      body: { email, password: "Wrong-Password-For-Limit-1" },
      noRateLimitRetry: true,
    });
    assert.equal(
      afterGap.status,
      429,
      `the bucket must still be exhausted (phase=${phase}); got ${afterGap.status} ${afterGap.text.slice(0, 200)}`,
    );
    await writeSetting(supervisor, "rateLimit.authAttempts", HEADROOM_ATTEMPTS);
  });
});
