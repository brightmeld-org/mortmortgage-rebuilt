// POST /api/auth/forgot-password — contracts §B: ForgotPasswordRequest -> Ack 200
// (public; errors: 429, validation error). REQ-015/NFR-011/NFR-012.
//
// Uniform response (§4.1.6): the SAME Ack whether or not the address exists. When
// it does, a 60-minute single-use token is issued (stored hashed only) and the
// reset link lands as a simulated-email OutboundMessage row. CSRF exempt by design.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { forgotPasswordRequestSchema } from "@/lib/schemas/auth";
import { forgotPassword, FORGOT_ACK_MESSAGE } from "@/lib/services/auth-account";
import { enforceRateLimit } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, forgotPasswordRequestSchema);
  if (!parsed.ok) return parsed.response;

  // §4.1.9 persisted rate limit — keyed SUBMITTED account + client IP; identical
  // derivation whether or not the address exists (no existence leak).
  const limited = await enforceRateLimit(request, {
    scope: "forgot-password",
    policy: "auth",
    account: parsed.data.email,
  });
  if (limited) return limited;

  await forgotPassword(parsed.data.email, requestMeta(request));

  // Identical body on every non-error path (no existence signal).
  return Response.json({ message: FORGOT_ACK_MESSAGE });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
