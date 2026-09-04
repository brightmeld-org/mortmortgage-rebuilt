// /forgot-password — AuthPages (task-009, contracts §C; requirements §8
// "Forgot / Reset Password").
//
// Reached from: /sign-in "Forgot password?" link.

import type { Metadata } from "next";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password — MortMortgage" };

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:py-16">
      <ForgotPasswordForm />
    </div>
  );
}
