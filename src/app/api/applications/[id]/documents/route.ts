// GET  /api/applications/:id/documents — contracts §B: DocumentListResponse 200
//   (borrower, caseworker, supervisor; 403, 404; no pagination, max 50).
//   REQ-038/REQ-053.
// POST /api/applications/:id/documents — contracts §B: Document 201 (borrower,
//   caseworker, supervisor; validation error, 403, 404, 409, 413, 429).
//   multipart/form-data upload (REQ-038, NFR-013, INT-012, NFR-012, SEC-12/13,
//   XBR-016/024, ASM-004). The 429 in the row is the PERSISTED rate limiter
//   (src/lib/services/rate-limit.ts, scope "document-upload", policy "general" —
//   REQ-018 names document upload explicitly and puts non-auth endpoints on the
//   60/min budget). It is enforced HERE, in the Node request path: the limiter
//   moved out of middleware in task-008 because edge middleware cannot use
//   Prisma. The configured document cap surfaces as 409.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { parseUploadForm } from "@/lib/services/document-multipart";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { listDocuments, uploadDocument } from "@/lib/services/document";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  try {
    return Response.json(await listDocuments(guarded.ctx.user, id));
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  // REQ-018 / §B 429: guard FIRST (SEC-19), then the limit, then the expensive
  // work. This is the same guard -> limit -> work ordering every other wired
  // §4.1.9 handler uses (e.g. ocr/retry, sms-verification), and here it also
  // means an over-budget caller never reaches the multipart parse, the storage
  // write or the OCR enqueue. Keyed by the session user (no request body is
  // read to derive the account).
  const limited = await enforceRateLimit(request, {
    scope: "document-upload",
    policy: "general",
    account: guarded.ctx.user.userId,
  });
  if (limited) return limited;

  const { id } = await params;
  const parsed = await parseUploadForm(request);
  if (!parsed.ok) return parsed.response;

  try {
    const document = await uploadDocument(
      guarded.ctx.user,
      id,
      parsed.body,
      parsed.file,
      requestMeta(request),
    );
    return Response.json(document, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
export const POST = logged(POST_impl);
