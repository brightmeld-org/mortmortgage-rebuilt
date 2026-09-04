// Test-only fixture seam operations (task-046/test-fixtures-contract.md).
//
// Reachable ONLY through POST /api/test/fixtures, which is ABSENT (404) unless
// NODE_ENV !== "production" AND DEMO_MODE === "true" (the demo-login gating
// pattern). Nine operations make time- and environment-dependent §7.7 states
// reachable for the independent test suite:
//   - backdating ops move existing timestamps BACKWARDS only — they age rows
//     the public API already created, never create domain data;
//   - run-stuck-job-reconciler invokes the existing exported ASYNC-004 scan;
//   - set-simulation-fault flips the demo-gated runtime SIM_FAULT_* override;
//   - fail-next-audit-write arms the one-shot audit-insert failure.
//
// Failure semantics per the seam contract: unknown target → 404, a request the
// operation cannot satisfy → 400, both as the standard ErrorResponse. Never 500
// for contract-defined rejections (HttpProblem carries them to the route).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import { CONFIG_DEFAULTS, CONFIG_KEYS, getConfigNumber } from "@/lib/http/config";
import { armFailNextAuditWrite } from "@/lib/services/audit";
import {
  reconcileStuckDocumentJobs,
  reconcileStuckDocumentJobsWithin,
} from "@/lib/services/document-ocr";
import {
  setSimFaultOverride,
  type SimFaultOverrideValue,
} from "@/lib/services/sim-fault-override";
import type { TokenPurpose } from "@/lib/services/tokens";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function unknownTarget(message: string): HttpProblem {
  return new HttpProblem(404, ERROR_CODES.notFound, message);
}

function cannotSatisfy(message: string): HttpProblem {
  return new HttpProblem(400, ERROR_CODES.validationError, message, { details: [message] });
}

function shiftedBack(value: Date, deltaMs: number): Date {
  return new Date(value.getTime() - deltaMs);
}

/** User row for a seam op, matched case-insensitively (INV-013 posture). */
async function requireUserByEmail(email: string): Promise<{ id: string }> {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) throw unknownTarget(`No account exists for ${email}`);
  return user;
}

// ---------------------------------------------------------------------------
// 1. backdate-workflow-state
// ---------------------------------------------------------------------------

/**
 * Rigid time-translation of the application's workflow timeline by -hours:
 * stateEnteredAt, slaPausedAt (when an open suspension exists), and EVERY
 * WorkflowHistory row move together. The SLA clock origin is reconstructed
 * from WorkflowHistory (src/lib/services/sla.ts deriveStateClock), so moving
 * only stateEnteredAt would not move the clock; moving every row uniformly
 * preserves row ordering, suspend/resume pairing, and accumulated suspended
 * time exactly (INV-012), while the current-state clock origin lands `hours`
 * in the past. State, assignment, versions, and audit history are untouched.
 */
export async function backdateWorkflowState(
  applicationId: string,
  hours: number,
): Promise<{ stateEnteredAt: string }> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, stateEnteredAt: true, slaPausedAt: true },
  });
  if (!app) throw unknownTarget("Application not found");

  const deltaMs = hours * HOUR_MS;
  const newEnteredAt = shiftedBack(app.stateEnteredAt, deltaMs);

  await prisma.$transaction(async (tx) => {
    const history = await tx.workflowHistory.findMany({
      where: { applicationId },
      select: { id: true, createdAt: true },
    });
    for (const row of history) {
      await tx.workflowHistory.update({
        where: { id: row.id },
        data: { createdAt: shiftedBack(row.createdAt, deltaMs) },
      });
    }
    await tx.application.update({
      where: { id: applicationId },
      data: {
        stateEnteredAt: newEnteredAt,
        ...(app.slaPausedAt !== null
          ? { slaPausedAt: shiftedBack(app.slaPausedAt, deltaMs) }
          : {}),
      },
    });
  });

  return { stateEnteredAt: newEnteredAt.toISOString() };
}

// ---------------------------------------------------------------------------
// 2. backdate-suspension
// ---------------------------------------------------------------------------

/**
 * Ages the OPEN suspension only: slaPausedAt (fallback: now) and the latest
 * "→ suspended" WorkflowHistory row move -hours. Earlier (closed) suspension
 * intervals keep their recorded accumulation untouched.
 */
export async function backdateSuspension(
  applicationId: string,
  hours: number,
): Promise<{ slaPausedAt: string }> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, workflowState: true, slaPausedAt: true },
  });
  if (!app) throw unknownTarget("Application not found");
  if (app.workflowState !== "suspended") {
    throw cannotSatisfy("backdate-suspension requires an application currently in suspended");
  }

  const deltaMs = hours * HOUR_MS;
  const newPausedAt = shiftedBack(app.slaPausedAt ?? new Date(), deltaMs);

  await prisma.$transaction(async (tx) => {
    const suspendRow = await tx.workflowHistory.findFirst({
      where: { applicationId, toState: "suspended" },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });
    if (suspendRow) {
      await tx.workflowHistory.update({
        where: { id: suspendRow.id },
        data: { createdAt: shiftedBack(suspendRow.createdAt, deltaMs) },
      });
    }
    await tx.application.update({
      where: { id: applicationId },
      data: { slaPausedAt: newPausedAt },
    });
  });

  return { slaPausedAt: newPausedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// 3. age-document-job
// ---------------------------------------------------------------------------

export async function ageDocumentJob(
  documentId: string,
  minutes: number,
  forceProcessing: boolean,
  reconcile: boolean,
): Promise<{ jobId: string; status: string; startedAt: string; markedFailed?: number }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, currentVersionId: true },
  });
  if (!document || document.currentVersionId === null) {
    throw unknownTarget("Document (with a current version) not found");
  }
  const job = await prisma.documentJob.findFirst({
    where: { documentVersionId: document.currentVersionId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, startedAt: true },
  });
  if (!job) throw unknownTarget("The document's current version has no job to age");

  const newStartedAt = shiftedBack(job.startedAt ?? new Date(), minutes * MINUTE_MS);
  const agingData = {
    startedAt: newStartedAt,
    // ASYNC-004: the stuck rule applies to `processing` rows only; forcing
    // the status clears completion bookkeeping so the aged job is coherent.
    ...(forceProcessing ? { status: "processing" as const, finishedAt: null } : {}),
  };

  if (!reconcile) {
    const updated = await prisma.documentJob.update({
      where: { id: job.id },
      data: agingData,
      select: { id: true, status: true, startedAt: true },
    });
    return {
      jobId: updated.id,
      status: updated.status,
      startedAt: (updated.startedAt ?? newStartedAt).toISOString(),
    };
  }

  // reconcile: true — the aging mutation AND one real ASYNC-004 stuck scan run
  // in ONE transaction, so the live scheduler can never observe the aged row in
  // a claimable `processing` state before the reconciler has failed it (the
  // race the plain forceProcessing path is exposed to: the runner claims the
  // aged row ~seconds later and overwrites the backdated startedAt). Inside the
  // transaction the scan sees this transaction's own aging write; outside it,
  // concurrent scans/claims see only terminal committed states. The scan is the
  // production reconciler's own core (reconcileStuckDocumentJobsWithin), NOT a
  // reimplementation; its §4.8.2 terminal supervisor fan-out runs post-commit
  // below, exactly as in the production entry point.
  let markedFailed = 0;
  let notifyAfterCommit: () => Promise<void> = async () => {};
  const settled = await prisma.$transaction(async (tx) => {
    await tx.documentJob.update({ where: { id: job.id }, data: agingData });
    const scan = await reconcileStuckDocumentJobsWithin(tx);
    markedFailed = scan.reconciled;
    notifyAfterCommit = scan.notifyAfterCommit;
    return tx.documentJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { id: true, status: true, startedAt: true },
    });
  });
  await notifyAfterCommit();

  return {
    jobId: settled.id,
    status: settled.status,
    startedAt: (settled.startedAt ?? newStartedAt).toISOString(),
    markedFailed,
  };
}

// ---------------------------------------------------------------------------
// 4. run-stuck-job-reconciler
// ---------------------------------------------------------------------------

/** One synchronous ASYNC-004 stuck-job scan (the worker's 5-minute tick, on demand). */
export async function runStuckJobReconciler(): Promise<{ markedFailed: number }> {
  const markedFailed = await reconcileStuckDocumentJobs();
  return { markedFailed };
}

// ---------------------------------------------------------------------------
// 5. age-application
// ---------------------------------------------------------------------------

/**
 * Moves Application.createdAt AND the per-section "last saved" timestamps
 * (Borrower.updatedAt / ApplicationData.updatedAt — the values the XBR-020
 * copy-staleness advisory compares against application.staleCopyThresholdDays)
 * `days` into the past.
 */
export async function ageApplication(
  applicationId: string,
  days: number,
): Promise<{ createdAt: string }> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, createdAt: true },
  });
  if (!app) throw unknownTarget("Application not found");

  const deltaMs = days * DAY_MS;
  const newCreatedAt = shiftedBack(app.createdAt, deltaMs);

  await prisma.$transaction(async (tx) => {
    await tx.application.update({
      where: { id: applicationId },
      data: { createdAt: newCreatedAt },
    });
    const borrowers = await tx.borrower.findMany({
      where: { applicationId },
      select: { id: true, updatedAt: true },
    });
    for (const borrower of borrowers) {
      await tx.borrower.update({
        where: { id: borrower.id },
        data: { updatedAt: shiftedBack(borrower.updatedAt, deltaMs) },
      });
    }
    const data = await tx.applicationData.findUnique({
      where: { applicationId },
      select: { id: true, updatedAt: true },
    });
    if (data) {
      await tx.applicationData.update({
        where: { applicationId },
        data: { updatedAt: shiftedBack(data.updatedAt, deltaMs) },
      });
    }
  });

  return { createdAt: newCreatedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// 6. age-token
// ---------------------------------------------------------------------------

/** Seam token kind → PasswordResetToken.purpose (src/lib/services/tokens.ts vocabulary). */
const TOKEN_KIND_TO_PURPOSE: Record<string, TokenPurpose> = {
  "email-verification": "verify-email",
  "password-reset": "reset",
  invitation: "invite",
  "email-change": "verify-new-email",
};

export type AgeTokenKind = keyof typeof TOKEN_KIND_TO_PURPOSE;

/**
 * Moves the outstanding (unused) token's issue time -minutes: createdAt AND
 * expiresAt shift together, so expiry = original TTL measured from the aged
 * issue moment — exactly the boundary the §4.6.11 windows define.
 */
export async function ageToken(
  kind: AgeTokenKind,
  email: string,
  minutes: number,
): Promise<{ expiresAt: string }> {
  const purpose = TOKEN_KIND_TO_PURPOSE[kind];
  const user = await requireUserByEmail(email);
  const token = await prisma.passwordResetToken.findFirst({
    where: { userId: user.id, purpose, usedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, expiresAt: true },
  });
  if (!token) {
    throw unknownTarget(`No outstanding ${kind} token exists for that address`);
  }

  const deltaMs = minutes * MINUTE_MS;
  const updated = await prisma.passwordResetToken.update({
    where: { id: token.id },
    data: {
      createdAt: shiftedBack(token.createdAt, deltaMs),
      expiresAt: shiftedBack(token.expiresAt, deltaMs),
    },
    select: { expiresAt: true },
  });

  return { expiresAt: updated.expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// 7. age-session
// ---------------------------------------------------------------------------

/**
 * Ages the account's most recently created active session: idleMinutes moves
 * lastSeenAt (the idle-expiry basis in src/lib/auth.ts), absoluteHours moves
 * createdAt AND expiresAt together (the absolute-expiry basis).
 */
export async function ageSession(
  email: string,
  idleMinutes: number | undefined,
  absoluteHours: number | undefined,
): Promise<{ idleExpiresAt: string; absoluteExpiresAt: string }> {
  if (idleMinutes === undefined && absoluteHours === undefined) {
    throw cannotSatisfy("age-session requires idleMinutes and/or absoluteHours");
  }
  const user = await requireUserByEmail(email);
  const session = await prisma.session.findFirst({
    where: { userId: user.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, lastSeenAt: true, createdAt: true, expiresAt: true },
  });
  if (!session) throw unknownTarget("No active session exists for that account");

  const data: Prisma.SessionUpdateInput = {};
  if (idleMinutes !== undefined) {
    data.lastSeenAt = shiftedBack(session.lastSeenAt, idleMinutes * MINUTE_MS);
  }
  if (absoluteHours !== undefined) {
    const deltaMs = absoluteHours * HOUR_MS;
    data.createdAt = shiftedBack(session.createdAt, deltaMs);
    data.expiresAt = shiftedBack(session.expiresAt, deltaMs);
  }
  const updated = await prisma.session.update({
    where: { id: session.id },
    data,
    select: { lastSeenAt: true, expiresAt: true },
  });

  const idleWindowMinutes = await getConfigNumber(
    CONFIG_KEYS.sessionIdleTimeoutMinutes,
    CONFIG_DEFAULTS[CONFIG_KEYS.sessionIdleTimeoutMinutes],
  );
  return {
    idleExpiresAt: new Date(updated.lastSeenAt.getTime() + idleWindowMinutes * MINUTE_MS).toISOString(),
    absoluteExpiresAt: updated.expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 8. set-simulation-fault
// ---------------------------------------------------------------------------

/** Seam provider name → SIM_FAULT_* integration key. */
const PROVIDER_TO_INTEGRATION: Record<string, string> = {
  credit: "CREDIT",
  income: "INCOME",
  avm: "AVM",
  aus: "AUS",
  pricing: "PRICING",
  ocr: "OCR",
};

export type SimulationFaultProvider = keyof typeof PROVIDER_TO_INTEGRATION;

/**
 * Per-provider fault modes DEFINED by the delivered mapping document
 * (task-048/simulation-mapping.md §Fault Scenarios tables, verbatim). "none"
 * (restore normal behavior) is defined for every provider. Pairs outside the
 * tables are rejected with 400.
 */
const DEFINED_FAULT_MODES: Record<SimulationFaultProvider, readonly string[]> = {
  credit: ["none", "partial", "unavailable", "timeout", "invalid-response"],
  income: ["none", "unavailable", "timeout", "invalid-response"],
  avm: ["none", "partial", "unavailable", "timeout"],
  aus: ["none", "unavailable", "timeout", "invalid-response"],
  pricing: ["none", "unavailable", "timeout", "invalid-response"],
  ocr: ["none", "slow", "timeout", "unavailable", "partial", "invalid-response"],
};

/** Seam mode vocabulary → env-style SIM_FAULT value ("invalid-response" → "invalid"). */
function toOverrideValue(mode: string): SimFaultOverrideValue {
  return (mode === "invalid-response" ? "invalid" : mode) as SimFaultOverrideValue;
}

export function setSimulationFault(
  provider: SimulationFaultProvider,
  mode: string,
): { provider: string; mode: string } {
  const defined = DEFINED_FAULT_MODES[provider];
  if (!defined.includes(mode)) {
    throw cannotSatisfy(
      `The delivered mapping document defines no "${mode}" fault mode for the ${provider} simulation`,
    );
  }
  setSimFaultOverride(PROVIDER_TO_INTEGRATION[provider]!, toOverrideValue(mode));
  return { provider, mode };
}

// ---------------------------------------------------------------------------
// 9. fail-next-audit-write
// ---------------------------------------------------------------------------

export function failNextAuditWrite(armed: boolean): { armed: boolean } {
  armFailNextAuditWrite(armed);
  return { armed };
}
