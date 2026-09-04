// POST /api/applications/:id/signatures — contracts §B: SignatureRequest ->
//   SignatureInfo 201 (borrower; validation error, 403, 404, 409). REQ-037,
//   §4.2.8, VR-073..VR-077, INV-024/026/027/029.
//
// RECORD-LEVEL SCOPING: owner borrower only (requireBorrowerOwnedAction inside
// the service — INV-027: staff incl. Supervisors 403); guard + strict schema run
// before any write. The demonstration-attestation mode is demo-mode-gated inside
// the service (§B: absent — 404 — when DEMO_MODE=false; the gate must read the
// LIVE environment per request, so it cannot live in the static schema).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { signatureRequestSchema } from "@/lib/schemas/signature";
import { captureSignature } from "@/lib/services/signature";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, signatureRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const signature = await captureSignature(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(signature, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
