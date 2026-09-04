// SignatureRequest schema (task-012) — STRICT zod mirror of contracts.json
// models.SignatureRequest; field names and SignatureMode literals VERBATIM.
//
// VR-073 borrowerId uuid; VR-074 mode enum-value; VR-075 imageData max-length
// 280000 (the decoded ≤200KB + PNG sniff run in the service, where the bytes
// exist); VR-076 typedName required iff typed / imageData required iff drawn;
// VR-077 attestationAccepted must be true.
//
// NOTE the demo-mode GATE is deliberately NOT here: "demo" is a real contract
// enum literal, and whether it exists is a LIVE environment question (§B
// demo-mode-gated endpoints — absent-404 when DEMO_MODE=false, not a 400).
// The service answers it per request (src/lib/services/signature.ts).

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";
import { RENDER_TEXT_MAX_CHARS } from "@/lib/pure/png";

/** contracts.json enums.SignatureMode — verbatim. */
export const SIGNATURE_MODES = ["drawn", "typed", "demo"] as const;
export type SignatureModeValue = (typeof SIGNATURE_MODES)[number];

/** VR-075: raw data-URL string cap (280000 chars ≈ 200KB decoded + envelope). */
export const IMAGE_DATA_MAX_CHARS = 280000;

export const signatureRequestSchema = strictSchema({
  borrowerId: z.string().uuid(), // VR-073
  mode: z.enum(SIGNATURE_MODES), // VR-074
  imageData: z.string().min(1).max(IMAGE_DATA_MAX_CHARS).optional(), // VR-075
  // Bounded so the server-side renderer's raster stays within the INV-024 image cap.
  typedName: z.string().min(1).max(RENDER_TEXT_MAX_CHARS).optional(),
  attestationAccepted: z.boolean(),
}).superRefine((body, ctx) => {
  // VR-077: the certification checkbox is required.
  if (body.attestationAccepted !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attestationAccepted"],
      message: "attestationAccepted must be true — the certification checkbox is required",
    });
  }
  // VR-076 cross-field requiredness.
  if (body.mode === "drawn" && body.imageData === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["imageData"],
      message: "imageData is required when mode is drawn",
    });
  }
  if (body.mode === "typed" && body.typedName === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["typedName"],
      message: "typedName is required when mode is typed",
    });
  }
});

export type SignatureRequest = z.infer<typeof signatureRequestSchema>;
