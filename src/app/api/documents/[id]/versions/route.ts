// POST /api/documents/:id/versions — contracts §B: Document 201 (borrower,
//   caseworker, supervisor; validation error, 403, 404, 409, 413).
//   Replacement upload: new DocumentVersion n+1, currentVersionId repointed
//   atomically, priors retained, new DocumentJob queued before the response
//   (REQ-038, SEC-13, XBR-016, ASM-004, INV-007).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { parseUploadForm } from "@/lib/services/document-multipart";
import { uploadDocumentVersion } from "@/lib/services/document";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseUploadForm(request);
  if (!parsed.ok) return parsed.response;

  try {
    const document = await uploadDocumentVersion(
      guarded.ctx.user,
      id,
      parsed.body,
      parsed.file,
      requestMeta(request),
    );
    return Response.json(document, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
