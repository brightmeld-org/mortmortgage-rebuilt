/**
 * SSN blind index and last-four extraction (NFR-002, INV-018, SEC-1).
 *
 * The blind index is an HMAC-SHA256 of the NORMALIZED SSN (digits only) keyed by
 * `SSN_BLIND_INDEX_KEY`, so "123-45-6789" and "123456789" produce the same index —
 * formatting can never split identical SSNs. It is stored in Borrower.ssnBlindIndex
 * under a NON-unique index: duplicate SSNs must be detectable (FraudFlag, INV-018),
 * never blocked.
 *
 * The last four digits are stored separately (Borrower.ssnLast4) as the only
 * plaintext-derived SSN fragment, feeding maskSsn() in src/lib/crypto/masking.ts.
 */

import { createHmac } from "node:crypto";

const SSN_DIGITS = 9;

function blindIndexKey(): Buffer {
  const raw = process.env.SSN_BLIND_INDEX_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error("SSN_BLIND_INDEX_KEY is not set");
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length < 32) {
    throw new Error("SSN_BLIND_INDEX_KEY must decode to at least 32 bytes");
  }
  return key;
}

/**
 * Normalize an SSN to its 9 digits (strips dashes, spaces, any non-digit).
 * Throws if the result is not exactly 9 digits — format validation (VR-069)
 * happens at the API boundary; this guard catches internal misuse.
 */
export function normalizeSsn(ssn: string): string {
  const digits = ssn.replace(/\D/g, "");
  if (digits.length !== SSN_DIGITS) {
    throw new Error(`SSN must contain exactly ${SSN_DIGITS} digits`);
  }
  return digits;
}

/**
 * Deterministic HMAC-SHA256 blind index (hex) over the normalized SSN.
 * Same SSN in any formatting → same index (duplicate detection, INV-018).
 */
export function ssnBlindIndex(ssn: string): string {
  return createHmac("sha256", blindIndexKey()).update(normalizeSsn(ssn)).digest("hex");
}

/** Last four digits of the (normalized) SSN, for masked display (BorrowerRecord.ssnLast4). */
export function ssnLast4(ssn: string): string {
  return normalizeSsn(ssn).slice(-4);
}
