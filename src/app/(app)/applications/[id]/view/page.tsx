// /applications/:id/view — BorrowerApplicationView (task-017, contracts §C;
// REQ-020/REQ-042/REQ-052, FLOW-005).
//
// Navigation path: dashboard "View" action on any non-editable state; also
// notification links (task-037). The wizard at /applications/:id is task-016.
// Dynamic segment name [id] matches the existing /api/applications/[id] level.

import type { Metadata } from "next";
import { ApplicationViewClient } from "@/components/borrower/ApplicationViewClient";
import { requireBorrowerSession } from "@/components/borrower/server-session";

export const metadata: Metadata = { title: "Application — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function ApplicationViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireBorrowerSession(`/applications/${id}/view`);
  return <ApplicationViewClient applicationId={id} />;
}
