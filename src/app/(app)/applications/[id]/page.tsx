// /applications/:id — the 10-step URLA 2020 wizard (task-016, contracts §C
// UrlaWizard, gui-spec "wizard" screen).
//
// NAVIGATION PATH (navigation completeness rule): reached from the borrower
// dashboard "Continue" action on Draft / Revision Requested applications
// (task-017), from /applications/new after Create, and from the public-tools
// start-application bridge (task-018). Deep-linkable step via ?step=n.
//
// Server component: resolves route/search params and the DEMO_MODE flag (only
// the derived boolean crosses to the client — same pattern as the sign-in
// page); all data loading is session-scoped client fetching inside WizardRoot.
// Task-044 consistency pass: borrower page gate (wrong role → own role home,
// same as every other borrower page — previously relied on API-level 403s).

import type { Metadata } from "next";
import { requireBorrowerSession } from "@/components/borrower/server-session";
import { WizardRoot } from "@/components/wizard/WizardRoot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "URLA Application — MortMortgage" };

export default async function WizardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const { id } = await params;
  const { step } = await searchParams;
  await requireBorrowerSession(`/applications/${id}`);
  const initialStep = Number(step);
  const demoMode = process.env.DEMO_MODE === "true";
  return (
    <WizardRoot
      applicationId={id}
      initialStep={Number.isInteger(initialStep) && initialStep >= 1 && initialStep <= 10 ? initialStep : 1}
      demoMode={demoMode}
    />
  );
}
