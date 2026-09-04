// POST /api/applications/:id/bank-links/:linkId/import — contracts §B:
// BankLinkImportRequest → Application 200 (borrower; validation error, 403,
// 404). REQ-039, VR-107, XBR-019.
//
// Guard first, strict body parse (accountIds non-empty), then the service:
// owner-only (INV-027), linkId scoped WITH applicationId (foreign linkId →
// 404), unlinked link → 404, borrower-editable states only (wrong state → 403
// — documented resolution in src/lib/services/bank-link.ts), accountIds
// validated against the DECRYPTED link session (unknown id → 400), idempotent
// append of source `bank-link` asset rows with encrypted account-number
// envelopes, signature invalidation + DTI/LTV/CLTV recalc + versionStamp bump
// + `bank-import` audit in ONE transaction. Returns the full Application.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { bankLinkImportSchema } from "@/lib/schemas/bank-link";
import { importBankLink } from "@/lib/services/bank-link";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, bankLinkImportSchema);
  if (!parsed.ok) return parsed.response;

  const { id, linkId } = await params;
  try {
    const application = await importBankLink(
      guarded.ctx.user,
      id,
      linkId,
      parsed.data,
      requestMeta(request),
    );
    return Response.json(application);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
