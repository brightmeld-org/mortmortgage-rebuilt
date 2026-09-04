// GET /api/documents/:id/download — contracts §B: streamed binary 200
//   (borrower, caseworker, supervisor; 403, 404). Serves the CURRENT version
//   with Content-Disposition: attachment and the SNIFFED content type
//   (SEC-12/SEC-14, NFR-013, INT-012). Never JSON, never a full memory load.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getDocumentDownload } from "@/lib/services/document";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const download = await getDocumentDownload(guarded.ctx.user, id);
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
