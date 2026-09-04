// AVM simulation — PURE CORE (task-024, INT-004/INT-015, RFP §6.3.3).
//
// Pure function of documented inputs (subject address/geocode, stated value,
// property type, ZIP) plus a referenceDate parameter — no clock reads, no
// randomness (every in-range value is seeded from the subject input, §6.1).
//
// §6.3.3 mapping (scenario keyed by the LAST DIGIT of the ZIP):
//   digit 0–5 → value factor 1.00 + (digit−2)×0.01 (0.98/0.99/1.00/1.01/1.02/1.03)
//   digit 6–8 → factor 0.90 (low appraisal)
//   digit 9   → PARTIAL response: value returned, NO comparables, confidence 40.
//               INTERPRETATION (documented): §6.3.3 states no factor for 9 —
//               factor 1.00 is used (value = stated value).
//   Comparables (non-partial): 4 synthetic sales within 0.6 miles, the first
//   four at AVM value × {0.94, 0.98, 1.03, 1.07}; sale dates within 180 days;
//   coordinates offset DETERMINISTICALLY from the subject geocode (seeded
//   radius 0.08–0.55 mi + seeded bearing, converted to lat/lon deltas — the
//   reported distanceMiles is exactly that radius).
//   Trend by ZIP digit parity: even → rising; 5/7/9 → stable; 1/3 → declining.
//   INTERPRETATION (documented): trendPct12mo is not numerically specified —
//   fixed +3.0 / 0.0 / −3.0 by trend.
//   INTERPRETATION (documented): valueLow/valueHigh are not numerically
//   specified — ±5% of the AVM value (omitted on partial responses, which
//   §6.3.3 limits to value + confidence).
//   Confidence — INTERPRETATION (documented): §6.3.3 specifies only the
//   partial confidence (40); 90 is used for the 1.00-factor tiers and 80 for
//   the low-appraisal tier.

import { roundRatioPercent } from "@/lib/pure/qualification";
import { isoDaysAgo, lastDigitOf, round2, seededInt } from "@/lib/pure/simulations/shared";
import type {
  AvmCheckResult,
  ComparableSale,
  MarketTrend,
} from "@/lib/pure/simulations/check-results";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AvmSubjectInput {
  /** Subject address display text — comparable-address seed material. */
  addressText: string;
  /** Subject ZIP — its LAST DIGIT keys the §6.3.3 scenario. */
  zip: string;
  /** SubjectProperty.estimatedValue (the stated value the factor applies to). */
  statedValue: number;
  /** PropertyType enum value — seed material (§6.3.3 lists it as an input). */
  propertyType?: string | null;
  /** Subject geocode — comparables offset deterministically from it. */
  latitude?: number | null;
  longitude?: number | null;
  /** LoanDetails.requestedLoanAmount — enables recomputedLtv when present. */
  requestedLoanAmount?: number | null;
}

export interface AvmSimOptions {
  /** SIM_FAULT_AVM=partial forces the digit-9 partial shape for any ZIP. */
  partial: boolean;
  /** Anchors sale dates (never Date.now here). */
  referenceDate: Date;
}

/** Thrown when the input carries no scenario digit or no positive stated value. */
export class AvmInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvmInputError";
  }
}

// ---------------------------------------------------------------------------
// Scenario mapping
// ---------------------------------------------------------------------------

/** §6.3.3 value factor by ZIP last digit (9 → 1.00, see header interpretation). */
export function avmValueFactor(digit: number): number {
  if (digit <= 5) return round2(1.0 + (digit - 2) * 0.01);
  if (digit <= 8) return 0.9;
  return 1.0;
}

/** §6.3.3 trend by ZIP digit: even → rising; 5/7/9 → stable; 1/3 → declining. */
export function avmMarketTrend(digit: number): MarketTrend {
  if (digit % 2 === 0) return "rising";
  if (digit === 1 || digit === 3) return "declining";
  return "stable"; // 5, 7, 9
}

const TREND_PCT: Record<MarketTrend, number> = { rising: 3.0, stable: 0.0, declining: -3.0 };

/** §6.3.3 "first four" comparable price multipliers, in order. */
export const COMPARABLE_PRICE_MULTIPLIERS = [0.94, 0.98, 1.03, 1.07] as const;

const COMPARABLE_STREETS = [
  "Alder Court",
  "Birchwood Lane",
  "Cedar Hollow Drive",
  "Dunmore Avenue",
  "Elmcrest Way",
  "Foxtail Terrace",
] as const;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function buildComparables(
  input: AvmSubjectInput,
  estimatedValue: number,
  referenceDate: Date,
): ComparableSale[] {
  const seed = `avm|${input.zip}|${input.addressText}|${input.propertyType ?? ""}`;
  const comparables: ComparableSale[] = [];
  for (let i = 0; i < COMPARABLE_PRICE_MULTIPLIERS.length; i += 1) {
    const rowSeed = `${seed}|comp|${i}`;
    const salePrice = round2(estimatedValue * COMPARABLE_PRICE_MULTIPLIERS[i]!);
    // Deterministic placement: seeded radius (< 0.6 mi) + seeded bearing.
    const radiusMiles = seededInt(`${rowSeed}|radius`, 8, 55) / 100; // 0.08–0.55
    const bearingDeg = seededInt(`${rowSeed}|bearing`, 0, 359);
    const bearingRad = (bearingDeg * Math.PI) / 180;
    let latitude: number | undefined;
    let longitude: number | undefined;
    if (typeof input.latitude === "number" && typeof input.longitude === "number") {
      const dLat = (radiusMiles * Math.cos(bearingRad)) / 69; // ~69 mi per degree latitude
      const lonScale = 69 * Math.max(0.2, Math.cos((input.latitude * Math.PI) / 180));
      const dLon = (radiusMiles * Math.sin(bearingRad)) / lonScale;
      latitude = Math.round((input.latitude + dLat) * 1e6) / 1e6;
      longitude = Math.round((input.longitude + dLon) * 1e6) / 1e6;
    }
    const squareFeet = seededInt(`${rowSeed}|sqft`, 950, 3_600);
    comparables.push({
      addressText: `${seededInt(`${rowSeed}|number`, 100, 9_899)} ${
        COMPARABLE_STREETS[seededInt(`${rowSeed}|street`, 0, COMPARABLE_STREETS.length - 1)]!
      }`,
      salePrice,
      saleDate: isoDaysAgo(referenceDate, seededInt(`${rowSeed}|saledays`, 15, 175)), // within 180 days
      distanceMiles: radiusMiles,
      beds: seededInt(`${rowSeed}|beds`, 2, 5),
      baths: seededInt(`${rowSeed}|baths`, 2, 7) / 2, // 1.0–3.5 in half-bath steps
      squareFeet,
      pricePerSqFt: round2(salePrice / squareFeet),
      latitude,
      longitude,
    });
  }
  return comparables;
}

/** §6.3.3 AVM simulation — the full wire AvmCheckResult. */
export function simulateAvm(input: AvmSubjectInput, options: AvmSimOptions): AvmCheckResult {
  const digit = lastDigitOf(input.zip);
  if (digit === null) {
    throw new AvmInputError("AVM simulation requires a ZIP with a trailing digit");
  }
  if (!(typeof input.statedValue === "number" && Number.isFinite(input.statedValue) && input.statedValue > 0)) {
    throw new AvmInputError("AVM simulation requires a positive stated value");
  }

  const partial = options.partial || digit === 9;
  const factor = avmValueFactor(digit);
  const estimatedValue = round2(input.statedValue * factor);
  const marketTrend = avmMarketTrend(digit);

  const recomputedLtv =
    typeof input.requestedLoanAmount === "number" && input.requestedLoanAmount > 0
      ? (roundRatioPercent((input.requestedLoanAmount / estimatedValue) * 100) ?? undefined)
      : undefined;

  if (partial) {
    // §6.3.3 digit 9: value returned, no comparables, confidence 40.
    return {
      estimatedValue,
      confidenceScore: 40,
      marketTrend,
      trendPct12mo: TREND_PCT[marketTrend],
      comparables: [],
      recomputedLtv,
    };
  }

  return {
    estimatedValue,
    valueLow: round2(estimatedValue * 0.95),
    valueHigh: round2(estimatedValue * 1.05),
    confidenceScore: factor === 0.9 ? 80 : 90,
    marketTrend,
    trendPct12mo: TREND_PCT[marketTrend],
    comparables: buildComparables(input, estimatedValue, options.referenceDate),
    recomputedLtv,
  };
}
