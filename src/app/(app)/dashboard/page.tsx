// /dashboard — BorrowerDashboard (task-017, contracts §C; REQ-020).
//
// Navigation path: sign-in → role home (BORROWER → /dashboard); also the
// borrower header "Dashboard" link and the app logo. Wrong-role users are
// redirected to their own role home (§4.1.10).

import type { Metadata } from "next";
import { DashboardClient } from "@/components/borrower/DashboardClient";
import { requireBorrowerSession } from "@/components/borrower/server-session";

export const metadata: Metadata = { title: "Dashboard — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requireBorrowerSession("/dashboard");
  return <DashboardClient />;
}
