// /notifications — full paginated notification list, every authenticated role
// (contracts §C NotificationBell responsibility, task-037, REQ-070 / §4.8.3 /
// DATA-004; frame gui-spec "notifications" screen).
//
// Reached from: AppHeader NotificationBell dropdown → "View all notifications"
// (notif-view-all) in every role header. Route directly addressable at
// /notifications (requirements §8 shared-page inventory); the edge middleware
// protects the /notifications prefix and this gate covers dead cookies —
// unauthenticated → /sign-in with return path. No role restriction: the API
// scopes rows to the session user.

import type { Metadata } from "next";
import { requireAppSession } from "@/components/borrower/server-session";
import { NotificationsView } from "@/components/borrower/NotificationsView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Notifications — MortMortgage" };

export default async function NotificationsPage() {
  const user = await requireAppSession("/notifications");
  return <NotificationsView role={user.role} />;
}
