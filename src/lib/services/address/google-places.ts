// Google Places adapter for the AddressSuggestProvider seam (CH-025 Layer B —
// INT-023, INV-051/052). Hand-completed behind the ratified interface: the
// suggest surface ONLY (INV-052 — the deterministic geocoder is not reachable
// through this module), silent-degrade-to-[] on every fault (§4.2.11).
//
// Call shape (reference: App A's places proxy endpoints): the legacy Places
// Web Service — autocomplete (types=address, US-only) then per-prediction
// details (fields=address_components,formatted_address) to assemble the
// contracted AddressSuggestion rows. No SDK dependency; server-side fetch
// with a hard timeout. The API key comes from GOOGLE_PLACES_API_KEY
// (fail-fast validated at module load by address/index.ts) and is only ever
// used in server-side request URLs — never serialized to a client.

import type { AddressSuggestion } from "@/lib/services/geocoding";

const AUTOCOMPLETE_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";

/** Suggest-surface budget: the simulation resolves in ~50-250 ms; a real
 *  round-trip gets a firm ceiling so the wizard's type-ahead stays responsive
 *  and a hung upstream degrades to manual entry instead of a spinner. */
const TIMEOUT_MS = 4000;
/** Details fan-out cap — one details call per returned suggestion. */
const MAX_RESULTS = 8;

interface PlacesComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

async function fetchJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

function parseAddressComponents(
  components: PlacesComponent[],
  formatted: string,
): AddressSuggestion | null {
  let streetNumber = "";
  let route = "";
  let city = "";
  let state = "";
  let zip = "";
  let county: string | undefined;
  for (const c of components) {
    if (c.types.includes("street_number")) streetNumber = c.long_name;
    else if (c.types.includes("route")) route = c.long_name;
    else if (c.types.includes("locality")) city = c.long_name;
    else if (!city && c.types.includes("sublocality")) city = c.long_name;
    else if (c.types.includes("administrative_area_level_1")) state = c.short_name;
    else if (c.types.includes("administrative_area_level_2")) county = c.long_name;
    else if (c.types.includes("postal_code")) zip = c.long_name;
  }
  const street = [streetNumber, route].filter(Boolean).join(" ");
  // The contracted AddressSuggestion requires street/city/state/zip — a
  // prediction that resolves without any of them is dropped, not padded.
  if (!street || !city || !state || !zip) return null;
  return {
    formatted: formatted || `${street}, ${city}, ${state} ${zip}`,
    street,
    city,
    state,
    zip,
    ...(county !== undefined ? { county } : {}),
  };
}

/**
 * Real suggest implementation. Faults of every kind — missing key, non-OK
 * status, REQUEST_DENIED/OVER_QUERY_LIMIT, timeout, malformed payload —
 * resolve to [] (the seam's suggestAddressesViaProvider adds a second
 * catch-all). Queries shorter than the simulation's 2-char clamp return []
 * to keep the endpoint's behavior envelope identical across modes.
 */
export async function googlePlacesSuggestAddresses(
  q: string | null,
): Promise<AddressSuggestion[]> {
  const query = (q ?? "").trim();
  if (query.length < 2) return [];
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const acParams = new URLSearchParams({
      input: query,
      types: "address",
      components: "country:us",
      key: apiKey,
    });
    const ac = await fetchJson(`${AUTOCOMPLETE_URL}?${acParams}`, controller.signal);
    if (!ac || (ac.status !== "OK" && ac.status !== "ZERO_RESULTS")) return [];
    const predictions = (Array.isArray(ac.predictions) ? ac.predictions : [])
      .filter((p): p is { place_id: string } => typeof (p as { place_id?: unknown })?.place_id === "string")
      .slice(0, MAX_RESULTS);

    const detailed = await Promise.all(
      predictions.map(async (p) => {
        try {
          const dParams = new URLSearchParams({
            place_id: p.place_id,
            fields: "address_components,formatted_address",
            key: apiKey,
          });
          const d = await fetchJson(`${DETAILS_URL}?${dParams}`, controller.signal);
          const result = d?.result as
            | { address_components?: PlacesComponent[]; formatted_address?: string }
            | undefined;
          if (d?.status !== "OK" || !Array.isArray(result?.address_components)) return null;
          return parseAddressComponents(result.address_components, result.formatted_address ?? "");
        } catch {
          return null; // one failed details call drops one suggestion, not the list
        }
      }),
    );
    return detailed.filter((s): s is AddressSuggestion => s !== null);
  } catch {
    return []; // silent degrade (INV-052) — timeout, network, parse
  } finally {
    clearTimeout(timer);
  }
}
