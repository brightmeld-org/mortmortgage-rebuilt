// Bank-link request schemas (task-014) — contracts.json field names verbatim,
// strict per SEC-18 (unknown fields rejected → 400 validation error).

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/**
 * contracts §A BankLinkAuthRequest — VR-104 (institutionId non-empty),
 * VR-105 (username non-empty), VR-106 (password non-empty; the `fail` / `slow`
 * simulation triggers are VALUES, not schema concerns). Upper bounds are the
 * build's boundary-validation convention, mirroring the other schemas.
 */
export const bankLinkAuthSchema = strictSchema({
  institutionId: z.string().min(1, "institutionId is required").max(100),
  username: z.string().min(1, "username is required").max(200),
  password: z.string().min(1, "password is required").max(200),
});

export type BankLinkAuthRequest = z.infer<typeof bankLinkAuthSchema>;

/**
 * contracts §A BankLinkImportRequest — VR-107: accountIds is a required,
 * NON-EMPTY array of aggregator account ids from the link session (membership
 * in the session is checked service-side against the decrypted session payload).
 */
export const bankLinkImportSchema = strictSchema({
  accountIds: z
    .array(z.string().min(1).max(100))
    .min(1, "accountIds must contain at least one account id")
    .max(50),
});

export type BankLinkImportRequest = z.infer<typeof bankLinkImportSchema>;
