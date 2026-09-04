// POST /api/public/handoff-token — contracts §B: HandoffTokenRequest ->
// HandoffTokenResponse 200 (public; errors: validation error, 429). REQ-045.
//
// Issues the SIGNED, 60-minute, BROWSER-HELD hand-off token (FLOW-001): the
// visitor's calculator inputs travel INSIDE the signed token, held in
// sessionStorage client-side — NEVER server-stored for anonymous users (this
// handler creates no DB rows beyond the rate-limit bucket). Signing/verification
// share one implementation: src/lib/services/handoff-token.ts, already consumed
// by POST /api/applications (task-011), which silently ignores expired/tampered
// tokens and creates a plain Draft.
//
// Rate limit: 60/min public-calculator class. CSRF exempt by design — same
// reasoning as the other public calculator endpoints.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { handoffTokenRequestSchema } from "@/lib/schemas/public-tools";
import { createHandoffToken, HANDOFF_TOKEN_DEFAULT_TTL_SECONDS } from "@/lib/services/handoff-token";

async function POST_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const limited = await enforceRateLimit(request, {
    scope: "public-calculator",
    policy: "general",
    account: guarded.ctx.user?.userId ?? null,
  });
  if (limited) return limited;

  const parsed = await parseBody(request, handoffTokenRequestSchema);
  if (!parsed.ok) return parsed.response;

  // contracts §A HandoffTokenResponse { token, expiresAt } — 60-minute TTL (REQ-045).
  const { token, expiresAt } = createHandoffToken(parsed.data, HANDOFF_TOKEN_DEFAULT_TTL_SECONDS);
  return Response.json({ token, expiresAt });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
