// POST /api/documents/:id/ocr/retry — contracts §B: no body -> DocumentJobInfo
//   202 (caseworker, supervisor; 403, 404, 429). REQ-067, NFR-014, AC-44.
//
// §4.7 "manual retry always allowed": enqueues a NEW tracked DocumentJob for
// the document's current version (record exists before this 202 returns —
// ASYNC-001) and hands the execution chain to `after()` so the response
// returns first. A job already active for the version is answered 202 with
// THAT job (idempotent-while-in-flight — the DB partial unique index decides,
// never check-then-act).
//
// 429: the §B error contract for this endpoint — general per-minute policy on
// the established "integration-trigger" scope, keyed by the session user.
//
// RECORD-LEVEL SCOPING: caseworker must hold the ACTIVE assignment (403);
// supervisors act on everything; unknown ids are 404. Audited with the
// SESSION actor (audit-integrity rule).

import { logged } from "@/lib/log";
import { after } from "next/server";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { retryDocumentOcr } from "@/lib/services/document-ocr";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId ?? requestIdFrom(request);

  const limited = await enforceRateLimit(request, {
    scope: "integration-trigger",
    policy: "general",
    account: guarded.ctx.user.userId,
  });
  if (limited) return limited;

  const { id } = await params;
  try {
    const result = await retryDocumentOcr(guarded.ctx.user, id, requestMeta(request));
    if (result.execution) {
      // Keep the serverless context alive until the chain records its outcome —
      // the 202 below returns first (ASYNC-001).
      const execution = result.execution;
      after(() => execution);
    }
    return Response.json(result.info, { status: 202 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
