// GET /api/address/suggest — contracts §B: AddressSuggestResponse 200, 401;
// roleGate authenticated-any; none (max 10). REQ-040, INT-007, INT-018.
//
// ?q=<prefix> (min 2 chars — shorter/missing q returns 200 with EMPTY
// suggestions, a documented clamp: §B declares no validation-error status for
// this row). "!!" in q, and SIM_FAULT_ADDRESS timeout/unavailable, degrade
// silently to empty suggestions (manual entry, §4.2.11). Stateless — no user
// data, no record-level scoping, no audit (§D: no XBR owns address).

// CH-025 (INV-051/INV-052): suggestions now flow through the
// AddressSuggestProvider seam — ADDRESS_PROVIDER=simulation (default) is the
// delivered dataset simulation, byte-identical; =real is the Layer-B slot
// (fail-soft [] until hand-completed). Any provider fault degrades silently to
// an empty list in both modes. The deterministic geocoder is NOT behind this
// seam (INV-052).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { suggestAddressesViaProvider, type AddressSuggestion } from "@/lib/services/address";

/** contracts §A AddressSuggestResponse. */
interface AddressSuggestResponse {
  suggestions: AddressSuggestion[];
}

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;

  const q = new URL(request.url).searchParams.get("q");
  const suggestions = await suggestAddressesViaProvider(q);
  const body: AddressSuggestResponse = { suggestions };
  return Response.json(body);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
