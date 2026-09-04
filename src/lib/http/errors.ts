// ErrorResponse builders — the single error egress shape for the entire project.
//
// Contract: contracts.md §A `ErrorResponse { code, message, details?, requestId?,
// currentState?, allowedTransitions? }` (WF-047, NFR-027). Every non-2xx JSON body in
// the app MUST be produced by this module: guard, CSRF, validation, pagination,
// rate limiting (middleware builds the same shape inline — see src/middleware.ts,
// which cannot import Node-only modules), and every route handler.
//
// `currentState` / `allowedTransitions` appear only on workflow 409s (task-019/020).
//
// NOTE: the contract does not enumerate `code` literals — it only fixes the field as a
// string. The stable machine codes below are this build's convention; keep them
// consistent across increments.
//
// This module is intentionally dependency-free (no prisma, no next/*) so it stays
// importable from any runtime, including edge-adjacent unit scripts.

/** contracts.md §A ErrorResponse — exact field names. */
export interface ErrorResponse {
  code: string;
  message: string;
  details?: string[];
  requestId?: string;
  /** WorkflowState machine name — present on workflow 409s only. */
  currentState?: string;
  /** toState machine names allowed from currentState — workflow 409s only. */
  allowedTransitions?: string[];
}

/** Stable machine codes used across the build (convention — see module header). */
export const ERROR_CODES = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  csrfInvalid: "csrf_invalid",
  notFound: "not_found",
  validationError: "validation_error",
  conflict: "conflict",
  rateLimited: "rate_limited",
  internal: "internal_error",
} as const;

export interface ErrorOptions {
  details?: string[];
  requestId?: string;
  currentState?: string;
  allowedTransitions?: string[];
}

/** Build the ErrorResponse body object (no Response wrapper). */
export function errorBody(code: string, message: string, opts: ErrorOptions = {}): ErrorResponse {
  const body: ErrorResponse = { code, message };
  if (opts.details !== undefined) body.details = opts.details;
  if (opts.requestId !== undefined) body.requestId = opts.requestId;
  if (opts.currentState !== undefined) body.currentState = opts.currentState;
  if (opts.allowedTransitions !== undefined) body.allowedTransitions = opts.allowedTransitions;
  return body;
}

/** Build a JSON Response carrying the contract ErrorResponse shape. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  opts: ErrorOptions = {},
): Response {
  return Response.json(errorBody(code, message, opts), { status });
}

// --- Convenience builders (status + code fixed; message overridable) ---

export function unauthorized(requestId?: string, message = "Authentication required"): Response {
  return errorResponse(401, ERROR_CODES.unauthorized, message, { requestId });
}

export function forbidden(requestId?: string, message = "You do not have permission to perform this action"): Response {
  return errorResponse(403, ERROR_CODES.forbidden, message, { requestId });
}

export function csrfFailure(requestId?: string, message = "Missing or invalid CSRF token"): Response {
  return errorResponse(403, ERROR_CODES.csrfInvalid, message, { requestId });
}

export function notFound(requestId?: string, message = "Not found"): Response {
  return errorResponse(404, ERROR_CODES.notFound, message, { requestId });
}

/** 400 with `details[]` listing field errors — the contract's "validation error" (SEC-18). */
export function validationError(details: string[], requestId?: string, message = "Request validation failed"): Response {
  return errorResponse(400, ERROR_CODES.validationError, message, { details, requestId });
}

export function conflict(message: string, opts: ErrorOptions = {}): Response {
  return errorResponse(409, ERROR_CODES.conflict, message, opts);
}

export function rateLimited(requestId?: string, message = "Too many requests — please try again later"): Response {
  return errorResponse(429, ERROR_CODES.rateLimited, message, { requestId });
}

/**
 * Extract the request-correlation id set by src/middleware.ts (`x-request-id`),
 * so error bodies can echo it (requirements §7.6).
 */
export function requestIdFrom(request: Request): string | undefined {
  return request.headers.get("x-request-id") ?? undefined;
}

// ---------------------------------------------------------------------------
// HttpProblem — typed service-layer failure carrying its contract ErrorResponse
// ---------------------------------------------------------------------------

/**
 * Thrown by service functions for contract-defined failures (403/404/409/400...).
 * Route handlers catch it and emit the single ErrorResponse shape via
 * `problemResponse`. Keeps services HTTP-aware only through this one seam.
 */
export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly opts: ErrorOptions;

  constructor(status: number, code: string, message: string, opts: ErrorOptions = {}) {
    super(message);
    this.name = "HttpProblem";
    this.status = status;
    this.code = code;
    this.opts = opts;
  }
}

/** Build the Response for a caught HttpProblem, echoing the request id. */
export function problemResponse(problem: HttpProblem, requestId?: string): Response {
  return errorResponse(problem.status, problem.code, problem.message, {
    ...problem.opts,
    requestId: problem.opts.requestId ?? requestId,
  });
}
