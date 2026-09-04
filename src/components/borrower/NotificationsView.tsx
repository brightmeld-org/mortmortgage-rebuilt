"use client";

// NotificationsView (contracts §C NotificationBell responsibility, task-037,
// REQ-070 / §4.8.3 / DATA-004) — the /notifications full paginated list for
// every authenticated role (frame gui-spec "notifications" screen: read/unread
// state, title, body preview, relative time, link to related application,
// "Mark all read" action).
//
// Reached from: AppHeader NotificationBell dropdown → "View all notifications"
// (notif-view-all) → /notifications (src/app/(app)/notifications/page.tsx).
//
// Data: GET /api/notifications with the shared ?page/?pageSize params
// (NotificationPage envelope, server-clamped). Clicking a row marks it read
// (POST /api/notifications/:id/read) then navigates to the role-dependent
// application target; unlinked rows just mark read in place. Failed external
// deliveries show a non-intrusive "Delivery failed" badge (supervisor retry
// lives on the Outbound Messages page, not here).
//
// Selector contract (build-plan §C): notif-page-list — extended within the
// namespace only (notif-page-item-{id}, notif-page-mark-all-read,
// notif-page-prev, notif-page-next, notif-page-error; data-unread attribute).
//
// Design language: increment-6/8 list-page pattern (OutboundMessagesView) —
// Card + Badge tones + btn classes, paper/copper frame tokens.

import { useCallback, useEffect, useState } from "react";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import { ApiErrorBanner, Badge, Card, SkeletonBlock, btnOutline } from "@/components/borrower/ui";
import {
  announceNotificationsChanged,
  applicationHref,
  formatRelativeTime,
  type HeaderRole,
  type NotificationInfo,
  type NotificationPage,
} from "./notifications-shared";

const PAGE_SIZE = 25; // shared list-page default (audit viewer / outbound convention)

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function NotificationsView({ role }: { role: HeaderRole }) {
  const [data, setData] = useState<NotificationPage | null>(null);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  const [actionError, setActionError] = useState<ErrorResponseBody | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (targetPage: number) => {
    const result = await getJson<NotificationPage>(
      `/api/notifications?page=${targetPage}&pageSize=${PAGE_SIZE}`,
    );
    if (result.ok) {
      setData(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.error);
    }
  }, []);

  useEffect(() => {
    void reload(page);
  }, [reload, page]);

  /** Mark read, then navigate to the related application (when linked). */
  async function activate(notification: NotificationInfo) {
    setActionError(null);
    if (!notification.readAt) {
      const result = await postWithCsrf(`/api/notifications/${notification.id}/read`);
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
    }
    if (notification.applicationId) {
      window.location.assign(applicationHref(role, notification.applicationId));
      return;
    }
    await reload(page);
    announceNotificationsChanged(); // header bell badge refreshes immediately
  }

  async function markAllRead() {
    setBusy(true);
    setActionError(null);
    const result = await postWithCsrf("/api/notifications/read-all");
    setBusy(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    await reload(page);
    announceNotificationsChanged(); // header bell badge refreshes immediately
  }

  const unread = data?.unreadCount ?? 0;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  function renderRow(notification: NotificationInfo) {
    const isUnread = !notification.readAt;
    const inner = (
      <span className="flex gap-3">
        <span
          aria-hidden
          className={`mt-2 h-2 w-2 shrink-0 rounded-full ${isUnread ? "bg-copper" : "bg-transparent"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={`text-sm ${isUnread ? "font-semibold text-ink" : "font-medium text-ink-soft"}`}
            >
              {notification.title}
            </span>
            {isUnread ? <Badge tone="info">Unread</Badge> : null}
            {notification.deliveryStatus === "failed" ? (
              <Badge tone="danger">Delivery failed</Badge>
            ) : null}
          </span>
          <span className="mt-0.5 block text-sm text-muted">{notification.body}</span>
          <span
            title={formatTimestamp(notification.createdAt)}
            className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted"
          >
            <span>{formatRelativeTime(notification.createdAt)}</span>
            {notification.applicationId ? (
              <span className="font-semibold text-copper">View application →</span>
            ) : null}
          </span>
        </span>
      </span>
    );
    const shared = {
      "data-testid": `notif-page-item-${notification.id}`,
      "data-unread": isUnread ? "true" : "false",
      className:
        "block w-full border-b border-line px-1 py-3 text-left transition-colors duration-200 last:border-b-0 hover:bg-paper",
    };
    return (
      <li key={notification.id}>
        {notification.applicationId ? (
          <a
            {...shared}
            href={applicationHref(role, notification.applicationId)}
            onClick={(event) => {
              event.preventDefault();
              void activate(notification);
            }}
          >
            {inner}
          </a>
        ) : (
          <button type="button" {...shared} onClick={() => void activate(notification)}>
            {inner}
          </button>
        )}
      </li>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Notifications</h1>
          <p className="mt-1 text-sm text-muted">
            {data === null
              ? "Loading…"
              : unread > 0
                ? `${unread} unread notification${unread === 1 ? "" : "s"}.`
                : "You're all caught up."}
          </p>
        </div>
        <button
          type="button"
          data-testid="notif-page-mark-all-read"
          className={btnOutline}
          disabled={busy || unread === 0}
          onClick={() => void markAllRead()}
        >
          {busy ? "Marking…" : "Mark all read"}
        </button>
      </div>

      {loadError ? (
        <ApiErrorBanner
          message={loadError.message}
          details={loadError.details}
          testId="notif-page-load-error"
        />
      ) : null}
      {actionError ? (
        <ApiErrorBanner
          message={actionError.message}
          details={actionError.details}
          testId="notif-page-error"
        />
      ) : null}

      <Card>
        {data === null ? (
          <SkeletonBlock className="h-40" />
        ) : data.rows.length === 0 ? (
          <p data-testid="notif-page-list" className="py-6 text-center text-sm text-muted">
            No notifications yet.
          </p>
        ) : (
          <ul data-testid="notif-page-list">{data.rows.map(renderRow)}</ul>
        )}

        {data && data.total > data.pageSize ? (
          <div className="mt-3 flex items-center justify-between text-sm text-ink-soft">
            <button
              type="button"
              data-testid="notif-page-prev"
              className={btnOutline}
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span>
              Page {data.page} of {totalPages}
            </span>
            <button
              type="button"
              data-testid="notif-page-next"
              className={btnOutline}
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
