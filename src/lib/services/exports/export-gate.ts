// Shared per-application export gate (task-040 — wave-1 shared plumbing for
// increment 10; reused read-only by task-041 urla-pdf).
//
// Contracts §B rows for /api/applications/:id/exports/*: GET, supervisor,
// errorCodes 403/404/409. The supervisor roleGate itself is enforced by the
// single shared guard in the route (INV-038); THIS module answers the two
// record-level questions every per-application export shares:
//   - unknown id            -> 404 (HttpProblem, single ErrorResponse shape)
//   - Draft application     -> 409 (RFP §4.9: exports are available for any
//                              NON-Draft application; workflow-flavored 409 so
//                              the body carries currentState)
//
// It also owns the `?full=true&reason=<text>` query-boundary validation for
// the MISMO full-SSN export mode (contracts §B query-parameter conventions +
// the SCOPE DISCIPLINE boundary-validation rule): `full`, when present, must
// be exactly "true"; `reason` is required non-empty when full=true and is
// rejected when supplied without full=true. Violations are the framework's
// validation failure (400 + details[]), thrown as HttpProblem for the route's
// single catch seam.

import { prisma } from "@/lib/prisma";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";

/** The gate's projection of the application — enough for filenames + audit summaries. */
export interface ExportableApplication {
  id: string;
  applicationNumber: string;
  workflowState: string;
}

/**
 * Load the application and enforce the shared per-application export gate:
 * 404 unknown id, 409 Draft. Callers run AFTER the supervisor guard.
 */
export async function requireExportableApplication(
  applicationId: string,
): Promise<ExportableApplication> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, applicationNumber: true, workflowState: true },
  });
  if (!app) {
    throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  }
  if (app.workflowState === "draft") {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "Draft applications cannot be exported — exports are available once an application has been submitted",
      { currentState: app.workflowState },
    );
  }
  return { id: app.id, applicationNumber: app.applicationNumber, workflowState: app.workflowState };
}

/** Parsed `?full=true&reason=<text>` state for the MISMO exports. */
export interface FullSsnExportParams {
  /** True only when the Supervisor explicitly requested a full-SSN export. */
  full: boolean;
  /** The audited reason — non-null exactly when full is true. */
  reason: string | null;
}

/** Upper bound keeping an operator-typed reason plausible for one audit row. */
const REASON_MAX_LENGTH = 2000;

/**
 * Validate and parse the full-SSN query parameters (contracts §B:
 * `?full=true&reason=<text>` — Supervisor full-SSN export requires reason,
 * audited; default masked). Throws HttpProblem 400 with details[] on any
 * boundary violation.
 */
export function parseFullSsnParams(request: Request): FullSsnExportParams {
  const url = new URL(request.url);
  const full = url.searchParams.get("full");
  const reason = url.searchParams.get("reason");
  const details: string[] = [];

  if (full !== null && full !== "true") {
    details.push('full: must be exactly "true" when provided');
  }
  if (full === "true") {
    if (reason === null || reason.trim().length === 0) {
      details.push("reason: a non-empty reason is required for a full-SSN export");
    } else if (reason.length > REASON_MAX_LENGTH) {
      details.push(`reason: must be at most ${REASON_MAX_LENGTH} characters`);
    }
  } else if (reason !== null) {
    details.push("reason: only valid together with full=true");
  }

  if (details.length > 0) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details,
    });
  }

  return full === "true"
    ? { full: true, reason: reason!.trim() }
    : { full: false, reason: null };
}
