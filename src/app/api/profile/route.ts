// GET /api/profile — contracts §B: UserProfile 200 (authenticated-any; 401).
// PUT /api/profile — contracts §B: UpdateProfileRequest -> UserProfile 200
// (authenticated-any; validation error, 401). REQ-041, VR-024..VR-026.
//
// RECORD-LEVEL SCOPING: operates ONLY on the session user's own User row.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, unauthorized } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { updateProfileRequestSchema } from "@/lib/schemas/auth";
import { getProfile, updateProfile } from "@/lib/services/profile";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;

  const profile = await getProfile(guarded.ctx.user.userId);
  if (!profile) return unauthorized(requestIdFrom(request)); // session user row vanished
  return Response.json(profile);
}

async function PUT_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "authenticated-any" });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  const parsed = await parseBody(request, updateProfileRequestSchema);
  if (!parsed.ok) return parsed.response;

  const profile = await updateProfile(
    { userId: user.userId, role: user.role },
    parsed.data,
    requestMeta(request),
  );
  return Response.json(profile);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
export const PUT = logged(PUT_impl);
