"use client";

// OutboundMessagesView (contracts §C, task-036, REQ-071 / §6.3.8 / §4.8.4) —
// the /supervisor/outbound simulated email/SMS log: channel, recipient,
// subject, body, status, timestamp, with the demo-mode one-click verify
// affordance (§4.1.2 — a message carrying a /verify-email link gets a Verify
// button) and a manual delivery Retry for failed notification-linked rows
// (POST /api/notifications/:id/retry, ASM-009).
//
// Reached from: (app) shell supervisor nav → "Outbound" (nav-sup-outbound) →
// /supervisor/outbound (src/app/(app)/supervisor/outbound/page.tsx).
//
// Selector contract (build-plan §C): outbound-row-{id}, outbound-verify-btn-{id}
// — extended within the namespace only (outbound-retry-btn-{id},
// outbound-body-{id}, outbound-prev-page, outbound-next-page, outbound-error).
//
// Design language: increment-6 supervisor table pattern
// (CaseworkerManagement) — Card + table + Badge tones + btn classes.

import { useCallback, useEffect, useState } from "react";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import { ApiErrorBanner, Badge, Card, CardHeading, SkeletonBlock, btnOutline } from "@/components/borrower/ui";

// contracts.json models.OutboundMessageInfo — exact field names.
interface OutboundMessageInfo {
  id: string;
  channel: "email" | "sms"; // enums.ExternalChannel verbatim
  recipient: string;
  subject?: string;
  body: string;
  notificationId?: string;
  status: "pending" | "sent" | "failed"; // enums.NotificationDeliveryStatus verbatim
  createdAt: string;
}

// contracts.json models.OutboundMessagesPage — exact field names.
interface OutboundMessagesPage {
  rows: OutboundMessageInfo[];
  page: number;
  pageSize: number;
  total: number;
}

const STATUS_TONES: Record<OutboundMessageInfo["status"], "success" | "warn" | "gray"> = {
  sent: "success",
  pending: "warn",
  failed: "gray",
};

const CHANNEL_LABELS: Record<OutboundMessageInfo["channel"], string> = {
  email: "Email",
  sms: "SMS",
};

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

/**
 * §4.1.2 one-click follow: the actionable link embedded in the message body.
 * Three token-bearing bodies reach this page — the email-verification link, the
 * REQ-041 change-email confirmation link sent to the new address, and the staff
 * set-password (invitation) link, whose banner promises it is "viewable on the
 * Outbound Messages page". All get the same one-click affordance; the label
 * names which one it is.
 */
function extractVerifyLink(body: string): { href: string; label: string } | null {
  const patterns: Array<{ re: RegExp; label: string }> = [
    // /verify-new-email FIRST, defensively: the loop returns on the first match, and
    // this is the most specific path of the three. Today's /verify-email pattern is
    // anchored tightly enough not to overlap, but any future loosening of it (dropping
    // the "?token=" anchor, or allowing a path suffix) would otherwise silently
    // reclassify a change-email link as a plain verification link and send the
    // supervisor to the wrong route. Specific before general costs nothing here.
    { re: /https?:\/\/\S+\/verify-new-email\?token=[A-Za-z0-9._~-]+/, label: "Confirm new email" },
    { re: /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9._~-]+/, label: "Verify" },
    { re: /https?:\/\/\S+\/accept-invitation\?token=[A-Za-z0-9._~-]+/, label: "Open invitation" },
  ];
  for (const { re, label } of patterns) {
    const match = body.match(re);
    if (!match) continue;
    try {
      const url = new URL(match[0]);
      // same-origin path — never an external host
      return { href: `${url.pathname}${url.search}`, label };
    } catch {
      return null;
    }
  }
  return null;
}

export function OutboundMessagesView() {
  const [data, setData] = useState<OutboundMessagesPage | null>(null);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  const [actionError, setActionError] = useState<ErrorResponseBody | null>(null);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = useCallback(async (targetPage: number) => {
    const result = await getJson<OutboundMessagesPage>(
      `/api/admin/outbound-messages?page=${targetPage}&pageSize=25`,
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

  async function retryDelivery(row: OutboundMessageInfo) {
    if (!row.notificationId) return;
    setBusyRowId(row.id);
    setActionError(null);
    const result = await postWithCsrf(`/api/notifications/${row.notificationId}/retry`);
    setBusyRowId(null);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    await reload(page);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h1 className="font-display text-2xl font-bold text-ink">Outbound Messages</h1>
        <p className="mt-1 text-sm text-muted">
          Simulated email/SMS log (demonstration mode — nothing is sent externally). Failed
          notification deliveries can be retried here.
        </p>
      </div>

      {loadError ? (
        <ApiErrorBanner message={loadError.message} details={loadError.details} testId="outbound-load-error" />
      ) : null}
      {actionError ? (
        <ApiErrorBanner message={actionError.message} details={actionError.details} testId="outbound-error" />
      ) : null}

      <Card>
        <CardHeading>
          Messages{data ? ` (${data.total})` : ""}
        </CardHeading>
        {data === null ? (
          <SkeletonBlock className="h-40" />
        ) : data.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No outbound messages recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th className="px-2 py-2">Channel</th>
                  <th className="px-2 py-2">Recipient</th>
                  <th className="px-2 py-2">Subject</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Timestamp</th>
                  <th className="px-2 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const verifyLink = extractVerifyLink(row.body);
                  const expanded = expandedId === row.id;
                  return (
                    <tr
                      key={row.id}
                      data-testid={`outbound-row-${row.id}`}
                      className="border-b border-line align-top last:border-b-0"
                    >
                      <td className="px-2 py-2">
                        <Badge tone={row.channel === "email" ? "gray" : "warn"}>
                          {CHANNEL_LABELS[row.channel]}
                        </Badge>
                      </td>
                      <td className="max-w-[16rem] truncate px-2 py-2 text-ink">{row.recipient}</td>
                      <td className="max-w-[20rem] px-2 py-2 text-ink-soft">
                        <p className="truncate">{row.subject ?? "—"}</p>
                        <button
                          type="button"
                          data-testid={`outbound-body-${row.id}`}
                          className="mt-0.5 text-xs font-medium text-copper hover:underline"
                          onClick={() => setExpandedId(expanded ? null : row.id)}
                        >
                          {expanded ? "Hide body" : "Show body"}
                        </button>
                        {expanded ? (
                          <pre className="mt-1 max-w-[28rem] whitespace-pre-wrap rounded-md bg-paper p-2 text-xs text-ink-soft">
                            {row.body}
                          </pre>
                        ) : null}
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={STATUS_TONES[row.status]}>{row.status}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-ink-soft">
                        {formatTimestamp(row.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        {verifyLink ? (
                          <a
                            href={verifyLink.href}
                            target="_blank"
                            rel="noreferrer"
                            data-testid={`outbound-verify-btn-${row.id}`}
                            className={btnOutline}
                          >
                            {verifyLink.label}
                          </a>
                        ) : null}
                        {row.status === "failed" && row.notificationId ? (
                          <button
                            type="button"
                            data-testid={`outbound-retry-btn-${row.id}`}
                            className={`${btnOutline} ml-2`}
                            disabled={busyRowId === row.id}
                            onClick={() => void retryDelivery(row)}
                          >
                            {busyRowId === row.id ? "Retrying…" : "Retry"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > data.pageSize ? (
          <div className="mt-3 flex items-center justify-between text-sm text-ink-soft">
            <button
              type="button"
              data-testid="outbound-prev-page"
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
              data-testid="outbound-next-page"
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
