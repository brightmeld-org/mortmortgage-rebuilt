// POST /api/applications/:id/bank-links/exchange — contracts §B (CH-025.OP-5):
// BankLinkExchangeRequest → BankLinkSession 200 (borrower; validation error,
// 401, 403, 404, 503). REQ-039, INT-006, INT-023, VR-137, INV-054.
//
// Guard first (401 unauthenticated, 403 staff role — before any id lookup),
// then body parse (strict zod; VR-137: an empty/missing publicToken is a 400
// validation error and is NEVER forwarded to the aggregator), then the
// service: owner-only (staff → 403, non-owner/unknown → 404 per INV-027), then
// the BankAggregatorProvider seam — simulation (default) → contracted 503
// not-available; real-unwired → retryable 503. A Layer-B success returns the
// SAME §A BankLinkSession shape via the same serializer as the credentials
// flow (INV-054); plaintext token material never appears in any response.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { bankLinkExchangeSchema } from "@/lib/services/bank/schemas";
import { exchangeBankLinkToken } from "@/lib/services/bank-link";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, bankLinkExchangeSchema);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  try {
    const session = await exchangeBankLinkToken(
      guarded.ctx.user,
      id,
      parsed.data,
      requestMeta(request),
    );
    return Response.json(session);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
