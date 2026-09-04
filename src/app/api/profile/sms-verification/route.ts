// POST /api/profile/sms-verification — contracts §B: (no body) -> Ack 200
// (roleGate ["borrower"]; errors: 403, 429). REQ-041.
//
// Simulated SMS (§6.3.8): a 6-digit code — hashed at rest, 10-minute single use —
// recorded as an OutboundMessage row on the sms channel to the profile's mobile
// number. Requires a mobile number on file (set via notification preferences).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { requestIdFrom, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { startSmsVerification } from "@/lib/services/profile";
import { enforceRateLimit } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  // §4.1.9-style persisted limit (§B row lists 429) — session account + client IP.
  const limited = await enforceRateLimit(request, {
    scope: "sms-verification",
    policy: "auth",
    account: user.userId,
  });
  if (limited) return limited;

  const result = await startSmsVerification(
    { userId: user.userId, role: user.role },
    requestMeta(request),
  );
  if (!result.ok) return validationError(result.details, requestIdFrom(request));
  return Response.json({ message: "A verification code has been sent to your mobile number." });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
