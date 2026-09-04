// Typed access to the bundled synthetic U.S. address dataset (task-015,
// REQ-040, INT-018, RFP §6.3.6).
//
// addresses.json is GENERATED — do not hand-edit; re-run
// `node scripts/generate-address-dataset.mjs` (fixed seed, byte-identical
// output). 2,016 rows across 24 states, real city/county/ZIP-prefix combos,
// synthetic street names and census tracts.

import rawAddresses from "./addresses.json";

export interface AddressRow {
  street: string;
  unit?: string;
  city: string;
  state: string; // 2-letter code
  zip: string; // 5 digits, prefix plausible for the state
  county: string;
  lat: number;
  lng: number;
  censusTract: string; // SSCCC.TTTT.BB synthetic format (e.g. "06037.9012.03")
}

export const ADDRESS_DATASET: readonly AddressRow[] = rawAddresses as AddressRow[];
