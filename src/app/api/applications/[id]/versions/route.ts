// GET /api/applications/:id/versions — contracts §B: VersionPage 200 (borrower,
//   caseworker, supervisor; 403, 404; offset-limit max 100). REQ-052, INV-036.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { listVersions } from "@/lib/services/application";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const pagination = await getPagination(request, 100);
    const page = await listVersions(guarded.ctx.user, id, pagination);
    return Response.json(page);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
