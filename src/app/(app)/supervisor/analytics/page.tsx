// AnalyticsDashboard page (contracts §C, task-038, REQ-062) —
// /supervisor/analytics.
//
// Reached from: (app) shell supervisor nav → "Analytics" (nav-sup-analytics);
// frame nav map: sup-applications header → sup-analytics; the pending-approvals
// list here links onward to /staff/applications/:id (staff-app-detail).
//
// Server component inside the (app) route group (top-nav shell). Page-level
// role gate mirrors the API guard: unauthenticated → /sign-in with return
// path; wrong-role → own role home (§4.1.10). GET /api/supervisor/analytics
// enforces the supervisor roleGate authoritatively.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { AnalyticsDashboard } from "@/components/supervisor/analytics/AnalyticsDashboard";

export const metadata: Metadata = { title: "Analytics — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function SupervisorAnalyticsPage() {
  const user = await requireAppSession("/supervisor/analytics");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  return <AnalyticsDashboard />;
}
