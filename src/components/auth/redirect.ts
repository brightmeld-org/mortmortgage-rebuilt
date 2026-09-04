// Open-redirect defense for the return-to-requested-page flow (task-009).
//
// Only same-origin RELATIVE paths are honored: a valid target starts with a
// single "/" (not "//" or "/\" which browsers treat as protocol-relative), and
// carries no scheme. Anything else — absolute URLs, protocol-relative,
// javascript:, backslash tricks — is rejected and the caller falls back.
//
// Precedence (noted per the build plan): the ORIGINALLY REQUESTED page (the
// ?redirectTo= query param, validated here) wins over the server-provided
// SignInResponse.redirectTo, EXCEPT when the server redirect is itself a flow
// step (MFA pages, verification-pending) or the recovery-code re-enrollment
// prompt (/profile?mfaReenroll=1) — flow steps always run first and the
// requested page is threaded through them as a query param.

/** True only for same-origin relative paths ("/dashboard", "/a/b?c=d"). */
export function isSafeRelativePath(candidate: string | null | undefined): candidate is string {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (!candidate.startsWith("/")) return false;
  // "//host" (protocol-relative) and "/\host" (IE/Chromium backslash quirk).
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return false;
  // Belt-and-suspenders: no scheme separator anywhere before a query/hash.
  const beforeQuery = candidate.split(/[?#]/, 1)[0];
  if (beforeQuery.includes(":") || beforeQuery.includes("\\")) return false;
  return true;
}

/** Validated requested-page path, or null when absent/unsafe. */
export function safeRedirect(candidate: string | null | undefined): string | null {
  return isSafeRelativePath(candidate) ? candidate : null;
}

/** Append ?redirectTo=… to a flow page path when a requested page is present. */
export function withRedirectParam(path: string, redirectTo: string | null): string {
  if (!redirectTo) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}redirectTo=${encodeURIComponent(redirectTo)}`;
}
