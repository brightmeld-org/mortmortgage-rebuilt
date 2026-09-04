// Simulated external dispatch (§6.3.8, INT-009/INT-020, ASYNC dispatch seam).
//
// In demonstration mode nothing is sent externally: every email/SMS the system
// "sends" is a REAL OutboundMessage row (viewable on the Supervisor Outbound
// Messages page, REQ-071). This module is the dispatch seam auth flows call in
// their production code path — verification links, reset links, and SMS codes
// land here as rows with the real link/code in the body.
//
// Raw tokens appear ONLY inside the persisted message body (that is the
// simulated delivery), never in any log line.
//
// Status: direct auth messages (verification/reset links, SMS codes) "send"
// synchronously and record as 'sent'. The notification service (task-036,
// src/lib/services/notifications.ts) layers the §6.3.8 @bounce.example
// retryable-failure seam on top by passing an explicit `status` — these
// recorders stay the single OutboundMessage write path either way.

import type { OutboundMessage } from "@prisma/client";
import type { AuditTransactionClient } from "@/lib/services/audit";

/** Base URL used in message links. */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3083").replace(/\/+$/, "");
}

export async function recordOutboundEmail(
  tx: AuditTransactionClient,
  input: {
    recipient: string;
    subject: string;
    body: string;
    notificationId?: string;
    /** Simulated outcome (task-036 @bounce.example seam). Default 'sent'. */
    status?: "sent" | "failed";
  },
): Promise<OutboundMessage> {
  return tx.outboundMessage.create({
    data: {
      channel: "email",
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      notificationId: input.notificationId ?? null,
      status: input.status ?? "sent",
    },
  });
}

export async function recordOutboundSms(
  tx: AuditTransactionClient,
  input: {
    recipient: string;
    body: string;
    notificationId?: string;
    /** Simulated outcome (task-036 seam). Default 'sent'. */
    status?: "sent" | "failed";
  },
): Promise<OutboundMessage> {
  return tx.outboundMessage.create({
    data: {
      channel: "sms",
      recipient: input.recipient,
      body: input.body,
      notificationId: input.notificationId ?? null,
      status: input.status ?? "sent",
    },
  });
}
