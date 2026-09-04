// Request schemas for the task-006 auth + profile endpoints — contracts §E
// VR-001..VR-014 and VR-024..VR-031, mirrored EXACTLY (field names and enum
// literals verbatim from contracts.json). All schemas are strict: unknown JSON
// fields are rejected (SEC-18) via the shared strictSchema helper.
//
// Server-side-only policy rules (§4.1.5 character classes, common-password list,
// history — the VR-004 detail block) run in src/lib/services/password-policy.ts
// after schema validation; the schema carries the §E min-length values.

import { z } from "zod";
import { strictSchema } from "@/lib/http/validation";

/** contracts.json enums.NotificationChannelPreference — verbatim literals. */
export const NOTIFICATION_CHANNEL_VALUES = ["email", "sms", "both"] as const;

// --- §E RegisterRequest (VR-001..VR-006) ---
export const registerRequestSchema = strictSchema({
  firstName: z.string().min(1, "must be non-empty"), // VR-001
  lastName: z.string().min(1, "must be non-empty"), // VR-002
  email: z.string().email("must be a valid email address"), // VR-003
  password: z.string().min(12, "must be at least 12 characters"), // VR-004 (classes/common list server-side)
  passwordConfirmation: z.string(),
  acceptTerms: z.boolean(),
}).superRefine((data, ctx) => {
  if (data.passwordConfirmation !== data.password) {
    // VR-005
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["passwordConfirmation"],
      message: "must equal password",
    });
  }
  if (data.acceptTerms !== true) {
    // VR-006
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acceptTerms"],
      message: "must be true for registration to proceed",
    });
  }
});

// --- §E SignInRequest (VR-007/VR-008) ---
export const signInRequestSchema = strictSchema({
  email: z.string().email("must be a valid email address"), // VR-007
  password: z.string().min(1, "must be non-empty"), // VR-008
});

// --- §E VerifyEmailRequest (VR-009) — also used by verify-new-email ---
export const verifyEmailRequestSchema = strictSchema({
  token: z.string().min(1, "must be non-empty"), // VR-009
});

// --- §E ForgotPasswordRequest (VR-010) ---
export const forgotPasswordRequestSchema = strictSchema({
  email: z.string().email("must be a valid email address"), // VR-010
});

// --- §E ResetPasswordRequest (VR-011/VR-012) ---
export const resetPasswordRequestSchema = strictSchema({
  token: z.string().min(1, "must be non-empty"), // VR-011
  newPassword: z.string().min(12, "must be at least 12 characters"), // VR-012
});

// --- §E ChangePasswordRequest (VR-013/VR-014) ---
export const changePasswordRequestSchema = strictSchema({
  currentPassword: z.string().min(1, "must be non-empty"), // VR-013
  newPassword: z.string().min(12, "must be at least 12 characters"), // VR-014
});

// --- §E UpdateProfileRequest (VR-024..VR-026) ---
export const updateProfileRequestSchema = strictSchema({
  firstName: z.string().min(1, "must be non-empty"), // VR-024
  lastName: z.string().min(1, "must be non-empty"), // VR-025
  phone: z.string().max(30, "must be at most 30 characters").optional(), // VR-026
});

// --- §E ChangeEmailRequest (VR-027/VR-028) ---
export const changeEmailRequestSchema = strictSchema({
  newEmail: z.string().email("must be a valid email address"), // VR-027
  currentPassword: z.string().min(1, "must be non-empty"), // VR-028
});

// --- §E NotificationPreferencesRequest (VR-029/VR-030) ---
export const notificationPreferencesRequestSchema = strictSchema({
  channel: z.enum(NOTIFICATION_CHANNEL_VALUES), // VR-029 — literals verbatim
  mobileNumber: z.string().max(30, "must be at most 30 characters").optional(),
});
// VR-030's "and must be verified via the SMS code flow" needs live DB state, so the
// whole cross-field rule is enforced in the profile service (single place, one message).

// --- §E SmsVerifyRequest (VR-031) ---
export const smsVerifyRequestSchema = strictSchema({
  code: z.string().min(1, "must be non-empty"), // VR-031
});

// --- §E AcceptInvitationRequest (VR-022/VR-023, task-033) ---
export const acceptInvitationRequestSchema = strictSchema({
  token: z.string().min(1, "must be non-empty"), // VR-022
  password: z.string().min(12, "must be at least 12 characters"), // VR-023 (classes/common list server-side)
});

/** contracts.json enums.DemoRole — verbatim literals. */
export const DEMO_ROLE_SCHEMA_VALUES = ["borrower", "caseworker", "supervisor"] as const;

// --- §E DemoLoginRequest (VR-021, task-008) ---
export const demoLoginRequestSchema = strictSchema({
  role: z.enum(DEMO_ROLE_SCHEMA_VALUES), // VR-021 — enum-value, literals verbatim
});
