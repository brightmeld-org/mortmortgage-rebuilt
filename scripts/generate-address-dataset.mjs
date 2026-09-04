// Deterministic synthetic U.S. address dataset generator (task-015, RFP §6.3.6).
//
// Emits src/lib/data/addresses.json: >= 2,000 synthetic addresses across >= 20
// states, each with street, unit?, city, state, zip, county, lat, lng,
// censusTract. Fixed-seed PRNG (mulberry32) — re-running always reproduces the
// identical file. Real city / state / county / ZIP-prefix combinations with
// plausible-format synthetic street names (no "Test/Fake/Sample" placeholders);
// coordinates jitter around real city anchors, always inside the state.
//
// Run: node scripts/generate-address-dataset.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SEED = 0x20260828;

// mulberry32 — tiny deterministic PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 24 states — real city / county / 3-digit ZIP prefix / anchor-coordinate
// combos. Anchors sit >= 0.1 deg inside the state bbox used by the runtime
// geocoder (src/lib/data/addresses-meta.ts); jitter is +/- 0.08 deg.
// fips = 2-digit state FIPS (must agree with addresses-meta.ts).
const STATES = [
  { code: "CA", fips: "06", cities: [
    { city: "Los Angeles", county: "Los Angeles County", zip3: "900", lat: 34.05, lng: -118.24 },
    { city: "San Diego", county: "San Diego County", zip3: "921", lat: 32.72, lng: -117.16 },
    { city: "Sacramento", county: "Sacramento County", zip3: "958", lat: 38.58, lng: -121.49 },
  ] },
  { code: "TX", fips: "48", cities: [
    { city: "Houston", county: "Harris County", zip3: "770", lat: 29.76, lng: -95.37 },
    { city: "Dallas", county: "Dallas County", zip3: "752", lat: 32.78, lng: -96.8 },
    { city: "Austin", county: "Travis County", zip3: "787", lat: 30.27, lng: -97.74 },
  ] },
  { code: "NY", fips: "36", cities: [
    { city: "Buffalo", county: "Erie County", zip3: "142", lat: 42.89, lng: -78.88 },
    { city: "Albany", county: "Albany County", zip3: "122", lat: 42.65, lng: -73.75 },
    { city: "Rochester", county: "Monroe County", zip3: "146", lat: 43.16, lng: -77.61 },
  ] },
  { code: "FL", fips: "12", cities: [
    { city: "Miami", county: "Miami-Dade County", zip3: "331", lat: 25.76, lng: -80.29 },
    { city: "Orlando", county: "Orange County", zip3: "328", lat: 28.54, lng: -81.38 },
    { city: "Tampa", county: "Hillsborough County", zip3: "336", lat: 27.95, lng: -82.46 },
  ] },
  { code: "IL", fips: "17", cities: [
    { city: "Chicago", county: "Cook County", zip3: "606", lat: 41.88, lng: -87.73 },
    { city: "Springfield", county: "Sangamon County", zip3: "627", lat: 39.8, lng: -89.65 },
    { city: "Peoria", county: "Peoria County", zip3: "616", lat: 40.69, lng: -89.59 },
  ] },
  { code: "PA", fips: "42", cities: [
    { city: "Philadelphia", county: "Philadelphia County", zip3: "191", lat: 39.99, lng: -75.17 },
    { city: "Pittsburgh", county: "Allegheny County", zip3: "152", lat: 40.44, lng: -80.0 },
    { city: "Harrisburg", county: "Dauphin County", zip3: "171", lat: 40.27, lng: -76.88 },
  ] },
  { code: "OH", fips: "39", cities: [
    { city: "Columbus", county: "Franklin County", zip3: "432", lat: 39.96, lng: -83.0 },
    { city: "Cleveland", county: "Cuyahoga County", zip3: "441", lat: 41.5, lng: -81.69 },
    { city: "Cincinnati", county: "Hamilton County", zip3: "452", lat: 39.1, lng: -84.51 },
  ] },
  { code: "GA", fips: "13", cities: [
    { city: "Atlanta", county: "Fulton County", zip3: "303", lat: 33.75, lng: -84.39 },
    { city: "Savannah", county: "Chatham County", zip3: "314", lat: 32.08, lng: -81.19 },
    { city: "Augusta", county: "Richmond County", zip3: "309", lat: 33.47, lng: -82.01 },
  ] },
  { code: "NC", fips: "37", cities: [
    { city: "Charlotte", county: "Mecklenburg County", zip3: "282", lat: 35.23, lng: -80.84 },
    { city: "Raleigh", county: "Wake County", zip3: "276", lat: 35.78, lng: -78.64 },
    { city: "Greensboro", county: "Guilford County", zip3: "274", lat: 36.07, lng: -79.79 },
  ] },
  { code: "MI", fips: "26", cities: [
    { city: "Detroit", county: "Wayne County", zip3: "482", lat: 42.33, lng: -83.05 },
    { city: "Grand Rapids", county: "Kent County", zip3: "495", lat: 42.96, lng: -85.66 },
    { city: "Lansing", county: "Ingham County", zip3: "489", lat: 42.73, lng: -84.55 },
  ] },
  { code: "WA", fips: "53", cities: [
    { city: "Seattle", county: "King County", zip3: "981", lat: 47.61, lng: -122.33 },
    { city: "Spokane", county: "Spokane County", zip3: "992", lat: 47.66, lng: -117.43 },
    { city: "Tacoma", county: "Pierce County", zip3: "984", lat: 47.25, lng: -122.44 },
  ] },
  { code: "OR", fips: "41", cities: [
    { city: "Portland", county: "Multnomah County", zip3: "972", lat: 45.52, lng: -122.68 },
    { city: "Salem", county: "Marion County", zip3: "973", lat: 44.94, lng: -123.04 },
    { city: "Eugene", county: "Lane County", zip3: "974", lat: 44.05, lng: -123.09 },
  ] },
  { code: "AZ", fips: "04", cities: [
    { city: "Phoenix", county: "Maricopa County", zip3: "850", lat: 33.45, lng: -112.07 },
    { city: "Tucson", county: "Pima County", zip3: "857", lat: 32.22, lng: -110.97 },
    { city: "Mesa", county: "Maricopa County", zip3: "852", lat: 33.42, lng: -111.83 },
  ] },
  { code: "CO", fips: "08", cities: [
    { city: "Denver", county: "Denver County", zip3: "802", lat: 39.74, lng: -104.99 },
    { city: "Colorado Springs", county: "El Paso County", zip3: "809", lat: 38.83, lng: -104.82 },
    { city: "Boulder", county: "Boulder County", zip3: "803", lat: 40.01, lng: -105.27 },
  ] },
  { code: "MA", fips: "25", cities: [
    { city: "Boston", county: "Suffolk County", zip3: "021", lat: 42.36, lng: -71.06 },
    { city: "Worcester", county: "Worcester County", zip3: "016", lat: 42.26, lng: -71.8 },
    { city: "Springfield", county: "Hampden County", zip3: "011", lat: 42.1, lng: -72.59 },
  ] },
  { code: "NJ", fips: "34", cities: [
    { city: "Newark", county: "Essex County", zip3: "071", lat: 40.74, lng: -74.17 },
    { city: "Jersey City", county: "Hudson County", zip3: "073", lat: 40.73, lng: -74.08 },
    { city: "Trenton", county: "Mercer County", zip3: "086", lat: 40.22, lng: -74.76 },
  ] },
  { code: "VA", fips: "51", cities: [
    { city: "Richmond", county: "Henrico County", zip3: "232", lat: 37.54, lng: -77.44 },
    { city: "Virginia Beach", county: "Virginia Beach City", zip3: "234", lat: 36.85, lng: -76.02 },
    { city: "Roanoke", county: "Roanoke County", zip3: "240", lat: 37.27, lng: -79.94 },
  ] },
  { code: "TN", fips: "47", cities: [
    { city: "Nashville", county: "Davidson County", zip3: "372", lat: 36.16, lng: -86.78 },
    { city: "Memphis", county: "Shelby County", zip3: "381", lat: 35.15, lng: -90.05 },
    { city: "Knoxville", county: "Knox County", zip3: "379", lat: 35.96, lng: -83.92 },
  ] },
  { code: "MN", fips: "27", cities: [
    { city: "Minneapolis", county: "Hennepin County", zip3: "554", lat: 44.98, lng: -93.27 },
    { city: "Saint Paul", county: "Ramsey County", zip3: "551", lat: 44.95, lng: -93.09 },
    { city: "Duluth", county: "St. Louis County", zip3: "558", lat: 46.79, lng: -92.2 },
  ] },
  { code: "MO", fips: "29", cities: [
    { city: "Kansas City", county: "Jackson County", zip3: "641", lat: 39.1, lng: -94.58 },
    { city: "St. Louis", county: "St. Louis County", zip3: "631", lat: 38.63, lng: -90.29 },
    { city: "Columbia", county: "Boone County", zip3: "652", lat: 38.95, lng: -92.33 },
  ] },
  { code: "WI", fips: "55", cities: [
    { city: "Milwaukee", county: "Milwaukee County", zip3: "532", lat: 43.04, lng: -87.95 },
    { city: "Madison", county: "Dane County", zip3: "537", lat: 43.07, lng: -89.4 },
    { city: "Green Bay", county: "Brown County", zip3: "543", lat: 44.51, lng: -88.02 },
  ] },
  { code: "MD", fips: "24", cities: [
    { city: "Baltimore", county: "Baltimore County", zip3: "212", lat: 39.29, lng: -76.61 },
    { city: "Rockville", county: "Montgomery County", zip3: "208", lat: 39.08, lng: -77.15 },
    { city: "Annapolis", county: "Anne Arundel County", zip3: "214", lat: 38.98, lng: -76.49 },
  ] },
  { code: "NV", fips: "32", cities: [
    { city: "Las Vegas", county: "Clark County", zip3: "891", lat: 36.17, lng: -115.14 },
    { city: "Reno", county: "Washoe County", zip3: "895", lat: 39.53, lng: -119.81 },
    { city: "Henderson", county: "Clark County", zip3: "890", lat: 36.04, lng: -114.98 },
  ] },
  { code: "UT", fips: "49", cities: [
    { city: "Salt Lake City", county: "Salt Lake County", zip3: "841", lat: 40.76, lng: -111.89 },
    { city: "Provo", county: "Utah County", zip3: "846", lat: 40.23, lng: -111.66 },
    { city: "Ogden", county: "Weber County", zip3: "844", lat: 41.22, lng: -111.97 },
  ] },
];

const STREET_NAMES = [
  "Main", "Oak", "Maple", "Cedar", "Pine", "Elm", "Washington", "Lincoln",
  "Jefferson", "Madison", "Franklin", "Highland", "Sunset", "Riverside",
  "Prospect", "Chestnut", "Willow", "Sycamore", "Birch", "Magnolia", "Juniper",
  "Dogwood", "Hawthorne", "Sheridan", "Monroe", "Harrison", "Grant",
  "Delaware", "Hudson", "Lakeview", "Hillcrest", "Meadow", "Orchard", "Spruce",
  "Walnut", "Poplar", "Laurel", "Summit", "Valley", "Cherry",
];
const STREET_SUFFIXES = ["St", "Ave", "Blvd", "Dr", "Ln", "Rd", "Ct", "Pl", "Ter", "Way"];

const ROWS_PER_CITY = 28; // 24 states x 3 cities x 28 = 2016 rows

// County -> stable 3-digit code for the synthetic census tract (odd, 001-397).
function countyCode3(county) {
  let h = 0x811c9dc5;
  for (let i = 0; i < county.length; i += 1) {
    h ^= county.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String(((h % 199) * 2 + 1)).padStart(3, "0");
}

const rand = mulberry32(SEED);
const rows = [];
const seen = new Set();

for (const state of STATES) {
  for (const cityDef of state.cities) {
    let produced = 0;
    while (produced < ROWS_PER_CITY) {
      const number = 100 + Math.floor(rand() * 9800);
      const name = STREET_NAMES[Math.floor(rand() * STREET_NAMES.length)];
      const suffix = STREET_SUFFIXES[Math.floor(rand() * STREET_SUFFIXES.length)];
      const street = `${number} ${name} ${suffix}`;
      const zip = `${cityDef.zip3}${String(Math.floor(rand() * 100)).padStart(2, "0")}`;
      const key = `${street.toLowerCase()}|${zip}`;
      // Draw the unit/coord/tract randoms unconditionally so the stream stays
      // aligned regardless of dedupe retries at other ROWS_PER_CITY values.
      const hasUnit = rand() < 0.15;
      const unitNumber = 1 + Math.floor(rand() * 40);
      const lat = +(cityDef.lat + (rand() * 2 - 1) * 0.08).toFixed(6);
      const lng = +(cityDef.lng + (rand() * 2 - 1) * 0.08).toFixed(6);
      const tract4 = 1000 + Math.floor(rand() * 9000);
      const block2 = String(Math.floor(rand() * 100)).padStart(2, "0");
      if (seen.has(key)) continue; // dedupe on street+zip (the geocode index key)
      seen.add(key);
      const row = {
        street,
        ...(hasUnit ? { unit: `Apt ${unitNumber}` } : {}),
        city: cityDef.city,
        state: state.code,
        zip,
        county: cityDef.county,
        lat,
        lng,
        censusTract: `${state.fips}${countyCode3(cityDef.county)}.${tract4}.${block2}`,
      };
      rows.push(row);
      produced += 1;
    }
  }
}

// Sanity: counts + format checks before writing.
const states = new Set(rows.map((r) => r.state));
if (rows.length < 2000) throw new Error(`only ${rows.length} rows generated`);
if (states.size < 20) throw new Error(`only ${states.size} states generated`);
for (const r of rows) {
  if (!/^\d{3,5} [A-Z][a-z]+ [A-Za-z]+$/.test(r.street)) throw new Error(`bad street: ${r.street}`);
  if (!/^\d{5}$/.test(r.zip)) throw new Error(`bad zip: ${r.zip}`);
  if (!/^\d{5}\.\d{4}\.\d{2}$/.test(r.censusTract)) throw new Error(`bad tract: ${r.censusTract}`);
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "data", "addresses.json");
const json = `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`;
writeFileSync(outPath, json);
console.log(`wrote ${rows.length} addresses across ${states.size} states to ${outPath} (${json.length} bytes)`);
