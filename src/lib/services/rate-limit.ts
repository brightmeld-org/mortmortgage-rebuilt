// Persistent, DB-backed rate limiting (task-008). REQ-018 / SEC-11 / NFR-012,
// contracts §B cross-cutting rate-limiter note, requirements §4.1.9.
//
// Replaces the profile scaffold's in-memory middleware limiter (src/middleware.ts,
// increment 1). Buckets live in the RateLimitBucket table, so limits SURVIVE
// RESTARTS and apply ACROSS INSTANCES sharing the database — the two properties
// the contract buys with persistence (SEC-11). Edge middleware cannot use Prisma,
// so enforcement runs in the Node request path: each rate-limited route handler
// calls `enforceRateLimit(...)` at the top (after auth/parse, before any
// expensive or state-changing work).
//
// Design (fits the task-001 schema exactly — key + windowStart + count):
//   - FIXED WINDOW: windowStart = floor(now / windowMs) * windowMs. One row per
//     (key, windowStart) — the schema's @@unique([key, windowStart]).
//   - KEYS = one bucket PER DIMENSION (INV-042), never a composite:
//       <scope>|acct|<normalized-account>   and   <scope>|ip|<client-ip>
//     Each rate-limited request consumes BOTH and is refused if EITHER exceeds
//     its limit. A composite account+ip key (what this file shipped with) gives
//     every (account, ip) pair its own budget, so one source spraying N distinct
//     accounts opens N buckets and is never throttled. A dimension with no
//     resolvable value is SKIPPED — never collapsed onto a shared sentinel.
//     Scope isolates endpoint groups so e.g. sign-in attempts never consume the
//     registration budget. The ACCOUNT component is derived from what the CALLER
//     SUBMITTED (normalized email) or the session user id — never from whether
//     the account exists, so key derivation is byte-identical for known and
//     unknown accounts (no existence leak).
//   - CLIENT IP comes from src/lib/http/client-ip.ts, which reads
//     X-Forwarded-For from the RIGHT (TRUST_PROXY_HOP_COUNT, default 1) and only
//     when TRUST_PROXY=true. Under the shipped TRUST_PROXY=false default no
//     client IP is resolvable in this runtime and the IP dimension is skipped —
//     see that module's header for the investigated reason and residual risk.
//   - ATOMIC upsert-increment in ONE SQL statement (INSERT ... ON CONFLICT DO
//     UPDATE ... RETURNING) — race-safe under concurrent requests: N parallel
//     calls produce exactly N increments and the cap can never be overshot by a
//     read-then-write race.
//   - LIMITS from LIVE SystemConfig (seeded keys below; §4.6.11 "Rate-limit
//     defaults"), contract defaults as fallback: 10 / 15 min for the §4.1.9
//     authentication list, 60 / min for the general list. All configurable.
//   - 429s use the project's single ErrorResponse shape (src/lib/http/errors.ts)
//     plus a Retry-After header (seconds until the window rolls) — the same
//     final shape the scaffold limiter already emitted.
//   - CLEANUP is opportunistic: whenever a NEW bucket row is created, expired
//     rows older than twice the largest configured window are pruned (indexed
//     on windowStart). No cron dependency.
//
// §4.1.9 endpoint coverage — ALL of REQ-018's named surfaces are now wired via
// route-handler calls. The list below is the authoritative map; it is enforced,
// not merely documented, by task-046/suites/14-client-ip-and-limit-coverage.test.ts,
// which scans the route tree and fails if a contracted 429 endpoint has no
// enforceRateLimit call.
//   - policy "auth": sign-in, registration, email verification (consume +
//     resend), password-reset request + submit, MFA verify, MFA enroll/verify,
//     demo login, SMS verification issue, accept-invitation
//   - policy "general" (REQ-018 "60/min for others"):
//     - public calculator calls: prequalify / compare / handoff-token
//     - document upload: POST /api/applications/:id/documents
//     - integration-triggering endpoint: POST /api/documents/:id/ocr/retry
//       (POST /api/applications/:id/checks/:checkType is the other §4.1.9
//       "integration-triggering" surface but its §B row does NOT list 429, so it
//       is deliberately unwired — the contract, not this comment, is the gate.)

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getConfigNumber } from "@/lib/http/config";
import { clientIpFrom } from "@/lib/http/client-ip";
import { ERROR_CODES, errorBody, requestIdFrom } from "@/lib/http/errors";

/**
 * Account dimension for a token-only auth endpoint (verify-email, reset-password,
 * accept-invitation — bodies carrying a single-use token and no email or session).
 * INV-042 / CH-019: these must key on SOMETHING so they don't collapse onto the
 * coarse scope-global fail-closed bucket. The token is reduced to a non-reversible
 * tag (never stored raw in the RateLimitBucket.key column) so the bucket dimension
 * is per-token without leaking token material.
 */
export function tokenRateLimitAccount(token: string): string {
  return `tok:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Policies + SystemConfig keys (seeded by the task-004 config migration)
// ---------------------------------------------------------------------------

export type RateLimitPolicy = "auth" | "general";

/** Seeded SystemConfig keys (prisma/migrations/*seed_system_config). */
export const RATE_LIMIT_CONFIG_KEYS = {
  authAttempts: "rateLimit.authAttempts",
  authWindowMinutes: "rateLimit.authWindowMinutes",
  generalPerMinute: "rateLimit.generalPerMinute",
} as const;

/** Contract defaults (§4.1.9) — fallbacks only; live values come from SystemConfig. */
export const RATE_LIMIT_DEFAULTS = {
  authAttempts: 10,
  authWindowMinutes: 15,
  generalPerMinute: 60,
} as const;

async function policyValues(policy: RateLimitPolicy): Promise<{ limit: number; windowMs: number }> {
  if (policy === "auth") {
    const limit = await getConfigNumber(
      RATE_LIMIT_CONFIG_KEYS.authAttempts,
      RATE_LIMIT_DEFAULTS.authAttempts,
    );
    const windowMinutes = await getConfigNumber(
      RATE_LIMIT_CONFIG_KEYS.authWindowMinutes,
      RATE_LIMIT_DEFAULTS.authWindowMinutes,
    );
    return { limit, windowMs: Math.max(1000, Math.round(windowMinutes * 60_000)) };
  }
  const limit = await getConfigNumber(
    RATE_LIMIT_CONFIG_KEYS.generalPerMinute,
    RATE_LIMIT_DEFAULTS.generalPerMinute,
  );
  return { limit, windowMs: 60_000 };
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Endpoint-group scopes. One bucket per (scope, account, ip) — adding a scope for
 * a new §4.1.9 surface is deliberate, reviewed work (see coverage list above).
 */
export type RateLimitScope =
  | "sign-in"
  | "register"
  | "verify-email"
  | "resend-verification"
  | "forgot-password"
  | "reset-password"
  | "mfa-verify"
  | "mfa-enroll-verify"
  | "demo-login"
  | "sms-verification"
  | "accept-invitation"
  | "public-calculator"
  | "document-upload"
  | "integration-trigger";

/**
 * Normalize the account component EXACTLY the same way for every caller —
 * whether or not the account exists (uniformity: no existence signal in either
 * behavior or timing; the bucket write happens regardless). Returns null when
 * the request carries no account dimension at all (token-only bodies), which is
 * a property of the REQUEST SHAPE, never of whether the account exists — so the
 * uniformity guarantee is unaffected.
 */
function normalizeAccount(account: string | null | undefined): string | null {
  const trimmed = (account ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * INV-042: one bucket PER DIMENSION, never a composite key.
 *
 * A composite `<scope>|<account>|<ip>` key means each (account, ip) pair gets
 * its own fresh budget, so one source spraying N distinct accounts consumes N
 * buckets and is never throttled — the account dimension and the IP dimension
 * have to be counted SEPARATELY and the request refused if EITHER is over.
 *
 * A dimension with no resolvable value is SKIPPED, never collapsed onto a
 * shared sentinel. The previous `"no-ip"` constant was exactly that forbidden
 * sentinel; so was `"-"` for the account. A sentinel is the worst of both
 * worlds: with an IP-less request it pretended to be an IP dimension while
 * providing none, and under a split key it would merge every unrelated caller
 * into one global bucket, turning the limiter itself into a DoS.
 */
export function bucketKeys(
  scope: RateLimitScope,
  account: string | null | undefined,
  ip: string | null,
): string[] {
  const keys: string[] = [];
  const normalizedAccount = normalizeAccount(account);
  if (normalizedAccount !== null) keys.push(`${scope}|acct|${normalizedAccount}`);
  const trimmedIp = ip?.trim();
  if (trimmedIp !== undefined && trimmedIp.length > 0) keys.push(`${scope}|ip|${trimmedIp}`);
  return keys;
}

// ---------------------------------------------------------------------------
// Atomic consume + opportunistic prune
// ---------------------------------------------------------------------------

export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests recorded in the current window INCLUDING this one. */
  count: number;
  limit: number;
  /** Seconds until the current fixed window rolls over (Retry-After on 429). */
  retryAfterSeconds: number;
}

/** Increment ONE bucket atomically and return its post-increment count. */
async function consumeOneBucket(key: string, windowStart: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "RateLimitBucket" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${key}, ${windowStart}, 1, now(), now())
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimitBucket"."count" + 1, "updatedAt" = now()
    RETURNING "count"`;
  return rows[0]?.count ?? 1;
}

/**
 * Record one request against EVERY applicable bucket dimension and report
 * whether it is within the limit (INV-042).
 *
 * Each dimension keeps the single-statement atomic upsert-increment that makes
 * the limiter race-safe within a process and correct ACROSS instances sharing
 * the database. The request is refused if ANY dimension exceeds its limit, and
 * the reported verdict is the STRICTEST one (highest count).
 *
 * Every dimension is consumed UNCONDITIONALLY — no short-circuit on the first
 * over-limit bucket. That preserves the uniformity property the composite-key
 * version had: the work done is a function of the request SHAPE only, never of
 * whether the submitted account exists, so neither behavior nor timing leaks
 * account existence.
 *
 * FAIL CLOSED on zero dimensions (INV-042 as amended by CH-019, LENS-016). When
 * neither an account nor a trustworthy client IP resolves — the shipped
 * TRUST_PROXY=false posture for a token-only or anonymous request — there is
 * nothing per-request to key on, but the request is NOT allowed for that reason.
 * It is counted against a single scope-level GLOBAL bucket (`<scope>|global`) and
 * refused once that bucket exceeds its limit. This was the fail-OPEN gap: six
 * contracted-429 endpoints (verify-email / reset-password / accept-invitation and
 * the public prequalify/compare/handoff-token calculators) resolved zero
 * dimensions and so could be driven without limit (70 unthrottled requests
 * against a 60/min endpoint, live-proven). The scope-global bucket is the ONE
 * sanctioned shared bucket and applies ONLY to an otherwise-entirely-unkeyed
 * request; the per-dimension skip rule still forbids collapsing an
 * individually-resolvable dimension onto a sentinel. Token-only auth endpoints
 * pass a token-derived account (see tokenRateLimitAccount) so they key per-token
 * rather than sharing this global bucket.
 */
export async function consumeRateLimit(
  scope: RateLimitScope,
  policy: RateLimitPolicy,
  account: string | null | undefined,
  ip: string | null,
): Promise<RateLimitVerdict> {
  const { limit, windowMs } = await policyValues(policy);
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000));
  let keys = bucketKeys(scope, account, ip);

  if (keys.length === 0) {
    // FAIL CLOSED (CH-019 / LENS-016): nothing resolved to key on — enforce a
    // scope-level global bucket rather than allowing unconditionally.
    keys = [`${scope}|global`];
  }

  const counts: number[] = [];
  for (const key of keys) counts.push(await consumeOneBucket(key, windowStart));
  const strictest = Math.max(...counts);

  // Opportunistic cleanup: only when this call OPENED a new bucket (bounds prune
  // frequency to once per key per window). Horizon = 2x the LARGEST configured
  // window so a long-window policy's live buckets are never pruned by a
  // short-window caller. Failure here must never fail the request.
  if (counts.some((count) => count === 1)) {
    try {
      const authWindowMinutes = await getConfigNumber(
        RATE_LIMIT_CONFIG_KEYS.authWindowMinutes,
        RATE_LIMIT_DEFAULTS.authWindowMinutes,
      );
      const largestWindowMs = Math.max(authWindowMinutes * 60_000, 60_000, windowMs);
      await prisma.rateLimitBucket.deleteMany({
        where: { windowStart: { lt: new Date(now - 2 * largestWindowMs) } },
      });
    } catch {
      // prune is best-effort by design
    }
  }

  return {
    allowed: strictest <= limit,
    count: strictest,
    limit,
    retryAfterSeconds,
  };
}

// ---------------------------------------------------------------------------
// Route-handler entry point
// ---------------------------------------------------------------------------

/**
 * Enforce the rate limit for a request. Returns the 429 Response (contract
 * ErrorResponse + Retry-After header) when over the limit, or null to proceed.
 *
 * Call at the top of the rate-limited route handler — after the guard/session
 * resolution (SEC-19) and, for body-keyed flows, after parseBody supplies the
 * account component; always BEFORE any expensive or state-changing work.
 *
 * `account`: the submitted email (public credential flows), the session user id
 * (authenticated flows), the demo account email (demo login), or null for
 * token-only flows. IP comes from the TRUST_PROXY-aware resolver (task-006).
 */
export async function enforceRateLimit(
  request: Request,
  opts: { scope: RateLimitScope; policy: RateLimitPolicy; account: string | null },
): Promise<Response | null> {
  const verdict = await consumeRateLimit(
    opts.scope,
    opts.policy,
    opts.account,
    clientIpFrom(request),
  );
  if (verdict.allowed) return null;

  return Response.json(
    errorBody(ERROR_CODES.rateLimited, "Too many requests — please try again later", {
      requestId: requestIdFrom(request),
    }),
    { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
  );
}
