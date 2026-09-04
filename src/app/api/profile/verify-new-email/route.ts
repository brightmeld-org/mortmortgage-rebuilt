// POST /api/profile/verify-new-email — contracts §B: VerifyEmailRequest -> Ack 200
// (public; errors: validation error). REQ-041/NFR-011.
//
// INV-010: race-safe single consumption. INV-013: the atomic swap is arbitrated by
// the unique lower(email) index — a conflicting existing account produces the SAME
// uniform failure as an invalid token (no availability disclosure). CSRF exempt by
// design (public token-bearing endpoint — the single-use token IS the authorization).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { verifyEmailRequestSchema } from "@/lib/schemas/auth";
import { verifyNewEmail } from "@/lib/services/profile";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, verifyEmailRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await verifyNewEmail(parsed.data.token, requestMeta(request));
  if (!result.ok) {
    // Uniform for unknown/expired/used token AND for an email conflict (INV-013).
    return validationError(
      ["token: invalid or expired verification token"],
      requestIdFrom(request),
    );
  }
  return Response.json({ message: "Your new email address is verified and now active." });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
