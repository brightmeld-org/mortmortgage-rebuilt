// Proxy-trust-aware client IP resolution (§4.1.7, INV-042): the System is
// configurable to trust proxy-supplied client IP headers only when explicitly
// configured (TRUST_PROXY=true — deployment sits behind a known proxy);
// otherwise header values are ignored, because x-forwarded-for is
// client-forgeable when the app faces the network directly.
//
// SOCKET PEER ADDRESS — investigated, not assumed (Next 15.5.24):
// NextRequest exposes no `ip` (removed in Next 15; see
// node_modules/next/dist/server/web/spec-extension/request.d.ts) and route
// handlers receive a plain web `Request` with no socket handle. The runtime's
// only carrier is base-server.js, which does
// `req.headers['x-forwarded-for'] ??= originalRequest.socket.remoteAddress` —
// note the `??=`: the socket address is injected ONLY when the caller sent no
// X-Forwarded-For, and is NOT appended when the caller did. A caller can
// therefore SUPPRESS the socket address entirely by sending its own header, and
// nothing in the request distinguishes "socket address Next injected" from
// "value the caller forged". So there is no trustworthy socket peer address
// available to a route handler in this runtime.
//
// Consequence, stated plainly: in the shipped TRUST_PROXY=false default the
// client IP is null and the rate limiter's IP dimension is legitimately SKIPPED
// (INV-042 "a dimension with no resolvable value is skipped"). The residual risk
// is real and NOT papered over — a direct-to-internet deployment gets
// account-dimension rate limiting only. Closing it requires either fronting the
// app with a proxy and setting TRUST_PROXY=true + TRUST_PROXY_HOP_COUNT, or a
// custom Node server that plumbs socket.remoteAddress through itself.
//
// Consumers: audit-entry `ip` fields and session rows (task-006), and the
// task-008 persistent rate limiter's IP-scoped bucket dimension.

import { requestIdFrom } from "@/lib/http/errors";

/** Request-derived metadata bundle recorded on sessions and audit entries. */
export interface RequestMetaBundle {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestMeta(request: Request): RequestMetaBundle {
  return {
    ip: clientIpFrom(request),
    userAgent: request.headers.get("user-agent"),
    requestId: requestIdFrom(request) ?? null,
  };
}

export function trustProxyEnabled(): boolean {
  return (process.env.TRUST_PROXY ?? "").toLowerCase() === "true";
}

/**
 * Number of TRUSTED proxy hops in front of the app (TRUST_PROXY_HOP_COUNT,
 * default 1). Each trusted proxy APPENDS the address that connected to it, so
 * in `client, proxy1, ... proxyN-1` the trusted client IP sits exactly
 * `hopCount` positions from the RIGHT. Only consulted when TRUST_PROXY=true.
 */
export function trustProxyHopCount(): number {
  const parsed = Number.parseInt(process.env.TRUST_PROXY_HOP_COUNT ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Client IP for audit/session records and the rate limiter, or null when it
 * cannot be trusted.
 *
 * INV-042: the client IP is the entry TRUST_PROXY_HOP_COUNT positions from the
 * RIGHT of X-Forwarded-For — NEVER the leftmost entry. The leftmost entry is
 * whatever the original caller wrote there: vary it per request and every
 * request mints a fresh rate-limit bucket; pin it to a victim's address and the
 * victim's bucket is poisoned. Entries are appended left-to-right by each hop,
 * so counting from the right is the only position an attacker upstream of the
 * trusted proxies cannot control.
 *
 * A header too short to hold a trusted entry yields null rather than a
 * best-effort guess — absence is recorded as absence, never a placeholder.
 */
export function clientIpFrom(request: Request): string | null {
  if (!trustProxyEnabled()) return null;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const hop = trustProxyHopCount();
    // Fewer entries than trusted hops: no entry in this header was written by a
    // trusted proxy. Do not fall back to another forgeable header.
    if (entries.length < hop) return null;
    return entries[entries.length - hop]!;
  }
  // No X-Forwarded-For at all — x-real-ip is the single-value form the same
  // trusted proxy sets. Trusted for exactly the same reason, and only here.
  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp !== undefined && realIp.length > 0 ? realIp : null;
}
