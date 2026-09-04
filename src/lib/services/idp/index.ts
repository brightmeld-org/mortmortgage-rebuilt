// Provider selection seam (task-008, §4.1.8 / AC-09).
//
// The delivered System runs entirely on the built-in provider — selection is
// deliberately NOT config-driven yet, because no second implementation exists
// (AC-09 requires the abstraction plus wiring NOTES, not a live external
// integration). Swapping providers means implementing IdentityProvider
// (provider.ts) and returning the new instance here — no changes anywhere else
// (see WIRING.md).

import type { IdentityProvider } from "@/lib/services/idp/provider";
import { builtInProvider } from "@/lib/services/idp/built-in";

export type { IdentityProvider, ProvisionInput, ProvisionResult } from "@/lib/services/idp/provider";

/** The active identity provider. */
export function getIdentityProvider(): IdentityProvider {
  return builtInProvider;
}
