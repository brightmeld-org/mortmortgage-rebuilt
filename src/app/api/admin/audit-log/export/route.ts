// GET /api/admin/audit-log/export — contracts §B (task-039):
//   (no body) -> streamed text/csv 200 (supervisor; errors 403 [401 via
//   guard], validation error; cursor pagination, configured row cap
//   audit.exportRowCap default 100,000; span ≤ 1096d).
//
// REQ-064 / NFR-015 / SEC-14 / INV-009 / §4.6.10.
//
// - Same filters as the viewer (?actionType=&applicationSearch=&userSearch=&
//   from=&to=) — the export streams exactly "the current filter", same
//   newest-first order as the viewer. ?page is accepted-and-ignored (the
//   contract declares cursor pagination for this endpoint).
// - SEC-14: rows are read in cursor batches of ≤ 1000 (iterateAuditRows) into
//   a pull-based ReadableStream — the full filtered set is NEVER loaded into
//   memory; the only whole-filter query is one COUNT aggregate (cap-hit
//   detection, needed before headers are sent).
// - Row cap: SystemConfig audit.exportRowCap (§4.6.11, default 100,000) read
//   via the config service. When the filtered total exceeds the cap the
//   stream terminates after `cap` data rows with a visible trailer message
//   line, and the response carries x-audit-export-cap-hit /
//   x-audit-export-row-cap / x-audit-export-total headers so the viewer UI
//   can surface the cap-hit state (headers must be decided before streaming
//   begins — hence the pre-count).
// - The export action ITSELF is audited (SEC-8 "export") through the tx-only
//   audit service before streaming begins: actor from the authenticated
//   session (NEVER the request), the raw filter echo + cap recorded in
//   `after`. INV-009 note: that is a new append-only row about the export —
//   audit rows themselves are never mutated.
// - CSV cells are csv-safe (RFC-4180 quoting + formula-trigger prefix guard,
//   FT-61); Content-Disposition: attachment (§B download convention).
//
// INV-009 (BLOCKING): this file exports GET ONLY — no POST/PUT/PATCH/DELETE
// handler may ever be added under /api/admin/audit-log for any role.

import { logged } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { guard } from "@/lib/guard";
import { HttpProblem, problemResponse } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { audit } from "@/lib/services/audit";
import { getNumberSetting } from "@/lib/services/config";
import {
  auditLogWhere,
  capHitMessage,
  csvHeaderLine,
  csvLine,
  iterateAuditRows,
  parseAuditLogParams,
} from "@/lib/services/audit-log";
import { toAuditLogEntryInfo } from "@/lib/services/audit";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;

  try {
    // Validation (incl. the 1096-day span rule) BEFORE any data access.
    const { filters, echo } = parseAuditLogParams(request);

    // Configured cap (audit.exportRowCap, §4.6.11 — INV-024 live read).
    const rowCap = await getNumberSetting("audit.exportRowCap");

    // One COUNT aggregate for cap-hit detection (headers precede the stream).
    const total = await prisma.auditLogEntry.count({ where: auditLogWhere(filters) });
    const capHit = total > rowCap;

    // The export action is itself audited, in-transaction, actor from session.
    await prisma.$transaction(async (tx) => {
      await audit(tx, {
        actor: user.userId,
        role: user.role,
        actionType: "export",
        entityType: "AuditLogExport",
        summary: "Audit log exported to CSV with the current filter",
        after: {
          filter: { ...echo },
          rowCap,
          matchingRows: total,
          capHit,
        },
        ip: requestMeta(request).ip,
        requestId: requestId ?? null,
      });
    });

    const encoder = new TextEncoder();
    const rowIterator = iterateAuditRows(filters, rowCap);
    let headerSent = false;
    let trailerSent = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(`${csvHeaderLine()}\r\n`));
          return;
        }
        const batch = await rowIterator.next();
        if (!batch.done) {
          const chunk = batch.value
            .map((row) => `${csvLine(toAuditLogEntryInfo(row))}\r\n`)
            .join("");
          controller.enqueue(encoder.encode(chunk));
          return;
        }
        if (capHit && !trailerSent) {
          trailerSent = true;
          controller.enqueue(encoder.encode(`${capHitMessage(rowCap, total)}\r\n`));
          return;
        }
        controller.close();
      },
      async cancel() {
        await rowIterator.return();
      },
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const headers = new Headers({
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-log-export-${stamp}.csv"`,
      "cache-control": "no-store",
      "x-audit-export-row-cap": String(rowCap),
      "x-audit-export-total": String(total),
    });
    if (capHit) headers.set("x-audit-export-cap-hit", "true");

    return new Response(stream, { status: 200, headers });
  } catch (error) {
    if (error instanceof HttpProblem) return problemResponse(error, requestId);
    throw error;
  }
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
