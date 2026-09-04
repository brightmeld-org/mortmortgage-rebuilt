// POST /api/fraud-flags/:id/resolve — contracts §B: FraudFlagResolveRequest →
//   FraudFlagInfo 200 (caseworker, supervisor; validation error, 403, 404,
//   409). Fraud flag resolution (task-027, REQ-060, §4.6.6, VR-118/119).
//
// RECORD-LEVEL SCOPING: the flag is loaded, then its owning application's
// write access verified — assigned caseworker or Supervisor (§3.3). VR-118
// cross-field (status resolved/dismissed only; HIGH-severity dismissal is
// Supervisor-only) and the already-resolved 409 are enforced in the service's
// transactional path; resolver identity comes from the session only.

import { logged } from "@/lib/log";
import { z } from "zod";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { parseBody, strictSchema } from "@/lib/http/validation";
import { FRAUD_FLAG_STATUS_VALUES, resolveFraudFlag } from "@/lib/services/fraud";

// contracts §A FraudFlagResolveRequest — field names/enum literals verbatim.
// VR-119 non-empty here; VR-118 cross-field (never "open") in the service.
const resolveRequestSchema = strictSchema({
  status: z.enum(FRAUD_FLAG_STATUS_VALUES),
  resolutionNote: z.string().min(1, "a resolution note is required"),
});

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, resolveRequestSchema);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  try {
    const info = await resolveFraudFlag(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(info, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
