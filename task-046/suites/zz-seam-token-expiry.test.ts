/**
 * §7.7 + INV-037 — token expiry boundaries (exactly 24 h / 60 min) and session
 * idle/absolute timeouts (REQ-011, REQ-015, NFR-004, INV-010).
 * Depends on the sanctioned test-only fixture seam — see task-046/test-fixtures-contract.md.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
  demoLogin,
  extractToken,
  outboundMessagesFor,
  registerBorrower,
  resetTokenFor,
  suitePrefix,
  STRONG_PASSWORD,
  type Session,
} from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting } from "../helpers/config.js";
import { requireSeam, seam } from "../helpers/seam.js";
import { GET, POST, expectOk } from "../helpers/http.js";

const PREFIX = suitePrefix("token");

let supervisor: Session;

/** Registers an account and returns the address plus its outstanding verification token. */
async function pendingAccount(label: string): Promise<{ email: string; token: string }> {
  const email = `${PREFIX}-${label}@t46.example`;
  expectOk(
    await POST("/api/auth/register", {
      body: {
        firstName: "Token",
        lastName: "Fixture",
        email,
        password: STRONG_PASSWORD,
        passwordConfirmation: STRONG_PASSWORD,
        acceptTerms: true,
      },
    }),
    "register",
    200,
  );
  return { email, token: extractToken(await outboundMessagesFor(supervisor, email)) };
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  await ensureAuthHeadroom(supervisor);
  await requireSeam();
});

describe("§7.7 verification token expiry boundary (24 hours)", () => {
  test("a token aged to exactly the boundary minus one minute still verifies", { timeout: 300000 }, async () => {
    const { email, token } = await pendingAccount("verify-inside");
    await seam("age-token", { kind: "email-verification", email, minutes: 24 * 60 - 1 });
    const result = await POST("/api/auth/verify-email", { body: { token } });
    assert.equal(result.status, 200, `inside the 24-hour window: ${result.status} ${result.text.slice(0, 200)}`);
  });

  test("a token aged past the boundary is refused", { timeout: 300000 }, async () => {
    const { email, token } = await pendingAccount("verify-outside");
    await seam("age-token", { kind: "email-verification", email, minutes: 24 * 60 + 1 });
    const result = await POST("/api/auth/verify-email", { body: { token } });
    assert.notEqual(result.status, 200, "an expired verification token must never verify");
    assert.ok([400, 401, 409].includes(result.status), `got ${result.status} ${result.text.slice(0, 200)}`);
  });
});

describe("§7.7 password-reset token expiry boundary (60 minutes)", () => {
  async function resetToken(label: string): Promise<{ email: string; token: string }> {
    const { email, token: verification } = await pendingAccount(label);
    expectOk(await POST("/api/auth/verify-email", { body: { token: verification } }), "verify", 200);
    expectOk(await POST("/api/auth/forgot-password", { body: { email } }), "forgot-password", 200);
    // INV-041: reset tokens are redacted out of GET /api/admin/outbound-messages
    // UNCONDITIONALLY — the HTTP harvest WAS the takeover chain. The stored row
    // is never rewritten, so the harness reads the raw token from the database.
    return { email, token: await resetTokenFor(email) };
  }

  test("a reset token aged to 59 minutes still resets", { timeout: 300000 }, async () => {
    const { email, token } = await resetToken("reset-inside");
    await seam("age-token", { kind: "password-reset", email, minutes: 59 });
    const result = await POST("/api/auth/reset-password", {
      body: { token, newPassword: "Tst-Fixture-Inside-7712" },
    });
    assert.equal(result.status, 200, `inside the 60-minute window: ${result.status} ${result.text.slice(0, 200)}`);
  });

  test("a reset token aged past 60 minutes is refused", { timeout: 300000 }, async () => {
    const { email, token } = await resetToken("reset-outside");
    await seam("age-token", { kind: "password-reset", email, minutes: 61 });
    const result = await POST("/api/auth/reset-password", {
      body: { token, newPassword: "Tst-Fixture-Outside-7713" },
    });
    assert.notEqual(result.status, 200, "an expired reset token must never reset a password");
    assert.ok([400, 401, 409].includes(result.status), `got ${result.status} ${result.text.slice(0, 200)}`);
  });

  test("a consumed reset token cannot be replayed even inside the window (INV-010)", { timeout: 300000 }, async () => {
    const { token } = await resetToken("reset-replay");
    const first = await POST("/api/auth/reset-password", {
      body: { token, newPassword: "Tst-Fixture-Replay-7714" },
    });
    assert.equal(first.status, 200, first.text.slice(0, 200));
    const replay = await POST("/api/auth/reset-password", {
      body: { token, newPassword: "Tst-Fixture-Replay-7715" },
    });
    assert.notEqual(replay.status, 200, "a consumed token must never authenticate again");
  });
});

describe("§7.7 session idle and absolute expiry (NFR-004)", () => {
  test("a session past the configured idle timeout no longer authenticates", { timeout: 300000 }, async () => {
    const idleMinutes = Number(await readSetting(supervisor, "session.idleTimeoutMinutes"));
    assert.equal(idleMinutes, 30, "fixture assumes the §4.6.11 default idle timeout");
    const borrower = await registerBorrower(supervisor, `${PREFIX}-idle`);
    assert.equal((await GET("/api/auth/session", { session: borrower.session })).status, 200);

    await seam("age-session", { email: borrower.email, idleMinutes: idleMinutes + 1 });
    const result = await GET("/api/auth/session", { session: borrower.session });
    assert.equal(result.status, 401, "an idle-expired session must be refused");
  });

  test("a session past the absolute timeout no longer authenticates", { timeout: 300000 }, async () => {
    const absoluteHours = Number(await readSetting(supervisor, "session.absoluteTimeoutHours"));
    assert.equal(absoluteHours, 12, "fixture assumes the §4.6.11 default absolute timeout");
    const borrower = await registerBorrower(supervisor, `${PREFIX}-absolute`);
    assert.equal((await GET("/api/auth/session", { session: borrower.session })).status, 200);

    await seam("age-session", { email: borrower.email, absoluteHours: absoluteHours + 1 });
    const result = await GET("/api/auth/session", { session: borrower.session });
    assert.equal(result.status, 401, "an absolutely-expired session must be refused even if recently active");
  });
});
