// POST /api/applications/:id/bank-links/link-token — contracts §B (CH-025.OP-4):
// (no request body) → BankLinkTokenResponse 200 (borrower; 401, 403, 404, 503).
// REQ-039, INT-006, INT-023, INV-054.
//
// Guard first (401 unauthenticated, 403 staff role — before any id lookup, so
// a denial never depends on a seeded id), then the service: owner-only (staff →
// 403, non-owner/unknown → 404 per INV-027), then the BankAggregatorProvider
// seam — BANK_PROVIDER=simulation (default) → contracted 503 not-available;
// =real with the Layer-B adapter not yet wired → retryable 503, never a crash.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { createBankLinkToken } from "@/lib/services/bank-link";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    const token = await createBankLinkToken(guarded.ctx.user, id);
    return Response.json(token);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
