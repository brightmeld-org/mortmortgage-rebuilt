// DemoDataPage (contracts §C, task-043, REQ-066 / NFR-016 / FLOW-012) —
// /supervisor/demo-data. Seed / Remove Demo Data with progress and run summary.
//
// Navigation path: (app) shell supervisor nav → "Demo Data" link
// (wired by task-044 in AppHeader) → /supervisor/demo-data; the route is also
// directly addressable per the §8 route inventory.
//
// DEMO-MODE GATE: when DEMO_MODE !== "true" this route is ABSENT — notFound()
// renders the standard 404, mirroring the API endpoints' gating (§B
// demo-mode-gated surfaces). Page-level role gate mirrors the API guard:
// unauthenticated → /sign-in with return path; wrong role → own role home.

import type { Metadata } from "next";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { demoModeEnabled } from "@/lib/services/demo-login";
import { DemoDataView } from "@/components/supervisor/DemoDataView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Demo Data — MortMortgage" };

export default async function SupervisorDemoDataPage() {
  // Gate FIRST: with demo mode off this route behaves as if it did not exist.
  if (!demoModeEnabled()) notFound();

  const user = await requireAppSession("/supervisor/demo-data");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  return <DemoDataView />;
}
