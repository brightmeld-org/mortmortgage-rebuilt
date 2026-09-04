// Client-side API access for the borrower surfaces (task-017).
//
// Every path here is copied from the contracts §B endpoint table — the ONLY
// source of truth for API paths. Error bodies are the contract ErrorResponse
// and their message/details are surfaced VERBATIM (NFR-025).
//
// CSRF: state-changing requests carry x-csrf-token from GET /api/auth/session
// (SessionInfo.csrfToken) — same pattern as src/components/auth/api.ts.

import {
  getSession,
  postJsonWithCsrf,
  type ApiResult,
  type ErrorResponseBody,
  type SessionInfo,
} from "@/components/auth/api";
import type { ApplicationWire } from "./types";

export type { ApiResult, ErrorResponseBody, SessionInfo };
export { getSession };

/** GET a JSON §B endpoint with the session cookie. */
export async function getJson<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, { credentials: "same-origin" });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.ok) return { ok: true, status: response.status, data: body as T };
    if (body && typeof body === "object" && typeof (body as ErrorResponseBody).message === "string") {
      return { ok: false, status: response.status, error: body as ErrorResponseBody };
    }
    return {
      ok: false,
      status: response.status,
      error: { code: "unavailable", message: "This service is not available right now. Please try again later." },
    };
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: "network_error", message: "Could not reach the server. Check your connection and try again." },
    };
  }
}

/** Fetch a fresh CSRF token (session-bound synchronizer token — SEC-3). */
export async function freshCsrf(): Promise<string | null> {
  const session = await getSession();
  return session?.csrfToken ?? null;
}

const NO_SESSION_ERROR: ErrorResponseBody = {
  code: "unauthorized",
  message: "Your session has expired. Sign in again to continue.",
};

/** POST JSON with a freshly-read CSRF token. */
export async function postWithCsrf<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const csrf = await freshCsrf();
  if (!csrf) return { ok: false, status: 401, error: NO_SESSION_ERROR };
  return postJsonWithCsrf<T>(path, csrf, body);
}

/** PUT JSON with CSRF (profile + notification-preference updates). */
export async function putWithCsrf<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const csrf = await freshCsrf();
  if (!csrf) return { ok: false, status: 401, error: NO_SESSION_ERROR };
  try {
    const response = await fetch(path, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
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

/** DELETE with CSRF (draft deletion). */
export async function deleteWithCsrf<T>(path: string): Promise<ApiResult<T>> {
  const csrf = await freshCsrf();
  if (!csrf) return { ok: false, status: 401, error: NO_SESSION_ERROR };
  try {
    const response = await fetch(path, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf },
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

/** POST multipart/form-data with CSRF (document uploads — §B upload transport). */
export async function postMultipartWithCsrf<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  const csrf = await freshCsrf();
  if (!csrf) return { ok: false, status: 401, error: NO_SESSION_ERROR };
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      body: form,
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

async function parseResult<T>(response: Response): Promise<ApiResult<T>> {
  if (response.status === 204) return { ok: true, status: 204, data: undefined as T };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) return { ok: true, status: response.status, data: body as T };
  if (body && typeof body === "object" && typeof (body as ErrorResponseBody).message === "string") {
    return { ok: false, status: response.status, error: body as ErrorResponseBody };
  }
  return {
    ok: false,
    status: response.status,
    error: { code: "unavailable", message: "This service is not available right now. Please try again later." },
  };
}

// ---------------------------------------------------------------------------
// Borrower workflow actions (POST /api/applications/:id/transition)
// ---------------------------------------------------------------------------

/**
 * Execute a borrower transition. The endpoint requires the CURRENT
 * versionStamp (§A optimistic concurrency: captured from the most recent GET,
 * never cached across reloads) — so this helper always re-reads the
 * application first, then posts the transition with the fresh stamp.
 */
export async function borrowerTransition(
  applicationId: string,
  toState: "withdrawn" | "declined_by_borrower",
  reason?: string,
): Promise<ApiResult<ApplicationWire>> {
  const current = await getJson<ApplicationWire>(`/api/applications/${applicationId}`);
  if (!current.ok) return current;
  const body: Record<string, unknown> = {
    toState,
    versionStamp: current.data.versionStamp,
  };
  const trimmed = reason?.trim();
  if (trimmed) body.reason = trimmed;
  return postWithCsrf<ApplicationWire>(`/api/applications/${applicationId}/transition`, body);
}
