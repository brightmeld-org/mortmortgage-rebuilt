/**
 * Session minting for the §7.7 suite.
 *
 * Two paths, both contract-only:
 *   - demo-login (POST /api/auth/demo-login) for the three seeded demo personas.
 *   - full registration → verify → MFA enrol for fresh borrowers, harvesting the
 *     verification token from GET /api/admin/outbound-messages as supervisor
 *     (the contracted observation surface for simulated delivery).
 */
import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { GET, POST, expectOk, type Session } from "./http.js";

export type { Session } from "./http.js";

export interface SessionInfo {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "BORROWER" | "CASEWORKER" | "SUPERVISOR";
  isDemo?: boolean;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  csrfToken: string;
}

function readSessionCookie(headers: Headers): string {
  const raw = headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const match = /(^|;\s*)(mm_session=[^;]*)/.exec(entry);
    if (match) return match[2];
  }
  const single = headers.get("set-cookie");
  if (single) {
    const match = /(mm_session=[^;]*)/.exec(single);
    if (match) return match[1];
  }
  throw new Error("no session cookie in response");
}

/** Turns a raw cookie into a Session by reading GET /api/auth/session. */
export async function hydrate(cookie: string): Promise<Session> {
  const partial: Session = { cookie, csrfToken: "", userId: "", email: "", role: "BORROWER" };
  const result = await GET<SessionInfo>("/api/auth/session", { session: partial });
  const info = expectOk(result, "GET /api/auth/session", 200);
  return {
    cookie,
    csrfToken: info.csrfToken,
    userId: info.userId,
    email: info.email,
    role: info.role,
  };
}

export type DemoRole = "borrower" | "caseworker" | "supervisor";

/** Instant session for one of the three seeded demo personas (demo mode only). */
export async function demoLogin(role: DemoRole): Promise<Session> {
  const result = await POST("/api/auth/demo-login", { body: { role }, retryOn5xx: 2 });
  expectOk(result, `POST /api/auth/demo-login ${role}`, 200);
  return hydrate(readSessionCookie(result.headers));
}

/** §A OutboundMessageInfo. */
export interface OutboundMessage {
  id: string;
  channel: "email" | "sms";
  recipient: string;
  subject?: string;
  body: string;
  notificationId?: string;
  status: "pending" | "sent" | "failed";
  createdAt: string;
}

interface OutboundMessagesPage {
  rows: OutboundMessage[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Reads simulated outbound email/SMS as supervisor — the contracted way to observe
 * delivery (§B GET /api/admin/outbound-messages).
 */
export async function outboundMessagesFor(
  supervisor: Session,
  address: string,
): Promise<OutboundMessage[]> {
  const collected: OutboundMessage[] = [];
  for (let page = 1; page <= 6; page += 1) {
    const path = `/api/admin/outbound-messages?page=${page}&pageSize=100`;
    const result = await GET<OutboundMessagesPage>(path, { session: supervisor });
    const body = expectOk(result, "GET /api/admin/outbound-messages", 200);
    const rows = body.rows ?? [];
    collected.push(...rows.filter((row) => (row.recipient ?? "").toLowerCase() === address.toLowerCase()));
    if (rows.length < body.pageSize || page * body.pageSize >= body.total) break;
  }
  return collected;
}

const TOKEN_PATTERN = /(?:token=|\/verify-email\/|\/reset-password\/|\/accept-invitation\/)([A-Za-z0-9._-]{16,})/;

/**
 * Extracts the token from the MOST RECENT message for that address. A mailbox can hold
 * several tokens (verification, email-change, reset); newest wins.
 */
export function extractToken(messages: OutboundMessage[]): string {
  const newestFirst = [...messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const message of newestFirst) {
    const match = TOKEN_PATTERN.exec(message.body ?? "");
    if (match) return match[1];
  }
  throw new Error(
    `no token found in ${messages.length} outbound message(s): ${messages.map((m) => (m.body ?? "").slice(0, 200)).join(" | ")}`,
  );
}

/**
 * The RAW password-reset token for an address, read from the DATABASE.
 *
 * INV-041 (FIND-002) redacts `?token=` out of `GET /api/admin/outbound-messages`
 * UNCONDITIONALLY for password-reset links, because the HTTP path was itself a
 * complete account-takeover chain (forgot-password -> read the token as
 * supervisor -> reset-password). `extractToken()` walked exactly that chain, so
 * a harness that completes a reset over HTTP is performing the attack the
 * contract closed — it must not be re-enabled by weakening the redaction.
 *
 * The STORED `OutboundMessage.body` is deliberately never rewritten (only egress
 * is redacted), and the harness runs locally with `DATABASE_URL`, so the honest
 * substitute is a direct read. `extractToken()` / `outboundMessagesFor()` stay
 * on HTTP for verification, email-change and invitation tokens, which still
 * egress under `DEMO_MODE=true`.
 *
 * A short-lived client is created and disconnected per call (three calls in the
 * whole suite set) so no Prisma handle keeps the test runner's event loop alive.
 */
export async function resetTokenFor(address: string): Promise<string> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  try {
    const row = await db.outboundMessage.findFirst({
      where: { recipient: address, body: { contains: "/reset-password?token=" } },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    });
    const match = /\/reset-password\?token=([A-Za-z0-9._~-]+)/.exec(row?.body ?? "");
    if (!match) throw new Error(`no stored password-reset token for ${address}`);
    return match[1]!;
  } finally {
    await db.$disconnect();
  }
}

export interface FreshBorrower {
  session: Session;
  email: string;
  password: string;
  recoveryCodes: string[];
  totpSecret: string;
}

export const STRONG_PASSWORD = "Tst-Fixture-Phrase-4417";

/** Deterministic 6-digit TOTP for an enrollment secret (otpauth is already a dependency). */
export function totpCode(secret: string, offsetSeconds = 0): string {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
  return totp.generate({ timestamp: Date.now() + offsetSeconds * 1000 });
}

/**
 * A TOTP code guaranteed to differ from `previous`, waiting for the next 30-second
 * period if necessary. A consumed code must never authenticate twice, so back-to-back
 * MFA operations in one test need a fresh window.
 */
export async function freshTotpCode(secret: string, previous?: string): Promise<string> {
  const deadline = Date.now() + 40000;
  let code = totpCode(secret);
  while (previous && code === previous && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    code = totpCode(secret);
  }
  return code;
}

/**
 * Registers a brand-new borrower and drives it all the way to a usable session:
 * register → verify email (token via outbound messages) → sign in → enrol MFA.
 */
export async function registerBorrower(supervisor: Session, emailLocalPart: string): Promise<FreshBorrower> {
  const email = `${emailLocalPart}@t46.example`;
  const registerResult = await POST("/api/auth/register", {
    retryOn5xx: 2,
    body: {
      firstName: "Fixture",
      lastName: "Borrower",
      email,
      password: STRONG_PASSWORD,
      passwordConfirmation: STRONG_PASSWORD,
      acceptTerms: true,
    },
  });
  expectOk(registerResult, `POST /api/auth/register ${email}`, 200);

  const token = extractToken(await outboundMessagesFor(supervisor, email));
  expectOk(
    await POST("/api/auth/verify-email", { body: { token }, retryOn5xx: 2 }),
    "POST /api/auth/verify-email",
    200,
  );

  const signIn = await POST<{ status: string }>("/api/auth/sign-in", {
    body: { email, password: STRONG_PASSWORD },
    retryOn5xx: 2,
  });
  expectOk(signIn, `POST /api/auth/sign-in ${email}`, 200);
  const cookie = readSessionCookie(signIn.headers);
  // Pre-MFA the session is not yet "authenticated" — GET /api/auth/session 401s until
  // enrollment completes, so the enrollment calls run on a bare cookie.
  const preMfa: Session = { cookie, csrfToken: "", userId: "", email, role: "BORROWER" };

  const enrolInit = await POST<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }>(
    "/api/auth/mfa/enroll",
    { session: preMfa },
  );
  const init = expectOk(enrolInit, "POST /api/auth/mfa/enroll", 200);
  const verify = await POST<{ recoveryCodes: string[] }>("/api/auth/mfa/enroll/verify", {
    session: preMfa,
    body: { code: totpCode(init.secret) },
  });
  const verified = expectOk(verify, "POST /api/auth/mfa/enroll/verify", 200);

  const session = await hydrate(cookie);
  return { session, email, password: STRONG_PASSWORD, recoveryCodes: verified.recoveryCodes, totpSecret: init.secret };
}

export interface StaffAccountRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "CASEWORKER" | "SUPERVISOR";
  status: "active" | "inactive";
  mfaStatus: "enrolled" | "pending" | "reset";
  activeAssignments: number;
  completedThisMonth: number;
  lastSignInAt?: string;
}

export interface FreshStaff {
  session: Session;
  email: string;
  password: string;
  account: StaffAccountRow;
  totpSecret: string;
}

/**
 * Invites a staff member (supervisor-only), accepts the invitation with the token
 * harvested from outbound messages, then signs in and enrols MFA. Used wherever a
 * SECOND supervisor (different-approver rule) or caseworker (reassignment) is needed.
 */
export async function inviteStaff(
  supervisor: Session,
  emailLocalPart: string,
  role: "CASEWORKER" | "SUPERVISOR",
): Promise<FreshStaff> {
  const email = `${emailLocalPart}@t46.example`;
  const invite = await POST<StaffAccountRow>("/api/admin/staff", {
    session: supervisor,
    body: { firstName: "Fixture", lastName: role === "SUPERVISOR" ? "Supervisor" : "Caseworker", email, role },
  });
  const account = expectOk(invite, `POST /api/admin/staff ${role}`, 201);

  const token = extractToken(await outboundMessagesFor(supervisor, email));
  expectOk(
    await POST("/api/auth/accept-invitation", { body: { token, password: STRONG_PASSWORD } }),
    "POST /api/auth/accept-invitation",
    200,
  );

  const signIn = await POST("/api/auth/sign-in", {
    body: { email, password: STRONG_PASSWORD },
    retryOn5xx: 2,
  });
  expectOk(signIn, `POST /api/auth/sign-in ${email}`, 200);
  const cookie = readSessionCookie(signIn.headers);
  const preMfa: Session = { cookie, csrfToken: "", userId: account.id, email, role };

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

  return { session: await hydrate(cookie), email, password: STRONG_PASSWORD, account, totpSecret: init.secret };
}

/** Suite-scoped unique prefix so re-runs never collide (uniqueness-based cleanup). */
export function suitePrefix(name: string): string {
  return `t46-${name}-${randomUUID().slice(0, 8)}`;
}
