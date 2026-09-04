// POST /api/applications/:id/bank-links — contracts §B: BankLinkAuthRequest →
// BankLinkSession 200 (borrower; validation error, 401, 403, 404).
// REQ-039, INT-006, INT-017, VR-104..106, §4.2.10 + §6.3.5.
//
// Guard first (401 unauthenticated, 403 staff role), then body parse (strict
// zod), then the service: owner-only (staff → 403, non-owner/unknown → 404 per
// INV-027), unknown institutionId → 404, simulated credential exchange with
// §6.3.5 latency (password `fail` → 401 auth_failed, `slow` → +8 s), encrypted
// token at rest, `bank-link` audit in-transaction.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { bankLinkAuthSchema } from "@/lib/schemas/bank-link";
import { createBankLink } from "@/lib/services/bank-link";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, bankLinkAuthSchema);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  try {
    const session = await createBankLink(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(session);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
