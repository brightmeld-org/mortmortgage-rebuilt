/**
 * §7.7 — REQ-014 / §4.1.5 password expiration is enforced at sign-in (LENS-018).
 *
 * §4.1.5 states "180 days; user prompted to change at sign-in", and the value
 * table gives password.expiryDays = 180. Before LENS-018 the config key had ZERO
 * consumers — the sixth of REQ-014's six sub-rules was declared and never wired.
 * It is now evaluated at the ONE point a returning user is granted a FULL session
 * (POST /api/auth/mfa/verify) and surfaced, like the MFA re-enrollment prompt, via
 * redirectTo (SignInStatus carries no dedicated value). The expiry prompt takes
 * precedence over the re-enrollment prompt — the credential must be rotated first.
 *
 * Proven two ways:
 *   1. The decision function isUserPasswordExpired directly (past horizon / fresh /
 *      undated-fails-closed).
 *   2. The REAL sign-in → mfa/verify handshake (recovery-code path, the harness's
 *      reliable positive-verify convention): an expired password routes to the
 *      change-password prompt EVEN over the reenroll prompt; a fresh one does not.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { isUserPasswordExpired } from "@/lib/services/password-policy";
import { demoLogin, registerBorrower, suitePrefix } from "../helpers/auth.js";
import { POST, expectOk, type Session } from "../helpers/http.js";

const PREFIX = suitePrefix("pwexp");
const DAY_MS = 24 * 60 * 60 * 1000;

let userId = "";
let email = "";
let password = "";
let recoveryCodes: string[] = [];

before(async () => {
  const supervisor = await demoLogin("supervisor");
  const fresh = await registerBorrower(supervisor, `${PREFIX}-b`);
  userId = fresh.session.userId;
  email = fresh.email;
  password = fresh.password;
  recoveryCodes = fresh.recoveryCodes;
  assert.ok(userId.length > 0, "registered borrower must have a resolved userId");
  assert.ok(recoveryCodes.length >= 2, "enrollment must issue recovery codes for the two verifies");
});

async function setPasswordChangedAt(when: Date | null): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { passwordChangedAt: when } });
}

/** sign-in → mfa/verify with a single-use recovery code; returns the redirectTo. */
async function signInWithRecovery(recoveryCode: string): Promise<string> {
  const si = await POST<{ status: string }>("/api/auth/sign-in", {
    body: { email, password },
    retryOn5xx: 2,
  });
  expectOk(si, "POST /api/auth/sign-in", 200);
  assert.equal(si.body.status, "mfa-required", "an enrolled account is mfa-required at sign-in");
  const cookie = (si.headers.getSetCookie?.() ?? [])
    .map((entry) => /(mm_session=[^;]*)/.exec(entry)?.[1])
    .find((value): value is string => Boolean(value));
  assert.ok(cookie, "sign-in must issue a pre-MFA session cookie");
  const session: Session = { cookie, csrfToken: "", userId: "", email, role: "BORROWER" };

  const mv = await POST<{ status: string; redirectTo: string }>("/api/auth/mfa/verify", {
    session,
    body: { recoveryCode },
  });
  const body = expectOk(mv, "POST /api/auth/mfa/verify", 200);
  assert.equal(body.status, "signed-in", "a completed MFA challenge is signed-in");
  return body.redirectTo;
}

describe("REQ-014 §4.1.5 password expiry (LENS-018)", () => {
  test("isUserPasswordExpired: past the horizon → expired; fresh → not; undated → fails closed", async () => {
    await setPasswordChangedAt(new Date(Date.now() - 200 * DAY_MS));
    assert.equal(await isUserPasswordExpired(userId), true, "200 days old must be expired (default 180)");

    await setPasswordChangedAt(new Date(Date.now() - 10 * DAY_MS));
    assert.equal(await isUserPasswordExpired(userId), false, "10 days old must not be expired");

    await setPasswordChangedAt(null);
    assert.equal(await isUserPasswordExpired(userId), true, "null passwordChangedAt must fail closed (expired)");
  });

  test("an expired password is prompted to change at sign-in, over the reenroll prompt; a fresh one is not", { timeout: 180000 }, async () => {
    await setPasswordChangedAt(new Date(Date.now() - 200 * DAY_MS));
    const expired = await signInWithRecovery(recoveryCodes[0]!);
    assert.equal(
      expired,
      "/profile?passwordExpired=1",
      "an expired password must be prompted to change at sign-in (§4.1.5), even over the reenroll prompt",
    );

    await setPasswordChangedAt(new Date());
    const fresh = await signInWithRecovery(recoveryCodes[1]!);
    assert.notEqual(fresh, "/profile?passwordExpired=1", "a fresh password must NOT hit the expiry prompt");
    assert.equal(
      fresh,
      "/profile?mfaReenroll=1",
      "with a fresh password the recovery-code sign-in falls through to the normal reenroll prompt",
    );
  });
});

after(async () => {
  // Leave the throwaway account with a sane, non-expired timestamp.
  if (userId) {
    try {
      await setPasswordChangedAt(new Date());
    } catch {
      // best-effort cleanup
    }
  }
});
