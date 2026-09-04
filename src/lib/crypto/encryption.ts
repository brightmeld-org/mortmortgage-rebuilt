/**
 * Field-level encryption for PII at rest (NFR-002, AC-54, SEC-1).
 *
 * AES-256-GCM via node:crypto only — no third-party dependencies.
 *
 * Key management
 * --------------
 * - `FIELD_ENCRYPTION_KEYS` holds the full key ring as a keyId → key map. Two accepted
 *   formats:
 *     1. JSON object:            {"k1":"<base64 32-byte key>","k2":"<base64 32-byte key>"}
 *     2. Comma-separated pairs:  k1:<base64 32-byte key>,k2:<base64 32-byte key>
 * - `FIELD_ENCRYPTION_ACTIVE_KEY_ID` names the key used for all NEW encryption.
 * - Every ciphertext is stored WITH the keyId that produced it, so retired-but-present
 *   keys can still decrypt old rows (rotation window). See src/lib/crypto/KEY-ROTATION.md
 *   and scripts/rotate-keys.ts for the re-encryption procedure.
 *
 * Binary envelope layout (what lands in the *Ciphertext Bytes columns):
 *   byte 0        envelope version (currently 0x01)
 *   bytes 1..12   96-bit IV (random per call — never reused)
 *   bytes 13..28  128-bit GCM auth tag
 *   bytes 29..    AES-256-GCM ciphertext
 *
 * JSON-embedded envelope (account numbers inside ApplicationData JSON documents —
 * assets / liabilities / realEstateOwned[].mortgages — where a sibling column is
 * impossible for array elements; see prisma/schema.prisma header):
 *   { "__enc": "aes-256-gcm", "keyId": "<id>", "ciphertext": "<base64 binary envelope>" }
 * The `__enc` marker lets the rotation script find every embedded envelope by deep walk
 * without hard-coding JSON paths.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = 0x01;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + AUTH_TAG_LENGTH;
const KEY_LENGTH = 32;

/** Result of encrypting one field: what gets stored in the ciphertext + keyId columns. */
export interface EncryptedField {
  ciphertext: Buffer;
  keyId: string;
}

/** Marker value identifying a JSON-embedded encryption envelope. */
export const JSON_ENVELOPE_MARKER = "aes-256-gcm" as const;

/**
 * JSON-embedded envelope for encrypted values inside ApplicationData JSON documents.
 * (A type alias, not an interface, so it is assignable to Prisma's InputJsonValue.)
 */
export type JsonEncryptedEnvelope = {
  __enc: typeof JSON_ENVELOPE_MARKER;
  keyId: string;
  /** base64 encoding of the same binary envelope used for Bytes columns. */
  ciphertext: string;
};

// ---------------------------------------------------------------------------
// Key ring parsing (cached, invalidated when the env var strings change)
// ---------------------------------------------------------------------------

interface KeyRing {
  keys: Map<string, Buffer>;
  activeKeyId: string;
}

let cachedRing: KeyRing | null = null;
let cachedKeysRaw: string | undefined;
let cachedActiveRaw: string | undefined;

function parseKeyRing(): KeyRing {
  const keysRaw = process.env.FIELD_ENCRYPTION_KEYS;
  const activeRaw = process.env.FIELD_ENCRYPTION_ACTIVE_KEY_ID;

  if (cachedRing && keysRaw === cachedKeysRaw && activeRaw === cachedActiveRaw) {
    return cachedRing;
  }

  if (!keysRaw || keysRaw.trim() === "") {
    throw new Error("FIELD_ENCRYPTION_KEYS is not set");
  }
  if (!activeRaw || activeRaw.trim() === "") {
    throw new Error("FIELD_ENCRYPTION_ACTIVE_KEY_ID is not set");
  }

  const entries = new Map<string, Buffer>();
  const trimmed = keysRaw.trim();

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("FIELD_ENCRYPTION_KEYS is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FIELD_ENCRYPTION_KEYS JSON must be an object of keyId -> base64 key");
    }
    for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new Error(`FIELD_ENCRYPTION_KEYS entry "${keyId}" must be a base64 string`);
      }
      entries.set(keyId, decodeKey(keyId, value));
    }
  } else {
    for (const pair of trimmed.split(",")) {
      const p = pair.trim();
      if (p === "") continue;
      const sep = p.indexOf(":");
      if (sep <= 0 || sep === p.length - 1) {
        throw new Error(
          'FIELD_ENCRYPTION_KEYS list entries must be "keyId:base64key" pairs',
        );
      }
      const keyId = p.slice(0, sep).trim();
      entries.set(keyId, decodeKey(keyId, p.slice(sep + 1).trim()));
    }
  }

  if (entries.size === 0) {
    throw new Error("FIELD_ENCRYPTION_KEYS contains no keys");
  }

  const activeKeyId = activeRaw.trim();
  if (!entries.has(activeKeyId)) {
    throw new Error(
      `FIELD_ENCRYPTION_ACTIVE_KEY_ID "${activeKeyId}" is not present in FIELD_ENCRYPTION_KEYS`,
    );
  }

  cachedRing = { keys: entries, activeKeyId };
  cachedKeysRaw = keysRaw;
  cachedActiveRaw = activeRaw;
  return cachedRing;
}

function decodeKey(keyId: string, base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `FIELD_ENCRYPTION_KEYS key "${keyId}" must decode to ${KEY_LENGTH} bytes (got ${key.length})`,
    );
  }
  return key;
}

/** The keyId currently used for new encryption (rotation target). */
export function getActiveKeyId(): string {
  return parseKeyRing().activeKeyId;
}

/** All keyIds present in the key ring (active + retained-for-decryption). */
export function listKeyIds(): string[] {
  return [...parseKeyRing().keys.keys()];
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt — Bytes-column envelope
// ---------------------------------------------------------------------------

/**
 * Encrypt one plaintext field value under the active key.
 * A fresh random 96-bit IV is generated per call; IV and auth tag are embedded
 * in the returned binary envelope (layout documented at the top of this file).
 */
export function encryptField(plaintext: string): EncryptedField {
  const ring = parseKeyRing();
  const key = ring.keys.get(ring.activeKeyId)!;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, authTag, body]);
  return { ciphertext, keyId: ring.activeKeyId };
}

/**
 * Decrypt one field encrypted by {@link encryptField}. The keyId stored beside the
 * ciphertext selects the key — old keys in the ring keep decrypting after rotation.
 * Throws on unknown keyId, malformed envelope, or auth-tag failure (tampering).
 */
export function decryptField(field: { ciphertext: Uint8Array; keyId: string }): string {
  const ring = parseKeyRing();
  const key = ring.keys.get(field.keyId);
  if (!key) {
    throw new Error(`No encryption key in FIELD_ENCRYPTION_KEYS for keyId "${field.keyId}"`);
  }
  const envelope = Buffer.isBuffer(field.ciphertext)
    ? field.ciphertext
    : Buffer.from(field.ciphertext);
  if (envelope.length < HEADER_LENGTH) {
    throw new Error("Encrypted field envelope is too short");
  }
  if (envelope[0] !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted field envelope version ${envelope[0]}`);
  }
  const iv = envelope.subarray(1, 1 + IV_LENGTH);
  const authTag = envelope.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const body = envelope.subarray(HEADER_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt — JSON-embedded envelope (ApplicationData account numbers)
// ---------------------------------------------------------------------------

/** Encrypt a value into the JSON-embedded envelope shape (active key, fresh IV). */
export function encryptFieldToJson(plaintext: string): JsonEncryptedEnvelope {
  const { ciphertext, keyId } = encryptField(plaintext);
  return {
    __enc: JSON_ENVELOPE_MARKER,
    keyId,
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Decrypt a JSON-embedded envelope produced by {@link encryptFieldToJson}. */
export function decryptFieldFromJson(envelope: JsonEncryptedEnvelope): string {
  return decryptField({
    ciphertext: Buffer.from(envelope.ciphertext, "base64"),
    keyId: envelope.keyId,
  });
}

/** Type guard: is this JSON value an embedded encryption envelope? */
export function isJsonEncryptedEnvelope(value: unknown): value is JsonEncryptedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__enc === JSON_ENVELOPE_MARKER &&
    typeof (value as Record<string, unknown>).keyId === "string" &&
    typeof (value as Record<string, unknown>).ciphertext === "string"
  );
}
