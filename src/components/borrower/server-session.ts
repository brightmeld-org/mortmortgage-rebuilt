// Server-side session resolution for (app) pages/layout (task-017).
// Same session source as the API guard (src/lib/auth.ts) — resolved from the
// request cookies via next/headers. SERVER COMPONENTS ONLY (imports Prisma).

import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/role-home";

/** Resolve the session from request cookies; null when signed out/expired. */
export async function resolveAppSession(): Promise<SessionUser | null> {
  const requestHeaders = await headers();
  const cookieCarrier = new Request("http://internal/app", {
    headers: { cookie: requestHeaders.get("cookie") ?? "" },
  });
  return getSessionUser(cookieCarrier);
}

/**
 * Session gate for (app) pages: unauthenticated (incl. dead cookie — the
 * middleware only sees cookie PRESENCE) → /sign-in with the return path.
 */
export async function requireAppSession(returnTo: string): Promise<SessionUser> {
  const user = await resolveAppSession();
  if (!user) {
    redirect(`/sign-in?redirectTo=${encodeURIComponent(returnTo)}` as Route);
  }
  return user;
}

/**
 * Borrower-only page gate: wrong-role users are redirected to their own role
 * home (requirements §4.1.10).
 */
export async function requireBorrowerSession(returnTo: string): Promise<SessionUser> {
  const user = await requireAppSession(returnTo);
  if (user.role !== "BORROWER") {
    redirect(ROLE_HOME[user.role] as Route);
  }
  return user;
}
