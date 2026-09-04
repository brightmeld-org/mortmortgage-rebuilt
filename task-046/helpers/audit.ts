/**
 * Audit-log read helpers (supervisor-only, §B GET /api/admin/audit-log).
 * Used by the route-enumeration audit-coverage proof and by per-operation checks.
 */
import { GET, expectOk, type Session } from "./http.js";

/** §A AuditLogEntryInfo. */
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorName?: string;
  actorRole?: string;
  actionType: string;
  applicationNumber?: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  before?: string;
  after?: string;
  reason?: string;
  requestId?: string;
}

interface AuditLogPage {
  rows: AuditLogEntry[];
  page: number;
  pageSize: number;
  total: number;
}

/** Fetches audit entries, newest first, up to `maxRows`. */
export async function auditEntries(supervisor: Session, maxRows = 400): Promise<AuditLogEntry[]> {
  const collected: AuditLogEntry[] = [];
  for (let page = 1; collected.length < maxRows && page <= 20; page += 1) {
    const path = `/api/admin/audit-log?page=${page}&pageSize=100`;
    const result = await GET<AuditLogPage>(path, { session: supervisor });
    const body = expectOk(result, `GET ${path}`, 200);
    collected.push(...(body.rows ?? []));
    if ((body.rows ?? []).length === 0 || page * body.pageSize >= body.total) break;
  }
  return collected;
}

/** Audit entries recorded at or after `since` (ISO string). */
export async function auditEntriesSince(supervisor: Session, since: string, maxRows = 600): Promise<AuditLogEntry[]> {
  const cutoff = Date.parse(since);
  const rows = await auditEntries(supervisor, maxRows);
  return rows.filter((row) => Date.parse(row.timestamp) >= cutoff);
}
