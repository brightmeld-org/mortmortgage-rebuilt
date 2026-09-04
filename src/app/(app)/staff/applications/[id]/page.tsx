// /staff/applications/:id — StaffApplicationDetail (task-029, contracts §C;
// REQ-049, REQ-050, REQ-053, REQ-054, DATA-004).
//
// Navigation path: caseworker queue (/caseworker/queue) or completion history
// row click → here; supervisor all-applications (task-031) and notification
// links also target this route (§8 route inventory: "Application Detail
// (staff)" — Caseworker (assigned), Supervisor).
//
// Page gate: staff only — borrowers are redirected to their own role home
// (§4.1.10). RECORD-LEVEL scoping (assigned caseworker vs supervisor) is
// enforced by GET /api/applications/:id; the client renders its 403/404
// bodies verbatim.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { StaffApplicationDetailClient } from "@/components/staff/detail/StaffApplicationDetailClient";
import { getPreliminaryRecommendation } from "@/lib/services/approval";
import { ROLE_HOME } from "@/lib/role-home";

export const metadata: Metadata = { title: "Application Detail — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function StaffApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireAppSession(`/staff/applications/${id}`);
  if (user.role !== "CASEWORKER" && user.role !== "SUPERVISOR") {
    redirect(ROLE_HOME[user.role] as Route);
  }
  // task-032 approval panel: the caseworker recommendation
  // (Application.preliminaryRecommendation) is not a §A wire field — it is
  // read server-side for SUPERVISOR sessions only and passed as a prop
  // (record-level read access for supervisors is S-4; unknown ids simply
  // yield null and the client's GET /api/applications/:id still 404s).
  const preliminaryRecommendation =
    user.role === "SUPERVISOR" ? await getPreliminaryRecommendation(id) : null;
  return (
    <StaffApplicationDetailClient
      applicationId={id}
      role={user.role}
      preliminaryRecommendation={preliminaryRecommendation}
    />
  );
}
