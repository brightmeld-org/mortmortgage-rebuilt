// POST /api/admin/demo-data/seed — contracts §B: (no body) -> SeedRunInfo 202
// (supervisor; errors 403, 404, 409). REQ-066 / INT-022 / NFR-016 / ASYNC-006.
//
// DEMO-MODE GATE (§B demo-mode-gated endpoints): when DEMO_MODE !== "true" the
// endpoint is ABSENT — `notFound()` renders the SAME 404 an unknown route
// produces. Gate runs first, exactly as if the file were not deployed (the
// same pattern as POST /api/auth/demo-login).
//
// ASYNC-006 (documented interpretation, see src/lib/services/demo-seed): the
// seed run executes WITHIN the request in one interactive transaction and the
// 202 carries the COMPLETED SeedRunInfo (recordCounts populated). Concurrency
// is global-singleton via a Postgres advisory lock — a concurrent seed or
// removal run returns 409. The audit actor is the triggering Supervisor from
// the session (never a request body).

import { logged } from "@/lib/log";
import { notFound } from "next/navigation";
import { guard } from "@/lib/guard";
import { requestMeta } from "@/lib/http/client-ip";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { demoModeEnabled } from "@/lib/services/demo-login";
import { runDemoSeed, toSeedRunInfo } from "@/lib/services/demo-seed";

async function POST_impl(request: Request): Promise<Response> {
  // Gate FIRST: with demo mode off this handler behaves as if it did not exist.
  if (!demoModeEnabled()) notFound();

  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;
  const meta = requestMeta(request);

  try {
    const { run } = await runDemoSeed({
      userId: user.userId,
      role: user.role,
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return Response.json(toSeedRunInfo(run), { status: 202 });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestId);
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
