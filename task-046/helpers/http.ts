/**
 * Shared HTTP client for the task-046 §7.7 suite.
 *
 * Every request goes through the running app over HTTP — no Prisma, no schema
 * knowledge. Only paths present in the contracts.json §B endpoint table are ever
 * called (see helpers/contract.ts for the enumeration used by the coverage proofs).
 */

export const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3083";

/** A signed-in session: the cookie plus the session-bound synchronizer token (SEC-3). */
export interface Session {
  cookie: string;
  csrfToken: string;
  userId: string;
  email: string;
  role: "BORROWER" | "CASEWORKER" | "SUPERVISOR";
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export interface RequestOptions {
  session?: Session | null;
  body?: unknown;
  /** multipart/form-data body; when set, `body` is ignored. */
  form?: FormData;
  /** Extra headers merged last. */
  headers?: Record<string, string>;
  /** Omit the CSRF header even on a state-changing method (negative CSRF tests). */
  omitCsrf?: boolean;
  /** Do not retry on 429 — used by the rate-limit persistence suite. */
  noRateLimitRetry?: boolean;
  /**
   * Retry this many times on a 5xx. Fixture setup only — assertions never use it, so a
   * genuine server fault still fails the test that is asserting on it.
   */
  retryOn5xx?: number;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parse<T>(text: string, contentType: string | null): T {
  if (text.length === 0) return undefined as T;
  if (contentType && contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
  return text as unknown as T;
}

/**
 * Issue a request against the running app. Honors Retry-After on 429 (the auth
 * endpoints are rate-limited by contract) unless the caller opts out.
 */
export async function api<T = unknown>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const url = buildUrl(path);
  const maxAttempts = Math.max(options.noRateLimitRetry ? 1 : 3, (options.retryOn5xx ?? 0) + 1);

  for (let attempt = 1; ; attempt += 1) {
    const headers: Record<string, string> = {};
    if (options.session) {
      headers["Cookie"] = options.session.cookie;
      if (STATE_CHANGING.has(method) && !options.omitCsrf) {
        headers["x-csrf-token"] = options.session.csrfToken;
      }
    }
    let payload: BodyInit | undefined;
    if (options.form) {
      payload = options.form;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(options.body);
    }
    Object.assign(headers, options.headers ?? {});

    const response = await fetch(url, { method, headers, body: payload, redirect: "manual" });
    const text = await response.text();

    if (response.status >= 500 && options.retryOn5xx && attempt <= options.retryOn5xx) {
      await sleep(1500);
      continue;
    }

    if (response.status === 429 && attempt < maxAttempts && !options.noRateLimitRetry) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      const waitMs = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 5000);
      await sleep(waitMs);
      continue;
    }

    return {
      status: response.status,
      body: parse<T>(text, response.headers.get("content-type")),
      text,
      headers: response.headers,
    };
  }
}

export const GET = <T = unknown>(path: string, options: RequestOptions = {}) => api<T>("GET", path, options);
export const POST = <T = unknown>(path: string, options: RequestOptions = {}) => api<T>("POST", path, options);
export const PUT = <T = unknown>(path: string, options: RequestOptions = {}) => api<T>("PUT", path, options);
export const PATCH = <T = unknown>(path: string, options: RequestOptions = {}) => api<T>("PATCH", path, options);
export const DEL = <T = unknown>(path: string, options: RequestOptions = {}) => api<T>("DELETE", path, options);

/** Shared ErrorResponse shape (§B: every non-2xx body). */
export interface ErrorResponse {
  code: string;
  message: string;
  details?: string[];
  requestId?: string;
  currentState?: string;
  allowedTransitions?: string[];
}

/** Throws with the server's message attached — turns setup failures into readable output. */
export function expectOk<T>(result: ApiResult<T>, what: string, ...accepted: number[]): T {
  const allowed = accepted.length > 0 ? accepted : [200, 201, 202, 204];
  if (!allowed.includes(result.status)) {
    throw new Error(`${what}: expected ${allowed.join("/")} but got ${result.status} — ${result.text.slice(0, 600)}`);
  }
  return result.body;
}
