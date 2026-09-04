/**
 * §7.7 — the OCR ten-minute stuck rule (ASYNC-004, REQ-067, NFR-014).
 * Depends on the sanctioned test-only fixture seam — see task-046/test-fixtures-contract.md.
 *
 * Observation model: the stuck rule is asserted from the RESPONSE of the atomic
 * `age-document-job` + `reconcile: true` operation, which ages the job and runs one
 * stuck-job reconciler scan inside a single database transaction (op 3 of the seam
 * contract). A later poll of job state is deliberately NOT the oracle: when the job
 * the reconciler failed still has attempts remaining, the reconciler sets its retry
 * due immediately, so the live job runner may legitimately requeue it seconds later.
 * The settled state carried by the atomic response is the deterministic observation.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { requireSeam, seam } from "../helpers/seam.js";
import { GET, POST, expectOk } from "../helpers/http.js";
import { enums, jobTransitions } from "../helpers/contract.js";
import {
  buildSubmittableDraft,
  claim,
  pdfBytes,
  transitionOk,
  uploadDocument,
  type Application,
} from "../helpers/application.js";

const PREFIX = suitePrefix("stuck");
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

let supervisor: Session;
let caseworker: Session;
let application: Application;

/** The `age-document-job` response when `reconcile: true` (seam contract op 3). */
interface AgedJob {
  ok: boolean;
  jobId: string;
  status: string;
  startedAt: string;
  markedFailed: number;
}

/**
 * Ages the document's current-version job and runs one reconciler scan atomically.
 * The returned settled state is what the assertions read — no read-back race.
 */
async function ageAndReconcile(documentId: string, minutes: number): Promise<AgedJob> {
  const result = (await seam("age-document-job", {
    documentId,
    minutes,
    forceProcessing: true,
    reconcile: true,
  })) as unknown as AgedJob;
  assert.equal(result.ok, true);
  assert.equal(typeof result.jobId, "string", "the seam must name the job it aged");
  assert.ok(result.jobId.length > 0);
  assert.equal(typeof result.markedFailed, "number", "`reconcile: true` must carry the op-4 count");
  assert.ok(
    enums.DocumentJobStatus.includes(result.status),
    `post-reconcile status ${result.status} must be a contract DocumentJobStatus`,
  );
  return result;
}

/**
 * Waits until the live worker has finished with the job.
 *
 * Aging a job the worker is still driving is a race: the worker writes its own
 * startedAt when it moves to the next attempt, which undoes the backdating before the
 * reconciler ever sees it. Once the job is terminal nothing else is touching the row,
 * so `age-document-job` with forceProcessing produces a stable stuck job.
 */
async function awaitSettled(documentId: string, timeoutMs = 240000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await job(documentId);
    if (current && ["completed", "failed"].includes(current.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`document ${documentId} job never reached a terminal status`);
}

async function job(documentId: string): Promise<{ status: string; attempt: number; maxAttempts: number } | undefined> {
  const path = `/api/documents/${documentId}/ocr`;
  const panel = expectOk(
    await GET<{ job?: { status: string; attempt: number; maxAttempts: number } }>(path, { session: caseworker }),
    path,
    200,
  );
  return panel.job;
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  await requireSeam();

  const borrower = (await registerBorrower(supervisor, `${PREFIX}-b1`)).session;
  const draft = await buildSubmittableDraft(borrower);
  application = await transitionOk(borrower, draft.id, {
    toState: "application_received",
    versionStamp: draft.versionStamp,
  });
  expectOk(await claim(caseworker, application.id), "claim", 201);
});

describe("§7.7 stuck-job reconciler (ASYNC-004)", () => {
  test("the contract's job map allows exactly processing → failed and failed → queued", () => {
    assert.deepEqual(jobTransitions.processing.sort(), ["completed", "failed"]);
    assert.deepEqual(jobTransitions.failed, ["queued"]);
    assert.equal(jobTransitions.completed, undefined, "completed is terminal");
  });

  test("a job processing beyond ten minutes is marked failed and becomes retryable", { timeout: 300000 }, async () => {
    const upload = await uploadDocument(caseworker, application.id, "stuck-probe.pdf", pdfBytes(2400), "pay-stub");
    const document = expectOk(upload, "upload", 201);
    await awaitSettled(document.id);

    // Aged to eleven minutes — past the ten-minute rule — and reconciled in the same
    // transaction, so no other transaction can ever see the aged row in a claimable state.
    const aged = await ageAndReconcile(document.id, 11);

    const agedByMs = Date.now() - Date.parse(aged.startedAt);
    assert.ok(
      Number.isFinite(agedByMs) && agedByMs >= STUCK_THRESHOLD_MS,
      `the seam must have aged startedAt past ten minutes, got ${aged.startedAt}`,
    );
    assert.equal(aged.status, "failed", "a job stuck past ten minutes must be marked failed");
    assert.ok(aged.markedFailed >= 1, `the reconciler must have failed the stuck job, got ${aged.markedFailed}`);

    // "Becomes retryable": the contract's only outbound edge from failed is queued, and
    // the manual retry affordance must accept the job.
    assert.deepEqual(jobTransitions[aged.status], ["queued"]);
    const retryPath = `/api/documents/${document.id}/ocr/retry`;
    const retry = await POST<{ id: string; status: string }>(retryPath, { session: caseworker });
    assert.equal(retry.status, 202, `a failed job must be retryable: ${retry.text.slice(0, 200)}`);
    assert.equal(typeof retry.body?.id, "string", "retry must return the tracked DocumentJob (SEC-13)");
    assert.ok(
      enums.DocumentJobStatus.includes(retry.body.status),
      `retry status ${retry.body?.status} must be a contract DocumentJobStatus`,
    );
  });

  test("a job processing for less than ten minutes is left alone", { timeout: 300000 }, async () => {
    const upload = await uploadDocument(caseworker, application.id, "not-stuck.pdf", pdfBytes(2400), "w2");
    const document = expectOk(upload, "upload", 201);
    await awaitSettled(document.id);

    // Nine minutes is inside the boundary; the same atomic scan must leave it alone.
    const aged = await ageAndReconcile(document.id, 9);

    assert.equal(aged.status, "processing", "nine minutes is inside the ten-minute rule and must not be failed");
    assert.equal(aged.markedFailed, 0, "nothing was stuck, so the scan must have failed nothing");

    // Hand the job back to the runner so this test leaves no row parked just short of
    // the boundary for a later test's scan to trip over.
    const retryPath = `/api/documents/${document.id}/ocr/retry`;
    const retry = await POST(retryPath, { session: caseworker });
    assert.equal(retry.status, 202, `manual retry must be accepted: ${retry.text.slice(0, 200)}`);
  });

  test("the reconciler is idempotent — a second scan changes nothing", { timeout: 300000 }, async () => {
    const upload = await uploadDocument(caseworker, application.id, "idempotent.pdf", pdfBytes(2400), "w2");
    const document = expectOk(upload, "upload", 201);
    await awaitSettled(document.id);

    const aged = await ageAndReconcile(document.id, 20);
    assert.equal(aged.status, "failed", "twenty minutes is past the rule and must be marked failed");
    assert.ok(aged.markedFailed >= 1, `the first scan must have failed the stuck job, got ${aged.markedFailed}`);

    const second = await seam("run-stuck-job-reconciler");
    assert.equal(second.ok, true);
    assert.equal(
      second.markedFailed,
      0,
      `a repeated scan must not mark an already-handled job again, got ${String(second.markedFailed)}`,
    );
  });
});
