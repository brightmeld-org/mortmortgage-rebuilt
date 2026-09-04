// POST /api/applications/:id/document-requests — contracts §B:
//   DocumentRequestInfo 201 (caseworker, supervisor; validation error, 403,
//   404). REQ-053, VR-099/100. Creates the borrower's in-app Notification
//   naming type and reason in the same transaction.
// GET  /api/applications/:id/document-requests — contracts §B:
//   DocumentRequestList 200 (borrower, caseworker, supervisor; 403, 404; no
//   pagination, max 50). REQ-053.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { documentRequestCreateSchema } from "@/lib/schemas/document";
import { createDocumentRequest, listDocumentRequests } from "@/lib/services/document";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, documentRequestCreateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const created = await createDocumentRequest(
      guarded.ctx.user,
      id,
      parsed.data,
      requestMeta(request),
    );
    return Response.json(created, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    return Response.json(await listDocumentRequests(guarded.ctx.user, id));
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
export const GET = logged(GET_impl);
