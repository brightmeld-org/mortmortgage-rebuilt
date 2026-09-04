// OutboundMessagesView page (contracts §C, task-036, REQ-071 / §6.3.8) —
// /supervisor/outbound.
//
// Reached from: (app) shell supervisor nav → "Outbound" (nav-sup-outbound).
// Route directly addressable at /supervisor/outbound (requirements §8 route
// inventory). Page-level role gate mirrors the API guard: unauthenticated →
// /sign-in with return path; wrong-role → own role home (§4.1.10). The API
// endpoint enforces the supervisor roleGate authoritatively.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { OutboundMessagesView } from "@/components/supervisor/OutboundMessagesView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Outbound Messages — MortMortgage" };

export default async function SupervisorOutboundPage() {
  const user = await requireAppSession("/supervisor/outbound");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  return <OutboundMessagesView />;
}
