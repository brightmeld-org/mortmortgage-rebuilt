// /accept-invitation — AuthPages invitation set-password landing (task-009,
// contracts §C "invitation set-password landing"; REQ-063/NFR-011).
//
// Route note: requirements §8's inventory has no explicit page row for the
// invitation landing — the contracted endpoint is POST
// /api/auth/accept-invitation, so the page mirrors that path (logged in
// frame-extensions.md). The endpoint's BACKEND lands with task-033 (staff
// admin, later increment): until then the API 404s and the form surfaces a sane
// unavailable message — expected cross-increment behavior.
//
// Reached from: the set-password link inside the invitation OutboundMessage
// (`/accept-invitation?token=…`, generated when task-033 lands).

import type { Metadata } from "next";
import { AcceptInvitationForm } from "./AcceptInvitationForm";

export const metadata: Metadata = { title: "Accept invitation — MortMortgage" };

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  // Boundary validation: opaque token, non-empty only.
  const token = typeof params.token === "string" && params.token.length > 0 ? params.token : null;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:py-16">
      <AcceptInvitationForm token={token} />
    </div>
  );
}
