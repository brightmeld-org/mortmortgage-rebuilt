// CaseworkerManagement page (contracts §C, task-033, REQ-063) — /supervisor/caseworkers.
//
// Reached from: (app) shell supervisor nav → "Staff" (nav-sup-staff). Route
// directly addressable at /supervisor/caseworkers (frame §sup-caseworkers,
// requirements §8 route inventory).
//
// Server component inside the (app) route group (top-nav shell). Page-level
// role gate mirrors the API guard: unauthenticated → /sign-in with return
// path; wrong-role → own role home (§4.1.10). The API endpoints enforce the
// supervisor roleGate authoritatively.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { CaseworkerManagement } from "@/components/supervisor/CaseworkerManagement";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Caseworkers — MortMortgage" };

export default async function SupervisorCaseworkersPage() {
  const user = await requireAppSession("/supervisor/caseworkers");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  // currentUserId powers the client-side mirrors of INV-002/INV-003 (own-row
  // Deactivate / Reset-MFA disabled); the server guards remain authoritative.
  return <CaseworkerManagement currentUserId={user.userId} />;
}
