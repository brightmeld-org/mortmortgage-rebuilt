// Document-OCR job worker + lifecycle service (task-034 — REQ-067, NFR-014,
// INT-008, INT-019, XBR-016/017, WALK-001, ASYNC-001, ASYNC-004, AC-44).
//
// GET  /api/documents/:id/ocr        → OcrPanelResponse (job? + extraction?)
// POST /api/documents/:id/ocr/retry  → 202 DocumentJobInfo (manual Retry)
//
// ===========================================================================
// ASYNC-001 CONFORMANCE POSTURE (as implemented — no queue library exists in
// this build; pg-boss is NOT installed. Same pattern as ASYNC-005 in
// src/lib/services/underwriting-checks.ts; the durable worker/scheduler
// process is task-045, increment 11, which boots on the EXPORTED functions
// below):
//   - Row-before-response: the upload/replacement transactions in
//     src/lib/services/document.ts create the `queued` DocumentJob in the SAME
//     transaction as the DocumentVersion (XBR-016) — the job record exists
//     before the upload response returns. Manual Retry creates its queued row
//     before its 202 returns.
//   - Serial-per-key (idempotency key `document-ocr:{documentVersionId}`):
//     satisfied by the DATABASE — a partial unique index (migration
//     20260829130000) allows at most ONE job in queued/processing per document
//     version. A concurrent duplicate Retry hits P2002 and receives the
//     EXISTING active job (202, idempotent-while-in-flight); all status
//     transitions are GUARDED updateMany calls (row state is the authority,
//     never check-then-act).
//   - FSM (contracts stateTransitions.DocumentJobStatus): queued → processing
//     → completed | failed; failed → queued (automatic-retry requeue). Manual
//     Retry enqueues a NEW job row (attempt 0) — §4.7 "Retry re-enqueues the
//     job" — so it is available from ANY terminal state (failed or completed)
//     without violating the FSM; pending automatic retries of prior jobs for
//     the version are canceled when it supersedes them.
//   - Execution: after the enqueuing transaction commits, the provider seam
//     (src/lib/services/ocr) runs OUTSIDE any transaction; its returned
//     latencyMs (§6.3.7: 4 s ± 2, `slow` 45 s) is applied with a non-blocking
//     sleep, then the outcome is recorded in a SECOND transaction
//     (multi-tx-with-reconciler). The upload path hands the execution promise
//     to Next 15 `after()` (fallback: detached promise outside a request
//     scope) so responses return first.
//   - Retry policy (ASYNC-001: maxAttempts=5 — CONFIGURABLE via SystemConfig
//     `ocr.retryLimit`, read at enqueue time onto DocumentJob.maxAttempts —
//     exponential backoff, initial 30 s): a retryable failure with attempts
//     remaining PERSISTS the schedule on the row (nextRetryAt = finishedAt +
//     30s * 2^(attempt-1)). The in-process chain honors the real delay; the
//     scheduler (runDueDocumentJobs — boot/lazy/task-045) requeues any due row
//     a dead process left behind. The §6.3.7 `fail` trigger returns a NON-
//     retryable failure from attempt 3, ending the job `failed` after exactly
//     2 automatic retries; manual Retry is always available (AC-44).
//   - Reconciler (ASYNC-004 / WALK-001, 10-minute rule): jobs stuck in
//     `processing` longer than OCR_STUCK_THRESHOLD_MS are marked failed with a
//     retryable message (auto-requeued when attempts remain). Invoked LAZILY
//     on OCR API traffic, exported for boot wiring (task-045), idempotent and
//     fire-and-forget safe (guarded per-row updates; the next scan covers a
//     missed cycle).
//   - Fraud hook (XBR-017): after a completed extraction's transaction
//     COMMITS, evaluateOcrTriggers (src/lib/services/fraud.ts) runs in its OWN
//     transaction and never throws — a fraud failure can neither roll back nor
//     break the recorded extraction (same posture as the XBR-022 hook in
//     underwriting-checks).
// ===========================================================================
//
// RECORD-LEVEL SCOPING: route roleGate (caseworker/supervisor) is only the
// gate; a caseworker must hold the ACTIVE assignment for the document's
// application (403 otherwise); supervisors read/act on everything (S-4).
// Borrowers never reach OCR content — their visibility is the jobStatus badge
// on the borrower-visible Document serialization (document.ts toDocumentWire).
//
// LIVE-STATE: every provider input is assembled from the live rows — the
// version's file name + content hash and the application's ENTERED data
// (borrower name, decrypted DOB, SSN last-4, employment, assets, gift record)
// so §6.3.7 derived values genuinely match what the borrower typed.

import type { DocumentJob, OcrExtraction, Prisma } from "@prisma/client";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canReadApplication, canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { getNumberSetting } from "@/lib/services/config";
import { sleep } from "@/lib/services/bank-aggregator";
import { decryptField } from "@/lib/crypto/encryption";
import { formatDobDisplay } from "@/lib/crypto/masking";
import { evaluateOcrTriggers } from "@/lib/services/fraud";
import { notifyActiveSupervisors } from "@/lib/services/notifications";
import {
  attributionForProvider,
  getDocumentOcrProvider,
  type OcrEnteredData,
  type OcrExtractedField,
  type OcrExtractionRequest,
} from "@/lib/services/ocr";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ASYNC-004 / §4.7: jobs processing beyond 10 minutes are failed + retryable. */
export const OCR_STUCK_THRESHOLD_MS = 10 * 60_000;

/** ASYNC-001 retryPolicy.initialDelaySeconds = 30, exponential. */
export const OCR_RETRY_INITIAL_DELAY_MS = 30_000;

const STUCK_ERROR_MESSAGE =
  "The extraction did not complete within 10 minutes and was marked failed. It can be retried.";

/**
 * Exponential-backoff delay AFTER the given (1-based) failed attempt:
 * 30 s, 60 s, 120 s, 240 s, ... (ASYNC-001: exponential, initial 30 s).
 */
export function computeOcrBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return OCR_RETRY_INITIAL_DELAY_MS * 2 ** exponent;
}

// ---------------------------------------------------------------------------
// Wire shapes (contracts §A — exact field names)
// ---------------------------------------------------------------------------

export interface DocumentJobInfoWire {
  id: string;
  documentVersionId: string;
  status: "queued" | "processing" | "completed" | "failed";
  attempt: number;
  maxAttempts: number;
  provider?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface OcrExtractionInfoWire {
  id: string;
  documentVersionId: string;
  provider: string;
  providerAttribution: string;
  fields: OcrExtractedField[];
  createdAt: string;
}

export interface OcrPanelResponseWire {
  job?: DocumentJobInfoWire;
  extraction?: OcrExtractionInfoWire;
}

export function toDocumentJobInfo(row: DocumentJob): DocumentJobInfoWire {
  const info: DocumentJobInfoWire = {
    id: row.id,
    documentVersionId: row.documentVersionId,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
  };
  if (row.provider !== null) info.provider = row.provider;
  if (row.startedAt !== null) info.startedAt = row.startedAt.toISOString();
  if (row.finishedAt !== null) info.finishedAt = row.finishedAt.toISOString();
  if (row.error !== null) info.error = row.error;
  return info;
}

export function toOcrExtractionInfo(row: OcrExtraction): OcrExtractionInfoWire {
  return {
    id: row.id,
    documentVersionId: row.documentVersionId,
    provider: row.provider,
    providerAttribution: attributionForProvider(row.provider),
    // Stored verbatim by the worker in the §A OcrFieldResult[] shape.
    fields: Array.isArray(row.fields) ? (row.fields as unknown as OcrExtractedField[]) : [],
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Live provider-input assembly (LIVE-STATE rule)
// ---------------------------------------------------------------------------

function asObjectArray(value: Prisma.JsonValue | null | undefined): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Prisma.JsonObject => typeof row === "object" && row !== null && !Array.isArray(row),
  ) as Record<string, unknown>[];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface JobContext {
  job: DocumentJob;
  applicationId: string;
  documentId: string;
  documentType: string;
  fileName: string;
  contentSha256: string;
}

async function loadJobContext(jobId: string): Promise<JobContext | null> {
  const job = await prisma.documentJob.findUnique({
    where: { id: jobId },
    include: {
      documentVersion: {
        select: {
          id: true,
          originalFileName: true,
          sha256: true,
          document: { select: { id: true, applicationId: true, documentType: true } },
        },
      },
    },
  });
  if (!job) return null;
  const version = job.documentVersion;
  return {
    job,
    applicationId: version.document.applicationId,
    documentId: version.document.id,
    documentType: version.document.documentType,
    fileName: version.originalFileName,
    contentSha256: version.sha256 ?? version.id,
  };
}

/** Assemble the §6.3.7 ENTERED-data slice from the live application rows. */
async function assembleEnteredData(applicationId: string): Promise<OcrEnteredData> {
  const [borrower, data] = await Promise.all([
    prisma.borrower.findFirst({
      where: { applicationId, ordinal: 1 },
      select: {
        firstName: true,
        lastName: true,
        ssnLast4: true,
        dateOfBirthCiphertext: true,
        dateOfBirthKeyId: true,
        employments: true,
      },
    }),
    prisma.applicationData.findUnique({
      where: { applicationId },
      select: { assets: true, otherCredits: true },
    }),
  ]);

  // NFR-003 / SEC-2 BOUNDARY: the raw ISO DOB never leaves the identity-own
  // endpoint. The extraction simulation copies whatever it is handed straight
  // into OcrExtraction.fields — an UNENCRYPTED JSON column that is then
  // serialised verbatim by toOcrExtractionInfo — so the ISO form is converted
  // to the "Mon D, YYYY" display form HERE, before it can enter the pure core.
  // The pure simulation module (src/lib/pure/simulations/ocr.ts) must not
  // import @/lib/crypto/masking: it is a declared pure core ("No DB, no clock,
  // no env"). Converting at the boundary covers BOTH live-PII emission sites
  // (the government-id spec and fixtureFieldSpecs), because both read
  // OcrEnteredData.dateOfBirth.
  let dateOfBirth: string | null = null;
  if (borrower?.dateOfBirthCiphertext && borrower.dateOfBirthKeyId) {
    try {
      dateOfBirth = formatDobDisplay(
        decryptField({
          ciphertext: borrower.dateOfBirthCiphertext,
          keyId: borrower.dateOfBirthKeyId,
        }),
      );
    } catch (err) {
      // Tolerated: the simulation falls back to a synthetic unmapped DOB.
      console.error(`document-ocr: DOB decrypt failed for application ${applicationId}`, err);
    }
  }

  const fullName = borrower
    ? `${borrower.firstName ?? ""} ${borrower.lastName ?? ""}`.trim()
    : "";
  const employment = asObjectArray(borrower?.employments).find((e) => str(e.employerName) !== null);
  const asset = asObjectArray(data?.assets).find(
    (a) => str(a.financialInstitution) !== null || num(a.cashOrMarketValue) !== null,
  );
  const gift = asObjectArray(data?.otherCredits).find(
    (c) => c.type === "gift-of-cash" || c.type === "gift-of-equity",
  );

  return {
    borrowerFullName: fullName.length > 0 ? fullName : null,
    dateOfBirth,
    ssnLast4: str(borrower?.ssnLast4),
    employerName: str(employment?.employerName),
    baseMonthlyIncome: num(employment?.baseMonthlyIncome),
    bankInstitution: str(asset?.financialInstitution),
    accountLast4: str(asset?.accountNumberLast4),
    accountBalance: num(asset?.cashOrMarketValue),
    giftDonor: str(gift?.sourceOrDonor),
    giftAmount: num(gift?.value),
  };
}

// ---------------------------------------------------------------------------
// Reconciler (ASYNC-004 / WALK-001 — 10-minute stuck rule)
// ---------------------------------------------------------------------------

/**
 * Mark DocumentJobs stuck in `processing` longer than the threshold as failed
 * with a retryable message; jobs with automatic attempts remaining become due
 * immediately (nextRetryAt = now) so the next scheduler pass requeues them.
 * Idempotent and cheap when nothing is stuck (one indexed query — WALK-001).
 * Invoked lazily on OCR API traffic and EXPORTED for boot/scheduled wiring by
 * the task-045 worker (ASYNC-004 global-singleton scan, fire-and-forget safe).
 *
 * @returns the number of jobs reconciled.
 */
export async function reconcileStuckDocumentJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - OCR_STUCK_THRESHOLD_MS);
  const stuck = await findStuckDocumentJobs(prisma, cutoff);
  if (stuck.length === 0) return 0;

  const { reconciled, terminalRefs } = await prisma.$transaction((tx) =>
    failStuckDocumentJobs(tx, stuck, cutoff),
  );

  // Post-commit §4.8.2 fan-out (durable-fact sequencing; helper never throws).
  for (const ref of terminalRefs) {
    await notifySupervisorsOfTerminalOcrFailure(ref);
  }
  return reconciled;
}

/**
 * Reconciler core for a caller that must run the stuck scan INSIDE an existing
 * transaction — the test-fixtures seam's atomic `age-document-job` +
 * `reconcile: true` (task-046 op 3), which must never let the live scheduler
 * observe an aged row in a claimable state before the scan has failed it.
 * Same predicate and action as reconcileStuckDocumentJobs — the shared
 * findStuckDocumentJobs / failStuckDocumentJobs helpers — except the scan runs
 * on the caller's transaction client, so it also sees that transaction's own
 * uncommitted writes. The §4.8.2 terminal fan-out must stay post-commit, so it
 * is returned as a callback: invoke `notifyAfterCommit()` once the wrapping
 * transaction has committed, never inside it.
 */
export async function reconcileStuckDocumentJobsWithin(
  tx: Prisma.TransactionClient,
): Promise<{ reconciled: number; notifyAfterCommit: () => Promise<void> }> {
  const cutoff = new Date(Date.now() - OCR_STUCK_THRESHOLD_MS);
  const stuck = await findStuckDocumentJobs(tx, cutoff);
  if (stuck.length === 0) return { reconciled: 0, notifyAfterCommit: async () => {} };

  const { reconciled, terminalRefs } = await failStuckDocumentJobs(tx, stuck, cutoff);
  return {
    reconciled,
    notifyAfterCommit: async () => {
      for (const ref of terminalRefs) {
        await notifySupervisorsOfTerminalOcrFailure(ref);
      }
    },
  };
}

/** Row shape of the ASYNC-004 stuck scan (shared by both reconciler entry points). */
const STUCK_JOB_SELECT = {
  id: true,
  attempt: true,
  maxAttempts: true,
  documentVersionId: true,
  documentVersion: {
    select: {
      originalFileName: true,
      document: { select: { applicationId: true, documentType: true } },
    },
  },
} satisfies Prisma.DocumentJobSelect;

type StuckJobRow = Prisma.DocumentJobGetPayload<{ select: typeof STUCK_JOB_SELECT }>;

/** The ASYNC-004 stuck predicate: one indexed query (WALK-001). */
function findStuckDocumentJobs(
  db: Prisma.TransactionClient,
  cutoff: Date,
): Promise<StuckJobRow[]> {
  return db.documentJob.findMany({
    where: { status: "processing", startedAt: { lt: cutoff } },
    select: STUCK_JOB_SELECT,
  });
}

/**
 * The ASYNC-004 stuck action: guarded per-row fail + audit inside the caller's
 * transaction. Returns the reconciled count and the §4.8.2 terminal refs for
 * the caller to fan out AFTER its transaction commits.
 */
async function failStuckDocumentJobs(
  tx: Prisma.TransactionClient,
  stuck: StuckJobRow[],
  cutoff: Date,
): Promise<{ reconciled: number; terminalRefs: TerminalOcrFailureRef[] }> {
  let reconciled = 0;
  // §4.8.2: a stuck failure with NO attempts remaining is a terminal failure —
  // collected here and fanned out to supervisors AFTER the transaction commits.
  const terminalRefs: TerminalOcrFailureRef[] = [];
  for (const row of stuck) {
    const now = new Date();
    const terminal = row.attempt >= row.maxAttempts;
    // Guarded per-row update: a job that completed between the scan and this
    // transaction is left alone (idempotent — ASYNC-004 posture). The same
    // guard makes the terminal alert exactly-once: a re-run never matches a
    // row that is no longer `processing`.
    const updated = await tx.documentJob.updateMany({
      where: { id: row.id, status: "processing", startedAt: { lt: cutoff } },
      data: {
        status: "failed",
        finishedAt: now,
        error: STUCK_ERROR_MESSAGE,
        nextRetryAt: terminal ? null : now,
      },
    });
    if (updated.count === 0) continue;
    reconciled += 1;
    if (terminal) {
      terminalRefs.push({
        applicationId: row.documentVersion.document.applicationId,
        documentType: row.documentVersion.document.documentType,
        fileName: row.documentVersion.originalFileName,
        documentVersionId: row.documentVersionId,
        attempt: row.attempt,
      });
    }
    await audit(tx as AuditTransactionClient, {
      actor: null,
      role: "SYSTEM",
      actionType: "ocr-job",
      applicationId: row.documentVersion.document.applicationId,
      entityType: "DocumentJob",
      entityId: row.id,
      summary: terminal
        ? `OCR job marked failed by the stuck-job reconciler — processing longer than 10 minutes on attempt ${row.attempt} of ${row.maxAttempts}; no automatic retries remaining; manual Retry available`
        : `OCR job marked failed by the stuck-job reconciler — processing longer than 10 minutes on attempt ${row.attempt} of ${row.maxAttempts}; retry available`,
    });
  }
  return { reconciled, terminalRefs };
}

// ---------------------------------------------------------------------------
// Single-attempt processor (the worker step)
// ---------------------------------------------------------------------------

export type ProcessJobResult =
  | "completed"
  | "failed-retryable"
  | "failed-final"
  | "not-claimed"
  | "skipped";

/**
 * Run ONE attempt of a queued job: claim it (guarded queued → processing with
 * attempt increment — the row state is the serial-per-key authority), call the
 * provider seam OUTSIDE any transaction, apply its latency with a non-blocking
 * sleep, then record the outcome in a second transaction. On a completed
 * extraction the XBR-017 fraud evaluation runs post-commit in its own
 * transaction (never throws, never rolls back the extraction).
 *
 * Exported for the task-045 worker and for evidence-level drives.
 */
export async function processDocumentJobOnce(jobId: string): Promise<ProcessJobResult> {
  const provider = getDocumentOcrProvider();

  // Claim: guarded FSM transition queued → processing. Losing the race (or a
  // non-queued row) is a no-op — whoever claimed it owns this attempt.
  const claimed = await prisma.documentJob.updateMany({
    where: { id: jobId, status: "queued" },
    data: {
      status: "processing",
      startedAt: new Date(),
      attempt: { increment: 1 },
      provider: provider.name,
      error: null,
      nextRetryAt: null,
    },
  });
  if (claimed.count === 0) return "not-claimed";

  const ctx = await loadJobContext(jobId);
  if (!ctx) return "skipped";
  const attempt = ctx.job.attempt;

  // Provider call + §6.3.7 latency — genuinely called, OUTSIDE any transaction
  // (ASYNC DISPATCH rule). Unexpected provider-layer errors record a retryable
  // failure; a crash mid-flight is covered by the 10-minute reconciler.
  let outcome: Awaited<ReturnType<typeof provider.run>>;
  try {
    const request: OcrExtractionRequest = {
      documentType: ctx.documentType,
      fileName: ctx.fileName,
      contentSha256: ctx.contentSha256,
      attempt,
      referenceDate: new Date(),
      entered: await assembleEnteredData(ctx.applicationId),
    };
    outcome = await provider.run(request);
    await sleep(outcome.latencyMs);
  } catch (err) {
    console.error(`document-ocr job ${jobId}: provider execution error`, err);
    outcome = {
      ok: false,
      failure: {
        code: "unavailable",
        message: "The extraction failed unexpectedly. Retry the extraction.",
        retryable: true,
      },
      latencyMs: 0,
    };
  }

  const finishedAt = new Date();

  if (outcome.ok) {
    const fields = outcome.fields;
    const rawText = outcome.rawText;
    const recorded = await prisma.$transaction(async (tx) => {
      const updated = await tx.documentJob.updateMany({
        where: { id: jobId, status: "processing" },
        data: { status: "completed", finishedAt, error: null, nextRetryAt: null },
      });
      if (updated.count === 0) return false; // reconciled meanwhile — leave alone
      await tx.ocrExtraction.create({
        data: {
          documentVersionId: ctx.job.documentVersionId,
          provider: provider.name,
          // VERBATIM §A OcrFieldResult[] wire payload.
          fields: fields as unknown as Prisma.InputJsonValue,
          rawText,
        },
      });
      await audit(tx as AuditTransactionClient, {
        actor: null,
        role: "SYSTEM",
        actionType: "ocr-job",
        applicationId: ctx.applicationId,
        entityType: "DocumentJob",
        entityId: jobId,
        summary: `OCR extraction completed for ${ctx.documentType} "${ctx.fileName}" — ${fields.length} field(s), attempt ${attempt} of ${ctx.job.maxAttempts}, provider ${provider.name}`,
      });
      return true;
    });
    if (!recorded) return "skipped";

    // XBR-017: post-commit, own transaction, never throws (INV-018 posture) —
    // the `mismatch` fraud flag flows through fraud.ts, never created by hand.
    await evaluateOcrTriggers(ctx.job.documentVersionId);
    return "completed";
  }

  const retryScheduled = outcome.failure.retryable && attempt < ctx.job.maxAttempts;
  const nextRetryAt = retryScheduled
    ? new Date(finishedAt.getTime() + computeOcrBackoffMs(attempt))
    : null;
  const recorded = await prisma.$transaction(async (tx) => {
    const updated = await tx.documentJob.updateMany({
      where: { id: jobId, status: "processing" },
      data: { status: "failed", finishedAt, error: outcome.failure.message, nextRetryAt },
    });
    if (updated.count === 0) return false;
    await audit(tx as AuditTransactionClient, {
      actor: null,
      role: "SYSTEM",
      actionType: "ocr-job",
      applicationId: ctx.applicationId,
      entityType: "DocumentJob",
      entityId: jobId,
      summary: retryScheduled
        ? `OCR extraction failed for ${ctx.documentType} "${ctx.fileName}" on attempt ${attempt} of ${ctx.job.maxAttempts} — automatic retry scheduled with exponential backoff; ${outcome.failure.message}`
        : `OCR extraction failed for ${ctx.documentType} "${ctx.fileName}" after attempt ${attempt} of ${ctx.job.maxAttempts} — no further automatic retries; manual Retry available; ${outcome.failure.message}`,
    });
    return true;
  });
  if (!recorded) return "skipped";

  // §4.8.2 supervisor trigger "OCR job failure after max retries": the
  // terminal-failure state is COMMITTED above (a durable fact) before the
  // fan-out runs, in its own transaction through the task-036 single
  // notification service. Never throws — an alert failure must not disturb
  // the recorded job state (same posture as the XBR-017 fraud hook).
  // Exactly-once per terminal event: only the caller that won the guarded
  // processing → failed transition with no retry scheduled reaches this.
  if (!retryScheduled) {
    await notifySupervisorsOfTerminalOcrFailure({
      applicationId: ctx.applicationId,
      documentType: ctx.documentType,
      fileName: ctx.fileName,
      documentVersionId: ctx.job.documentVersionId,
      attempt,
    });
  }
  return retryScheduled ? "failed-retryable" : "failed-final";
}

/** What the §4.8.2 terminal-failure fan-out needs to describe the event. */
interface TerminalOcrFailureRef {
  applicationId: string;
  documentType: string;
  fileName: string;
  documentVersionId: string;
  /** 1-based attempt count at the moment the job became terminally failed. */
  attempt: number;
}

/**
 * Post-commit §4.8.2 fan-out to all active Supervisors through the task-036
 * single notification service. Never throws. Called from BOTH terminal-failure
 * producers — the worker's final-failure branch and the stuck reconciler's
 * attempts-exhausted branch — always AFTER the failed state has committed.
 */
async function notifySupervisorsOfTerminalOcrFailure(ref: TerminalOcrFailureRef): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const application = await tx.application.findUnique({
        where: { id: ref.applicationId },
        select: { applicationNumber: true },
      });
      await notifyActiveSupervisors(tx, {
        type: "ocr-job-failed",
        title: "Document extraction failed",
        body:
          `OCR extraction for the ${ref.documentType} document "${ref.fileName}" on application ` +
          `${application?.applicationNumber ?? ref.applicationId} failed permanently after ` +
          `${ref.attempt} attempt(s) with no automatic retries remaining. Manual Retry is available ` +
          "on the document's OCR panel.",
        applicationId: ref.applicationId,
      });
    });
  } catch (err) {
    console.error(
      `document-ocr job for version ${ref.documentVersionId}: supervisor alert failed`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// In-process execution chain (upload/Retry handoff) + scheduler pass
// ---------------------------------------------------------------------------

/** Safety cap on chained attempts within one in-process execution. */
const CHAIN_MAX_STEPS = 25;

/**
 * Drive a job through its attempts IN PROCESS: run an attempt; on a retryable
 * failure honor the PERSISTED backoff (real sleep — the schedule stays honest
 * in dev), requeue with the guarded FSM transition failed → queued, and run
 * the next attempt. Every transition is guarded, so a concurrent scheduler
 * pass (or a manual Retry superseding this job) simply wins the race and this
 * chain exits. Never rejects.
 */
export async function runDocumentJobChain(jobId: string): Promise<void> {
  try {
    for (let step = 0; step < CHAIN_MAX_STEPS; step += 1) {
      const result = await processDocumentJobOnce(jobId);
      if (result !== "failed-retryable") return;

      const row = await prisma.documentJob.findUnique({
        where: { id: jobId },
        select: { nextRetryAt: true },
      });
      if (!row?.nextRetryAt) return; // canceled or superseded
      await sleep(Math.max(0, row.nextRetryAt.getTime() - Date.now()));

      // Guarded requeue (failed → queued) only while the persisted schedule is
      // still due — a manual Retry cancels it; the partial unique index turns a
      // race with a superseding active job into P2002 (handled: chain exits).
      try {
        const requeued = await prisma.documentJob.updateMany({
          where: { id: jobId, status: "failed", nextRetryAt: { lte: new Date() } },
          data: { status: "queued" },
        });
        if (requeued.count === 0) return;
      } catch {
        return; // active sibling job exists (P2002) — superseded
      }
    }
  } catch (err) {
    // Last resort: the reconciler/scheduler covers whatever state remains.
    console.error(`document-ocr job ${jobId}: execution chain error`, err);
  }
}

/**
 * Hand a job's execution chain to Next 15 `after()` so the enclosing response
 * returns first (ASYNC-001 row-before-response). Outside a request scope
 * (evidence scripts, the task-045 worker) `after()` throws — the chain then
 * runs as a detached promise instead.
 */
export function handOffOcrJobExecution(jobId: string): void {
  const work = () => runDocumentJobChain(jobId);
  try {
    after(work);
  } catch {
    void work();
  }
}

export interface DueJobsRunSummary {
  reconciled: number;
  requeued: number;
  processed: number;
}

/**
 * One scheduler pass (exported for task-045 boot/scheduled wiring; invoked
 * lazily on OCR API traffic so polling keeps the pipeline moving in dev):
 *   1. reconcile jobs stuck in processing (10-minute rule),
 *   2. requeue failed jobs whose persisted backoff schedule is due
 *      (failed → queued, guarded; P2002 = superseded by a newer active job),
 *   3. run one attempt for queued jobs (oldest first, bounded batch).
 * Idempotent and safe to run concurrently — every transition is guarded.
 */
export async function runDueDocumentJobs(batchSize = 5): Promise<DueJobsRunSummary> {
  const reconciled = await reconcileStuckDocumentJobs();

  let requeued = 0;
  const due = await prisma.documentJob.findMany({
    where: { status: "failed", nextRetryAt: { lte: new Date() } },
    orderBy: { nextRetryAt: "asc" },
    take: batchSize,
    select: { id: true },
  });
  for (const row of due) {
    try {
      const updated = await prisma.documentJob.updateMany({
        where: { id: row.id, status: "failed", nextRetryAt: { lte: new Date() } },
        data: { status: "queued" },
      });
      requeued += updated.count;
    } catch {
      // P2002: a newer active job exists for the version — cancel the schedule.
      await prisma.documentJob.updateMany({
        where: { id: row.id, status: "failed" },
        data: { nextRetryAt: null },
      });
    }
  }

  let processed = 0;
  const queued = await prisma.documentJob.findMany({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true },
  });
  for (const row of queued) {
    const result = await processDocumentJobOnce(row.id);
    if (result !== "not-claimed" && result !== "skipped") processed += 1;
  }

  return { reconciled, requeued, processed };
}

// ---------------------------------------------------------------------------
// Access scoping shared by the two OCR endpoints
// ---------------------------------------------------------------------------

interface ScopedDocument {
  id: string;
  applicationId: string;
  currentVersionId: string;
}

async function requireOcrDocumentAccess(
  user: SessionUser,
  documentId: string,
  mode: "read" | "write",
): Promise<ScopedDocument> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, applicationId: true, currentVersionId: true },
  });
  if (!doc || !doc.currentVersionId) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Document not found");
  }

  const denial = (reason: "not-found" | "not-owner" | "not-assigned"): never => {
    if (reason === "not-assigned") {
      throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
    }
    // not-found / not-owner: 404, no existence disclosure.
    throw new HttpProblem(404, ERROR_CODES.notFound, "Document not found");
  };
  if (mode === "write") {
    const access = await canWriteApplication(user, doc.applicationId);
    if (!access.allowed) denial(access.reason);
  } else {
    const access = await canReadApplication(user, doc.applicationId);
    if (!access.allowed) denial(access.reason);
    else if (access.level !== "full") {
      // S-2b summary-level (unassigned claimable) never exposes OCR content.
      throw new HttpProblem(
        403,
        ERROR_CODES.forbidden,
        "Claim this application to view its OCR results",
      );
    }
  }
  return { id: doc.id, applicationId: doc.applicationId, currentVersionId: doc.currentVersionId };
}

// ---------------------------------------------------------------------------
// GET /api/documents/:id/ocr — OcrPanelResponse
// ---------------------------------------------------------------------------

/**
 * Latest job + latest extraction for the document's CURRENT version (XBR-016:
 * checklist and OCR always operate on the current version). Either member may
 * be absent (§B: both optional) — e.g. a job still running has no extraction
 * yet. Poll-friendly; the route lazily kicks the scheduler pass via after().
 */
export async function getOcrPanel(
  user: SessionUser,
  documentId: string,
): Promise<OcrPanelResponseWire> {
  const doc = await requireOcrDocumentAccess(user, documentId, "read");

  const [job, extraction] = await Promise.all([
    prisma.documentJob.findFirst({
      where: { documentVersionId: doc.currentVersionId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.ocrExtraction.findFirst({
      where: { documentVersionId: doc.currentVersionId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const response: OcrPanelResponseWire = {};
  if (job) response.job = toDocumentJobInfo(job);
  if (extraction) response.extraction = toOcrExtractionInfo(extraction);
  return response;
}

// ---------------------------------------------------------------------------
// POST /api/documents/:id/ocr/retry — manual Retry (202 DocumentJobInfo)
// ---------------------------------------------------------------------------

export interface RetryOcrResult {
  /**
   * false = a job for the current version is already active (queued or
   * processing) and this request was idempotently answered with it — no new
   * job, no audit. Both variants respond 202 with DocumentJobInfo.
   */
  started: boolean;
  info: DocumentJobInfoWire;
  /**
   * The execution chain, already in flight and never rejecting. Routes hand it
   * to next/server `after()` so the 202 returns first; evidence scripts await
   * it directly. Null when started=false.
   */
  execution: Promise<void> | null;
}

/**
 * §4.7 "manual retry always allowed" (AC-44): enqueue a NEW DocumentJob
 * (attempt 0, maxAttempts from live SystemConfig `ocr.retryLimit`) for the
 * document's current version, canceling any pending automatic-retry schedule
 * it supersedes. Duplicate-in-flight requests are decided by the DB partial
 * unique index, never check-then-act. Audited with the SESSION actor.
 */
export async function retryDocumentOcr(
  user: SessionUser,
  documentId: string,
  meta: RequestMetaBundle,
): Promise<RetryOcrResult> {
  const doc = await requireOcrDocumentAccess(user, documentId, "write");

  // Lazy reconciler pass: a job stuck in `processing` must not shadow the
  // Retry as "already active" forever (ASYNC-004 crash recovery).
  await reconcileStuckDocumentJobs();

  const maxAttempts = await getNumberSetting("ocr.retryLimit");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const active = await prisma.documentJob.findFirst({
      where: { documentVersionId: doc.currentVersionId, status: { in: ["queued", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return { started: false, info: toDocumentJobInfo(active), execution: null };

    try {
      const job = await prisma.$transaction(async (tx) => {
        // Cancel pending automatic retries of the jobs this Retry supersedes —
        // exactly one pending path per version (serial-per-key).
        await tx.documentJob.updateMany({
          where: { documentVersionId: doc.currentVersionId, nextRetryAt: { not: null } },
          data: { nextRetryAt: null },
        });
        const created = await tx.documentJob.create({
          data: {
            documentVersionId: doc.currentVersionId,
            status: "queued",
            attempt: 0,
            maxAttempts,
          },
        });
        await audit(tx as AuditTransactionClient, {
          actor: user.userId,
          role: user.role,
          actionType: "ocr-job",
          applicationId: doc.applicationId,
          entityType: "DocumentJob",
          entityId: created.id,
          summary: `Manual OCR retry requested — new job enqueued for the current document version, up to ${maxAttempts} automatic attempt(s)`,
          ip: meta.ip,
          requestId: meta.requestId,
        });
        return created;
      });
      return { started: true, info: toDocumentJobInfo(job), execution: runDocumentJobChain(job.id) };
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
        continue; // an active job appeared concurrently — return it on re-read
      }
      throw err;
    }
  }
  throw new HttpProblem(
    409,
    ERROR_CODES.conflict,
    "An extraction job is already running for this document",
  );
}
