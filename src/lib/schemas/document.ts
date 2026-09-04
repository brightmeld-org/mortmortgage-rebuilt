// Document request-body schemas (task-013) — contracts.json shapes verbatim:
// DocumentUploadRequest, DocumentStatusRequest, DocumentRequestCreate.
// VR-095..VR-100. Strict objects — unknown fields rejected (SEC-18).

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** contracts.json enums.DocumentType — verbatim values (VR-095 / VR-099). */
export const DOCUMENT_TYPE_VALUES = [
  "w2",
  "pay-stub",
  "bank-statement",
  "tax-return-1040",
  "government-id",
  "gift-letter",
  "purchase-agreement",
  "homeowners-insurance-quote",
  "other",
] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPE_VALUES)[number];

/** contracts.json enums.DocumentStatus — verbatim values (VR-097). */
export const DOCUMENT_STATUS_VALUES = ["pending", "accepted", "insufficient", "waived"] as const;
export type DocumentStatusValue = (typeof DOCUMENT_STATUS_VALUES)[number];

/** contracts.json enums.DocumentJobStatus — verbatim values. */
export const DOCUMENT_JOB_STATUS_VALUES = ["queued", "processing", "completed", "failed"] as const;

/**
 * DocumentUploadRequest (multipart fields beside the `file` part).
 * VR-095: documentType enum-value. VR-096: description required when
 * documentType is `other` (e.g. VA Certificate of Eligibility).
 */
export const documentUploadRequestSchema = strictSchema({
  documentType: z.enum(DOCUMENT_TYPE_VALUES),
  description: z.string().trim().min(1).max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.documentType === "other" && (value.description === undefined || value.description.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["description"],
      message: "description is required when documentType is other (VR-096)",
    });
  }
});
export type DocumentUploadRequest = z.infer<typeof documentUploadRequestSchema>;

/**
 * DocumentStatusRequest. VR-097: status enum-value. VR-098: reason required
 * when status is insufficient or waived (waived is staff-only — the endpoint
 * itself is staff-gated).
 */
export const documentStatusRequestSchema = strictSchema({
  status: z.enum(DOCUMENT_STATUS_VALUES),
  reason: z.string().trim().min(1).max(500).optional(),
}).superRefine((value, ctx) => {
  if (
    (value.status === "insufficient" || value.status === "waived") &&
    (value.reason === undefined || value.reason.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: `reason is required when status is ${value.status} (VR-098)`,
    });
  }
});
export type DocumentStatusRequest = z.infer<typeof documentStatusRequestSchema>;

/** DocumentRequestCreate. VR-099: documentType enum-value. VR-100: reason non-empty. */
export const documentRequestCreateSchema = strictSchema({
  documentType: z.enum(DOCUMENT_TYPE_VALUES),
  reason: z.string().trim().min(1, "reason must be non-empty (VR-100)").max(1000),
});
export type DocumentRequestCreate = z.infer<typeof documentRequestCreateSchema>;

/** §4.2.9 human labels (checklist text, notifications) — display only. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentTypeValue, string> = {
  w2: "W-2",
  "pay-stub": "Pay Stub",
  "bank-statement": "Bank Statement",
  "tax-return-1040": "Tax Return (1040)",
  "government-id": "Government-Issued ID",
  "gift-letter": "Gift Letter",
  "purchase-agreement": "Purchase Agreement",
  "homeowners-insurance-quote": "Homeowner's Insurance Quote",
  other: "Other",
};
