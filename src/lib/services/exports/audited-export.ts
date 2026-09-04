// Shared audited-export wrapper (task-040 — wave-1 shared plumbing for
// increment 10; reused read-only by task-041/042).
//
// REQ-072 / SEC-8 / RFP §4.9: every export is Supervisor-only and INDIVIDUALLY
// audited under the RFP's export event vocabulary (export_mismo_json,
// export_mismo_xml, export_urla_pdf, export_hmda_lar, export_warehouse). This
// wrapper is the single seam every export route calls, following the task-039
// audit-export precedent:
//   - the audit row is written IN-TRANSACTION through the tx-only audit
//     service (task-003) BEFORE the response body is streamed;
//   - actionType is the SEC-8 vocabulary value "export";
//   - the actor is ALWAYS the authenticated session user (AUDIT INTEGRITY
//     RULE — never from the request); the Supervisor's full-SSN `reason` is
//     operator input recorded IN the row's reason column, never actor input;
//   - the export kind + request parameters are recorded in `after` so the
//     audit viewer shows exactly what left the system.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit } from "@/lib/services/audit";

/** RFP §4.9 export event vocabulary — the `kind` recorded on every export audit row. */
export type ExportKind =
  | "export_mismo_json"
  | "export_mismo_xml"
  | "export_urla_pdf"
  | "export_hmda_lar"
  | "export_warehouse";

export interface ExportAuditInput {
  /** The authenticated Supervisor session (guard output) — the ONLY actor source. */
  user: SessionUser;
  kind: ExportKind;
  /** Human-readable one-liner for the audit viewer. */
  summary: string;
  /** Application the export concerns (per-application exports); null for global. */
  applicationId?: string | null;
  /** Export request parameters echoed into `after` (e.g. { format, full, year, mode }). */
  params?: Record<string, unknown>;
  /** Supervisor's stated reason — REQUIRED by callers for full-SSN exports. */
  reason?: string | null;
  /** Server-derived request metadata (ip / requestId). */
  meta: RequestMetaBundle;
}

/**
 * Write the individual audit row for one export, in its own transaction,
 * BEFORE any response bytes are produced. A failed audit insert throws and
 * the route returns 5xx — an export can never happen silently un-audited.
 */
export async function auditExport(input: ExportAuditInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await audit(tx, {
      actor: input.user.userId,
      role: input.user.role,
      actionType: "export",
      applicationId: input.applicationId ?? null,
      entityType: input.applicationId ? "Application" : "Export",
      entityId: input.applicationId ?? null,
      summary: input.summary,
      after: { kind: input.kind, ...(input.params ?? {}) } as Prisma.InputJsonValue,
      reason: input.reason ?? null,
      ip: input.meta.ip,
      requestId: input.meta.requestId,
    });
  });
}
