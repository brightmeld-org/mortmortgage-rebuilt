// Client-side API helpers for the AuthPages suite (task-009).
//
// Every call funnels through postJson/getJson so error handling is uniform:
// non-2xx JSON bodies are parsed as the contract ErrorResponse
// { code, message, details?, ... } and the SERVER text is surfaced verbatim
// (build rule: render server messages exactly — never rewrite them). Non-JSON
// failures (e.g. the not-yet-built accept-invitation backend 404ing with an
// HTML page) degrade to a typed "unavailable" result instead of throwing.

/** contracts.md §A ErrorResponse — client mirror (exact field names). */
export interface ErrorResponseBody {
  code: string;
  message: string;
  details?: string[];
  requestId?: string;
}

/** contracts.md §A SessionInfo — client mirror (exact field names). */
export interface SessionInfo {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "BORROWER" | "CASEWORKER" | "SUPERVISOR";
  isDemo?: boolean;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  csrfToken: string;
}

/** contracts.md §A SignInResponse — status literals verbatim from enums.SignInStatus. */
export interface SignInResponse {
  status: "signed-in" | "mfa-required" | "mfa-enrollment-required" | "verification-pending";
  redirectTo?: string;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ErrorResponseBody };

/** Fallback body when a failure response carries no parseable JSON. */
function unavailableError(): ErrorResponseBody {
  return {
    code: "unavailable",
    message: "This service is not available right now. Please try again later.",
  };
}

async function parseResult<T>(response: Response): Promise<ApiResult<T>> {
  if (response.status === 204) {
    return { ok: true, status: 204, data: undefined as T };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    return { ok: true, status: response.status, data: body as T };
  }
  if (body && typeof body === "object" && typeof (body as ErrorResponseBody).message === "string") {
    return { ok: false, status: response.status, error: body as ErrorResponseBody };
  }
  return { ok: false, status: response.status, error: unavailableError() };
}

/** POST a JSON body (public auth endpoints — no CSRF header by design). */
export async function postJson<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    return await parseResult<T>(response);
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: "network_error", message: "Could not reach the server. Check your connection and try again." },
    };
  }
}

/**
 * POST with the session-bound CSRF token (state-changing AUTHENTICATED calls,
 * e.g. resend-verification). Token source: GET /api/auth/session →
 * SessionInfo.csrfToken; header name from src/lib/csrf.ts (x-csrf-token).
 */
export async function postJsonWithCsrf<T>(
  path: string,
  csrfToken: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-csrf-token": csrfToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    return await parseResult<T>(response);
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: "network_error", message: "Could not reach the server. Check your connection and try again." },
    };
  }
}

/** GET /api/auth/session — null when signed out (401) or unreachable. */
export async function getSession(): Promise<SessionInfo | null> {
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!response.ok) return null;
    return (await response.json()) as SessionInfo;
  } catch {
    return null;
  }
}

/**
 * Flatten an ErrorResponse for display: the server's message verbatim, and
 * details[] entries verbatim as list items (empty when absent).
 */
export function errorLines(error: ErrorResponseBody): { message: string; details: string[] } {
  return { message: error.message, details: error.details ?? [] };
}
