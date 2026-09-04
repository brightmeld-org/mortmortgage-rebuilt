// POST /api/test/fixtures — sanctioned TEST-ONLY fixture seam
// (task-046/test-fixtures-contract.md; profile Independent Test Suite Fixture
// Rules). NOT a product surface: it ages existing rows and flips demo-gated
// runtime toggles so time- and environment-dependent §7.7 states become
// reachable. Consumed exclusively by task-046/suites/zz-seam-*.test.ts.
//
// DEMO-MODE GATE (mirrors src/app/api/auth/demo-login): the route is ABSENT —
// `notFound()` renders the SAME 404 an unknown route produces — unless
// NODE_ENV !== "production" AND DEMO_MODE === "true". The gate runs before
// everything else, exactly as if the file were not deployed (src/middleware.ts
// additionally rewrites the path to an unknown route when the gate is closed).
// When on, the seam is reachable without authentication and without a CSRF
// token, per the seam contract — acceptable ONLY because the route cannot
// exist in a production build.
//
// Responses: 200 { ok: true, ...op fields }; rejections use the standard
// ErrorResponse shape — 400 (unknown op / unsatisfiable request, via the
// strict schema and HttpProblem) or 404 (unknown target). Never 500 for
// contract-defined rejections.

import { z } from "zod";
import { logged } from "@/lib/log";
import { notFound } from "next/navigation";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";
import { parseBody, strictSchema } from "@/lib/http/validation";
import {
  ageApplication,
  ageDocumentJob,
  ageSession,
  ageToken,
  backdateSuspension,
  backdateWorkflowState,
  failNextAuditWrite,
  runStuckJobReconciler,
  setSimulationFault,
} from "@/lib/services/test-fixtures";

/** Same gate as the demo-login family, plus the non-production requirement of the seam contract. */
function fixtureSeamEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.DEMO_MODE === "true";
}

// ---------------------------------------------------------------------------
// Request schema — one strict object per op (unknown ops and unknown fields
// both land on the contract 400 "validation error")
// ---------------------------------------------------------------------------

const positiveFinite = z.number().finite().positive();

const testFixtureRequestSchema = z.discriminatedUnion("op", [
  strictSchema({
    op: z.literal("backdate-workflow-state"),
    applicationId: z.string().uuid(),
    hours: positiveFinite,
  }),
  strictSchema({
    op: z.literal("backdate-suspension"),
    applicationId: z.string().uuid(),
    hours: positiveFinite,
  }),
  strictSchema({
    op: z.literal("age-document-job"),
    documentId: z.string().uuid(),
    minutes: positiveFinite,
    forceProcessing: z.boolean().optional(),
    reconcile: z.boolean().optional(),
  }),
  strictSchema({
    op: z.literal("run-stuck-job-reconciler"),
  }),
  strictSchema({
    op: z.literal("age-application"),
    applicationId: z.string().uuid(),
    days: positiveFinite,
  }),
  strictSchema({
    op: z.literal("age-token"),
    kind: z.enum(["email-verification", "password-reset", "invitation", "email-change"]),
    email: z.string().min(1),
    minutes: positiveFinite,
  }),
  strictSchema({
    op: z.literal("age-session"),
    email: z.string().min(1),
    idleMinutes: positiveFinite.optional(),
    absoluteHours: positiveFinite.optional(),
  }),
  strictSchema({
    op: z.literal("set-simulation-fault"),
    provider: z.enum(["credit", "income", "avm", "aus", "pricing", "ocr"]),
    mode: z.enum(["none", "slow", "timeout", "unavailable", "partial", "invalid-response"]),
  }),
  strictSchema({
    op: z.literal("fail-next-audit-write"),
    armed: z.boolean(),
  }),
]);

type TestFixtureRequest = z.infer<typeof testFixtureRequestSchema>;

async function runOp(body: TestFixtureRequest): Promise<Record<string, unknown>> {
  switch (body.op) {
    case "backdate-workflow-state":
      return backdateWorkflowState(body.applicationId, body.hours);
    case "backdate-suspension":
      return backdateSuspension(body.applicationId, body.hours);
    case "age-document-job":
      return ageDocumentJob(
        body.documentId,
        body.minutes,
        body.forceProcessing ?? false,
        body.reconcile ?? false,
      );
    case "run-stuck-job-reconciler":
      return runStuckJobReconciler();
    case "age-application":
      return ageApplication(body.applicationId, body.days);
    case "age-token":
      return ageToken(body.kind, body.email, body.minutes);
    case "age-session":
      return ageSession(body.email, body.idleMinutes, body.absoluteHours);
    case "set-simulation-fault":
      return setSimulationFault(body.provider, body.mode);
    case "fail-next-audit-write":
      return failNextAuditWrite(body.armed);
  }
}

async function POST_impl(request: Request): Promise<Response> {
  // Gate FIRST: with the seam off this handler behaves as if it did not exist.
  if (!fixtureSeamEnabled()) notFound();

  // Public + CSRF-exempt per the seam contract (test seam, absent in production).
  const guarded = await guard(request, { roleGate: "public", csrf: false });
  if (!guarded.ok) return guarded.response;

  const parsed = await parseBody(request, testFixtureRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await runOp(parsed.data);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof HttpProblem) return problemResponse(err, requestIdFrom(request));
    throw err;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const POST = logged(POST_impl);
