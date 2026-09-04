// /verify-new-email — AuthPages (contracts §C; requirements REQ-041, §4.2.12
// "Change Email").
//
// Reached from: the single-use confirmation link inside the OutboundMessage sent
// to the NEW address by POST /api/profile/change-email
// (`/verify-new-email?token=…`, composed in src/lib/services/profile.ts), which
// the Supervisor → Outbound Messages page also surfaces as a one-click
// affordance. NOTHING else links here — unlike /verify-email there is no resend
// endpoint for this flow, so a visitor arriving WITHOUT a token gets an
// explanatory state instead of an action (see VerifyNewEmailClient).
//
// BUG-26: this route did not exist — the mailed link 404'd and the contracted
// POST /api/profile/verify-new-email had no caller anywhere in the client.

import type { Metadata } from "next";
import { VerifyNewEmailClient } from "./VerifyNewEmailClient";
import { safeRedirect } from "@/components/auth/redirect";

export const metadata: Metadata = { title: "Confirm new email — MortMortgage" };

export default async function VerifyNewEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; redirectTo?: string }>;
}) {
  const params = await searchParams;
  // Boundary validation: token is an opaque string — pass through non-empty only.
  const token = typeof params.token === "string" && params.token.length > 0 ? params.token : null;
  const redirectTo = safeRedirect(params.redirectTo ?? null);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:py-16">
      <VerifyNewEmailClient token={token} redirectTo={redirectTo} />
    </div>
  );
}
