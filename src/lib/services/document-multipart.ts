// Multipart upload parsing (task-013) — shared by the two upload routes.
//
// Contracts §B "Upload transport": POST /api/applications/:id/documents and
// POST /api/documents/:id/versions are multipart/form-data with a binary
// `file` part plus the DocumentUploadRequest fields. Parsing uses the Web API
// `request.formData()` built into Next 15 — no extra package (profile §2).
//
// Guard runs BEFORE this parser (SEC-19). Unknown form fields are rejected via
// the strict zod schema (SEC-18). Size limits and magic-byte sniffing are the
// service's job (they read live SystemConfig, INV-024).

import { errorResponse, requestIdFrom, validationError } from "@/lib/http/errors";
import { zodIssuesToDetails } from "@/lib/http/validation";
import { getNumberSetting } from "@/lib/services/config";
import {
  documentUploadRequestSchema,
  type DocumentUploadRequest,
} from "@/lib/schemas/document";
import type { UploadedFile } from "@/lib/services/document";

export type ParseUploadFormResult =
  | { ok: true; body: DocumentUploadRequest; file: UploadedFile }
  | { ok: false; response: Response };

/** Multipart envelope slack on top of the configured FILE limit (boundaries + fields). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export async function parseUploadForm(request: Request): Promise<ParseUploadFormResult> {
  const requestId = requestIdFrom(request);

  // 413 fast-path on the declared Content-Length BEFORE buffering the body
  // (INV-024 read live from SystemConfig). This also keeps the contracted 413
  // reachable under the Next dev proxy, which truncates >10 MB bodies before
  // the handler sees them (truncated multipart would otherwise misreport 400).
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > 0) {
    const maxMb = await getNumberSetting("documents.maxFileSizeMb");
    if (declaredLength > Math.floor(maxMb * 1024 * 1024) + MULTIPART_OVERHEAD_BYTES) {
      return {
        ok: false,
        response: errorResponse(
          413,
          "file_too_large",
          `File exceeds the configured maximum size of ${maxMb} MB`,
          { requestId },
        ),
      };
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return {
      ok: false,
      response: validationError(
        ["(body): request must be multipart/form-data with a file part and DocumentUploadRequest fields"],
        requestId,
      ),
    };
  }

  const filePart = form.get("file");
  if (!(filePart instanceof File)) {
    return {
      ok: false,
      response: validationError(["file: a binary file part named \"file\" is required"], requestId),
    };
  }

  // Collect the non-file fields into a plain object; the strict schema rejects
  // unknown fields and duplicate parts collapse to their first value.
  const fields: Record<string, string> = {};
  const details: string[] = [];
  for (const [name, value] of form.entries()) {
    if (name === "file") continue;
    if (typeof value !== "string") {
      details.push(`${name}: unexpected extra file part`);
      continue;
    }
    if (name in fields) {
      details.push(`${name}: duplicate form field`);
      continue;
    }
    fields[name] = value;
  }
  if (details.length > 0) {
    return { ok: false, response: validationError(details, requestId) };
  }

  const parsed = documentUploadRequestSchema.safeParse(fields);
  if (!parsed.success) {
    return { ok: false, response: validationError(zodIssuesToDetails(parsed.error), requestId) };
  }

  const bytes = Buffer.from(await filePart.arrayBuffer());
  return {
    ok: true,
    body: parsed.data,
    file: { originalFileName: filePart.name || "document", bytes },
  };
}
