// SystemStatusPage (contracts §C, task-045, NFR-027 / INT-001) —
// /supervisor/system. Background job metrics, integration modes, demo-mode
// indicator.
//
// Navigation path: (app) shell supervisor nav → "System Status" link
// (wired by task-044 in AppHeader) → /supervisor/system; the route is also
// directly addressable per the §8 route inventory.
//
// Page-level role gate mirrors the API guard: unauthenticated → /sign-in with
// return path; wrong role → own role home. NOT demo-mode-gated — observability
// is a production surface.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { SystemStatusView } from "@/components/supervisor/SystemStatusView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "System Status — MortMortgage" };

export default async function SupervisorSystemStatusPage() {
  const user = await requireAppSession("/supervisor/system");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  return <SystemStatusView />;
}
