# Field-Encryption Key Rotation (AC-54)

All PII-at-rest fields (SSN, date of birth, bank access tokens, MFA secrets, and
account numbers embedded in ApplicationData JSON) are encrypted with AES-256-GCM.
Every ciphertext is stored together with the `keyId` that produced it, so multiple
keys can coexist: old keys keep decrypting old rows while new writes use the active
key. Rotation is therefore a zero-downtime, two-phase operation.

## Environment variables

| Variable | Meaning |
|---|---|
| `FIELD_ENCRYPTION_KEYS` | The full key ring: keyId → base64 32-byte key. JSON object (`{"k1":"...","k2":"..."}`) or comma list (`k1:...,k2:...`). |
| `FIELD_ENCRYPTION_ACTIVE_KEY_ID` | The keyId used for all new encryption. Must exist in the ring. |
| `SSN_BLIND_INDEX_KEY` | HMAC key for the SSN blind index. **Not part of AES rotation** — rotating it changes every blind index and requires re-deriving `ssnBlindIndex` from decrypted SSNs (separate procedure; duplicate detection is broken until complete). |

## Rotation procedure

1. **Generate a new key** (32 random bytes, base64):

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

2. **Add the new key to the ring** in `FIELD_ENCRYPTION_KEYS` under a new keyId
   (e.g. `k2`), keeping the old key(s) in place. Deploy/restart so every process
   sees the updated ring. Nothing changes behavior yet — the old key is still active.

3. **Flip the active key**: set `FIELD_ENCRYPTION_ACTIVE_KEY_ID` to the new keyId
   and deploy/restart. From this moment all new/updated encrypted values use the
   new key; existing rows still decrypt via the old key in the ring.

4. **Re-encrypt existing data**:

   ```
   npx tsx scripts/rotate-keys.ts
   ```

   The script re-encrypts, batch-wise and transactionally per batch, every
   encrypted column (`Borrower.ssn*`, `Borrower.dateOfBirth*`,
   `MfaEnrollment.secret*`, `BankLink.accessToken*`) and every JSON-embedded
   envelope inside `ApplicationData` documents whose keyId is not the active key.
   It is idempotent and safe to re-run (a crash mid-run loses nothing — rerun to
   finish). Rows written concurrently by live traffic are keyId-guarded and
   skipped, then picked up on the next run.

5. **Verify completion**: re-run the script; all counts must be 0. Optionally
   inspect the database: no `*KeyId` column value and no embedded-envelope
   `keyId` should reference the old key.

6. **Retire the old key**: remove the old entry from `FIELD_ENCRYPTION_KEYS` and
   deploy/restart. Any ciphertext still referencing a removed keyId becomes
   undecryptable — only do this after step 5 reports zero stale rows. Keep the
   retired key material in secure escrow (offline) in case old database backups
   ever need restoring; a backup taken before step 4 requires the key that was
   active when it was taken.

## Envelope reference

Binary envelope (Bytes columns): `[version 0x01][12-byte IV][16-byte GCM tag][ciphertext]`,
random IV per encryption. JSON-embedded envelope (account numbers inside
ApplicationData documents): `{"__enc":"aes-256-gcm","keyId":"...","ciphertext":"<base64 binary envelope>"}`.
Both are produced/consumed exclusively by `src/lib/crypto/encryption.ts`.
