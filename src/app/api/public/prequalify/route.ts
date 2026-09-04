// POST /api/public/prequalify — contracts §B: PrequalifyRequest ->
// PrequalifyResponse 200 (public; errors: validation error, 429).
// REQ-043 / INT-016 / NFR-012.
//
// NO ANONYMOUS PERSISTENCE (FLOW-001 delivery): this handler creates no DB rows
// beyond the rate-limit bucket — inputs are computed on and discarded.
// Rate limit: 60/min "public calculator calls" class (contracts §B cross-cutting
// note) via the persisted RateLimitBucket store (task-008).
// CSRF exempt by design, mirroring the public auth endpoints (register): the
// tool is anonymous-first, computes a response from the submitted body only,
// and persists nothing — there is no privileged state a cross-site request
// could ride on (see src/lib/csrf.ts module header).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { prequalifyRequestSchema } from "@/lib/schemas/public-tools";
import { prequalify } from "@/lib/pure/public-tools";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  // 60/min public-calculator class — keyed session account (when present) + IP.
  const limited = await enforceRateLimit(request, {
    scope: "public-calculator",
    policy: "general",
    account: guarded.ctx.user?.userId ?? null,
  });
  if (limited) return limited;

  const parsed = await parseBody(request, prequalifyRequestSchema);
  if (!parsed.ok) return parsed.response;

  // contracts §A PrequalifyResponse — computed by the pure module (§E formulas,
  // tier rate from the §6.3.4 pricing base table).
  return Response.json(prequalify(parsed.data));
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
