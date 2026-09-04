// THE notification service (task-036 — REQ-068/REQ-069/REQ-070/REQ-071,
// §4.8.1-4.8.4, ASYNC-002, ASM-009, S-6, INT-009/INT-020, WALK-002).
//
// §4.8.1 SINGLE-SERVICE MANDATE: `createNotification` is the SOLE path that
// writes a Notification row. Every §4.8.2 trigger (workflow transitions,
// assignment events, decisions, document events, auth events, ...) routes
// through it — a source scan for `notification.create` must match ONLY this
// module (verified by evidence script). Do not create Notification rows
// anywhere else.
//
// WHAT ONE CALL DOES (in the CALLER'S transaction — the in-app row is atomic
// with its trigger):
//   1. Loads the recipient (role, external-channel preference, address).
//   2. S-6 central enforcement: when the recipient is a BORROWER, any staff
//      actor passed by the call site is referenced by DISPLAY NAME + ROLE only
//      — the staff user's email and user id are scrubbed from title/body here,
//      not per call site (`staffAttribution` is the shared formatter).
//   3. Creates the in-app Notification row. For BORROWER recipients an
//      external dispatch is resolved from User.notificationChannel (§4.2.12:
//      email | sms | both; SMS requires a verified mobile number — an
//      unverified SMS preference falls back to email; in-app is always on).
//      Staff recipients are in-app only (§4.8.1 "for Borrowers").
//   4. Delivery mode per `externalDelivery`:
//        "async" (default) — ASYNC-002: the row commits with
//          deliveryStatus=pending + nextAttemptAt=now and the delivery
//          executor runs post-commit (next/server after() inside a request;
//          guarded timer fallback outside one). At-least-once: a missed
//          hand-off is picked up by the WALK-002 due-scan.
//        "in-tx" — ASYNC-003 (decision dispatch): the simulated send happens
//          INSIDE the caller's transaction and a delivery failure THROWS,
//          aborting the whole transaction (T27/T28 only after successful
//          dispatch — WF-049).
//        "none" — in-app row only. Used when the external message is composed
//          by the caller itself (auth token emails — verification / reset
//          links stay in src/lib/services/auth-account.ts, linked back via
//          OutboundMessage.notificationId).
//
// ASYNC-002 EXECUTION (mirrors src/lib/services/underwriting-checks.ts — no
// queue library; pg-boss is NOT installed):
//   - Serial-per-key (`notification-delivery:{notificationId}`): the DB row is
//     the authority — an atomic guarded updateMany "claims" the row
//     (increments deliveryAttempts, sets a 10-minute in-flight lease on
//     nextAttemptAt). A concurrent executor's claim matches 0 rows: no
//     check-then-act race, no double attempt.
//   - Backoff PERSISTED on the row (ASM-009: 3 attempts, exponential, initial
//     60s): a retryable failure re-sets deliveryStatus=pending with
//     nextAttemptAt = now + 60s·2^(attempt-1). Evidence proves the schedule by
//     backdating nextAttemptAt and running the scan — never by real sleeps.
//   - After the 3rd failed attempt: deliveryStatus=failed + supervisor alert
//     (itself a notification through this service — §4.8.2 "notification
//     delivery failure") + manual retry (POST /api/notifications/:id/retry).
//   - `reconcileDueNotificationDeliveries()` is the WALK-002 scan — invoked
//     lazily by GET /api/notifications and GET /api/admin/outbound-messages,
//     scheduled in-process after a retryable failure, and EXPORTED for boot
//     wiring (task-045).
//
// §6.3.8 SIMULATION (INT-009/INT-020): every "send" is a REAL OutboundMessage
// row (Supervisor Outbound Messages page) + one structured log line — nothing
// external ever happens in demo mode. An email recipient ending
// `@bounce.example` records a retryable delivery failure. Latency 100 ms.
// Message bodies never enter the log (token hygiene — outbound.ts convention).
//
// Retry policy constants are fixed by the ASYNC-002 contract row (maxAttempts
// 3, exponential, initial 60s) — deliberately NOT SystemConfig (§4.6.11
// defines no notification-retry setting).

import { after } from "next/server";
import type { Notification, OutboundMessage, Prisma, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { logLine } from "@/lib/log";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { pageEnvelope, type PageEnvelope, type Pagination } from "@/lib/http/pagination";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { recordOutboundEmail, recordOutboundSms } from "@/lib/services/outbound";
import { sleep } from "@/lib/services/bank-aggregator";

// ---------------------------------------------------------------------------
// Constants (ASYNC-002 / ASM-009 — contract-fixed, see module header)
// ---------------------------------------------------------------------------

export const NOTIFICATION_MAX_DELIVERY_ATTEMPTS = 3;
export const NOTIFICATION_RETRY_INITIAL_DELAY_MS = 60_000;
/** §6.3.8: simulated email/SMS latency. */
export const SIMULATED_SEND_LATENCY_MS = 100;
/** In-flight lease a claim holds on nextAttemptAt (ASYNC-004 analogue: 10 min). */
export const DELIVERY_CLAIM_LEASE_MS = 10 * 60_000;

/** Exponential backoff after failed attempt n (1-based): 60s, 120s, ... */
export function deliveryBackoffMs(attempt: number): number {
  return NOTIFICATION_RETRY_INITIAL_DELAY_MS * 2 ** (Math.max(1, attempt) - 1);
}

// ---------------------------------------------------------------------------
// S-6 attribution (central — the ONLY staff-reference formatter for borrower-
// visible notification content)
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<UserRole, string> = {
  BORROWER: "Borrower",
  CASEWORKER: "Caseworker",
  SUPERVISOR: "Supervisor",
};

export interface StaffActorRef {
  userId?: string;
  firstName: string;
  lastName: string;
  email?: string;
  role: UserRole;
}

/** "Jane Doe (Caseworker)" — display name + role only, never id or email (S-6). */
export function staffAttribution(staff: StaffActorRef): string {
  const name = `${staff.firstName} ${staff.lastName}`.trim() || ROLE_LABELS[staff.role];
  return `${name} (${ROLE_LABELS[staff.role]})`;
}

/** Replace any staff email / user id that leaked into borrower-visible text. */
function scrubStaffIdentifiers(text: string, staff: StaffActorRef): string {
  let out = text;
  const replacement = staffAttribution(staff);
  if (staff.email && staff.email.length > 0) out = out.split(staff.email).join(replacement);
  if (staff.userId && staff.userId.length > 0) out = out.split(staff.userId).join(replacement);
  return out;
}

// ---------------------------------------------------------------------------
// Channel resolution (§4.2.12 preference → concrete sends)
// ---------------------------------------------------------------------------

interface RecipientView {
  id: string;
  role: UserRole;
  email: string;
  phone: string | null;
  notificationChannel: "email" | "sms" | "both";
  smsVerifiedAt: Date | null;
}

interface ResolvedSend {
  channel: "email" | "sms";
  recipient: string;
}

/**
 * External sends for a notification, LIVE from the recipient row at call time
 * (live-state rule — re-resolved on every delivery attempt so a preference
 * change between attempts takes effect). Staff: none (§4.8.1). Borrower:
 * per preference; SMS requires a verified mobile number, otherwise email.
 */
function resolveExternalSends(recipient: RecipientView): ResolvedSend[] {
  if (recipient.role !== "BORROWER") return [];
  const smsReady = recipient.smsVerifiedAt !== null && recipient.phone !== null && recipient.phone.length > 0;
  switch (recipient.notificationChannel) {
    case "email":
      return [{ channel: "email", recipient: recipient.email }];
    case "sms":
      return smsReady
        ? [{ channel: "sms", recipient: recipient.phone as string }]
        : [{ channel: "email", recipient: recipient.email }];
    case "both": {
      const sends: ResolvedSend[] = [{ channel: "email", recipient: recipient.email }];
      if (smsReady) sends.push({ channel: "sms", recipient: recipient.phone as string });
      return sends;
    }
  }
}

/**
 * NotificationChannel column value (enum in-app|email|sms is single-valued):
 * 'in-app' when nothing external; the single external channel otherwise.
 * Preference "both" records 'email' (the primary channel) — both sends are
 * fully recorded as OutboundMessage rows linked by notificationId.
 */
function channelColumnValue(sends: ResolvedSend[]): "in-app" | "email" | "sms" {
  if (sends.length === 0) return "in-app";
  return sends[0]!.channel;
}

// ---------------------------------------------------------------------------
// §6.3.8 simulated send (the provider abstraction over outbound.ts recorders)
// ---------------------------------------------------------------------------

interface SendOutcome {
  send: ResolvedSend;
  row: OutboundMessage;
  ok: boolean;
  error: string | null;
}

/** Retryable simulated bounce (§6.3.8): email recipient ending @bounce.example. */
function simulatedFailure(send: ResolvedSend): string | null {
  if (send.channel === "email" && send.recipient.toLowerCase().endsWith("@bounce.example")) {
    return `Delivery to ${send.recipient} bounced (simulated bounce address) — retryable`;
  }
  return null;
}

/**
 * One structured log line per simulated send (§6.3.8), via the shared task-045
 * helper. NFR-027 PII posture: correlation ids/channel/status ONLY — the
 * recipient address, subject, and body are PII and live on the OutboundMessage
 * row (the §6.3.8 record of the message), never on stdout.
 */
function logOutboundSend(entry: {
  notificationId: string;
  outboundMessageId: string;
  channel: "email" | "sms";
  status: "sent" | "failed";
  attempt: number;
  error: string | null;
}): void {
  logLine("info", { event: "outbound-message", ...entry });
}

/**
 * Record the simulated delivery of one notification over the resolved sends —
 * REAL OutboundMessage rows in the caller's transaction, nothing external.
 * Does NOT update the Notification row; callers aggregate the outcomes.
 */
async function recordSimulatedSends(
  tx: Prisma.TransactionClient,
  notification: { id: string; title: string; body: string },
  sends: ResolvedSend[],
  attempt: number,
): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  for (const send of sends) {
    const error = simulatedFailure(send);
    const status = error === null ? "sent" : "failed";
    const row =
      send.channel === "email"
        ? await recordOutboundEmail(tx as AuditTransactionClient, {
            recipient: send.recipient,
            subject: notification.title,
            body: notification.body,
            notificationId: notification.id,
            status,
          })
        : await recordOutboundSms(tx as AuditTransactionClient, {
            recipient: send.recipient,
            body: `${notification.title} — ${notification.body}`.slice(0, 320),
            notificationId: notification.id,
            status,
          });
    logOutboundSend({
      notificationId: notification.id,
      outboundMessageId: row.id,
      channel: send.channel,
      status,
      attempt,
      error,
    });
    outcomes.push({ send, row, ok: error === null, error });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// createNotification — THE single write path (§4.8.1)
// ---------------------------------------------------------------------------

export type ExternalDeliveryMode = "async" | "in-tx" | "none";

export interface CreateNotificationInput {
  recipientUserId: string;
  /** Free-form trigger tag (NotificationInfo.type is a string on the wire). */
  type: string;
  title: string;
  body: string;
  applicationId?: string | null;
  /**
   * Staff user the event concerns, for S-6 attribution on borrower-visible
   * content. Compose bodies with `staffAttribution(...)`; the service scrubs
   * this actor's email/user id from borrower-visible text as a backstop.
   */
  staffActor?: StaffActorRef | null;
  /** Delivery mode — see module header. Default "async" (ASYNC-002). */
  externalDelivery?: ExternalDeliveryMode;
}

/** Thrown by "in-tx" delivery on failure — aborts the caller's transaction (WF-049). */
export class NotificationDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationDeliveryError";
  }
}

/**
 * Create the in-app Notification row (+ external dispatch per mode) inside the
 * caller's transaction. Returns the created row. See the module header for the
 * full behavior contract.
 */
export async function createNotification(
  tx: Prisma.TransactionClient,
  input: CreateNotificationInput,
): Promise<Notification> {
  const recipient = await tx.user.findUnique({
    where: { id: input.recipientUserId },
    select: {
      id: true,
      role: true,
      email: true,
      phone: true,
      notificationChannel: true,
      smsVerifiedAt: true,
    },
  });
  if (!recipient) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Notification recipient not found");
  }

  // S-6 central enforcement for borrower-visible content.
  let title = input.title;
  let body = input.body;
  if (recipient.role === "BORROWER" && input.staffActor) {
    title = scrubStaffIdentifiers(title, input.staffActor);
    body = scrubStaffIdentifiers(body, input.staffActor);
  }

  const mode: ExternalDeliveryMode = input.externalDelivery ?? "async";
  const sends = mode === "none" ? [] : resolveExternalSends(recipient as RecipientView);
  const now = new Date();

  const notification = await tx.notification.create({
    data: {
      recipientUserId: recipient.id,
      type: input.type,
      title,
      body,
      applicationId: input.applicationId ?? null,
      channel: channelColumnValue(sends),
      // In-app delivery is the row itself → sent. External starts pending.
      deliveryStatus: sends.length === 0 ? "sent" : "pending",
      deliveryAttempts: 0,
      nextAttemptAt: sends.length === 0 ? null : now,
    },
  });

  if (sends.length === 0) return notification;

  if (mode === "in-tx") {
    // ASYNC-003 posture: deliver INSIDE the caller's transaction; any failure
    // throws and rolls the whole operation back (T27/T28 only after success).
    await sleep(SIMULATED_SEND_LATENCY_MS);
    const outcomes = await recordSimulatedSends(tx, notification, sends, 1);
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length > 0) {
      throw new NotificationDeliveryError(failed[0]!.error ?? "External delivery failed");
    }
    return tx.notification.update({
      where: { id: notification.id },
      data: { deliveryStatus: "sent", deliveryAttempts: 1, nextAttemptAt: null, deliveryError: null },
    });
  }

  // ASYNC-002: hand the delivery to the post-commit executor.
  schedulePostCommitDelivery(notification.id);
  return notification;
}

/** Convenience: one in-app notification to every active Supervisor (§4.8.2). */
export async function notifyActiveSupervisors(
  tx: Prisma.TransactionClient,
  input: Omit<CreateNotificationInput, "recipientUserId">,
  excludeUserId?: string | null,
): Promise<number> {
  const supervisors = await tx.user.findMany({
    where: {
      role: "SUPERVISOR",
      status: "active",
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
    select: { id: true },
  });
  for (const supervisor of supervisors) {
    await createNotification(tx, { ...input, recipientUserId: supervisor.id });
  }
  return supervisors.length;
}

// ---------------------------------------------------------------------------
// ASYNC-002 executor
// ---------------------------------------------------------------------------

/**
 * Post-commit hand-off: next/server after() inside a request (runs once the
 * response — and therefore the transaction — is done); outside a request
 * (evidence scripts, boot) a short guarded timer. A missed hand-off is never
 * lost: the row committed with nextAttemptAt=now, so the WALK-002 due-scan
 * picks it up (at-least-once-retry).
 */
function schedulePostCommitDelivery(notificationId: string, delayMs = 50): void {
  const run = () =>
    executeNotificationDelivery(notificationId).catch((err) =>
      console.error(`notification-delivery ${notificationId}: executor error`, err),
    );
  try {
    after(run);
  } catch {
    const timer = setTimeout(run, delayMs);
    (timer as { unref?: () => void }).unref?.();
  }
}

export type DeliveryResult = "sent" | "retry-scheduled" | "failed" | "skipped";

/**
 * One delivery attempt for one notification (idempotency key
 * `notification-delivery:{notificationId}`). The atomic claim below is the
 * serial-per-key authority: it only matches a row that is pending, due, and
 * under the attempt cap — everything else returns "skipped".
 */
export async function executeNotificationDelivery(notificationId: string): Promise<DeliveryResult> {
  const now = new Date();

  // THE claim (see module header): attempt++ and a 10-minute in-flight lease,
  // decided by the database in one statement.
  const claimed = await prisma.notification.updateMany({
    where: {
      id: notificationId,
      deliveryStatus: "pending",
      deliveryAttempts: { lt: NOTIFICATION_MAX_DELIVERY_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: {
      deliveryAttempts: { increment: 1 },
      nextAttemptAt: new Date(now.getTime() + DELIVERY_CLAIM_LEASE_MS),
    },
  });
  if (claimed.count === 0) return "skipped";

  const row = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { id: true, title: true, body: true, deliveryAttempts: true, recipientUserId: true },
  });
  if (!row) return "skipped";
  const attempt = row.deliveryAttempts;

  const recipient = await prisma.user.findUnique({
    where: { id: row.recipientUserId },
    select: {
      id: true,
      role: true,
      email: true,
      phone: true,
      notificationChannel: true,
      smsVerifiedAt: true,
    },
  });

  // Live re-resolution at execution time (live-state rule).
  const sends = recipient ? resolveExternalSends(recipient as RecipientView) : [];
  if (sends.length === 0) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { deliveryStatus: "sent", deliveryError: null, nextAttemptAt: null },
    });
    return "sent";
  }

  await sleep(SIMULATED_SEND_LATENCY_MS);

  // Single-tx recording (ASYNC-002 transactionalBoundary): outbound rows +
  // notification status + (on final failure) the supervisor alerts. A row
  // deleted between the claim and this transaction (demo-data removal is the
  // only delete path) surfaces as a P2003/P2025 — treated as "skipped".
  let result: DeliveryResult;
  try {
    result = await runDeliveryRecordingTx(notificationId, row, sends, attempt);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2003" || code === "P2025") return "skipped";
    throw err;
  }

  if (result === "retry-scheduled") {
    // In-process automatic retry at the persisted due time; crash recovery is
    // the due-scan (at-least-once-retry).
    const timer = setTimeout(() => {
      executeNotificationDelivery(notificationId).catch((err) =>
        console.error(`notification-delivery ${notificationId}: retry error`, err),
      );
    }, deliveryBackoffMs(attempt));
    (timer as { unref?: () => void }).unref?.();
  }
  return result;
}

async function runDeliveryRecordingTx(
  notificationId: string,
  row: { id: string; title: string; body: string },
  sends: ResolvedSend[],
  attempt: number,
): Promise<DeliveryResult> {
  return prisma.$transaction(async (tx): Promise<DeliveryResult> => {
    const outcomes = await recordSimulatedSends(tx, row, sends, attempt);
    const failed = outcomes.filter((o) => !o.ok);

    if (failed.length === 0) {
      await tx.notification.update({
        where: { id: notificationId },
        data: { deliveryStatus: "sent", deliveryError: null, nextAttemptAt: null },
      });
      return "sent";
    }

    const error = failed[0]!.error ?? "External delivery failed";
    if (attempt < NOTIFICATION_MAX_DELIVERY_ATTEMPTS) {
      // ASM-009: persist the exponential backoff schedule on the row.
      await tx.notification.update({
        where: { id: notificationId },
        data: {
          deliveryStatus: "pending",
          deliveryError: error,
          nextAttemptAt: new Date(Date.now() + deliveryBackoffMs(attempt)),
        },
      });
      return "retry-scheduled";
    }

    // Attempt 3 failed: terminal failed + supervisor alert (§4.8.2), manual
    // retry stays available (POST /api/notifications/:id/retry).
    await tx.notification.update({
      where: { id: notificationId },
      data: { deliveryStatus: "failed", deliveryError: error, nextAttemptAt: null },
    });
    await notifyActiveSupervisors(tx, {
      type: "delivery-failure",
      title: "Notification delivery failed",
      body:
        `External delivery of notification "${row.title}" failed after ` +
        `${NOTIFICATION_MAX_DELIVERY_ATTEMPTS} attempts: ${error}. ` +
        `Retry it from the Outbound Messages page.`,
      externalDelivery: "none",
    });
    return "failed";
  });
}

/**
 * WALK-002 due-scan (indexed on deliveryStatus+createdAt): execute every
 * pending delivery whose persisted nextAttemptAt is due, and finalize orphans
 * whose attempts are exhausted (crash between claim and record). Exported for
 * boot wiring (task-045); called lazily by the notification/outbound GET
 * routes; cheap when nothing is due.
 *
 * @returns number of rows acted on.
 */
export async function reconcileDueNotificationDeliveries(limit = 25): Promise<number> {
  const now = new Date();
  const due = await prisma.notification.findMany({
    where: {
      deliveryStatus: "pending",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, deliveryAttempts: true, title: true },
    take: limit,
  });

  let acted = 0;
  for (const row of due) {
    if (row.deliveryAttempts >= NOTIFICATION_MAX_DELIVERY_ATTEMPTS) {
      // Orphan (crashed after claim #3): finalize as failed + alert, guarded.
      await prisma.$transaction(async (tx) => {
        const updated = await tx.notification.updateMany({
          where: {
            id: row.id,
            deliveryStatus: "pending",
            deliveryAttempts: { gte: NOTIFICATION_MAX_DELIVERY_ATTEMPTS },
          },
          data: {
            deliveryStatus: "failed",
            deliveryError: "Delivery did not complete within the retry window — retry available",
            nextAttemptAt: null,
          },
        });
        if (updated.count === 0) return;
        acted += 1;
        await notifyActiveSupervisors(tx, {
          type: "delivery-failure",
          title: "Notification delivery failed",
          body:
            `External delivery of notification "${row.title}" failed after ` +
            `${NOTIFICATION_MAX_DELIVERY_ATTEMPTS} attempts. Retry it from the Outbound Messages page.`,
          externalDelivery: "none",
        });
      });
      continue;
    }
    const result = await executeNotificationDelivery(row.id);
    if (result !== "skipped") acted += 1;
  }
  return acted;
}

// ---------------------------------------------------------------------------
// Manual retry — POST /api/notifications/:id/retry (supervisor)
// ---------------------------------------------------------------------------

/**
 * Supervisor manual retry of a FAILED external delivery (REQ-068/ASM-009):
 * resets the attempt cycle, audits, and performs an immediate attempt so the
 * response reflects the fresh outcome. 404 unknown id; 409 when the
 * notification has no external channel or is not in failed status.
 */
export async function retryNotificationDelivery(
  user: SessionUser,
  notificationId: string,
  meta: RequestMetaBundle,
): Promise<NotificationInfo> {
  const row = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!row) throw new HttpProblem(404, ERROR_CODES.notFound, "Notification not found");
  if (row.channel === "in-app") {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "This notification is in-app only — there is no external delivery to retry",
    );
  }
  if (row.deliveryStatus !== "failed") {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      `Only failed deliveries can be retried (current delivery status: ${row.deliveryStatus})`,
    );
  }

  await prisma.$transaction(async (tx) => {
    // Guarded reset — a concurrent retry loses (0 rows) and still proceeds to
    // the executor, whose claim then decides.
    await tx.notification.updateMany({
      where: { id: notificationId, deliveryStatus: "failed" },
      data: { deliveryStatus: "pending", deliveryAttempts: 0, nextAttemptAt: new Date(), deliveryError: null },
    });
    await audit(tx as AuditTransactionClient, {
      actor: user.userId, // session identity only
      role: user.role,
      actionType: "notification-retry",
      applicationId: row.applicationId,
      entityType: "Notification",
      entityId: row.id,
      summary: `Manual delivery retry of notification "${row.title}" (previous error: ${row.deliveryError ?? "unknown"})`,
      ip: meta.ip,
      requestId: meta.requestId,
    });
  });

  await executeNotificationDelivery(notificationId);

  const fresh = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!fresh) throw new HttpProblem(404, ERROR_CODES.notFound, "Notification not found");
  return toNotificationInfo(fresh);
}

// ---------------------------------------------------------------------------
// Wire serializers + list/read services (contracts §A/§B — field names verbatim)
// ---------------------------------------------------------------------------

/** contracts.json models.NotificationInfo — exact field names. */
export interface NotificationInfo {
  id: string;
  type: string;
  title: string;
  body: string;
  applicationId?: string;
  channel: "in-app" | "email" | "sms";
  deliveryStatus: "pending" | "sent" | "failed";
  deliveryError?: string;
  readAt?: string;
  createdAt: string;
}

export interface NotificationPage extends PageEnvelope<NotificationInfo> {
  unreadCount: number;
}

export function toNotificationInfo(row: Notification): NotificationInfo {
  const info: NotificationInfo = {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    channel: row.channel as NotificationInfo["channel"],
    deliveryStatus: row.deliveryStatus,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.applicationId !== null) info.applicationId = row.applicationId;
  if (row.deliveryError !== null) info.deliveryError = row.deliveryError;
  if (row.readAt !== null) info.readAt = row.readAt.toISOString();
  return info;
}

/**
 * GET /api/notifications — STRICTLY the session user's own rows (record-level
 * scoping rule), newest first, shared clamp pagination, plus unreadCount.
 */
export async function listNotifications(
  user: SessionUser,
  pagination: Pagination,
): Promise<NotificationPage> {
  const where = { recipientUserId: user.userId };
  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  return { ...pageEnvelope(rows.map(toNotificationInfo), pagination, total), unreadCount };
}

/**
 * POST /api/notifications/:id/read — own rows only; another user's row is 404
 * (no existence disclosure). Idempotent: an already-read row keeps its readAt.
 */
export async function markNotificationRead(
  user: SessionUser,
  notificationId: string,
): Promise<NotificationInfo> {
  const row = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!row || row.recipientUserId !== user.userId) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Notification not found");
  }
  if (row.readAt !== null) return toNotificationInfo(row);
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  return toNotificationInfo(updated);
}

/** POST /api/notifications/read-all — marks the session user's unread rows. */
export async function markAllNotificationsRead(user: SessionUser): Promise<{ message: string }> {
  const updated = await prisma.notification.updateMany({
    where: { recipientUserId: user.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return {
    message: `${updated.count} notification${updated.count === 1 ? "" : "s"} marked as read`,
  };
}

// ---------------------------------------------------------------------------
// Outbound Messages page (REQ-071, §6.3.8 surface)
// ---------------------------------------------------------------------------

/** contracts.json models.OutboundMessageInfo — exact field names. */
export interface OutboundMessageInfo {
  id: string;
  channel: "email" | "sms";
  recipient: string;
  subject?: string;
  body: string;
  notificationId?: string;
  status: "pending" | "sent" | "failed";
  createdAt: string;
}

export type OutboundMessagesPage = PageEnvelope<OutboundMessageInfo>;

// --- Single-use token egress redaction (contracts §A, INV-041) -------------
//
// Raw password-reset, email-verification and staff-invitation tokens are stored
// hashed and NEVER appear in any API response body. The message BODIES, however,
// embed the raw token in a follow link (auth-account.ts registration + password
// reset, staff.ts invitation) — and GET /api/admin/outbound-messages serialises
// those bodies to any supervisor. Left raw that is a full account-takeover
// chain: forgot-password (public) -> read the log -> reset-password.
//
// The redaction is TIERED, because §C REQUIRES the OutboundMessagesView
// one-click follow affordance in demo mode and that affordance parses the token
// straight out of the body:
//   - /reset-password?token=...   -> ALWAYS redacted. No UI affordance consumes
//                                    it (OutboundMessagesView.extractVerifyLink
//                                    matches only verify-email and
//                                    accept-invitation), so redacting it costs
//                                    nothing and closes the takeover chain.
//   - /verify-email?token=...     -> live ONLY while DEMO_MODE=true, the sole
//   - /verify-new-email?token=...    mode in which the one-click affordance is
//   - /accept-invitation?token=..    a contracted requirement. All three are
//                                    email-verification / invitation class:
//                                    /verify-new-email (profile.ts email-change
//                                    confirmation) only ever confirms a change
//                                    the holder of the CURRENT password already
//                                    initiated, so it belongs in the same tier
//                                    as /verify-email, not with reset.
//   - anything else carrying ?token= -> redacted (fail closed: a token-bearing
//                                    link added later leaks nothing by default).
//
// EGRESS ONLY. The stored OutboundMessage row is never rewritten — the real
// link must keep working for whoever actually received the message.
//
// DEMO_MODE is read INLINE rather than through demoModeEnabled() from
// services/demo-login: that import closes a real cycle
// (notifications -> demo-login -> idp/index -> idp/built-in -> auth-account
// -> notifications). Verified by reading the import lists, not assumed.

const TOKEN_REDACTION = "[redacted]";
/** Query-bearing URL prefix immediately preceding a `?token=` value. */
const TOKEN_LINK_RE = /([^\s?#]*)\?token=[A-Za-z0-9._~-]+/g;
/** The email-verification / invitation follow links, live in demo mode only. */
const DEMO_FOLLOW_PATH_RE = /\/(?:verify-email|verify-new-email|accept-invitation)$/;

/** Redact every single-use token in an egressing subject/body (INV-041). */
export function redactSingleUseTokens(text: string): string {
  const demoFollowLive = process.env.DEMO_MODE === "true";
  return text.replace(TOKEN_LINK_RE, (match, prefix: string) =>
    demoFollowLive && DEMO_FOLLOW_PATH_RE.test(prefix)
      ? match
      : `${prefix}?token=${TOKEN_REDACTION}`,
  );
}

export function toOutboundMessageInfo(row: OutboundMessage): OutboundMessageInfo {
  const info: OutboundMessageInfo = {
    id: row.id,
    channel: row.channel,
    recipient: row.recipient,
    body: redactSingleUseTokens(row.body),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.subject !== null) info.subject = redactSingleUseTokens(row.subject);
  if (row.notificationId !== null) info.notificationId = row.notificationId;
  return info;
}

/** GET /api/admin/outbound-messages — supervisor-only, newest first. */
export async function listOutboundMessages(pagination: Pagination): Promise<OutboundMessagesPage> {
  const [rows, total] = await Promise.all([
    prisma.outboundMessage.findMany({
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.outboundMessage.count(),
  ]);
  return pageEnvelope(rows.map(toOutboundMessageInfo), pagination, total);
}
