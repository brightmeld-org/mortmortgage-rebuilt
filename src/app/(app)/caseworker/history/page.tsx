// /caseworker/history — completion history (task-028, contracts §C
// CaseworkerQueue responsibility; REQ-048).
//
// Navigation path: caseworker header "History" link (nav-history) and the
// "Completion History" tab on /caseworker/queue (history-tab).
//
// Page gate: caseworker only (GET /api/caseworker/history is caseworker-only
// per contracts §B) — wrong-role users are redirected to their own role home
// (§4.1.10).

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { HistoryClient } from "@/components/caseworker/HistoryClient";
import { ROLE_HOME } from "@/lib/role-home";

export const metadata: Metadata = { title: "Completion History — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function CaseworkerHistoryPage() {
  const user = await requireAppSession("/caseworker/history");
  if (user.role !== "CASEWORKER") redirect(ROLE_HOME[user.role] as Route);
  return <HistoryClient />;
}
