// Note request schema (task-030) — STRICT zod mirror of contracts.json
// NoteRequest (VR-093/VR-094).
//
// VR-093 (type enum-value) is enforced here with the verbatim contracts.json
// NoteType literals. VR-094 (content length ≤ the CONFIGURED limit by type —
// internal/formal 4,000, chatter 1,000, both SystemConfig-driven) is the notes
// service's job (src/lib/services/notes.ts) because the limit is a live config
// read; the 100,000 bound here is only the registry's hard ceiling
// (notes.maxLength max), a boundary-safety cap, not a contract constant.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** contracts.json enums.NoteType — verbatim literals. */
export const NOTE_TYPE_VALUES = ["internal", "formal", "chatter"] as const;

export const noteRequestSchema = strictSchema({
  // VR-093: enum-value.
  type: z.enum(NOTE_TYPE_VALUES),
  // VR-094 boundary bound; configured per-type limit enforced in the service.
  content: z
    .string()
    .max(100000)
    .refine((s) => s.trim().length > 0, { message: "content is required" }),
});

export type NoteRequest = z.infer<typeof noteRequestSchema>;
