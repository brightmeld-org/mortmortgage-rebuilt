// Shared wire types + helpers for the notification surfaces (task-037):
// NotificationBell (header dropdown, every role) and NotificationsView
// (/notifications full paginated page). Field names and enum literals are
// VERBATIM from contracts.json (models.NotificationInfo /
// models.NotificationPage; enums.NotificationChannel /
// enums.NotificationDeliveryStatus).

// contracts.json models.NotificationInfo — exact field names.
export interface NotificationInfo {
  id: string;
  type: string;
  title: string;
  body: string;
  applicationId?: string;
  channel: "in-app" | "email" | "sms"; // enums.NotificationChannel verbatim
  deliveryStatus: "pending" | "sent" | "failed"; // enums.NotificationDeliveryStatus verbatim
  deliveryError?: string;
  readAt?: string;
  createdAt: string;
}

// contracts.json models.NotificationPage — exact field names.
export interface NotificationPage {
  rows: NotificationInfo[];
  unreadCount: number;
  page: number;
  pageSize: number;
  total: number;
}

export type HeaderRole = "BORROWER" | "CASEWORKER" | "SUPERVISOR";

/**
 * Same-page coordination between the two surfaces: the /notifications page
 * dispatches this window event after a read-state mutation so the header
 * bell's badge refreshes immediately instead of on its next 15 s poll.
 */
export const NOTIFICATIONS_CHANGED_EVENT = "mm:notifications-changed";

export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

/**
 * Role-dependent link target for a notification's related application:
 * borrowers open their read-only view (/applications/:id/view — task-017
 * convention); staff open the staff detail (/staff/applications/:id —
 * task-029 convention). Notifications without an applicationId render
 * unlinked.
 */
export function applicationHref(role: HeaderRole, applicationId: string): string {
  return role === "BORROWER"
    ? `/applications/${applicationId}/view`
    : `/staff/applications/${applicationId}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Relative timestamp for notification rows (§4.8.3): "just now", "N minutes
 * ago", "N hours ago", "N days ago"; beyond 7 days the shared absolute date
 * format ("Mon D, YYYY" — borrower/format.ts convention).
 */
export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return DATE_FORMAT.format(new Date(then));
}
