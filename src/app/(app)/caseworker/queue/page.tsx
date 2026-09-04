// /caseworker/queue — CaseworkerQueue (task-028, contracts §C; REQ-047,
// REQ-048, REQ-003, DATA-004).
//
// Navigation path: sign-in → role home (CASEWORKER → /caseworker/queue); also
// the caseworker header "Queue" link (nav-queue) and the app logo. Row click →
// /staff/applications/:id (task-029); "Completion History" tab →
// /caseworker/history.
//
// Page gate: caseworker only — wrong-role users are redirected to their own
// role home (§4.1.10). Supervisors work the queue from /supervisor (task-031);
// the queue APIs stay available to them per contracts §B, but this PAGE shows
// the caseworker stats strip (GET /api/caseworker/stats is caseworker-only).

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { QueueClient } from "@/components/caseworker/QueueClient";
import { ROLE_HOME } from "@/lib/role-home";

export const metadata: Metadata = { title: "Queue — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function CaseworkerQueuePage() {
  const user = await requireAppSession("/caseworker/queue");
  if (user.role !== "CASEWORKER") redirect(ROLE_HOME[user.role] as Route);
  return <QueueClient />;
}
