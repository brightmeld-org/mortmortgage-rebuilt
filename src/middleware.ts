// Next.js middleware — edge layer of the task-005 enforcement stack:
//   (a) per-request CSP nonce + SEC-17 security headers on EVERY response,
//   (b) Origin/Host check on mutating /api requests (profile §12 CSRF baseline;
//       the session-bound synchronizer token check lives in src/lib/csrf.ts and is
//       enforced per-route by the shared guard).
//
// RATE LIMITING no longer lives here (task-008): the profile scaffold's
// in-memory limiter was REPLACED by the persisted RateLimitBucket design
// (REQ-018 / SEC-11 / NFR-012 — keyed account + client IP, survives restarts,
// shared across instances). Edge middleware cannot use Prisma, so enforcement
// runs in the Node request path: src/lib/services/rate-limit.ts, called at the
// top of every §4.1.9 rate-limited route handler (coverage list in that module).
//
// Middleware does NOT do session auth — the shared route guard (src/lib/guard.ts)
// owns authentication/authorization per SEC-19. Wrong-role PAGE redirects are wired
// when the auth pages exist (increment 2) via the named seam `roleAwarePageRedirect`.
//
// Runs on the edge runtime: no node:* or prisma imports here. Error bodies reuse the
// dependency-free contract builders from src/lib/http/errors.ts.

import { NextRequest, NextResponse } from "next/server";
import { ERROR_CODES, errorBody } from "@/lib/http/errors";

// ---------------------------------------------------------------------------
// (a) SEC-17 headers with per-request CSP nonce
// ---------------------------------------------------------------------------

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * CH-025 (INV-053): the ONLY branch input for the conditional CSP is the bank
 * provider mode. Edge-safe local read (this file cannot import the Node seam
 * module src/lib/services/bank/index.ts — its fail-fast validation belongs to
 * the Node boot path, not the edge). Strictly `=== "real"` — the biconditional:
 * any other value (including unset and invalid) keeps the delivered default.
 */
function isBankProviderReal(env: Record<string, string | undefined>): boolean {
  return (env.BANK_PROVIDER ?? "").trim().toLowerCase() === "real";
}

export function buildCsp(
  nonce: string,
  env: Record<string, string | undefined> = process.env,
): string {
  // SEC-17: NO 'unsafe-inline' scripts — framework inline scripts receive the
  // per-request nonce ('strict-dynamic' lets nonced scripts load their chunks).
  // Development only: 'unsafe-eval' is required by Next.js HMR/react-refresh;
  // SEC-17 governs the production posture, where it is never emitted.
  const isDev = env.NODE_ENV === "development";
  // CH-025 (INV-053): the bank aggregator Link widget (script + iframe from
  // https://cdn.plaid.com) is admitted in script-src AND frame-src when and
  // only when BANK_PROVIDER=real. Under simulation (including unset) the
  // emitted CSP is byte-identical to the delivered default — no frame-src
  // directive existed there (default-src 'self' governs frames), and none is
  // emitted. Nonce + strict-dynamic are unchanged in both modes.
  const bankReal = isBankProviderReal(env);
  const scriptSrc = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}${bankReal ? " https://cdn.plaid.com" : ""}`;
  return [
    "default-src 'self'",
    scriptSrc,
    // 'unsafe-inline' STYLES are permitted — SEC-17 restricts inline *scripts*;
    // Next/Tailwind inject style elements.
    "style-src 'self' 'unsafe-inline'",
    // ASM-008 / AC-37 (task-026): the AVM map loads keyless OpenStreetMap
    // tiles as plain <img> elements — the tile host is the ONLY external
    // origin the CSP admits, and only for images.
    "img-src 'self' blob: data: https://tile.openstreetmap.org",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(bankReal ? ["frame-src 'self' https://cdn.plaid.com"] : []),
    "frame-ancestors 'none'",
  ].join("; ");
}

function applySecurityHeaders(headers: Headers, csp: string): void {
  headers.set("Content-Security-Policy", csp);
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY"); // legacy twin of frame-ancestors 'none'
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

// ---------------------------------------------------------------------------
// Named seam — wrong-role PAGE redirects (increment 2)
// ---------------------------------------------------------------------------

/**
 * SEAM (increment 2, task-009/task-044): page-level auth redirects.
 *
 * task-009 wires the ANONYMOUS half — return-to-requested-page: a protected
 * PAGE request with no session cookie at all redirects to
 * /sign-in?redirectTo=<requested path>, and the sign-in flow (including MFA)
 * threads that param through so the user lands on the page they asked for.
 * Cookie PRESENCE is the only signal available on the edge runtime (no
 * Prisma) — a present-but-dead cookie falls through to the page, whose data
 * fetches 401 via the shared guard exactly as before (SEC-19: middleware never
 * does session auth). The WRONG-ROLE half (signed-in user on another role's
 * page → own role home) needs the resolved role and remains task-044's, in
 * the AppShell.
 */

/** Session cookie name — mirrors SESSION_COOKIE_NAME in src/lib/auth.ts (that
 * module cannot be imported here: it would pull Prisma into the edge bundle). */
const SESSION_COOKIE = "mm_session";

/** CH-025 (INV-054): the server-exposed bank-provider mode flag — set to
 * "real" iff BANK_PROVIDER=real; absent under simulation. Mirrors
 * BANK_MODE_COOKIE in src/components/wizard/api.ts (same no-import rule). */
const BANK_MODE_COOKIE = "mm_bank_mode";

/** Authenticated-page prefixes per the requirements §8 route inventory. */
const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/applications",
  "/profile",
  "/notifications",
  "/caseworker",
  "/staff",
  "/supervisor",
] as const;

function isProtectedPagePath(pathname: string): boolean {
  return PROTECTED_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function roleAwarePageRedirect(request: NextRequest): NextResponse | null {
  const { pathname, search } = request.nextUrl;
  if (!isProtectedPagePath(pathname)) return null;
  if (request.cookies.has(SESSION_COOKIE)) return null;

  const signIn = request.nextUrl.clone();
  signIn.pathname = "/sign-in";
  signIn.search = "";
  // Relative path only; the sign-in page re-validates it before use
  // (open-redirect defense in src/components/auth/redirect.ts).
  signIn.searchParams.set("redirectTo", `${pathname}${search}`);
  return NextResponse.redirect(signIn);
}

// ---------------------------------------------------------------------------
// Middleware body
// ---------------------------------------------------------------------------

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(request: NextRequest): NextResponse {
  const requestId = crypto.randomUUID();
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // (b) Origin/Host cross-check on mutating API requests (profile §12 baseline;
  // browser-carried Origin must match the host we are serving as).
  if (isApi && MUTATING_METHODS.has(request.method)) {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (origin && host) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null; // malformed Origin → mismatch
      }
      if (originHost !== host) {
        const response = NextResponse.json(
          errorBody(ERROR_CODES.forbidden, "Cross-origin request rejected", { requestId }),
          { status: 403 },
        );
        applySecurityHeaders(response.headers, csp);
        response.headers.set("x-request-id", requestId);
        return response;
      }
    }
  }

  const redirect = roleAwarePageRedirect(request);
  if (redirect) {
    applySecurityHeaders(redirect.headers, csp);
    redirect.headers.set("x-request-id", requestId);
    return redirect;
  }

  // (a) forward nonce + CSP + request id on the REQUEST so Next.js nonces its own
  // inline scripts during render and route handlers can echo x-request-id in
  // error bodies (src/lib/http/errors.ts#requestIdFrom).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-request-id", requestId);

  // Demo-mode gate (task-008, SEC-15 / contracts §B demo-mode-gated endpoints):
  // with DEMO_MODE off, POST /api/auth/demo-login must be ABSENT — 404, not
  // merely hidden. Rewriting to a path no route matches sends the request down
  // Next's natural unknown-route pipeline, so the response is byte-equivalent to
  // any other unknown URL (the route handler's own notFound() remains as
  // belt-and-suspenders). task-043 extends this list with the demo-data admin
  // endpoints when it builds them.
  // task-046 fixture seam: same ABSENT-not-hidden treatment, with the stricter
  // gate the seam contract requires (non-production AND demo mode).
  const fixtureSeamOff =
    process.env.DEMO_MODE !== "true" || process.env.NODE_ENV === "production";
  if (
    (pathname === "/api/auth/demo-login" && process.env.DEMO_MODE !== "true") ||
    (pathname === "/api/test/fixtures" && fixtureSeamOff)
  ) {
    const absent = request.nextUrl.clone();
    absent.pathname = "/api/absent";
    const response = NextResponse.rewrite(absent, { request: { headers: requestHeaders } });
    applySecurityHeaders(response.headers, csp);
    response.headers.set("x-request-id", requestId);
    return response;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response.headers, csp);
  response.headers.set("x-request-id", requestId);

  // CH-025 (INV-054): the server-exposed bank-mode flag for the borrower
  // bank-link UI — a bare mode word, never key material. Only real mode sets
  // the cookie; under simulation it is deleted ONLY when a stale copy is
  // present (a switched-back deployment), so the delivered zero-key posture's
  // responses stay byte-identical — no Set-Cookie header is ever emitted in
  // the default configuration.
  if (isBankProviderReal(process.env)) {
    response.cookies.set(BANK_MODE_COOKIE, "real", {
      path: "/",
      sameSite: "lax",
      httpOnly: false, // read by the wizard client to gate the Link-widget flow
    });
  } else if (request.cookies.has(BANK_MODE_COOKIE)) {
    response.cookies.delete(BANK_MODE_COOKIE);
  }

  return response;
}

export const config = {
  // Everything except Next static assets and the favicon — SEC-17 headers must be
  // on every page and API response.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
