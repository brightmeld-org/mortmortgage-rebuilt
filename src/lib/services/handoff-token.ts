// Public-tools hand-off token seam (REQ-045, FLOW-001; task-011 verification side).
//
// task-018 (public calculators) OWNS token GENERATION via POST /api/public/handoff-token
// and must import createHandoffToken from here so signing/verification share one
// implementation. task-011 consumes tokens on POST /api/applications: a VALID token
// pre-fills Step 3 income, Step 5 a single other-liability, and Step 7 loan values
// (FLOW-001); an EXPIRED or TAMPERED token is IGNORED — a plain Draft is created,
// never an error (VR-055, §B).
//
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadB64)).
// The payload embeds the §A HandoffTokenRequest fields verbatim plus `exp` (epoch
// seconds). Anonymous calculator inputs are carried INSIDE the signed token — never
// server-stored anonymously (FLOW-001 delivery note).

import { createHmac, timingSafeEqual } from "node:crypto";

/** contracts.md §A HandoffTokenRequest — exact field names, all optional. */
export interface HandoffPrefill {
  grossMonthlyIncome?: number;
  monthlyDebtPayments?: number;
  downPaymentAmount?: number;
  termMonths?: number;
  loanAmount?: number;
  interestRate?: number;
  /** contracts.json enums.LoanType value. */
  loanType?: string;
}

interface HandoffTokenPayload {
  v: 1;
  /** Expiry, epoch seconds. */
  exp: number;
  data: HandoffPrefill;
}

/** Default token lifetime (task-018 may pass its own TTL). */
export const HANDOFF_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

function handoffSecret(): string {
  const secret =
    process.env.HANDOFF_TOKEN_SECRET ?? process.env.CSRF_SECRET ?? process.env.SESSION_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("HANDOFF_TOKEN_SECRET (or CSRF_SECRET) must be set in production");
  }
  return "mortmortgage-dev-only-handoff-secret";
}

function sign(payloadB64: string): string {
  return createHmac("sha256", handoffSecret()).update(payloadB64).digest("base64url");
}

const LOAN_TYPES = ["conventional", "fha", "va", "usda"] as const;

/**
 * Create a signed hand-off token (task-018's generation seam). `nowMs` is
 * injectable for tests.
 */
export function createHandoffToken(
  data: HandoffPrefill,
  ttlSeconds: number = HANDOFF_TOKEN_DEFAULT_TTL_SECONDS,
  nowMs: number = Date.now(),
): { token: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload: HandoffTokenPayload = { v: 1, exp, data };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    token: `${payloadB64}.${sign(payloadB64)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Verify a hand-off token. Returns the embedded prefill data, or null for ANY
 * failure — malformed, tampered (signature mismatch), or expired. Callers treat
 * null as "ignore silently and create a plain Draft" (VR-055). Never throws.
 */
export function verifyHandoffToken(token: string, nowMs: number = Date.now()): HandoffPrefill | null {
  try {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    const payloadB64 = token.slice(0, dot);
    const presentedSig = token.slice(dot + 1);

    const expectedSig = sign(payloadB64);
    const a = Buffer.from(presentedSig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Partial<HandoffTokenPayload>;
    if (payload.v !== 1) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null;
    const data = payload.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;

    // Sanitize: only the §A HandoffTokenRequest fields, with sane types; anything
    // else in a (validly signed) payload is dropped rather than trusted.
    const out: HandoffPrefill = {};
    const numeric = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    const src = data as Record<string, unknown>;
    out.grossMonthlyIncome = numeric(src.grossMonthlyIncome);
    out.monthlyDebtPayments = numeric(src.monthlyDebtPayments);
    out.downPaymentAmount = numeric(src.downPaymentAmount);
    out.termMonths = numeric(src.termMonths);
    out.loanAmount = numeric(src.loanAmount);
    out.interestRate = numeric(src.interestRate);
    out.loanType =
      typeof src.loanType === "string" && (LOAN_TYPES as readonly string[]).includes(src.loanType)
        ? src.loanType
        : undefined;
    return out;
  } catch {
    return null;
  }
}
