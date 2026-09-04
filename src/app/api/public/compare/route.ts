// POST /api/public/compare — contracts §B: CompareRequest -> CompareResponse 200
// (public; errors: validation error, 429). REQ-044 / NFR-012.
//
// NO ANONYMOUS PERSISTENCE (FLOW-001 delivery): no DB rows beyond the
// rate-limit bucket. Rate limit: 60/min public-calculator class. CSRF exempt by
// design — same reasoning as /api/public/prequalify (anonymous-first, stateless
// computation, nothing persisted).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { compareRequestSchema } from "@/lib/schemas/public-tools";
import { compareScenarios } from "@/lib/pure/public-tools";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const limited = await enforceRateLimit(request, {
    scope: "public-calculator",
    policy: "general",
    account: guarded.ctx.user?.userId ?? null,
  });
  if (limited) return limited;

  const parsed = await parseBody(request, compareRequestSchema);
  if (!parsed.ok) return parsed.response;

  // contracts §A CompareResponse — per-scenario §E outputs with the single
  // lowest-total-cost scenario flagged bestValue.
  return Response.json({ scenarios: compareScenarios(parsed.data.scenarios) });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
