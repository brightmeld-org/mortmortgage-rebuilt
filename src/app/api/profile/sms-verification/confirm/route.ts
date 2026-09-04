// POST /api/profile/sms-verification/confirm — contracts §B:
// SmsVerifyRequest -> UserProfile 200 (roleGate ["borrower"]; errors:
// validation error, 403). REQ-041, VR-031, INV-010 (race-safe single consumption).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { smsVerifyRequestSchema } from "@/lib/schemas/auth";
import { confirmSmsVerification } from "@/lib/services/profile";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  const parsed = await parseBody(request, smsVerifyRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await confirmSmsVerification(
    { userId: user.userId, role: user.role },
    parsed.data.code,
    requestMeta(request),
  );
  if (!result.ok) return validationError(result.details, requestIdFrom(request));
  return Response.json(result.profile);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
