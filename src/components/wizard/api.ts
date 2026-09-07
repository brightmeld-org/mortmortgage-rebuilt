// UrlaWizard (task-016) — client API layer. Every path here is copied from the
// contracts.md §B endpoint table (the ONLY source of truth for API paths).
// State-changing requests carry the session-bound CSRF token from
// GET /api/auth/session (SessionInfo.csrfToken), same pattern as
// src/components/auth/api.ts. Non-2xx bodies are contract ErrorResponse and are
// surfaced verbatim (NFR-025).

import type {
  AddressSuggestion,
  Application,
  BankLinkSession,
  BankLinkTokenResponse,
  BorrowerApplicationRow,
  BorrowerIdentityOwn,
  AppDocument,
  DocumentListResponse,
  InstitutionInfo,
  NotePage,
  SectionSaveResponse,
  SignatureInfo,
  ValidationSummary,
} from "./types";

/** contracts.md §A ErrorResponse — client mirror (exact field names). */
export interface ErrorResponseBody {
  code: string;
  message: string;
  details?: string[];
  requestId?: string;
  currentState?: string;
  allowedTransitions?: string[];
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ErrorResponseBody };

function networkError(): ErrorResponseBody {
  return { code: "network_error", message: "Could not reach the server. Check your connection and try again." };
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

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, { credentials: "same-origin" });
    return await parseResult<T>(response);
  } catch {
    return { ok: false, status: 0, error: networkError() };
  }
}

async function sendJson<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  csrfToken: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-csrf-token": csrfToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    return await parseResult<T>(response);
  } catch {
    return { ok: false, status: 0, error: networkError() };
  }
}

// ---------------------------------------------------------------------------
// Session (CSRF source)
// ---------------------------------------------------------------------------

export interface SessionLite {
  userId: string;
  role: string;
  csrfToken: string;
}

export async function getSessionLite(): Promise<SessionLite | null> {
  const r = await getJson<SessionLite>("/api/auth/session");
  return r.ok ? r.data : null;
}

// ---------------------------------------------------------------------------
// Application + wizard endpoints (§B)
// ---------------------------------------------------------------------------

export function getApplication(id: string) {
  return getJson<Application>(`/api/applications/${id}`);
}

export function getApplicationList() {
  return getJson<{ rows: BorrowerApplicationRow[] }>("/api/applications");
}

export function getValidation(id: string) {
  return getJson<ValidationSummary>(`/api/applications/${id}/validation`);
}

export function getIdentityOwn(id: string, ordinal: number) {
  return getJson<BorrowerIdentityOwn>(`/api/applications/${id}/borrowers/${ordinal}/identity`);
}

export function saveSection(
  id: string,
  section: string,
  csrfToken: string,
  body: Record<string, unknown>,
) {
  return sendJson<SectionSaveResponse>("PUT", `/api/applications/${id}/sections/${section}`, csrfToken, body);
}

export function addCoBorrower(id: string, csrfToken: string) {
  return sendJson<Application>("POST", `/api/applications/${id}/co-borrower`, csrfToken);
}

export function removeCoBorrower(id: string, csrfToken: string) {
  return sendJson<Application>("DELETE", `/api/applications/${id}/co-borrower`, csrfToken);
}

export function postSignature(
  id: string,
  csrfToken: string,
  body: { borrowerId: string; mode: string; imageData?: string; typedName?: string; attestationAccepted: boolean },
) {
  return sendJson<SignatureInfo>("POST", `/api/applications/${id}/signatures`, csrfToken, body);
}

export function postTransition(
  id: string,
  csrfToken: string,
  body: { toState: string; versionStamp: number; note?: string; reason?: string },
) {
  return sendJson<Application>("POST", `/api/applications/${id}/transition`, csrfToken, body);
}

export function getNotes(id: string) {
  return getJson<NotePage>(`/api/applications/${id}/notes`);
}

export interface WorkflowHistoryRow {
  id: string;
  fromState: string;
  toState: string;
  note?: string;
  createdAt: string;
}

export function getWorkflowHistory(id: string) {
  return getJson<{ rows: WorkflowHistoryRow[] }>(`/api/applications/${id}/workflow-history`);
}

// ---------------------------------------------------------------------------
// Documents (§B; upload is multipart — XHR for upload progress)
// ---------------------------------------------------------------------------

export function getDocuments(id: string) {
  return getJson<DocumentListResponse>(`/api/applications/${id}/documents`);
}

/**
 * POST /api/applications/:id/documents — multipart/form-data with parts `file`
 * plus DocumentUploadRequest fields (§B upload transport). XMLHttpRequest is
 * used so the drop zone can render a real upload progress indicator (§4.2.9
 * step 3); the CSRF header rides along like every state-changing call.
 */
export function uploadDocument(
  id: string,
  csrfToken: string,
  file: File,
  documentType: string,
  description: string | undefined,
  onProgress: (pct: number) => void,
): Promise<ApiResult<AppDocument>> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("file", file);
    form.append("documentType", documentType);
    if (description) form.append("description", description);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/applications/${id}/documents`);
    xhr.setRequestHeader("x-csrf-token", csrfToken);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, status: xhr.status, data: body as AppDocument });
      } else if (body && typeof body === "object" && typeof (body as ErrorResponseBody).message === "string") {
        resolve({ ok: false, status: xhr.status, error: body as ErrorResponseBody });
      } else {
        resolve({
          ok: false,
          status: xhr.status,
          error: { code: "upload_failed", message: "The upload failed. Please try again." },
        });
      }
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, error: networkError() });
    xhr.send(form);
  });
}

/**
 * POST /api/documents/:id/versions — replacement upload (§B, REQ-038/AC-17).
 * Same multipart DocumentUploadRequest transport as the initial upload; the
 * server appends a new DocumentVersion (prior versions retained) and returns
 * the updated Document whose current version is the new file. Disallowed-state
 * errors (409) come back as contract ErrorResponse and are surfaced verbatim.
 */
export function uploadDocumentVersion(
  documentId: string,
  csrfToken: string,
  file: File,
  documentType: string,
  description: string | undefined,
  onProgress: (pct: number) => void,
): Promise<ApiResult<AppDocument>> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("file", file);
    form.append("documentType", documentType);
    if (description) form.append("description", description);
    const url = `/api/documents/${documentId}/versions`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("x-csrf-token", csrfToken);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, status: xhr.status, data: body as AppDocument });
      } else if (body && typeof body === "object" && typeof (body as ErrorResponseBody).message === "string") {
        resolve({ ok: false, status: xhr.status, error: body as ErrorResponseBody });
      } else {
        resolve({
          ok: false,
          status: xhr.status,
          error: { code: "upload_failed", message: "The upload failed. Please try again." },
        });
      }
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, error: networkError() });
    xhr.send(form);
  });
}

/**
 * DELETE /api/documents/:id — borrower deletes their own document, Draft only
 * (§4.2.9, REQ-038; BUG-33). Responds 204 with NO body; parseResult short-
 * circuits on 204, so `data` is undefined and `ok` is still true. Non-2xx
 * (403/404/409) comes back as a contract ErrorResponse, surfaced verbatim.
 */
export function deleteDocument(documentId: string, csrfToken: string) {
  return sendJson<void>("DELETE", `/api/documents/${documentId}`, csrfToken);
}

// ---------------------------------------------------------------------------
// Bank linking (§B)
// ---------------------------------------------------------------------------

export function getInstitutions() {
  return getJson<{ rows: InstitutionInfo[] }>("/api/bank-link/institutions");
}

export function postBankLinkAuth(
  id: string,
  csrfToken: string,
  body: { institutionId: string; username: string; password: string },
) {
  return sendJson<BankLinkSession>("POST", `/api/applications/${id}/bank-links`, csrfToken, body);
}

export function postBankLinkImport(id: string, linkId: string, csrfToken: string, accountIds: string[]) {
  return sendJson<Application>("POST", `/api/applications/${id}/bank-links/${linkId}/import`, csrfToken, {
    accountIds,
  });
}

/**
 * DELETE /api/applications/:id/bank-links/:linkId — unlink (§4.2.10, REQ-039;
 * BUG-28). Removes the link token and marks this link's imported asset rows as
 * manual; returns the refreshed §A Application (200). 403 in a non-editable
 * state, 404 for an unknown/already-unlinked link — both surfaced verbatim.
 */
export function deleteBankLink(id: string, linkId: string, csrfToken: string) {
  return sendJson<Application>("DELETE", `/api/applications/${id}/bank-links/${linkId}`, csrfToken);
}

// ---------------------------------------------------------------------------
// Bank linking — token flow (CH-025, INV-054; real mode only)
// ---------------------------------------------------------------------------

/** CH-025 (INV-054): the server-exposed bank-mode flag — mirrors
 *  BANK_MODE_COOKIE in src/middleware.ts. Set to "real" iff BANK_PROVIDER=real;
 *  absent under simulation, so the delivered default reads "simulation". */
const BANK_MODE_COOKIE = "mm_bank_mode";

/**
 * Read the bank-provider mode the server exposed (never key material). The
 * borrower bank-link UI renders the Link-widget flow only when this reports
 * "real"; under simulation the existing institution-picker + credentials form
 * renders unchanged (INV-054).
 */
export function readBankLinkMode(): "simulation" | "real" {
  if (typeof document === "undefined") return "simulation";
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BANK_MODE_COOKIE}=`));
  return entry?.slice(BANK_MODE_COOKIE.length + 1) === "real" ? "real" : "simulation";
}

/**
 * POST /api/applications/:id/bank-links/link-token — the short-lived Link
 * token for the client widget (real mode; 503 not-available under simulation,
 * retryable 503 while the real adapter is unwired — surfaced with Retry).
 */
export function postBankLinkToken(id: string, csrfToken: string) {
  return sendJson<BankLinkTokenResponse>(
    "POST",
    `/api/applications/${id}/bank-links/link-token`,
    csrfToken,
  );
}

/**
 * POST /api/applications/:id/bank-links/exchange — exchange the widget's
 * public token; returns the SAME BankLinkSession shape as the credentials flow
 * (INV-054), so the account-selection + import surface is shared unchanged.
 */
export function postBankLinkExchange(
  id: string,
  csrfToken: string,
  body: { publicToken: string; institutionId?: string; institutionName?: string },
) {
  return sendJson<BankLinkSession>(
    "POST",
    `/api/applications/${id}/bank-links/exchange`,
    csrfToken,
    body,
  );
}

// ---------------------------------------------------------------------------
// Address autocomplete (§B: ?q= min 2 chars; `!!` -> silent empty)
// ---------------------------------------------------------------------------

export async function suggestAddresses(q: string): Promise<AddressSuggestion[]> {
  try {
    // Same-origin relative path; the only dynamic part is a URL-encoded query
    // value (never host/path), built outside the fetch call.
    const suggestUrl = "/api/address/suggest?" + new URLSearchParams({ q }).toString();
    const response = await fetch(suggestUrl, {
      credentials: "same-origin",
    });
    if (!response.ok) return []; // silent degradation to manual entry (REQ-040)
    const body = (await response.json()) as { suggestions?: AddressSuggestion[] };
    return Array.isArray(body.suggestions) ? body.suggestions : [];
  } catch {
    return []; // silent — no error dialog (§4.2.11)
  }
}
