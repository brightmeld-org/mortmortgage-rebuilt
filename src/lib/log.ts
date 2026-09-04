// Structured JSON logging (task-045 — NFR-027, §7.6).
//
// ONE log helper for the whole system — web route handlers AND the src/worker
// process emit through these functions. Every line is single-line JSON on
// stdout with the contract field order:
//   { timestamp, level, requestId, userId, role, route, status, duration }
// plus event-specific fields. Errors carry `stack`.
//
// PII POSTURE (BLOCKING — §7.6 "no PII, tokens, secrets, or file contents"):
//   - identity in request lines is userId + role ONLY — never emails, names,
//     SSNs, passwords, or session tokens;
//   - `route` is the URL *pathname* only (never the query string, which may
//     carry verification/reset tokens);
//   - callers must never pass request/response bodies or file contents into
//     `fields`.
//
// REQUEST LOGGING CHOKE POINT: the app has no single runtime wrapper around
// route handlers (each route.ts exports its handlers directly and calls the
// shared guard internally), so `logged()` below IS the choke point — every
// handler in src/app/api/**/route.ts is exported through it. It measures
// duration, reads the final status, echoes the middleware-issued request id,
// and converts any *escaped* throw into the contract 500 ErrorResponse (with
// requestId echoed and the stack logged) so no error path leaves the app
// without a request id (§7.6).
//
// The guard (src/lib/guard.ts) stashes the authenticated identity per Request
// via `stashRequestUser` (WeakMap — the handler passes the same Request object
// it received), which is how the completion line knows userId/role without a
// second session lookup.

import { ERROR_CODES, errorResponse, HttpProblem, problemResponse, requestIdFrom } from "@/lib/http/errors";

export type LogLevel = "info" | "warn" | "error";

/** Emit one single-line JSON log record to stdout. */
export function logLine(level: LogLevel, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, ...fields })}\n`);
}

/** Emit an error-level record carrying the error message and stack trace (§7.6). */
export function logError(event: string, err: unknown, fields: Record<string, unknown> = {}): void {
  const error = err instanceof Error ? err : new Error(String(err));
  logLine("error", { event, ...fields, error: error.message, stack: error.stack ?? null });
}

// ---------------------------------------------------------------------------
// Per-request identity stash (populated by the shared guard)
// ---------------------------------------------------------------------------

interface RequestIdentity {
  userId: string;
  role: string;
}

const requestIdentities = new WeakMap<Request, RequestIdentity>();

/** Called by src/lib/guard.ts once the session is resolved (userId/role only — no PII). */
export function stashRequestUser(request: Request, identity: RequestIdentity): void {
  requestIdentities.set(request, identity);
}

// ---------------------------------------------------------------------------
// Route-handler wrapper — the single request-logging egress (NFR-027)
// ---------------------------------------------------------------------------

type AnyHandler = (...args: never[]) => Promise<Response>;

/**
 * Wrap a route handler: one structured JSON line per API request
 * `{ timestamp, level, requestId, userId, role, route, method, status, duration }`,
 * stack-trace logging on escaped errors, and a guaranteed contract-shaped 500
 * (requestId echoed) when a handler throws past its own error handling.
 */
export function logged<T extends AnyHandler>(handler: T): T {
  const wrapped = async (...args: unknown[]): Promise<Response> => {
    const request = args[0] instanceof Request ? (args[0] as Request) : undefined;
    const started = performance.now();
    // Pathname ONLY — query strings can carry tokens (§7.6).
    const route = request ? new URL(request.url).pathname : "unknown";
    const method = request?.method ?? "GET";
    const requestId = request ? requestIdFrom(request) : undefined;

    const complete = (status: number, level: LogLevel): void => {
      const identity = request ? requestIdentities.get(request) : undefined;
      logLine(level, {
        requestId: requestId ?? null,
        userId: identity?.userId ?? null,
        role: identity?.role ?? null,
        route,
        method,
        status,
        duration: Math.round(performance.now() - started),
      });
    };

    try {
      const response = await (handler as unknown as (...a: unknown[]) => Promise<Response>)(...args);
      complete(response.status, response.status >= 500 ? "error" : "info");
      return response;
    } catch (err) {
      // Next.js signals `notFound()` and `redirect()` by THROWING a plain Error
      // carrying a `digest` string ("NEXT_HTTP_ERROR_FALLBACK;404", "NEXT_REDIRECT;...").
      // The framework catches those at the route boundary and turns them into the
      // real 404/redirect. Because this wrapper sits INSIDE that boundary, swallowing
      // them would flatten a deliberate `notFound()` into a 500 — which is exactly
      // what the four DEMO_MODE/fixture-gated routes rely on to be ABSENT rather
      // than merely erroring when their seam is disabled. Re-throw so Next sees it.
      if (
        typeof err === "object" &&
        err !== null &&
        typeof (err as { digest?: unknown }).digest === "string" &&
        (err as { digest: string }).digest.startsWith("NEXT_")
      ) {
        throw err;
      }
      if (err instanceof HttpProblem) {
        // A contract failure that escaped its route's own handling — still egress
        // as the single ErrorResponse shape with the request id echoed.
        const response = problemResponse(err, requestId);
        complete(response.status, "warn");
        return response;
      }
      logError("unhandled-route-error", err, { requestId: requestId ?? null, route, method });
      complete(500, "error");
      return errorResponse(500, ERROR_CODES.internal, "An unexpected error occurred", { requestId });
    }
  };
  return wrapped as unknown as T;
}
