// Post-sign-in landing page per role (§C AppShell nav / §G entry screens).
// Single definition shared by the MFA challenge (task-007) and demo login
// (task-008); task-009/044 reuse it for wrong-role page redirects.

import type { UserRole } from "@prisma/client";

export const ROLE_HOME: Record<UserRole, string> = {
  BORROWER: "/dashboard",
  CASEWORKER: "/caseworker/queue",
  SUPERVISOR: "/supervisor",
};
