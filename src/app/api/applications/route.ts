// GET  /api/applications — contracts §B: BorrowerApplicationList 200 (borrower;
//   401, 403; offset-limit max 100; ?state= filter, ?page&pageSize). REQ-020.
// POST /api/applications — contracts §B: CreateApplicationRequest -> Application
//   201 (borrower; validation error, 403, 409). REQ-022/REQ-045/NFR-022.
//
// RECORD-LEVEL SCOPING: the list is WHERE-scoped to the session borrower's own
// applications; create writes only rows owned by the session borrower.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getPagination } from "@/lib/http/pagination";
import { requestMeta } from "@/lib/http/client-ip";
import { createApplicationRequestSchema } from "@/lib/schemas/application";
import { createApplication, listBorrowerApplications } from "@/lib/services/application";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  try {
    const pagination = await getPagination(request, 100);
    const state = new URL(request.url).searchParams.get("state");
    const list = await listBorrowerApplications(guarded.ctx.user, pagination, state);
    return Response.json(list);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, createApplicationRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const { application } = await createApplication(
      guarded.ctx.user,
      parsed.data,
      requestMeta(request),
    );
    return Response.json(application, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
export const POST = logged(POST_impl);
