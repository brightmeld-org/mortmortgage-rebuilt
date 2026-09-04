// U.S. state metadata for the address lookup / geocoding simulation (task-015,
// REQ-040, INT-018, RFP §6.3.6).
//
// Every state (50 + DC) carries an APPROXIMATE interior bounding box and its
// 2-digit FIPS code. The deterministic geocoder maps free-typed addresses into
// the bbox of the address's STATE (the state field wins over any ZIP-implied
// state — documented simulation rule). Bounding boxes are rectangles, so points
// near a border may geometrically fall in a neighboring state — acceptable for
// a simulation whose contract is "inside the state's bounding box".

export interface StateBBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface StateMeta {
  name: string;
  fips: string; // 2-digit state FIPS, zero-padded
  bbox: StateBBox;
}

export const STATE_META: Record<string, StateMeta> = {
  AL: { name: "Alabama", fips: "01", bbox: { minLat: 30.2, maxLat: 35.0, minLng: -88.5, maxLng: -84.9 } },
  AK: { name: "Alaska", fips: "02", bbox: { minLat: 55.0, maxLat: 71.0, minLng: -165.0, maxLng: -131.0 } },
  AZ: { name: "Arizona", fips: "04", bbox: { minLat: 31.4, maxLat: 36.9, minLng: -114.8, maxLng: -109.1 } },
  AR: { name: "Arkansas", fips: "05", bbox: { minLat: 33.0, maxLat: 36.5, minLng: -94.6, maxLng: -89.7 } },
  CA: { name: "California", fips: "06", bbox: { minLat: 32.6, maxLat: 41.9, minLng: -124.3, maxLng: -114.2 } },
  CO: { name: "Colorado", fips: "08", bbox: { minLat: 37.0, maxLat: 41.0, minLng: -109.0, maxLng: -102.1 } },
  CT: { name: "Connecticut", fips: "09", bbox: { minLat: 41.0, maxLat: 42.0, minLng: -73.7, maxLng: -71.8 } },
  DE: { name: "Delaware", fips: "10", bbox: { minLat: 38.5, maxLat: 39.8, minLng: -75.8, maxLng: -75.1 } },
  DC: { name: "District of Columbia", fips: "11", bbox: { minLat: 38.8, maxLat: 38.99, minLng: -77.11, maxLng: -76.9 } },
  FL: { name: "Florida", fips: "12", bbox: { minLat: 25.2, maxLat: 30.9, minLng: -87.5, maxLng: -80.1 } },
  GA: { name: "Georgia", fips: "13", bbox: { minLat: 30.4, maxLat: 34.9, minLng: -85.6, maxLng: -81.0 } },
  HI: { name: "Hawaii", fips: "15", bbox: { minLat: 18.9, maxLat: 22.2, minLng: -160.2, maxLng: -154.8 } },
  ID: { name: "Idaho", fips: "16", bbox: { minLat: 42.0, maxLat: 49.0, minLng: -117.2, maxLng: -111.0 } },
  IL: { name: "Illinois", fips: "17", bbox: { minLat: 37.0, maxLat: 42.5, minLng: -91.5, maxLng: -87.5 } },
  IN: { name: "Indiana", fips: "18", bbox: { minLat: 37.8, maxLat: 41.8, minLng: -88.1, maxLng: -84.8 } },
  IA: { name: "Iowa", fips: "19", bbox: { minLat: 40.4, maxLat: 43.5, minLng: -96.6, maxLng: -90.1 } },
  KS: { name: "Kansas", fips: "20", bbox: { minLat: 37.0, maxLat: 40.0, minLng: -102.0, maxLng: -94.6 } },
  KY: { name: "Kentucky", fips: "21", bbox: { minLat: 36.5, maxLat: 39.1, minLng: -89.5, maxLng: -82.0 } },
  LA: { name: "Louisiana", fips: "22", bbox: { minLat: 29.0, maxLat: 33.0, minLng: -94.0, maxLng: -89.0 } },
  ME: { name: "Maine", fips: "23", bbox: { minLat: 43.1, maxLat: 47.4, minLng: -71.1, maxLng: -66.9 } },
  MD: { name: "Maryland", fips: "24", bbox: { minLat: 38.0, maxLat: 39.7, minLng: -79.5, maxLng: -75.1 } },
  MA: { name: "Massachusetts", fips: "25", bbox: { minLat: 41.3, maxLat: 42.9, minLng: -73.5, maxLng: -69.9 } },
  MI: { name: "Michigan", fips: "26", bbox: { minLat: 41.7, maxLat: 45.9, minLng: -86.9, maxLng: -82.4 } },
  MN: { name: "Minnesota", fips: "27", bbox: { minLat: 43.5, maxLat: 49.0, minLng: -97.2, maxLng: -89.5 } },
  MS: { name: "Mississippi", fips: "28", bbox: { minLat: 30.2, maxLat: 35.0, minLng: -91.6, maxLng: -88.1 } },
  MO: { name: "Missouri", fips: "29", bbox: { minLat: 36.0, maxLat: 40.6, minLng: -95.7, maxLng: -89.1 } },
  MT: { name: "Montana", fips: "30", bbox: { minLat: 44.4, maxLat: 49.0, minLng: -116.0, maxLng: -104.0 } },
  NE: { name: "Nebraska", fips: "31", bbox: { minLat: 40.0, maxLat: 43.0, minLng: -104.0, maxLng: -95.3 } },
  NV: { name: "Nevada", fips: "32", bbox: { minLat: 35.0, maxLat: 42.0, minLng: -120.0, maxLng: -114.0 } },
  NH: { name: "New Hampshire", fips: "33", bbox: { minLat: 42.7, maxLat: 45.3, minLng: -72.6, maxLng: -70.6 } },
  NJ: { name: "New Jersey", fips: "34", bbox: { minLat: 39.0, maxLat: 41.3, minLng: -75.5, maxLng: -73.9 } },
  NM: { name: "New Mexico", fips: "35", bbox: { minLat: 31.3, maxLat: 37.0, minLng: -109.0, maxLng: -103.0 } },
  NY: { name: "New York", fips: "36", bbox: { minLat: 40.5, maxLat: 45.0, minLng: -79.7, maxLng: -71.9 } },
  NC: { name: "North Carolina", fips: "37", bbox: { minLat: 33.9, maxLat: 36.6, minLng: -84.3, maxLng: -75.5 } },
  ND: { name: "North Dakota", fips: "38", bbox: { minLat: 45.9, maxLat: 49.0, minLng: -104.0, maxLng: -96.6 } },
  OH: { name: "Ohio", fips: "39", bbox: { minLat: 38.4, maxLat: 41.9, minLng: -84.8, maxLng: -80.5 } },
  OK: { name: "Oklahoma", fips: "40", bbox: { minLat: 33.7, maxLat: 37.0, minLng: -103.0, maxLng: -94.4 } },
  OR: { name: "Oregon", fips: "41", bbox: { minLat: 42.0, maxLat: 46.2, minLng: -124.5, maxLng: -116.5 } },
  PA: { name: "Pennsylvania", fips: "42", bbox: { minLat: 39.7, maxLat: 42.3, minLng: -80.5, maxLng: -74.7 } },
  RI: { name: "Rhode Island", fips: "44", bbox: { minLat: 41.3, maxLat: 42.0, minLng: -71.9, maxLng: -71.1 } },
  SC: { name: "South Carolina", fips: "45", bbox: { minLat: 32.0, maxLat: 35.2, minLng: -83.3, maxLng: -78.5 } },
  SD: { name: "South Dakota", fips: "46", bbox: { minLat: 42.5, maxLat: 45.9, minLng: -104.0, maxLng: -96.4 } },
  TN: { name: "Tennessee", fips: "47", bbox: { minLat: 35.0, maxLat: 36.7, minLng: -90.3, maxLng: -81.7 } },
  TX: { name: "Texas", fips: "48", bbox: { minLat: 26.0, maxLat: 36.5, minLng: -106.6, maxLng: -93.5 } },
  UT: { name: "Utah", fips: "49", bbox: { minLat: 37.0, maxLat: 42.0, minLng: -114.0, maxLng: -109.0 } },
  VT: { name: "Vermont", fips: "50", bbox: { minLat: 42.7, maxLat: 45.0, minLng: -73.4, maxLng: -71.5 } },
  VA: { name: "Virginia", fips: "51", bbox: { minLat: 36.5, maxLat: 39.4, minLng: -83.6, maxLng: -75.2 } },
  WA: { name: "Washington", fips: "53", bbox: { minLat: 45.6, maxLat: 49.0, minLng: -124.7, maxLng: -117.0 } },
  WV: { name: "West Virginia", fips: "54", bbox: { minLat: 37.2, maxLat: 40.6, minLng: -82.6, maxLng: -77.7 } },
  WI: { name: "Wisconsin", fips: "55", bbox: { minLat: 42.5, maxLat: 46.9, minLng: -92.9, maxLng: -86.8 } },
  WY: { name: "Wyoming", fips: "56", bbox: { minLat: 41.0, maxLat: 45.0, minLng: -111.0, maxLng: -104.1 } },
};

const NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_META).map(([code, meta]) => [meta.name.toLowerCase(), code]),
);

/**
 * Resolve a state field value ("OR", "or", "Oregon") to a 2-letter code.
 * Returns null when unrecognized (geocoder falls back to a CONUS-wide box).
 */
export function resolveStateCode(state: string): string | null {
  const trimmed = state.trim();
  if (trimmed.length === 0) return null;
  const upper = trimmed.toUpperCase();
  if (STATE_META[upper]) return upper;
  return NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

/** Continental-US fallback box for unrecognized state values (documented seam). */
export const CONUS_BBOX: StateBBox = { minLat: 24.6, maxLat: 49.0, minLng: -124.7, maxLng: -66.9 };
