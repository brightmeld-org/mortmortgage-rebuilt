// /sign-in — AuthPages (task-009, contracts §C; requirements §8 "Sign In").
//
// Reached from: public header on every public page; landing hero "Sign in";
// /sign-up ↔ /forgot-password ↔ /verify-email links; middleware redirect from
// any protected page when no session cookie is present (?redirectTo=<path>).
//
// Server component: DEMO MODE is decided HERE, server-side, from
// process.env.DEMO_MODE — only the derived boolean crosses to the client
// (never the env value itself, and nothing when the mode is off; the
// /api/auth/demo-login endpoint is 404-absent in that case). force-dynamic so a
// production build can never freeze the flag at build time.

import type { Metadata } from "next";
import { SignInForm } from "./SignInForm";
import { safeRedirect } from "@/components/auth/redirect";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in — MortMortgage" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const params = await searchParams;
  // Boundary validation: only a same-origin relative path survives.
  const redirectTo = safeRedirect(params.redirectTo ?? null);
  const demoMode = process.env.DEMO_MODE === "true";

  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:py-16">
      <SignInForm redirectTo={redirectTo} demoMode={demoMode} />
    </div>
  );
}
