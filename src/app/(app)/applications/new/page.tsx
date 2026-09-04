// /applications/new — new-application source selection + section-copy picker
// (task-017, contracts §C BorrowerDashboard responsibility; REQ-022).
//
// Navigation path: borrower header "New Application" link and the dashboard
// "Start New Application" button. Create → POST /api/applications → redirect
// to /applications/:id (wizard step 1 — task-016).

import type { Metadata } from "next";
import { NewApplicationClient } from "@/components/borrower/NewApplicationClient";
import { requireBorrowerSession } from "@/components/borrower/server-session";

export const metadata: Metadata = { title: "New Application — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function NewApplicationPage() {
  await requireBorrowerSession("/applications/new");
  return <NewApplicationClient />;
}
