// GET  /api/applications/:id/notes — contracts §B: NotePage 200 (borrower,
//   caseworker, supervisor; 403, 404). offset-limit pagination (max 100).
//   `?since=<ISO>` serves the 15-second chatter poll; borrowers receive ONLY
//   formal notes (S-7 — enforced server-side in the service's WHERE clause).
// POST /api/applications/:id/notes — contracts §B: NoteRequest -> ApplicationNote
//   201 (caseworker, supervisor; validation error, 403, 404, 409).
//
// REQ-051, REQ-008, VR-093/094, INV-021/024/036, SEC-8.
//
// IMMUTABILITY (§4.4.5): notes and chatter are immutable and undeletable — no
// PATCH/PUT/DELETE handler exists here or anywhere for ApplicationNote.
//
// RECORD-LEVEL SCOPING: the roleGate is only the route gate; the service
// enforces S-1/S-2a/S-3/S-4 per record (borrower must own; caseworker must
// hold the active assignment — S-2b summary access does NOT include notes).

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import {
  HttpProblem,
  problemResponse,
  requestIdFrom,
  validationError,
} from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { getPagination } from "@/lib/http/pagination";
import { noteRequestSchema } from "@/lib/schemas/notes";
import { createNote, listNotes } from "@/lib/services/notes";

async function GET_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower", "caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;
  const requestId = guarded.ctx.requestId ?? requestIdFrom(request);

  const { id } = await params;

  // Boundary validation of the contracted `?since=` param (profile rule): a
  // present-but-unparseable value is rejected rather than silently ignored.
  const sinceRaw = new URL(request.url).searchParams.get("since");
  let since: Date | undefined;
  if (sinceRaw !== null) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return validationError(["since must be an ISO 8601 timestamp"], requestId);
    }
    since = parsed;
  }

  try {
    const pagination = await getPagination(request, 100);
    const page = await listNotes(guarded.ctx.user, id, pagination, since);
    return Response.json(page, { status: 200 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

async function POST_impl(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["caseworker", "supervisor"] });
  if (!guarded.ok) return guarded.response;

  const { id } = await params;
  const parsed = await parseBody(request, noteRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const note = await createNote(guarded.ctx.user, id, parsed.data, requestMeta(request));
    return Response.json(note, { status: 201 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
export const POST = logged(POST_impl);
