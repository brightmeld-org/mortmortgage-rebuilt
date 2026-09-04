// Background worker (task-045 — ASYNC-001..005, §7.1 "background jobs run via a
// worker process", NFR-027).
//
// THE durable execution layer for every async operation. The web app's lazy
// in-process execution (OCR routes, notification/outbound GETs, post-commit
// after() hand-offs) keeps demos moving without this process; the worker makes
// execution DURABLE: it does not depend on API traffic, survives web restarts,
// and re-drives work a crashed instance abandoned.
//
// Boot: every exported reconciler runs ONCE —
//   reconcileStuckDocumentJobs      (ASYNC-004/WALK-001: >10min processing -> failed+retryable)
//   runDueDocumentJobs              (ASYNC-001: due-retry requeue + queued-job execution)
//   reconcileDueNotificationDeliveries (ASYNC-002/WALK-002: due pending deliveries + orphans)
//   reconcileStuckDecisionDispatches   (ASYNC-003: approved/denied with dispatch pending)
//   reconcileStuckUnderwritingChecks   (ASYNC-005: in-flight check rows past their lease)
// Then a polling loop (WORKER_POLL_INTERVAL_MS, default 20s) drives the same
// set continuously.
//
// CONCURRENCY SAFETY: the worker adds NO scheduling state of its own — the
// DB rows remain the serial-per-key authorities (guarded updateMany claims,
// partial unique indexes, versionStamp WHERE clauses). Running the worker
// alongside the web app's lazy execution, or TWO workers side by side, cannot
// double-execute work: a lost claim matches 0 rows and is skipped. Proven by
// verification/increment-11/task-045/02_worker_two_instance.ts.
//
// Shutdown (SIGTERM/SIGINT): stop scheduling, let the in-flight pass finish
// (10s cap), prisma.$disconnect(), exit 0.
//
// Logs: single-line JSON via the shared helper (src/lib/log.ts) — same stream
// contract as the web side, no PII.

import { prisma } from "@/lib/prisma";
import { logError, logLine } from "@/lib/log";
// Fail fast on storage misconfiguration at boot (§6.1) — document jobs read
// uploaded files through this adapter.
import "@/lib/services/storage";
import { reconcileStuckDocumentJobs, runDueDocumentJobs } from "@/lib/services/document-ocr";
import { reconcileDueNotificationDeliveries } from "@/lib/services/notifications";
import { reconcileStuckDecisionDispatches } from "@/lib/services/decision-dispatch";
import { reconcileStuckUnderwritingChecks } from "@/lib/services/underwriting-checks";

const DEFAULT_POLL_INTERVAL_MS = 20_000;
const SHUTDOWN_GRACE_MS = 10_000;

function pollIntervalMs(): number {
  const raw = (process.env.WORKER_POLL_INTERVAL_MS ?? "").trim();
  if (raw === "") return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 3_600_000) {
    // Boundary validation: a broken interval is a deployment error, not a silent default.
    throw new Error(`WORKER_POLL_INTERVAL_MS="${raw}" must be an integer between 1000 and 3600000`);
  }
  return parsed;
}

let stopping = false;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one named reconciler, logging failures without killing the loop. */
async function step(name: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (err) {
    logError("worker-step-error", err, { step: name });
    return null;
  }
}

/** One full pass over every durable-execution scan. */
async function pass(phase: "boot" | "poll"): Promise<void> {
  const started = performance.now();
  // Boot runs the standalone stuck-scan explicitly (the contract's "every
  // exported reconciler once"); poll passes get it via runDueDocumentJobs.
  const stuckJobs = phase === "boot" ? await step("reconcileStuckDocumentJobs", () => reconcileStuckDocumentJobs()) : null;
  const jobs = await step("runDueDocumentJobs", () => runDueDocumentJobs());
  const notifications = await step("reconcileDueNotificationDeliveries", () => reconcileDueNotificationDeliveries());
  const dispatches = await step("reconcileStuckDecisionDispatches", () => reconcileStuckDecisionDispatches());
  const checks = await step("reconcileStuckUnderwritingChecks", () => reconcileStuckUnderwritingChecks());

  const jobsSummary = (jobs ?? { reconciled: 0, requeued: 0, processed: 0 }) as {
    reconciled: number;
    requeued: number;
    processed: number;
  };
  const acted =
    (typeof stuckJobs === "number" ? stuckJobs : 0) +
    jobsSummary.reconciled +
    jobsSummary.requeued +
    jobsSummary.processed +
    (typeof notifications === "number" ? notifications : 0) +
    (typeof dispatches === "number" ? dispatches : 0) +
    (typeof checks === "number" ? checks : 0);

  // Boot always logs its reconciler outcomes; poll passes log only when work happened.
  if (phase === "boot" || acted > 0) {
    logLine("info", {
      event: phase === "boot" ? "worker-boot-reconcile" : "worker-pass",
      documentJobs: jobsSummary,
      ...(phase === "boot" ? { stuckDocumentJobs: stuckJobs ?? 0 } : {}),
      notificationDeliveries: notifications ?? 0,
      decisionDispatches: dispatches ?? 0,
      underwritingChecks: checks ?? 0,
      duration: Math.round(performance.now() - started),
    });
  }
}

function scheduleNext(intervalMs: number): void {
  if (stopping) return;
  timer = setTimeout(() => {
    inFlight = pass("poll")
      .catch((err) => logError("worker-pass-error", err))
      .finally(() => {
        inFlight = null;
        scheduleNext(intervalMs);
      });
  }, intervalMs);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  logLine("info", { event: "worker-shutdown-begin", signal });
  if (inFlight) {
    // Let in-flight work finish, capped — abandoned claims are re-driven by the
    // reconcilers on the next boot (at-least-once, DB authority).
    await Promise.race([inFlight, sleep(SHUTDOWN_GRACE_MS)]);
  }
  await prisma.$disconnect();
  logLine("info", { event: "worker-shutdown-complete", signal });
  process.exit(0);
}

async function main(): Promise<void> {
  const intervalMs = pollIntervalMs();
  logLine("info", { event: "worker-start", intervalMs, pid: process.pid });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Windows evidence seam (dev only, off unless set): Windows cannot deliver a
  // catchable SIGTERM to another process (Node emulates signals; a sent SIGTERM
  // kills unconditionally), so the graceful-shutdown path is additionally
  // reachable via stdin — a "shutdown" line or stdin EOF. Container platforms
  // (the production path, DEPLOYMENT.md) use real SIGTERM.
  if ((process.env.WORKER_STDIN_SHUTDOWN ?? "").trim().toLowerCase() === "true") {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (chunk.toString().toLowerCase().includes("shutdown")) void shutdown("STDIN");
    });
    process.stdin.on("end", () => void shutdown("STDIN"));
    process.stdin.resume();
  }

  inFlight = pass("boot").finally(() => {
    inFlight = null;
  });
  await inFlight;
  scheduleNext(intervalMs);
}

main().catch(async (err) => {
  logError("worker-fatal", err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
