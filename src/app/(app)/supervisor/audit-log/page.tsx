// AuditLogViewer page (contracts §C, task-039, REQ-064) — /supervisor/audit-log.
//
// Navigation path: (app) shell supervisor header → "Audit Log"
// (nav-sup-audit-log — the link is added to
// src/components/borrower/AppHeader.tsx by task-038, which owns that file this
// increment; supervisor header order per the frame: All Applications,
// Analytics, Caseworkers, Audit Log, Settings). Route directly addressable at
// /supervisor/audit-log (frame §sup-audit-log, requirements §8 route
// inventory).
//
// Server component inside the (app) route group (top-nav shell). Page-level
// role gate mirrors the API guard: unauthenticated → /sign-in with return
// path; wrong-role → own role home (§4.1.10). The GET-only API endpoints
// enforce the supervisor roleGate authoritatively (INV-009: no write
// endpoints exist for the audit log).
//
// Server-side props: the action-type dropdown lists the REAL action types in
// use (DISTINCT actionType via the audit-log service — never a hardcoded
// partial list), and the configured export row cap (SystemConfig
// audit.exportRowCap, §4.6.11) is shown beside the export control.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { listDistinctActionTypes } from "@/lib/services/audit-log";
import { getNumberSetting } from "@/lib/services/config";
import { AuditLogViewer } from "@/components/supervisor/AuditLogViewer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Audit Log — MortMortgage" };

export default async function SupervisorAuditLogPage() {
  const user = await requireAppSession("/supervisor/audit-log");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  const [actionTypes, exportRowCap] = await Promise.all([
    listDistinctActionTypes(),
    getNumberSetting("audit.exportRowCap"),
  ]);

  return <AuditLogViewer actionTypes={actionTypes} exportRowCap={exportRowCap} />;
}
