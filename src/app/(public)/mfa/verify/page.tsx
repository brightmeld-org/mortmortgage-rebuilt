// /mfa/verify — AuthPages (task-009, contracts §C; requirements §8 "MFA
// Challenge"). TOTP or single-use recovery code.
//
// Reached from: sign-in when SignInResponse.status = "mfa-required" (server
// redirectTo "/mfa/verify"; requested page threaded via ?redirectTo=);
// /mfa/enroll redirects here on the 409 active-enrollment case.

import type { Metadata } from "next";
import { MfaVerifyClient } from "./MfaVerifyClient";
import { safeRedirect } from "@/components/auth/redirect";

export const metadata: Metadata = { title: "MFA challenge — MortMortgage" };

export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const params = await searchParams;
  const redirectTo = safeRedirect(params.redirectTo ?? null);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:py-16">
      <MfaVerifyClient redirectTo={redirectTo} />
    </div>
  );
}
