// /sign-up — AuthPages (task-009, contracts §C; requirements §8 "Create Account").
//
// Reached from: public header "Create Account" on every public page; landing
// hero "Start an application"; /sign-in "Create account" link.

import type { Metadata } from "next";
import { SignUpForm } from "./SignUpForm";
import { safeRedirect } from "@/components/auth/redirect";

export const metadata: Metadata = { title: "Create account — MortMortgage" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const params = await searchParams;
  const redirectTo = safeRedirect(params.redirectTo ?? null);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:py-16">
      <SignUpForm redirectTo={redirectTo} />
    </div>
  );
}
