// The SINGLE cached SystemConfig read accessor (INV-024).
//
// Every subsystem reads configured caps/thresholds through this module — one
// cache, one DB read path. The key REGISTRY (types, bounds, §4.6.11 defaults,
// labels) and the WRITE path (validated, audited, transactional) live in the
// task-004 config service (src/lib/services/config.ts); that service seeds the
// rows via migration and calls `invalidateConfigCache()` after every successful
// write so cached reads converge immediately in-process (the 30s TTL bounds
// staleness for any other process).
//
// This module stays dependency-light (prisma only) so the enforcement layer
// (auth, pagination) can import it without cycles: the service imports THIS
// module's key constants, never the reverse.
//
// Failure posture: a config-read failure falls back to the caller's default —
// the enforcement layer must not turn a config lookup problem into a 500 on
// every request. (If the DB itself is down, session resolution fails
// independently and the request 401s.)

import { prisma } from "@/lib/prisma";

/**
 * Canonical SystemConfig key constants for hot-path consumers (enforcement
 * layer). The FULL §4.6.11 key set is declared by the config-service registry
 * (CONFIG_REGISTRY in src/lib/services/config.ts) using this same dotted
 * naming convention; constants are surfaced here only for keys read by modules
 * that must not import the service.
 */
export const CONFIG_KEYS = {
  /** Session idle timeout, minutes (§4.6.11 default 30 min). */
  sessionIdleTimeoutMinutes: "session.idleTimeoutMinutes",
  /** Session absolute timeout, hours (§4.6.11 default 12 h). Used by task-006 at issuance. */
  sessionAbsoluteTimeoutHours: "session.absoluteTimeoutHours",
  /** Server-enforced maximum page size for every list endpoint (§4.6.11 default 100, INV-036). */
  maxPageSize: "pagination.maxPageSize",
} as const;

export const CONFIG_DEFAULTS = {
  [CONFIG_KEYS.sessionIdleTimeoutMinutes]: 30,
  [CONFIG_KEYS.sessionAbsoluteTimeoutHours]: 12,
  [CONFIG_KEYS.maxPageSize]: 100,
} as const;

// Small in-process TTL cache: config values are read on hot paths (session
// resolution, pagination) and change rarely (Supervisor settings page). The
// config service invalidates it on every successful write.
const CACHE_TTL_MS = 30_000;

/** `missing: true` caches a confirmed row-absence so absent keys do not re-query every call. */
const cache = new Map<string, { value: unknown; missing: boolean; expiresAt: number }>();

/**
 * Read one SystemConfig value (the decoded JSON value — number, boolean,
 * string, or array), or `undefined` when no row exists. Live data: reads the
 * SystemConfig row (30s TTL cache), never a compile-time constant when a row
 * exists. Throws only on unexpected read errors — use the typed wrappers
 * (getConfigNumber here, the service's typed getters) for fallback behavior.
 */
export async function getConfigValue(key: string): Promise<unknown> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.missing ? undefined : hit.value;

  const row = await prisma.systemConfig.findUnique({ where: { key } });
  if (!row) {
    cache.set(key, { value: undefined, missing: true, expiresAt: now + CACHE_TTL_MS });
    return undefined;
  }
  // The column is JSONB; Prisma returns the decoded value. Defensive: a value
  // stored as a JSON-encoded *string* of a scalar decodes one level further.
  const value = row.value;
  cache.set(key, { value, missing: false, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Read a numeric SystemConfig value with fallback (enforcement-layer posture:
 * any read failure or non-numeric/non-positive value falls back).
 */
export async function getConfigNumber(key: string, fallback: number): Promise<number> {
  try {
    const raw = await getConfigValue(key);
    if (raw === undefined) return fallback;
    const decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
    const n = typeof decoded === "number" ? decoded : Number(decoded);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // fall back (see failure posture in module header)
  }
  return fallback;
}

/**
 * Drop a cached value after a write (config service calls this), or the whole
 * cache when called without a key (test seam, also used by verification scripts).
 */
export function invalidateConfigCache(key?: string): void {
  if (key === undefined) cache.clear();
  else cache.delete(key);
}

/** Back-compat alias for the task-005 test seam name. */
export function clearConfigCache(): void {
  cache.clear();
}
