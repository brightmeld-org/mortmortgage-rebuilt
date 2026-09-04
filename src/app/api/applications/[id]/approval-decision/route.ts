// POST /api/applications/:id/approval-decision — contracts §B:
//   ApprovalDecisionRequest -> Application 200 (supervisor; 403/404/409/
//   validation error). The approval gate (task-020) — §4.5.2 model, WF-002,
//   VR-083..088, INV-001/017/020/028, XBR-009/010, ASYNC-003.
//
// Decision transitions T19–T26b, T31, T40 execute EXCLUSIVELY through this
// endpoint (the transition endpoint rejects them 409 — §B semantics). Level is
// derived from the current workflow state; the ApprovalRecord write and the
// resulting transition commit atomically in the gate service. Guard + strict
// schema run before any state read.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { approvalDecisionRequestSchema } from "@/lib/schemas/approval";
import { executeApprovalDecision } from "@/lib/services/approval";

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, approvalDecisionRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const application = await executeApprovalDecision(
      guarded.ctx.user,
      id,
      parsed.data,
      requestMeta(request),
    );
    return Response.json(application, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
