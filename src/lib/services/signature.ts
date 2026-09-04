// Signature-ceremony service (task-012) — POST /api/applications/:id/signatures.
//
// §4.2.8 / REQ-037 / INV-024 / INV-026 / INV-027 / INV-029 / SEC-15.
//
// The ceremony records, in ONE transaction: the signature row (mode, PNG image
// bytes, attestation text + version, UTC signedAt, client IP, user agent, the
// data-snapshot hash from THE single hash authority) and the `signature-capture`
// audit entry. Signing is allowed only in borrower-editable states (draft /
// revision_requested — 409 otherwise) and only by the OWNING BORROWER (INV-027:
// staff, including Supervisors, always 403).
//
// Image substance per mode:
//   drawn — client canvas PNG data URL; decoded ≤ 200 KB (INV-024) and sniffed
//           for real PNG magic bytes (VR-075) before storage.
//   typed — the server renders the typed legal name to PNG via the deterministic
//           src/lib/pure/png.ts renderer (closed dependency allowlist).
//   demo  — DEMO-MODE-GATED (§B): when DEMO_MODE !== "true" this mode is ABSENT
//           (404, indistinguishable from an unknown application), never a 400.
//           When on, a generated placeholder PNG is stored with demoBypass=true.
//
// Re-signing (INV-029): a new capture REPLACES the borrower's prior signature's
// validity — any prior non-invalidated rows for that borrower are invalidated in
// the same transaction, so at most one currently-valid signature exists per
// borrower. Signing does NOT bump versionStamp: application data is unchanged
// (the hash proves it), so other signatures stay valid.

import type { Signature } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { requireBorrowerOwnedAction } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { audit } from "@/lib/services/audit";
import { computeApplicationDataHash } from "@/lib/services/signature-validity";
import { serializeSignature } from "@/lib/services/application-serializer";
import { demoModeEnabled } from "@/lib/services/demo-login";
import { isBorrowerEditableState } from "@/lib/pure/workflow";
import { isPngBytes, renderTextPng } from "@/lib/pure/png";
import type { SignatureRequest } from "@/lib/schemas/signature";

// ---------------------------------------------------------------------------
// Ceremony constants (task-016 renders ATTESTATION_TEXT in the signing UI;
// task-019's gate compares versions if it ever needs to)
// ---------------------------------------------------------------------------

/** §4.2.8 certification statement, verbatim. */
export const ATTESTATION_TEXT =
  "I certify that the information provided in this application is true and accurate to the best of my knowledge";

/** Version tag stored on every capture (no SystemConfig key exists for it). */
export const ATTESTATION_VERSION = "v1";

/** INV-024: signature image ≤ 200 KB, enforced server-side on the DECODED bytes. */
export const SIGNATURE_IMAGE_MAX_BYTES = 200 * 1024;

/** Text rendered into the generated demo-attestation placeholder image. */
export const DEMO_PLACEHOLDER_TEXT = "Demonstration attestation";

// ---------------------------------------------------------------------------
// Failure helpers (conventions from src/lib/services/application.ts)
// ---------------------------------------------------------------------------

function notFoundProblem(message = "Application not found"): HttpProblem {
  return new HttpProblem(404, ERROR_CODES.notFound, message);
}

function validationProblem(details: string[]): HttpProblem {
  return new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", { details });
}

/**
 * INV-027 denial mapping: staff (incl. Supervisors) → 403; unknown application
 * → 404; another borrower's application → 404 (no existence disclosure).
 */
function throwBorrowerActionDenial(reason: "not-found" | "not-owner" | "staff-forbidden"): never {
  if (reason === "staff-forbidden") {
    throw new HttpProblem(403, ERROR_CODES.forbidden, "This action belongs to the applying borrower only");
  }
  throw notFoundProblem();
}

// ---------------------------------------------------------------------------
// Drawn-mode image validation (VR-075 substance)
// ---------------------------------------------------------------------------

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * Decode + validate a drawn-signature PNG data URL: PNG-typed data URL only,
 * valid base64, decoded size ≤ 200 KB (INV-024), and REAL PNG magic bytes +
 * IHDR (a payload merely claiming image/png is rejected).
 */
export function decodeDrawnImage(imageData: string): Buffer {
  if (!imageData.startsWith(PNG_DATA_URL_PREFIX)) {
    throw validationProblem(["imageData: must be a PNG data URL (data:image/png;base64,...)"]);
  }
  const b64 = imageData.slice(PNG_DATA_URL_PREFIX.length);
  if (b64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw validationProblem(["imageData: base64 payload is malformed"]);
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > SIGNATURE_IMAGE_MAX_BYTES) {
    throw validationProblem([
      `imageData: decoded image is ${bytes.length} bytes — the signature image cap is ${SIGNATURE_IMAGE_MAX_BYTES} bytes (200 KB)`,
    ]);
  }
  if (!isPngBytes(bytes)) {
    throw validationProblem(["imageData: payload is not a valid PNG image"]);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// captureSignature — the ceremony
// ---------------------------------------------------------------------------

/**
 * POST /api/applications/:id/signatures — 201 SignatureInfo.
 *
 * Errors: 404 unknown/foreign application, foreign borrowerId, or demo mode
 * while DEMO_MODE=false; 403 staff caller; 409 non-editable state; 400 image
 * validation failures.
 */
export async function captureSignature(
  user: SessionUser,
  applicationId: string,
  request: SignatureRequest,
  meta: RequestMetaBundle,
): Promise<Record<string, unknown>> {
  // §B demo gate FIRST (live env read): with demo mode off, the demonstration-
  // attestation mode is ABSENT — the same 404 an unknown application produces.
  if (request.mode === "demo" && !demoModeEnabled()) {
    throw notFoundProblem();
  }

  const access = await requireBorrowerOwnedAction(user, applicationId);
  if (!access.allowed) throwBorrowerActionDenial(access.reason);

  // Produce the image bytes BEFORE the transaction (pure work; VR-075 for
  // drawn). Typed/demo images are server-rendered — client-sent imageData is
  // never the stored artifact for those modes.
  let imageBytes: Buffer;
  switch (request.mode) {
    case "drawn":
      imageBytes = decodeDrawnImage(request.imageData!); // presence: VR-076 (schema)
      break;
    case "typed":
      imageBytes = renderTextPng(request.typedName!); // presence: VR-076 (schema)
      break;
    case "demo":
      imageBytes = renderTextPng(DEMO_PLACEHOLDER_TEXT);
      break;
  }
  if (imageBytes.length > SIGNATURE_IMAGE_MAX_BYTES) {
    // Renderer output backstop (INV-024) — unreachable at the schema's name cap.
    throw validationProblem(["typedName: rendered signature image exceeds the 200 KB cap"]);
  }

  const row: Signature = await prisma.$transaction(async (tx) => {
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: { id: true, applicationNumber: true, workflowState: true },
    });
    if (!app) throw notFoundProblem(); // deleted between guard and tx
    if (!isBorrowerEditableState(app.workflowState)) {
      throw new HttpProblem(
        409,
        ERROR_CODES.conflict,
        "Signing is only allowed in Draft or Revision Requested",
        { currentState: app.workflowState },
      );
    }

    // RECORD-LEVEL SCOPING: borrowerId must be a Borrower row OF THIS
    // application — a cross-application borrowerId must never attach (404, no
    // existence disclosure about other applications' borrower rows).
    const borrower = await tx.borrower.findUnique({
      where: { id: request.borrowerId },
      select: { id: true, applicationId: true, ordinal: true },
    });
    if (!borrower || borrower.applicationId !== applicationId) {
      throw notFoundProblem("Borrower not found on this application");
    }

    // THE single hash authority (INV-029) — stamped from live data in-tx.
    const dataHash = await computeApplicationDataHash(tx, applicationId);
    const now = new Date();

    // Re-sign supersede: invalidate any prior still-active rows for this
    // borrower so at most one currently-valid signature exists per borrower.
    await tx.signature.updateMany({
      where: { applicationId, borrowerId: borrower.id, invalidatedAt: null },
      data: { invalidatedAt: now },
    });

    const created = await tx.signature.create({
      data: {
        applicationId,
        borrowerId: borrower.id,
        mode: request.mode,
        imageData: new Uint8Array(imageBytes), // Prisma Bytes input (non-shared ArrayBuffer)
        attestationText: ATTESTATION_TEXT,
        attestationVersion: ATTESTATION_VERSION,
        signedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
        dataHash,
        demoBypass: request.mode === "demo",
      },
    });

    // AUDIT INTEGRITY: actor from the authenticated session only (§4.2.8
    // `signature_captured` — audited in the SAME transaction).
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: "signature-capture",
      applicationId,
      entityType: "Signature",
      entityId: created.id,
      summary: `Signature captured (${request.mode}${created.demoBypass ? ", demo bypass" : ""}) for borrower ${borrower.ordinal} on application ${app.applicationNumber}`,
      ip: meta.ip,
      requestId: meta.requestId,
    });

    return created;
  });

  // SignatureInfo wire shape — never leaks imageData/ip/userAgent/dataHash.
  return serializeSignature(row);
}
