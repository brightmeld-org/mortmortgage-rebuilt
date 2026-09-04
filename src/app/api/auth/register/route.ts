// POST /api/auth/register — contracts §B: RegisterRequest -> Ack 200
// (public; errors: validation error, 429). REQ-011/REQ-014/NFR-012.
//
// Uniform response (§4.1.2): the SAME Ack whether the address is new or already
// registered — existence is never disclosed. CSRF exempt by design (public
// unauthenticated auth endpoint — see src/lib/csrf.ts module header).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { validationError } from "@/lib/http/errors";
import { requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { registerRequestSchema } from "@/lib/schemas/auth";
import { validatePasswordPolicy } from "@/lib/services/password-policy";
import { register, REGISTER_ACK_MESSAGE } from "@/lib/services/auth-account";
import { enforceRateLimit } from "@/lib/services/rate-limit";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, registerRequestSchema);
  if (!parsed.ok) return parsed.response;

  // §4.1.9 persisted rate limit — keyed submitted account + client IP (task-008).
  const limited = await enforceRateLimit(request, {
    scope: "register",
    policy: "auth",
    account: parsed.data.email,
  });
  if (limited) return limited;

  // §4.1.5 policy beyond the schema's min-length: character classes + common list
  // (no history — the account does not exist yet).
  const policyDetails = await validatePasswordPolicy(parsed.data.password, { field: "password" });
  if (policyDetails.length > 0) {
    return validationError(policyDetails, requestIdFrom(request));
  }

  await register(
    {
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      email: parsed.data.email,
      password: parsed.data.password,
    },
    requestMeta(request),
  );

  // contracts §A Ack — identical body on every non-error path (no existence signal).
  return Response.json({ message: REGISTER_ACK_MESSAGE });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
