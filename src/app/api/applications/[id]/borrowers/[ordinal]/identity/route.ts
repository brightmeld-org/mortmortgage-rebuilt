// GET /api/applications/:id/borrowers/:ordinal/identity — contracts §B:
//   BorrowerIdentityOwn 200 (borrower; 403, 404). REQ-006/NFR-002/NFR-003, S-5.
//
// THE ONLY endpoint where the FULL decrypted SSN (###-##-####) and raw ISO DOB
// leave the server. roleGate borrower stops staff (403); the service restricts
// to the OWNING borrower (404 for any other borrower's application).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, notFound, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { getBorrowerIdentityOwn } from "@/lib/services/application";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string; ordinal: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id, ordinal } = await params;
  const ordinalNumber = Number(ordinal);
  if (!Number.isInteger(ordinalNumber) || ordinalNumber < 1 || ordinalNumber > 2) {
    return notFound(requestIdFrom(request));
  }

  try {
    const identity = await getBorrowerIdentityOwn(guarded.ctx.user, id, ordinalNumber);
    return Response.json(identity);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
