// Magic-byte content sniffing (task-013, SEC-12, §4.2.9, NFR-013).
//
// Every uploaded file is validated server-side by content sniffing — the
// client-supplied MIME type and file extension are NEVER trusted. Accepted
// types (§4.2.9): PDF, JPEG, PNG. An `.exe` renamed `.pdf` fails the sniff and
// is rejected as a validation error by the caller.
//
// Pure module: no I/O, no imports beyond types. The sniffed content type is
// authoritative — it is stored on DocumentVersion.sniffedContentType and served
// back as the download Content-Type (SEC-12).

export type SniffedContentType = "application/pdf" | "image/jpeg" | "image/png";

export interface SniffResult {
  contentType: SniffedContentType;
  /** Canonical extension for the sniffed type (server-derived, informational). */
  extension: "pdf" | "jpg" | "png";
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Sniff the real content type from the leading bytes. Returns null for
 * anything that is not a PDF, JPEG, or PNG — callers reject those uploads.
 */
export function sniffContentType(bytes: Uint8Array): SniffResult | null {
  if (startsWith(bytes, PDF_MAGIC)) return { contentType: "application/pdf", extension: "pdf" };
  if (startsWith(bytes, JPEG_MAGIC)) return { contentType: "image/jpeg", extension: "jpg" };
  if (startsWith(bytes, PNG_MAGIC)) return { contentType: "image/png", extension: "png" };
  return null;
}

/**
 * Sanitize a user-supplied original file name for use in a
 * `Content-Disposition: attachment; filename="..."` header. The storage key is
 * NEVER derived from this name (SEC-12) — this is display-only. Strips path
 * separators, control characters, and quote/backslash characters; collapses to
 * a safe fallback when nothing survives.
 */
export function sanitizeDownloadFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f"\\;]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "document";
}
