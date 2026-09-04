// GET /api/documents/:id/versions/:versionId/download — contracts §B: streamed
//   binary 200 (caseworker, supervisor ONLY; 403, 404). Version history stays
//   staff-only (§4.2.9: every prior version viewable/downloadable by staff).
//   The version must belong to the document (404 otherwise). SEC-12/SEC-14.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getDocumentVersionDownload } from "@/lib/services/document";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id, versionId } = await params;
  try {
    const download = await getDocumentVersionDownload(guarded.ctx.user, id, versionId);
    return new Response(download.stream, {
      status: 200,
      headers: {
        "content-type": download.contentType,
        "content-length": String(download.sizeBytes),
        "content-disposition": `attachment; filename="${download.fileName}"`,
      },
    });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
