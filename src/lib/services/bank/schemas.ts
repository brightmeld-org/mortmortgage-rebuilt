// Token-flow request schema (CH-025 — contracts §A BankLinkExchangeRequest,
// VR-137). Lives beside the bank seam rather than src/lib/schemas/bank-link.ts
// to keep the CH-025 blast radius exact; same strict-object conventions
// (SEC-18 — unknown fields rejected → 400 validation error).

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/**
 * contracts §A BankLinkExchangeRequest — VR-137 (publicToken non-empty: an
 * empty or missing token is a validation error, never forwarded to the
 * aggregator). institutionId/institutionName are optional display metadata the
 * Link widget may supply. Upper bounds are the build's boundary-validation
 * convention, mirroring the other schemas.
 */
export const bankLinkExchangeSchema = strictSchema({
  publicToken: z.string().min(1, "publicToken is required").max(500),
  institutionId: z.string().min(1).max(100).optional(),
  institutionName: z.string().min(1).max(200).optional(),
});

export type BankLinkExchangeRequest = z.infer<typeof bankLinkExchangeSchema>;
