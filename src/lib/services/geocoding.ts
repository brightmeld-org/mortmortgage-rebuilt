// Address lookup / geocoding simulation (task-015 — REQ-040, INT-007, INT-018,
// RFP §4.2.11 + §6.3.6).
//
// TWO surfaces:
//   suggestAddresses(q)  — the GET /api/address/suggest simulation: prefix +
//     fuzzy match over the bundled dataset, simulated latency, silent degrade.
//   geocodeAddress(a)    — the deterministic geocoder used by the
//     subject-property save hook (application-data.ts), AVM (task-025) and
//     HMDA (task-042). NO latency, NO fault handling — it is a pure
//     computation that must always produce coordinates (same input → same
//     output, always inside the address state's bounding box).
//
// SIMULATED LATENCY (suggest only — §6.3.6 "150 ms ± 100"):
//   Non-blocking async sleep, never inside a DB transaction (this module never
//   opens one). The jitter is DETERMINISTIC from the query hash (not
//   Math.random) so evidence runs are reproducible. Configurable per §6.3:
//     SIM_LATENCY_ADDRESS_BASE_MS    (default 150)
//     SIM_LATENCY_ADDRESS_JITTER_MS  (default 100)
//
// FAULT SCENARIOS (§6.3 preamble, `SIM_FAULT_<INTEGRATION>` convention —
// task-015 establishes it for this codebase as SIM_FAULT_ADDRESS):
//   SIM_FAULT_ADDRESS=none         → normal behavior (default; unknown values
//                                    are treated as none)
//   SIM_FAULT_ADDRESS=slow         → extra delay (SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS,
//                                    default 2000) on top of normal latency
//   SIM_FAULT_ADDRESS=timeout      → silent-empty degrade (manual entry). The
//                                    §6.3 30-second client timeout is truncated
//                                    to the normal latency here so evidence and
//                                    UX stay responsive — documented simplification.
//   SIM_FAULT_ADDRESS=unavailable  → silent-empty degrade (manual entry)
//   Input trigger (always active): "!!" anywhere in q → service unavailable →
//   200 with EMPTY suggestions, never an error (§4.2.11 silent degrade).
//
// QUERY CLAMP (documented choice): contracts §B declares only 200/401 for this
// endpoint — no validation-error status. A missing q or a q shorter than 2
// characters therefore returns 200 with empty suggestions (clamp), NOT a 400.

import { ADDRESS_DATASET, type AddressRow } from "@/lib/data/addresses";
import { CONUS_BBOX, resolveStateCode, STATE_META, type StateBBox } from "@/lib/data/addresses-meta";
import {
  fnv1a32,
  hashUnit,
  normalizeAddressText,
  rankAddressMatches,
} from "@/lib/pure/address-match";

// ---------------------------------------------------------------------------
// Contract shapes (contracts.json, verbatim field names)
// ---------------------------------------------------------------------------

/** contracts §A AddressSuggestion. */
export interface AddressSuggestion {
  formatted: string;
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
}

/** contracts §A GeoPoint. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
  county?: string;
  censusTract?: string;
}

/** Structural Address input for the geocoder (contracts §A Address fields). */
export interface GeocodeAddressInput {
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
  country?: string;
}

const MAX_SUGGESTIONS = 10; // contracts §B: none (max 10)
const MIN_QUERY_LENGTH = 2; // contracts §B: ?q=<prefix> (min 2 chars)

// ---------------------------------------------------------------------------
// Latency + fault configuration
// ---------------------------------------------------------------------------

export type AddressSimFault = "none" | "slow" | "timeout" | "unavailable";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read SIM_FAULT_ADDRESS at call time (unknown values degrade to "none"). */
export function addressSimFault(): AddressSimFault {
  const raw = (process.env.SIM_FAULT_ADDRESS ?? "none").trim().toLowerCase();
  return raw === "slow" || raw === "timeout" || raw === "unavailable" ? raw : "none";
}

/**
 * Deterministic simulated latency for a query: base ± jitter, the jitter drawn
 * from the query's FNV-1a hash (defaults 150 ± 100 → 50..250 ms).
 */
export function addressSuggestLatencyMs(q: string): number {
  const base = envInt("SIM_LATENCY_ADDRESS_BASE_MS", 150);
  const jitter = envInt("SIM_LATENCY_ADDRESS_JITTER_MS", 100);
  if (jitter === 0) return base;
  const offset = (fnv1a32(`latency|${q}`) % (2 * jitter + 1)) - jitter;
  return Math.max(0, base + offset);
}

/** Non-blocking async sleep — never a busy wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Suggest (prefix + fuzzy over the bundled dataset)
// ---------------------------------------------------------------------------

function suggestionText(row: AddressRow): string {
  return `${row.street} ${row.city} ${row.state} ${row.zip}`;
}

function toSuggestion(row: AddressRow): AddressSuggestion {
  const unitPart = row.unit ? `, ${row.unit}` : "";
  return {
    formatted: `${row.street}${unitPart}, ${row.city}, ${row.state} ${row.zip}`,
    street: row.street,
    ...(row.unit !== undefined ? { unit: row.unit } : {}),
    city: row.city,
    state: row.state,
    zip: row.zip,
    county: row.county,
  };
}

/**
 * Type-ahead suggestions (§4.2.11). Always resolves to a suggestion array —
 * NEVER throws for simulated-service conditions: unavailable/timeout faults,
 * the "!!" trigger, and short/missing queries all resolve to [] (the client
 * degrades to manual entry silently).
 */
export async function suggestAddresses(q: string | null): Promise<AddressSuggestion[]> {
  const query = q ?? "";
  const fault = addressSimFault();

  let delay = addressSuggestLatencyMs(query);
  if (fault === "slow") delay += envInt("SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS", 2000);
  await sleep(delay);

  if (fault === "unavailable" || fault === "timeout") return [];
  if (query.includes("!!")) return []; // input-trigger: service unavailable, silent
  if (normalizeAddressText(query).length < MIN_QUERY_LENGTH) return []; // documented clamp

  const matches = rankAddressMatches(query, ADDRESS_DATASET, suggestionText, MAX_SUGGESTIONS);
  return matches.map(toSuggestion);
}

// ---------------------------------------------------------------------------
// Deterministic geocoder
// ---------------------------------------------------------------------------

/** Dataset exact-match index: normalized street + 5-digit zip → row. */
let datasetIndex: Map<string, AddressRow> | null = null;

function indexKey(street: string, zip: string): string {
  return `${normalizeAddressText(street)}|${zip.replace(/\D/g, "").slice(0, 5)}`;
}

function getDatasetIndex(): Map<string, AddressRow> {
  if (!datasetIndex) {
    datasetIndex = new Map();
    for (const row of ADDRESS_DATASET) {
      const key = indexKey(row.street, row.zip);
      if (!datasetIndex.has(key)) datasetIndex.set(key, row);
    }
  }
  return datasetIndex;
}

/** Per-state dataset rows (for nearest-county + tract synthesis). */
let byState: Map<string, AddressRow[]> | null = null;

function getRowsForState(code: string): AddressRow[] {
  if (!byState) {
    byState = new Map();
    for (const row of ADDRESS_DATASET) {
      const list = byState.get(row.state);
      if (list) list.push(row);
      else byState.set(row.state, [row]);
    }
  }
  return byState.get(code) ?? [];
}

function countyCode3(county: string): string {
  return String((fnv1a32(county) % 199) * 2 + 1).padStart(3, "0");
}

/**
 * Deterministic geocode (RFP §6.3.6): a dataset row matched on normalized
 * street+zip returns its exact coordinates/county/tract; any other address
 * hashes its normalized text into the bounding box of the address's STATE
 * (the state field wins over the ZIP; unrecognized states fall back to a
 * CONUS-wide box). County is the nearest dataset county in that state, or a
 * synthesized "<State> County NN" when the state has no dataset rows. Census
 * tract is synthesized from the hash in the dataset's SSCCC.TTTT.BB format.
 * Pure computation — same input always produces the same GeoPoint.
 */
export function geocodeAddress(address: GeocodeAddressInput): GeoPoint {
  // 1. Exact dataset match on normalized street + zip.
  const match = getDatasetIndex().get(indexKey(address.street, address.zip));
  if (match) {
    return {
      latitude: match.lat,
      longitude: match.lng,
      county: match.county,
      censusTract: match.censusTract,
    };
  }

  // 2. Hash the normalized full text into the state's bounding box.
  const stateCode = resolveStateCode(address.state);
  const meta = stateCode ? STATE_META[stateCode] : undefined;
  const bbox: StateBBox = meta?.bbox ?? CONUS_BBOX;

  const normalized = normalizeAddressText(
    `${address.street} ${address.unit ?? ""} ${address.city} ${address.state} ${address.zip}`,
  );
  const h1 = fnv1a32(normalized);
  const h2 = fnv1a32(`${normalized}|lng`);
  const latitude = +(bbox.minLat + hashUnit(h1) * (bbox.maxLat - bbox.minLat)).toFixed(6);
  const longitude = +(bbox.minLng + hashUnit(h2) * (bbox.maxLng - bbox.minLng)).toFixed(6);

  // 3. County: nearest dataset county in the state (by coordinate distance),
  //    else synthesized.
  const stateRows = stateCode ? getRowsForState(stateCode) : [];
  let county: string;
  if (stateRows.length > 0) {
    let best = stateRows[0]!;
    let bestD = Number.POSITIVE_INFINITY;
    for (const row of stateRows) {
      const d = (row.lat - latitude) ** 2 + (row.lng - longitude) ** 2;
      if (d < bestD) {
        bestD = d;
        best = row;
      }
    }
    county = best.county;
  } else {
    const stateName = meta?.name ?? "Federal";
    county = `${stateName} County ${String(10 + (h1 % 90))}`;
  }

  // 4. Synthetic census tract, same SSCCC.TTTT.BB format as the dataset.
  const fips = meta?.fips ?? "00";
  const tract4 = 1000 + (h1 % 9000);
  const block2 = String(h2 % 100).padStart(2, "0");
  const censusTract = `${fips}${countyCode3(county)}.${tract4}.${block2}`;

  return { latitude, longitude, county, censusTract };
}

// ---------------------------------------------------------------------------
// Subject-property save hook (consumed by application-data.ts — task-011 edit)
// ---------------------------------------------------------------------------

/** True when the address has enough substance to geocode. */
function isGeocodableAddress(address: unknown): address is GeocodeAddressInput {
  if (address === null || typeof address !== "object") return false;
  const a = address as Record<string, unknown>;
  return (
    typeof a.street === "string" && a.street.trim().length > 0 &&
    typeof a.city === "string" && a.city.trim().length > 0 &&
    typeof a.state === "string" && a.state.trim().length > 0 &&
    typeof a.zip === "string" && a.zip.trim().length > 0
  );
}

/**
 * Server-side geocode-on-save (§4.2.11): the persisted SubjectProperty's
 * `geocode` is ALWAYS computed here from its address — any client-supplied
 * geocode is discarded. No address (or an incomplete one) → no geocode field.
 * Deterministic and fault-free by design: "!!"/SIM_FAULT degrade applies only
 * to the suggest query surface, never to this hook. Unchanged address →
 * identical geocode; changed address → re-geocoded.
 */
export function withServerGeocode<T extends { address?: unknown; geocode?: unknown }>(
  subjectProperty: T | undefined,
): T | undefined {
  if (subjectProperty === undefined) return undefined;
  const { geocode: _clientGeocode, ...rest } = subjectProperty;
  if (isGeocodableAddress(subjectProperty.address)) {
    return { ...rest, geocode: geocodeAddress(subjectProperty.address) } as unknown as T;
  }
  return rest as unknown as T;
}
