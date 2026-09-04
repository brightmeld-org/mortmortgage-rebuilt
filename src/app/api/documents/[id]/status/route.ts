// PATCH /api/documents/:id/status — contracts §B: Document 200 (caseworker,
//   supervisor; validation error, 403, 404, 409). REQ-053/REQ-038, VR-097/098
//   (reason required for insufficient/waived; waived staff-only via the
//   staff-only role gate). Audited with before/after (SEC-8).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { documentStatusRequestSchema } from "@/lib/schemas/document";
import { changeDocumentStatus } from "@/lib/services/document";

async function PATCH_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, documentStatusRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const document = await changeDocumentStatus(
      guarded.ctx.user,
      id,
      parsed.data,
      requestMeta(request),
    );
    return Response.json(document);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const PATCH = logged(PATCH_impl);
