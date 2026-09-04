// GET /api/bank-link/institutions — contracts §B: InstitutionList 200, 401;
// roleGate borrower; none (max 50). REQ-039, INT-017.
//
// The static fictional institution roster (§6.3.5 "at least 6") — stable ids,
// identical on every call. Well under the 50-row cap, so all rows are returned
// with no pagination. No record-level scoping (nothing user-specific) and no
// audit (a read of static reference data). Staff roles are 403 per the
// borrower roleGate.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { listInstitutions, type InstitutionInfo } from "@/lib/services/bank-aggregator";

/** contracts §A InstitutionList. */
interface InstitutionList {
  rows: InstitutionInfo[];
}

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const body: InstitutionList = { rows: [...listInstitutions()] };
  return Response.json(body);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
