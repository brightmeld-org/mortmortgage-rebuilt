// /mfa/enroll — AuthPages (task-009, contracts §C; requirements §8 "MFA
// Enrollment"). FLOW-002 steps 3-4: QR + text secret, TOTP verify, one-time
// recovery codes.
//
// Reached from: sign-in when SignInResponse.status = "mfa-enrollment-required"
// (server redirectTo "/mfa/enroll"; requested page threaded via ?redirectTo=).

import type { Metadata } from "next";
import { MfaEnrollClient } from "./MfaEnrollClient";
import { safeRedirect } from "@/components/auth/redirect";

export const metadata: Metadata = { title: "Set up MFA — MortMortgage" };

export default async function MfaEnrollPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const params = await searchParams;
  const redirectTo = safeRedirect(params.redirectTo ?? null);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:py-16">
      <MfaEnrollClient redirectTo={redirectTo} />
    </div>
  );
}
