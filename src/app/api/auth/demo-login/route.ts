// POST /api/auth/demo-login — contracts §B: DemoLoginRequest -> SignInResponse
// 200 (public; errors: 404, 429, validation error). REQ-012 §4.1.3 / NFR-016 /
// NFR-012 / SEC-15 / VR-021.
//
// DEMO-MODE GATE (§B demo-mode-gated endpoints): when DEMO_MODE !== "true" the
// endpoint is ABSENT — `notFound()` renders the SAME 404 an unknown route
// produces (not a JSON 403/404 that would reveal the route exists). The gate
// runs before everything else, exactly as if the file were not deployed.
//
// When on: provisions (find-or-create, race-safe) the demo account for the
// requested role and issues a FULL session immediately (pre-enrolled MFA — no
// TOTP challenge, §4.1.4). Rate-limited on the §4.1.9 auth policy, keyed by the
// demo account + client IP. CSRF exempt by design (public unauthenticated auth
// endpoint — src/lib/csrf.ts module header); the fresh Set-Cookie overwrites any
// stale cookie so the button works first-click right after a sign-out (§4.1.3).
// No password material exists in this flow at all (SEC-15).

import { logged } from "@/lib/log";
import { notFound } from "next/navigation";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestMeta } from "@/lib/http/client-ip";
import { demoLoginRequestSchema } from "@/lib/schemas/auth";
import { DEMO_ACCOUNTS, demoLogin, demoModeEnabled } from "@/lib/services/demo-login";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { sessionCookieHeader } from "@/lib/services/session";

async function POST_impl(request: Request): Promise<Response> {
  // Gate FIRST: with demo mode off this handler behaves as if it did not exist.
  if (!demoModeEnabled()) notFound();

  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, demoLoginRequestSchema); // VR-021 strict
  if (!parsed.ok) return parsed.response;

  // §4.1.9 auth-list rate limit, keyed demo-account + client IP (NFR-012).
  const limited = await enforceRateLimit(request, {
    scope: "demo-login",
    policy: "auth",
    account: DEMO_ACCOUNTS[parsed.data.role].email,
  });
  if (limited) return limited;

  const result = await demoLogin(parsed.data.role, requestMeta(request));

  // contracts §A SignInResponse — status literal verbatim from enums.SignInStatus.
  return Response.json(
    { status: "signed-in", redirectTo: result.redirectTo },
    {
      headers: {
        "set-cookie": sessionCookieHeader(result.issued.token, result.issued.maxAgeSeconds),
      },
    },
  );
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
