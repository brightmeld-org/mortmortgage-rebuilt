// Pure, deterministic address matching + hashing for the address lookup /
// geocoding simulation (task-015, REQ-040, INT-007, INT-018, RFP §6.3.6).
//
// No dependencies, no I/O, no randomness — same inputs always produce the same
// outputs (the profile's pure-function rules; fuzzy matching is a hand-rolled
// bounded Levenshtein, NOT a package — the profile allowlist has no fuzzy libs).

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalizeAddressText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenizeAddressText(text: string): string[] {
  const norm = normalizeAddressText(text);
  return norm.length === 0 ? [] : norm.split(" ");
}

// ---------------------------------------------------------------------------
// Deterministic hashing (FNV-1a 32-bit) — geocode + latency-jitter seed
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string. Unsigned 32-bit result. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Map a hash into [0, 1) deterministically. */
export function hashUnit(hash: number): number {
  return (hash >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Bounded Levenshtein (fuzzy tolerance)
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance between two tokens, capped at `max` (returns max + 1
 * when the distance exceeds it — callers only care about "within tolerance").
 */
export function levenshteinWithin(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb]! <= max ? prev[lb]! : max + 1;
}

/** Per-token fuzzy tolerance: short tokens 1 edit, longer tokens 2 edits. */
export function fuzzyToleranceFor(token: string): number {
  return token.length <= 3 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface AddressMatchScore {
  matched: boolean;
  /** Higher is better. Prefix matches always outrank fuzzy-only matches. */
  score: number;
}

/**
 * Score one candidate haystack (pre-normalized full-address text) against the
 * query tokens.
 *
 *   1. Whole-string prefix: haystack starts with the whole normalized query.
 *   2. Token-prefix: every query token is a prefix of some haystack token.
 *   3. Fuzzy: every query token is a prefix of OR within Levenshtein tolerance
 *      of some haystack token ("Mian St" still finds "Main St").
 *
 * Deterministic: pure arithmetic over the inputs.
 */
export function scoreAddressMatch(
  queryNorm: string,
  queryTokens: readonly string[],
  haystackNorm: string,
  haystackTokens: readonly string[],
): AddressMatchScore {
  if (queryTokens.length === 0) return { matched: false, score: 0 };

  if (haystackNorm.startsWith(queryNorm)) {
    // Tighter matches (less unmatched tail) rank higher.
    return { matched: true, score: 3000 - Math.min(999, haystackNorm.length - queryNorm.length) };
  }

  let allPrefix = true;
  let totalDistance = 0;
  for (const qt of queryTokens) {
    let bestPrefix = false;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    const tolerance = fuzzyToleranceFor(qt);
    for (const ht of haystackTokens) {
      if (ht.startsWith(qt)) {
        bestPrefix = true;
        break;
      }
      const d = levenshteinWithin(qt, ht, tolerance);
      if (d < bestDistance) bestDistance = d;
    }
    if (bestPrefix) continue;
    allPrefix = false;
    if (bestDistance > tolerance) return { matched: false, score: 0 };
    totalDistance += bestDistance;
  }

  if (allPrefix) {
    return { matched: true, score: 2000 - Math.min(999, haystackNorm.length - queryNorm.length) };
  }
  return { matched: true, score: 1000 - totalDistance * 50 - Math.min(499, haystackNorm.length) };
}

export interface RankedMatch<T> {
  row: T;
  score: number;
}

/**
 * Rank rows against a query and return the top `limit` (deterministic ordering:
 * score desc, then normalized text asc as the tiebreaker).
 */
export function rankAddressMatches<T>(
  query: string,
  rows: readonly T[],
  textOf: (row: T) => string,
  limit: number,
): T[] {
  const queryNorm = normalizeAddressText(query);
  const queryTokens = queryNorm.length === 0 ? [] : queryNorm.split(" ");
  if (queryTokens.length === 0) return [];

  const scored: Array<RankedMatch<T> & { norm: string }> = [];
  for (const row of rows) {
    const norm = normalizeAddressText(textOf(row));
    const tokens = norm.split(" ");
    const result = scoreAddressMatch(queryNorm, queryTokens, norm, tokens);
    if (result.matched) scored.push({ row, score: result.score, norm });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.row);
}
