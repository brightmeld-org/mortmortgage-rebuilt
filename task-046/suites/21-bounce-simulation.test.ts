/**
 * §7.7 — the §6.3.8 email/SMS simulation's `@bounce.example` fault (LENS-012).
 *
 * §6.3.8: "Simulated delivery records the message on the Outbound Messages page
 * and structured log. Recipient address ending `@bounce.example` → delivery
 * failure recorded (retryable). Latency 100 ms." AC-47 restates it: "a
 * `@bounce.example` address shows a failed delivery with retry".
 *
 * Implementation: `simulatedFailure()` in `src/lib/services/notifications.ts`
 * (the single §4.8.1 notification write path) marks the OutboundMessage row
 * `failed` and drives the ASYNC-002 retry cycle (3 attempts, exponential
 * backoff from 60 s, then terminal `failed` + supervisor alert + manual retry).
 *
 * WHAT MAKES THIS TEST GENUINE: it is a two-arm comparison. The SAME §4.8.2
 * trigger (`bank-link-imported`) is fired for two fresh borrowers who differ in
 * exactly one respect — the domain of their email address. The `@bounce.example`
 * arm must record a failed outbound row and a retryable notification; the
 * ordinary arm must record a sent row and a `sent` notification. Deleting
 * `simulatedFailure()` would make the two arms identical and fail this file.
 *
 * Everything runs over contracted HTTP endpoints against the running app.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, test } from "node:test";
import {
  STRONG_PASSWORD,
  demoLogin,
  extractToken,
  hydrate,
  outboundMessagesFor,
  registerBorrower,
  suitePrefix,
  totpCode,
  type OutboundMessage,
  type Session,
} from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { GET, POST, expectOk } from "../helpers/http.js";
import { createDraft } from "../helpers/application.js";

const PREFIX = suitePrefix("bounce");

/** §6.3.8 documented recipient trigger. */
const BOUNCE_DOMAIN = "bounce.example";

/** §A NotificationInfo. */
interface NotificationInfo {
  id: string;
  type: string;
  title: string;
  body: string;
  applicationId?: string;
  channel: "in-app" | "email" | "sms";
  deliveryStatus: "pending" | "sent" | "failed";
  deliveryError?: string;
  readAt?: string;
  createdAt: string;
}

interface NotificationPage {
  rows: NotificationInfo[];
  page: number;
  pageSize: number;
  total: number;
  unreadCount: number;
}

interface InstitutionList {
  rows: Array<{ id: string; name: string }>;
}

interface BankLinkSession {
  linkId: string;
  accounts: Array<{ externalAccountId: string }>;
}

let supervisor: Session;

before(async () => {
  supervisor = await demoLogin("supervisor");
  await ensureAuthHeadroom(supervisor);
});

// ---------------------------------------------------------------------------
// Fixtures — registration at an arbitrary address (the shared helper pins
// @t46.example, and the domain IS the variable under test here)
// ---------------------------------------------------------------------------

function readSessionCookie(headers: Headers): string {
  const raw = headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const match = /(^|;\s*)(mm_session=[^;]*)/.exec(entry);
    if (match) return match[2]!;
  }
  const single = headers.get("set-cookie");
  const match = single ? /(mm_session=[^;]*)/.exec(single) : null;
  if (match) return match[1]!;
  throw new Error("no session cookie in response");
}

/**
 * register → verify email → sign in → enrol MFA, at an EXPLICIT address.
 *
 * The verification email itself is recorded by `recordOutboundEmail` directly
 * (auth-account.ts composes it; the notification uses externalDelivery "none"),
 * so it is NOT subject to the §6.3.8 bounce seam and the token is readable for
 * a `@bounce.example` registrant exactly as for any other.
 */
async function registerBorrowerAt(email: string): Promise<Session> {
  expectOk(
    await POST("/api/auth/register", {
      retryOn5xx: 2,
      body: {
        firstName: "Fixture",
        lastName: "Borrower",
        email,
        password: STRONG_PASSWORD,
        passwordConfirmation: STRONG_PASSWORD,
        acceptTerms: true,
      },
    }),
    `POST /api/auth/register ${email}`,
    200,
  );

  const token = extractToken(await outboundMessagesFor(supervisor, email));
  expectOk(
    await POST("/api/auth/verify-email", { body: { token }, retryOn5xx: 2 }),
    "POST /api/auth/verify-email",
    200,
  );

  const signIn = await POST("/api/auth/sign-in", { body: { email, password: STRONG_PASSWORD }, retryOn5xx: 2 });
  expectOk(signIn, `POST /api/auth/sign-in ${email}`, 200);
  const cookie = readSessionCookie(signIn.headers);
  const preMfa: Session = { cookie, csrfToken: "", userId: "", email, role: "BORROWER" };

  const init = expectOk(
    await POST<{ secret: string }>("/api/auth/mfa/enroll", { session: preMfa }),
    "POST /api/auth/mfa/enroll",
    200,
  );
  expectOk(
    await POST("/api/auth/mfa/enroll/verify", { session: preMfa, body: { code: totpCode(init.secret) } }),
    "POST /api/auth/mfa/enroll/verify",
    200,
  );
  return hydrate(cookie);
}

/**
 * Fires the §4.8.2 borrower trigger "bank link imported" — a real notification
 * whose external delivery runs through the ASYNC-002 executor (the only path on
 * which the §6.3.8 seam can act; the auth token emails deliberately bypass it
 * with externalDelivery "none").
 */
async function fireBankLinkImportedNotification(borrower: Session, label: string): Promise<void> {
  const institutions = expectOk(
    await GET<InstitutionList>("/api/bank-link/institutions", { session: borrower }),
    "GET /api/bank-link/institutions",
    200,
  );
  const draft = await createDraft(borrower);
  const linkPath = `/api/applications/${draft.id}/bank-links`;
  const link = expectOk(
    await POST<BankLinkSession>(linkPath, {
      session: borrower,
      body: { institutionId: institutions.rows[0]!.id, username: `${PREFIX}-${label}`, password: STRONG_PASSWORD },
    }),
    `POST ${linkPath}`,
    200,
  );
  expectOk(
    await POST(`${linkPath}/${link.linkId}/import`, {
      session: borrower,
      body: { accountIds: link.accounts.map((a) => a.externalAccountId) },
    }),
    `POST ${linkPath}/${link.linkId}/import`,
    200,
  );
}

/** Polls the borrower's own notifications for the trigger, until delivery settles. */
async function awaitSettledNotification(borrower: Session, type: string, timeoutMs = 45000): Promise<NotificationInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: NotificationInfo | undefined;
  while (Date.now() < deadline) {
    const page = expectOk(
      await GET<NotificationPage>("/api/notifications?page=1&pageSize=50", { session: borrower }),
      "GET /api/notifications",
      200,
    );
    last = page.rows.find((row) => row.type === type);
    // "Settled" = the executor has run: either it succeeded, or it recorded an error.
    if (last && (last.deliveryStatus !== "pending" || last.deliveryError !== undefined)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    `notification "${type}" never settled within ${timeoutMs} ms (last seen: ${JSON.stringify(last ?? null)})`,
  );
}

async function awaitOutboundFor(address: string, timeoutMs = 30000): Promise<OutboundMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: OutboundMessage[] = [];
  while (Date.now() < deadline) {
    rows = await outboundMessagesFor(supervisor, address);
    if (rows.some((row) => row.notificationId)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return rows;
}

// ---------------------------------------------------------------------------

describe("§6.3.8 email simulation — a `@bounce.example` recipient records a retryable delivery failure", () => {
  test("the bounce arm fails and stays retryable; the identical control arm is delivered", { timeout: 300000 }, async () => {
    // --- arm A: recipient at the documented bounce domain ---------------------
    const bounceEmail = `${PREFIX}-a-${randomUUID().slice(0, 6)}@${BOUNCE_DOMAIN}`;
    assert.ok(bounceEmail.endsWith(`@${BOUNCE_DOMAIN}`), "arm A must use the §6.3.8 trigger domain");
    const bounceBorrower = await registerBorrowerAt(bounceEmail);
    await fireBankLinkImportedNotification(bounceBorrower, "a");
    const bounced = await awaitSettledNotification(bounceBorrower, "bank-link-imported");

    assert.equal(bounced.channel, "email", "a borrower's default preference (§4.2.12) is external email");
    assert.ok(
      bounced.deliveryError !== undefined && bounced.deliveryError.length > 0,
      "§6.3.8 requires the delivery FAILURE to be recorded on the notification",
    );
    assert.match(
      bounced.deliveryError,
      /bounce/i,
      `the recorded error must name the simulated bounce, got: ${bounced.deliveryError}`,
    );
    assert.ok(
      bounced.deliveryError.includes(bounceEmail),
      "the recorded error names the recipient that bounced",
    );
    // RETRYABLE (§6.3.8 / ASM-009): after a failed attempt the row goes back to
    // `pending` with the next attempt persisted — it is NOT terminal.
    assert.equal(
      bounced.deliveryStatus,
      "pending",
      `a retryable bounce re-schedules rather than terminating on attempt 1, got ${bounced.deliveryStatus}`,
    );

    // The message itself is on the Outbound Messages page, marked failed (REQ-071).
    const bounceRows = await awaitOutboundFor(bounceEmail);
    const bounceDelivery = bounceRows.filter((row) => row.notificationId === bounced.id);
    assert.ok(bounceDelivery.length >= 1, `no outbound row linked to notification ${bounced.id}`);
    for (const row of bounceDelivery) {
      assert.equal(row.channel, "email");
      assert.equal(row.status, "failed", "§6.3.8: the bounced message is recorded with a failed status");
      assert.equal(row.recipient.toLowerCase(), bounceEmail.toLowerCase());
      assert.equal(row.subject, bounced.title, "the recorded message is the notification that was sent");
    }
    // Registration's own verification email is NOT routed through the notification
    // service's external delivery, so it is unaffected by the seam — proof the
    // failure is the seam's doing and not a blanket refusal of the domain.
    const verification = bounceRows.filter((row) => !row.notificationId || row.notificationId !== bounced.id);
    assert.ok(
      verification.some((row) => row.status === "sent"),
      "the directly-composed verification email to the same address is still recorded as sent",
    );

    // AC-47 "with retry": the manual retry surface exists and is state-gated —
    // it accepts only a terminally FAILED delivery, and says so.
    const retry = await POST<{ code: string; message: string }>(`/api/notifications/${bounced.id}/retry`, {
      session: supervisor,
    });
    assert.equal(retry.status, 409, `retry of a still-cycling delivery must be a 409: ${retry.text.slice(0, 200)}`);
    assert.match(retry.body.message, /failed deliveries can be retried/i);

    // --- arm B: control, identical trigger at an ordinary address --------------
    const control = await registerBorrower(supervisor, `${PREFIX}-b`);
    await fireBankLinkImportedNotification(control.session, "b");
    const delivered = await awaitSettledNotification(control.session, "bank-link-imported");

    assert.equal(delivered.channel, "email", "the control arm uses the same external channel");
    assert.equal(
      delivered.deliveryStatus,
      "sent",
      `the control arm must deliver — otherwise arm A proves nothing (error: ${delivered.deliveryError})`,
    );
    assert.equal(delivered.deliveryError, undefined, "a delivered notification carries no delivery error");

    const controlRows = (await awaitOutboundFor(control.email)).filter((row) => row.notificationId === delivered.id);
    assert.ok(controlRows.length >= 1, "the control message is on the Outbound Messages page too");
    for (const row of controlRows) {
      assert.equal(row.status, "sent", "only the §6.3.8 bounce domain produces a failed status");
    }
  });
});
