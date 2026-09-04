"use client";

// NotificationBell (contracts §C, task-037, REQ-070 / §4.8.3 / DATA-004) —
// header bell for EVERY authenticated role, rendered by AppHeader in its
// reserved `notif-bell-slot` mount.
//
// Behavior: unread count badge (hidden at zero); click opens a dropdown of the
// latest 10 notifications (GET /api/notifications?page=1&pageSize=10 — the
// session-scoped NotificationPage) with read/unread state, relative
// timestamps, and links to the related application (role-dependent target,
// notifications-shared.ts); clicking a notification marks it read
// (POST /api/notifications/:id/read) then navigates; "Mark all read" posts
// /api/notifications/read-all and refreshes the count. Failed external
// deliveries show a non-intrusive "Delivery failed" tag — the supervisor
// retry surface lives on the Outbound Messages page, NOT here. Data refreshes
// on a 15 s poll (§4.4.5 chatter convention — no websockets) and on open.
// Dismissal: outside click + Escape, same pattern as the AppHeader user menu.
//
// Selector contract (build-plan §C NotificationBell): notif-bell, notif-badge,
// notif-dropdown, notif-item-{id}, notif-mark-all-read — extended within the
// namespace only (notif-view-all footer link; data-unread state attribute).

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postWithCsrf } from "@/components/borrower/api";
import {
  NOTIFICATIONS_CHANGED_EVENT,
  applicationHref,
  formatRelativeTime,
  type HeaderRole,
  type NotificationInfo,
  type NotificationPage,
} from "./notifications-shared";

const POLL_INTERVAL_MS = 15_000; // matches the established 15 s poll pattern
const DROPDOWN_SIZE = 10; // §4.8.3: dropdown shows at least the latest 10

export function NotificationBell({ role }: { role: HeaderRole }) {
  const [data, setData] = useState<NotificationPage | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const result = await getJson<NotificationPage>(
      `/api/notifications?page=1&pageSize=${DROPDOWN_SIZE}`,
    );
    if (result.ok) setData(result.data);
  }, []);

  // Initial load + modest 15 s poll so the badge stays current; the
  // /notifications page announces read-state mutations for instant refresh.
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_INTERVAL_MS);
    const onChanged = () => void reload();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => {
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    };
  }, [reload]);

  // Dismissal while open: outside click (user-menu pattern) + Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    setOpen((wasOpen) => {
      if (!wasOpen) void reload(); // fresh rows the moment it opens
      return !wasOpen;
    });
  }

  /** Mark read, then navigate to the related application (when linked). */
  async function activate(notification: NotificationInfo) {
    if (!notification.readAt) {
      await postWithCsrf(`/api/notifications/${notification.id}/read`);
    }
    if (notification.applicationId) {
      window.location.assign(applicationHref(role, notification.applicationId));
      return;
    }
    await reload(); // unlinked: stay, refresh read state + badge
  }

  async function markAllRead() {
    setBusy(true);
    await postWithCsrf("/api/notifications/read-all");
    await reload();
    setBusy(false);
  }

  const unread = data?.unreadCount ?? 0;
  const rows = data?.rows ?? [];

  function renderRow(notification: NotificationInfo) {
    const isUnread = !notification.readAt;
    const inner = (
      <span className="flex gap-2.5">
        <span
          aria-hidden
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isUnread ? "bg-copper" : "bg-transparent"}`}
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm ${isUnread ? "font-semibold text-ink" : "font-medium text-ink-soft"}`}
          >
            {notification.title}
          </span>
          <span className="block truncate text-xs text-muted">{notification.body}</span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
            <span>{formatRelativeTime(notification.createdAt)}</span>
            {notification.deliveryStatus === "failed" ? (
              <span className="font-semibold text-danger">Delivery failed</span>
            ) : null}
          </span>
        </span>
      </span>
    );
    const shared = {
      "data-testid": `notif-item-${notification.id}`,
      "data-unread": isUnread ? "true" : "false",
      className:
        "block w-full px-3 py-2 text-left transition-colors duration-200 hover:bg-paper",
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
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="notif-bell"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={toggle}
        className="relative flex h-9 w-9 items-center justify-center rounded-md bg-copper-soft text-copper transition-colors duration-200 hover:bg-copper/25"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
          <path d="M12 2a6 6 0 0 0-6 6v3.1l-1.68 3.36A1 1 0 0 0 5.21 16h13.58a1 1 0 0 0 .9-1.54L18 11.1V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 2.82-2H9.18A3 3 0 0 0 12 22Z" />
        </svg>
        {unread > 0 ? (
          <span
            data-testid="notif-badge"
            className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          data-testid="notif-dropdown"
          role="region"
          aria-label="Notifications"
          className="fixed left-3 right-3 top-16 z-50 rounded-lg border border-line bg-card shadow-lg sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-semibold text-ink">Notifications</p>
            <button
              type="button"
              data-testid="notif-mark-all-read"
              disabled={busy || unread === 0}
              onClick={() => void markAllRead()}
              className="text-xs font-semibold text-copper transition-colors duration-200 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Marking…" : "Mark all read"}
            </button>
          </div>
          {data === null ? (
            <div aria-hidden className="m-3 h-24 animate-pulse rounded-md bg-gray-soft" />
          ) : rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">No notifications yet.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto py-1">{rows.map(renderRow)}</ul>
          )}
          <div className="border-t border-line px-3 py-2">
            <a
              href="/notifications"
              data-testid="notif-view-all"
              className="text-sm font-semibold text-copper transition-colors duration-200 hover:underline"
            >
              View all notifications
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
