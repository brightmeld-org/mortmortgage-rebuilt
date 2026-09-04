// /profile — ProfilePage (task-017, contracts §C; REQ-041).
//
// Navigation path: user menu → Profile (every role header) and the borrower
// header "Profile" link. Available to ALL authenticated roles; the
// notification-preferences card renders for Borrowers only (server enforces
// the borrower-only endpoints regardless).

import type { Metadata } from "next";
import { ProfileClient } from "@/components/borrower/ProfileClient";
import { requireAppSession } from "@/components/borrower/server-session";

export const metadata: Metadata = { title: "Profile — MortMortgage" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  await requireAppSession("/profile");
  return <ProfileClient />;
}
