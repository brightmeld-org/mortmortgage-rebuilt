// /supervisor/exports — global compliance exports (task-044, RFP §8 "Exports",
// §4.9.4 HMDA LAR + §4.9.5 warehouse extract; endpoints task-042).
//
// NAVIGATION PATH (navigation completeness rule): reached from the supervisor
// header's "System" dropdown group → Exports (AppHeader nav-sup-exports), and
// from its hamburger-drawer equivalent on narrow widths.
//
// Server component: supervisor page gate (wrong role → own role home, same
// pattern as every supervisor page); the export downloads run client-side
// against GET /api/admin/exports/hmda-lar and /api/admin/exports/warehouse.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { ExportsClient } from "./ExportsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Exports — MortMortgage" };

export default async function SupervisorExportsPage() {
  const user = await requireAppSession("/supervisor/exports");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  return <ExportsClient />;
}
