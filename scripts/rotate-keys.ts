/**
 * Key-rotation re-encryption procedure (AC-54, NFR-002).
 *
 * Re-encrypts every encrypted column — and every JSON-embedded envelope inside
 * ApplicationData documents — whose keyId differs from the current active key
 * (FIELD_ENCRYPTION_ACTIVE_KEY_ID). Old keys must still be present in
 * FIELD_ENCRYPTION_KEYS so their ciphertexts can be decrypted during rotation.
 *
 * Operational procedure: see src/lib/crypto/KEY-ROTATION.md.
 *
 * Run:  npx tsx scripts/rotate-keys.ts
 *
 * Behavior:
 * - Batch-wise (BATCH_SIZE rows), transactional per row-batch: a batch either
 *   fully commits or fully rolls back, so a crash mid-run never strands a row
 *   half-rotated. Re-running the script is safe and idempotent — it only touches
 *   rows whose keyId is not the active key.
 * - Bytes-column updates are guarded on the old keyId (updateMany with keyId in
 *   the WHERE), so a row concurrently re-encrypted by live traffic during the
 *   batch window is skipped rather than clobbered.
 *
 * Covered columns:
 *   Borrower.ssnCiphertext / ssnKeyId
 *   Borrower.dateOfBirthCiphertext / dateOfBirthKeyId
 *   MfaEnrollment.secretCiphertext / secretKeyId
 *   BankLink.accessTokenCiphertext / accessTokenKeyId
 *   ApplicationData.* JSON documents — every embedded { __enc: "aes-256-gcm", ... }
 *   envelope found by deep walk (assets / liabilities / realEstateOwned[].mortgages
 *   account numbers), so new embedded locations are covered without editing this script.
 */

import { PrismaClient, Prisma } from "@prisma/client";
import {
  decryptField,
  encryptField,
  decryptFieldFromJson,
  encryptFieldToJson,
  getActiveKeyId,
  isJsonEncryptedEnvelope,
} from "../src/lib/crypto/encryption";

const BATCH_SIZE = 50;

export interface RotationCounts {
  borrowerSsn: number;
  borrowerDateOfBirth: number;
  mfaSecret: number;
  bankLinkAccessToken: number;
  applicationDataEnvelopes: number;
}

/** Re-encrypt ciphertext bytes stored under `keyId` with the active key. */
function reencryptBytes(
  ciphertext: Uint8Array,
  keyId: string,
): { ciphertext: Uint8Array<ArrayBuffer>; keyId: string } {
  const plaintext = decryptField({ ciphertext, keyId });
  const next = encryptField(plaintext);
  // Copy into a plain Uint8Array<ArrayBuffer> for Prisma's Bytes input type.
  return { ciphertext: new Uint8Array(next.ciphertext), keyId: next.keyId };
}

/**
 * Deep-walk a JSON document, re-encrypting every embedded envelope whose keyId
 * is not `activeKeyId`. Returns the number of envelopes rotated (0 = untouched).
 * Mutates the passed value in place.
 */
function rotateJsonEnvelopes(value: unknown, activeKeyId: string): number {
  if (value === null || typeof value !== "object") return 0;
  let rotated = 0;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (isJsonEncryptedEnvelope(item)) {
        if (item.keyId !== activeKeyId) {
          value[i] = encryptFieldToJson(decryptFieldFromJson(item));
          rotated++;
        }
      } else {
        rotated += rotateJsonEnvelopes(item, activeKeyId);
      }
    }
    return rotated;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (isJsonEncryptedEnvelope(item)) {
      if (item.keyId !== activeKeyId) {
        record[key] = encryptFieldToJson(decryptFieldFromJson(item));
        rotated++;
      }
    } else {
      rotated += rotateJsonEnvelopes(item, activeKeyId);
    }
  }
  return rotated;
}

function jsonContainsStaleEnvelope(value: unknown, activeKeyId: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isJsonEncryptedEnvelope(value)) return value.keyId !== activeKeyId;
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return items.some((item) => jsonContainsStaleEnvelope(item, activeKeyId));
}

/**
 * Rotate every encrypted column and JSON-embedded envelope to the active key.
 * Exported so the verification harness can exercise the real rotation path.
 */
export async function rotateAllKeys(prisma: PrismaClient): Promise<RotationCounts> {
  const activeKeyId = getActiveKeyId();
  const counts: RotationCounts = {
    borrowerSsn: 0,
    borrowerDateOfBirth: 0,
    mfaSecret: 0,
    bankLinkAccessToken: 0,
    applicationDataEnvelopes: 0,
  };

  // --- Borrower.ssn* and dateOfBirth* -------------------------------------
  for (;;) {
    const rows = await prisma.borrower.findMany({
      where: {
        OR: [
          { ssnKeyId: { not: null, notIn: [activeKeyId] } },
          { dateOfBirthKeyId: { not: null, notIn: [activeKeyId] } },
        ],
      },
      select: {
        id: true,
        ssnCiphertext: true,
        ssnKeyId: true,
        dateOfBirthCiphertext: true,
        dateOfBirthKeyId: true,
      },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        if (row.ssnKeyId && row.ssnKeyId !== activeKeyId && row.ssnCiphertext) {
          const next = reencryptBytes(row.ssnCiphertext, row.ssnKeyId);
          const res = await tx.borrower.updateMany({
            where: { id: row.id, ssnKeyId: row.ssnKeyId },
            data: { ssnCiphertext: next.ciphertext, ssnKeyId: next.keyId },
          });
          counts.borrowerSsn += res.count;
        }
        if (
          row.dateOfBirthKeyId &&
          row.dateOfBirthKeyId !== activeKeyId &&
          row.dateOfBirthCiphertext
        ) {
          const next = reencryptBytes(row.dateOfBirthCiphertext, row.dateOfBirthKeyId);
          const res = await tx.borrower.updateMany({
            where: { id: row.id, dateOfBirthKeyId: row.dateOfBirthKeyId },
            data: { dateOfBirthCiphertext: next.ciphertext, dateOfBirthKeyId: next.keyId },
          });
          counts.borrowerDateOfBirth += res.count;
        }
      }
    });
  }

  // --- MfaEnrollment.secret* ----------------------------------------------
  for (;;) {
    const rows = await prisma.mfaEnrollment.findMany({
      where: { secretKeyId: { notIn: [activeKeyId] } },
      select: { id: true, secretCiphertext: true, secretKeyId: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const next = reencryptBytes(row.secretCiphertext, row.secretKeyId);
        const res = await tx.mfaEnrollment.updateMany({
          where: { id: row.id, secretKeyId: row.secretKeyId },
          data: { secretCiphertext: next.ciphertext, secretKeyId: next.keyId },
        });
        counts.mfaSecret += res.count;
      }
    });
  }

  // --- BankLink.accessToken* ----------------------------------------------
  for (;;) {
    const rows = await prisma.bankLink.findMany({
      where: { accessTokenKeyId: { not: null, notIn: [activeKeyId] } },
      select: { id: true, accessTokenCiphertext: true, accessTokenKeyId: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        if (!row.accessTokenKeyId || !row.accessTokenCiphertext) continue;
        const next = reencryptBytes(row.accessTokenCiphertext, row.accessTokenKeyId);
        const res = await tx.bankLink.updateMany({
          where: { id: row.id, accessTokenKeyId: row.accessTokenKeyId },
          data: { accessTokenCiphertext: next.ciphertext, accessTokenKeyId: next.keyId },
        });
        counts.bankLinkAccessToken += res.count;
      }
    });
  }

  // --- ApplicationData JSON-embedded envelopes ----------------------------
  // keyIds live inside JSON documents, so stale rows are detected in JS.
  // Paged by id cursor over all rows; only rows containing a stale envelope
  // are rewritten (inside a per-batch transaction).
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.applicationData.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const jsonFields = [
      "assets",
      "otherCredits",
      "realEstateOwned",
      "liabilities",
      "otherLiabilities",
      "subjectProperty",
      "loan",
      "proposedHousingExpense",
    ] as const;

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const data: Prisma.ApplicationDataUpdateInput = {};
        let rowRotated = 0;
        for (const field of jsonFields) {
          const doc = row[field];
          if (doc === null || !jsonContainsStaleEnvelope(doc, activeKeyId)) continue;
          // Work on a deep copy so a failed transaction leaves `row` pristine.
          const copy = JSON.parse(JSON.stringify(doc)) as unknown;
          rowRotated += rotateJsonEnvelopes(copy, activeKeyId);
          data[field] = copy as Prisma.InputJsonValue;
        }
        if (rowRotated > 0) {
          await tx.applicationData.update({ where: { id: row.id }, data });
          counts.applicationDataEnvelopes += rowRotated;
        }
      }
    });
  }

  return counts;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  // Load .env for standalone execution (does not override already-set vars).
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on process environment.
  }

  const activeKeyId = getActiveKeyId();
  console.log(`[rotate-keys] active key id: ${activeKeyId}`);
  const prisma = new PrismaClient();
  try {
    const counts = await rotateAllKeys(prisma);
    console.log("[rotate-keys] rotation complete:");
    console.log(`  Borrower.ssn:               ${counts.borrowerSsn}`);
    console.log(`  Borrower.dateOfBirth:       ${counts.borrowerDateOfBirth}`);
    console.log(`  MfaEnrollment.secret:       ${counts.mfaSecret}`);
    console.log(`  BankLink.accessToken:       ${counts.bankLinkAccessToken}`);
    console.log(`  ApplicationData envelopes:  ${counts.applicationDataEnvelopes}`);
  } finally {
    await prisma.$disconnect();
  }
}

// Run main() only when executed directly (npx tsx scripts/rotate-keys.ts),
// not when rotateAllKeys is imported by the verification harness.
const isCliEntry = process.argv[1] !== undefined && /rotate-keys/.test(process.argv[1]);

if (isCliEntry) {
  main().catch((err) => {
    console.error("[rotate-keys] FAILED:", err);
    process.exitCode = 1;
  });
}
