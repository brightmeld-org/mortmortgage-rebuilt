// SupervisorApplications page (contracts §C, task-031, REQ-055) — /supervisor.
//
// Reached from: sign-in → role home (SUPERVISOR → /supervisor); (app) shell
// supervisor nav → "All Applications" (nav-sup-applications); the app logo.
// Row click → /staff/applications/:id (frame §sup-applications, §8 route
// inventory).
//
// Server component inside the (app) route group (top-nav shell). Page-level
// role gate mirrors the API guard: unauthenticated → /sign-in with return
// path; wrong-role → own role home (§4.1.10). GET /api/supervisor/applications
// enforces the supervisor roleGate authoritatively.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { SupervisorApplicationsClient } from "@/components/supervisor/SupervisorApplicationsClient";

export const metadata: Metadata = { title: "All Applications — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function SupervisorApplicationsPage() {
  const user = await requireAppSession("/supervisor");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  return <SupervisorApplicationsClient />;
}
