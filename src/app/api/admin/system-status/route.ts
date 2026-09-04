// GET /api/admin/system-status (contracts §B row 2622 — task-045, NFR-027, INT-001).
//
// SystemStatusResponse { jobs: JobMetrics, integrationModes: IntegrationMode[], demoMode }
// — supervisor-gated (401 unauthenticated / 403 non-supervisor) through the
// shared guard, same as every admin endpoint.
//
// LIVE DATA ONLY (live-state builder rule):
//   jobs — real rows, mapped into the three contracted buckets:
//     queued     = DocumentJob(status=queued)
//                + Notification(deliveryStatus=pending)          [ASYNC-002 awaiting delivery]
//                + Application(approved/denied, decisionNotificationPending) [ASYNC-003 awaiting dispatch]
//     processing = DocumentJob(status=processing)
//     failed     = DocumentJob(status=failed)                    [includes those with a
//                  scheduled automatic retry — they remain failed rows until requeued]
//                + Notification(deliveryStatus=failed)
//   Interpretation note: the contract's JobMetrics does not enumerate job kinds,
//   so pending notification deliveries and pending decision dispatches are
//   folded into "queued"/"failed" alongside OCR jobs (documented here and in
//   DEPLOYMENT.md).
//   integrationModes — the §6.2 integration list, mode derived from the SAME
//     env selections the provider seams read (CHECK_PROVIDER_<X>, OCR_PROVIDER;
//     "real" only when explicitly configured). Integrations with no real-provider
//     slot in this version (aggregator, geocoding, email-sms, aus) derive from
//     the same rule and therefore report "simulated".
//   demoMode — live DEMO_MODE env state.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { demoModeEnabled } from "@/lib/services/demo-login";

type ProviderMode = "simulated" | "real";

/** Same normalization as the provider seams (checks/index.ts, ocr/index.ts). */
function modeFromEnv(value: string | undefined): ProviderMode {
  return (value ?? "").trim().toLowerCase() === "real" ? "real" : "simulated";
}

/** §6.2 integration list → live env-derived mode (ProviderMode enum values). */
function integrationModes(): Array<{ integration: string; mode: ProviderMode }> {
  const env = process.env;
  return [
    { integration: "credit-bureau", mode: modeFromEnv(env.CHECK_PROVIDER_CREDIT) },
    { integration: "income-verification", mode: modeFromEnv(env.CHECK_PROVIDER_INCOME) },
    { integration: "avm", mode: modeFromEnv(env.CHECK_PROVIDER_AVM) },
    { integration: "pricing-engine", mode: modeFromEnv(env.CHECK_PROVIDER_PRICING) },
    { integration: "financial-data-aggregator", mode: modeFromEnv(env.BANK_AGGREGATOR_PROVIDER) },
    { integration: "address-geocoding", mode: modeFromEnv(env.GEOCODING_PROVIDER) },
    { integration: "document-ocr", mode: modeFromEnv(env.OCR_PROVIDER) },
    { integration: "email-sms", mode: modeFromEnv(env.MESSAGING_PROVIDER) },
    { integration: "aus", mode: modeFromEnv(env.CHECK_PROVIDER_AUS) },
  ];
}

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  const [jobCounts, pendingNotifications, failedNotifications, pendingDispatches] = await Promise.all([
    prisma.documentJob.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.notification.count({ where: { deliveryStatus: "pending" } }),
    prisma.notification.count({ where: { deliveryStatus: "failed" } }),
    prisma.application.count({
      where: { workflowState: { in: ["approved", "denied"] }, decisionNotificationPending: true },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of jobCounts) byStatus[row.status] = row._count._all;

  return Response.json({
    jobs: {
      queued: (byStatus.queued ?? 0) + pendingNotifications + pendingDispatches,
      processing: byStatus.processing ?? 0,
      failed: (byStatus.failed ?? 0) + failedNotifications,
    },
    integrationModes: integrationModes(),
    demoMode: demoModeEnabled(),
  });
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
