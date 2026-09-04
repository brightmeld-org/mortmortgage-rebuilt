// GET /api/applications/:id/versions/diff?from=&to= — contracts §B:
//   VersionDiffResponse 200 (borrower, caseworker, supervisor; 403, 404,
//   validation error — both params required). REQ-052.
//
// Diffs run over the MASKED section-structured snapshots (no raw SSN/DOB ever).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import {
  HttpProblem,
  problemResponse,
  requestIdFrom,
  validationError,
} from "@/lib/http/errors";
import { diffVersions } from "@/lib/services/application";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const requestId = requestIdFrom(request);

  const search = new URL(request.url).searchParams;
  const details: string[] = [];
  const from = parseVersionParam(search.get("from"), "from", details);
  const to = parseVersionParam(search.get("to"), "to", details);
  if (details.length > 0 || from === null || to === null) {
    return validationError(details, requestId);
  }

  try {
    const diff = await diffVersions(guarded.ctx.user, id, from, to);
    return Response.json(diff);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

function parseVersionParam(value: string | null, name: string, details: string[]): number | null {
  if (value === null || value.trim() === "") {
    details.push(`${name}: required version number`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    details.push(`${name}: must be a positive version number`);
    return null;
  }
  return n;
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
