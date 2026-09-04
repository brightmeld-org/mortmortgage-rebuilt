// Client-side API access for the staff application detail surface (task-029).
// Every path is copied from the contracts §B endpoint table. Error bodies are
// the contract ErrorResponse and are surfaced VERBATIM (NFR-025).
//
// Reuses the borrower client helpers (same CSRF synchronizer-token pattern);
// adds the PATCH verb needed by PATCH /api/documents/:id/status.

import {
  freshCsrf,
  getJson,
  postWithCsrf,
  type ApiResult,
  type ErrorResponseBody,
} from "@/components/borrower/api";

export { getJson, postWithCsrf };
export type { ApiResult, ErrorResponseBody };

/**
 * contracts §A ErrorResponse — currentState/allowedTransitions appear only on
 * workflow 409s (the auth mirror omits them; the staff surface renders them).
 */
export type WorkflowErrorBody = ErrorResponseBody & {
  currentState?: string;
  allowedTransitions?: string[];
};

const NO_SESSION_ERROR: ErrorResponseBody = {
  code: "unauthorized",
  message: "Your session has expired. Sign in again to continue.",
};

/** PATCH JSON with a freshly-read CSRF token (document status actions). */
export async function patchWithCsrf<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const csrf = await freshCsrf();
  if (!csrf) return { ok: false, status: 401, error: NO_SESSION_ERROR };
  try {
    const response = await fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) return { ok: true, status: response.status, data: parsed as T };
    if (parsed && typeof parsed === "object" && typeof (parsed as ErrorResponseBody).message === "string") {
      return { ok: false, status: response.status, error: parsed as ErrorResponseBody };
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
