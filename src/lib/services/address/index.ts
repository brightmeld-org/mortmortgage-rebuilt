// Address-suggest provider selection + fail-fast configuration validation
// (CH-025 — INV-051, INV-052, INT-023, REQ-040/INT-007). Mirrors the OCR seam
// (src/lib/services/ocr/index.ts): the suggest route imports ONLY
// getAddressSuggestProvider() / suggestAddressesViaProvider() — swapping
// implementations touches nothing else.
//
// CONFIGURATION (env — §6.1 provider enablement is deployment configuration):
//   ADDRESS_PROVIDER = "simulation" (default — zero-key operation) | "real"
//   A real provider additionally requires GOOGLE_PLACES_API_KEY.
//
// SCOPE (INV-052 — the request's hardest must-never): the real provider covers
// the TYPE-AHEAD SUGGEST surface ONLY. geocodeAddress() and withServerGeocode()
// — the deterministic geocoder feeding AVM, HMDA, and the subject-property
// save — take NO provider branch and remain the deterministic simulation in
// BOTH modes: real geocoding would silently move derived AVM valuations and
// HMDA regulatory export values. They stay in src/lib/services/geocoding.ts,
// untouched by this seam.
//
// FAULT POSTURE (§4.2.11 semantics preserved in both modes): any real-provider
// fault silently degrades to an EMPTY suggestions list — never a surfaced
// error. The client falls back to manual entry, exactly as the simulation's
// SIM_FAULT_ADDRESS degrade behaves today.
//
// REAL-PROVIDER SLOT (Layer B): the Google Places adapter body (HTTP calls) is
// NOT part of this delivery — the interface-conformant slot below fail-softs
// to [] until it is hand-completed behind this ratified interface.

import {
  parseProviderSelection,
  requireProviderKeys,
  type ProviderEnv,
} from "@/lib/services/provider-config";
import { suggestAddresses, type AddressSuggestion } from "@/lib/services/geocoding";
import { googlePlacesSuggestAddresses } from "@/lib/services/address/google-places";

export type { AddressSuggestion };

/**
 * The ratified seam surface (CH-025 Layer A): suggest ONLY — deliberately no
 * geocode member, so a future adapter cannot reach the deterministic geocoder
 * through this interface (INV-052).
 */
export interface AddressSuggestProvider {
  name: string;
  suggestAddresses(q: string | null): Promise<AddressSuggestion[]>;
}

/**
 * §6.1 fail-fast validation (INV-051). Throws ProviderConfigError at module
 * load when the real provider is enabled without its required configuration.
 * Simulation (the default) requires no configuration at all.
 */
export function validateAddressProviderConfig(env: ProviderEnv = process.env): void {
  if (parseProviderSelection(env, "ADDRESS_PROVIDER") !== "real") return;
  requireProviderKeys(env, "ADDRESS_PROVIDER", ["GOOGLE_PLACES_API_KEY"]);
}

// Fail fast at startup: the first import of this module (the suggest route) is
// the boot path for the address seam.
validateAddressProviderConfig();

/** The delivered simulation — prefix/fuzzy match over the bundled dataset. */
export const simulatedAddressSuggestProvider: AddressSuggestProvider = {
  name: "simulated-address-provider",
  suggestAddresses(q: string | null): Promise<AddressSuggestion[]> {
    return suggestAddresses(q);
  },
};

/**
 * Layer-B adapter (Google Places suggest — address/google-places.ts). Every
 * fault inside the adapter resolves to [] — the INV-052 fail-soft outcome for
 * this surface (manual entry, never a surfaced error).
 */
export const realAddressSuggestProvider: AddressSuggestProvider = {
  name: "real-address-provider",
  suggestAddresses(q: string | null): Promise<AddressSuggestion[]> {
    return googlePlacesSuggestAddresses(q);
  },
};

export function getAddressSuggestProvider(): AddressSuggestProvider {
  return parseProviderSelection(process.env, "ADDRESS_PROVIDER") === "real"
    ? realAddressSuggestProvider
    : simulatedAddressSuggestProvider;
}

/**
 * The suggest route's single entry point: run the selected provider and
 * enforce the silent-degrade contract — ANY provider fault resolves to []
 * (INV-052; §4.2.11 in both modes). Exported with an injectable provider so
 * deterministic unit tests can prove the degrade with a throwing provider.
 */
export async function suggestAddressesViaProvider(
  q: string | null,
  provider: AddressSuggestProvider = getAddressSuggestProvider(),
): Promise<AddressSuggestion[]> {
  try {
    return await provider.suggestAddresses(q);
  } catch {
    return []; // silent degrade — the client falls back to manual entry
  }
}
