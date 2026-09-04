// PUT /api/applications/:id/sections/:section — contracts §B: SectionSaveRequest
//   -> SectionSaveResponse 200 (borrower; validation error, 403, 404, 409).
//   The wizard auto-save endpoint (REQ-023/035/036, VR-056..VR-072/126..129,
//   XBR-003, XBR-021, INV-025/026/029/039).
//
// RECORD-LEVEL SCOPING: owner borrower only (requireBorrowerOwnedAction inside
// the service); guard + strict schema run before any write.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { sectionSaveRequestSchema } from "@/lib/schemas/application";
import { saveSection } from "@/lib/services/application-data";

async function PUT_impl(
  request: Request,
  { params }: { params: Promise<{ id: string; section: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;

  const { id, section } = await params;
  const parsed = await parseBody(request, sectionSaveRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await saveSection(guarded.ctx.user, id, section, parsed.data, requestMeta(request));
    return Response.json(result);
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const PUT = logged(PUT_impl);
