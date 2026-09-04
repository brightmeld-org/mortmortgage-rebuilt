// One-click demo logins (task-008). REQ-012 §4.1.3 / NFR-016 / SEC-15.
//
// Signs the caller in as the pre-provisioned demo account for a requested role.
// Reachable ONLY through POST /api/auth/demo-login, which is ABSENT (404) unless
// DEMO_MODE === "true" — this service performs its own belt-and-suspenders
// re-check and refuses to run with demo mode off.
//
// Provisioning is idempotent find-or-create through the identity-provider seam
// (task-008 provision hook): per role one User with isDemo: true, email
// pre-verified, MFA PRE-ENROLLED (§4.1.4 "Demo accounts are pre-enrolled") so
// the issued session is a FULL session immediately — no TOTP challenge blocks
// the one-click flow, consistent with the task-007 demo bypass seam (TOTP
// "000000" for profile-page re-auth flows). The account password is random per
// creation, never returned, never logged, never in any client bundle (SEC-15) —
// demo sign-in never touches the credential path.
//
// First-click reliability (§4.1.3): sign-in counters/lockout are reset on every
// demo login (a stranger hammering the demo email's credential form must not
// brick the demo), and the route overwrites any stale session cookie with the
// fresh one, so the flow works immediately after a sign-out.

import { prisma } from "@/lib/prisma";
import { ROLE_HOME } from "@/lib/role-home";
import type { UserRole } from "@prisma/client";
import type { RequestMeta } from "@/lib/services/auth-account";
import { getIdentityProvider } from "@/lib/services/idp";
import { createSession, type IssuedSession } from "@/lib/services/session";

import { DEMO_ROLE_SCHEMA_VALUES } from "@/lib/schemas/auth";

/** contracts.json enums.DemoRole — verbatim literals (single source: schema, VR-021). */
export type DemoRoleValue = (typeof DEMO_ROLE_SCHEMA_VALUES)[number];

/**
 * The pre-provisioned demo account per role (§4.1.3 "at least one per role").
 * Deterministic identities so the §4.6.12 demo seed (task-043) can stage data
 * against them; synthetic reserved-domain addresses (never routable).
 */
export const DEMO_ACCOUNTS: Record<
  DemoRoleValue,
  { email: string; role: UserRole; firstName: string; lastName: string }
> = {
  borrower: { email: "demo.borrower@demo.example", role: "BORROWER", firstName: "Demo", lastName: "Borrower" },
  caseworker: { email: "demo.caseworker@demo.example", role: "CASEWORKER", firstName: "Demo", lastName: "Caseworker" },
  supervisor: { email: "demo.supervisor@demo.example", role: "SUPERVISOR", firstName: "Demo", lastName: "Supervisor" },
};

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}

export interface DemoLoginResult {
  issued: IssuedSession;
  redirectTo: string;
}

/**
 * Provision (find-or-create, concurrency-safe) the demo account for `role` and
 * issue a FULL session for it. Throws only on demo mode off (route bug) or
 * infrastructure failure.
 */
export async function demoLogin(role: DemoRoleValue, meta: RequestMeta): Promise<DemoLoginResult> {
  if (!demoModeEnabled()) {
    throw new Error("demo login invoked with DEMO_MODE off — route gating failed");
  }

  const spec = DEMO_ACCOUNTS[role];
  const provisioned = await getIdentityProvider().provision(
    {
      email: spec.email,
      role: spec.role,
      firstName: spec.firstName,
      lastName: spec.lastName,
      emailVerified: true,
      isDemo: true,
      mfaPreEnrolled: true,
    },
    meta,
  );

  const issued = await prisma.$transaction(async (tx) => {
    // Mirror the credential sign-in success path (task-006): counters reset,
    // lockout cleared, lastSignInAt stamped — then the session, in one tx.
    await tx.user.update({
      where: { id: provisioned.userId },
      data: { failedLoginCount: 0, lockedUntil: null, lastSignInAt: new Date() },
    });
    return createSession(tx, {
      userId: provisioned.userId,
      mfaPending: false, // pre-enrolled demo account — full session immediately
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { issued, redirectTo: ROLE_HOME[spec.role] };
}
