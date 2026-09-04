// Serializer-level strip guarantee for borrower-visible output (S-6/S-7,
// SEC-22, NFR-023, REQ-007/REQ-008).
//
// CONVENTION (binding for every later increment): any serializer that produces a
// response a BORROWER can receive must project the record through `forBorrower`
// with an EXPLICIT field allowlist. The mechanism is allowlist-based — fields not
// named are stripped, so staff user ids, staff emails, internal notes, and chatter
// can never leak by accident when a model grows a column. Never hand a raw Prisma
// row (or spread one) into a borrower-facing Response.
//
// What must NEVER appear in a borrower allowlist:
//   - staff user identifiers or staff emails (S-6) — staff appear as display name +
//     role only (e.g. Application.assignedCaseworkerName is a display name field);
//   - notes of type internal, and chatter (S-7) — borrower note lists are filtered
//     to type=formal at the QUERY level AND serialized through forBorrower;
//   - raw encrypted/ciphertext columns, blind indexes, token hashes.
//
// This module is generic plumbing (live data in/out — a projection, not a stub);
// each feature increment declares its own allowlists next to its serializer.

/** A readonly list of keys of T that are safe on a borrower-visible surface. */
export type BorrowerAllowlist<T> = readonly (keyof T)[];

/**
 * Project `record` to exactly the allowlisted fields. Everything else — known or
 * unknown, present today or added by a future migration — is stripped. `undefined`
 * values are omitted so optional contract fields serialize as absent, not null-ish.
 */
export function forBorrower<T extends object, K extends keyof T>(
  record: T,
  allowlist: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of allowlist) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** List form of forBorrower — same guarantee for every row of a page. */
export function forBorrowerList<T extends object, K extends keyof T>(
  records: readonly T[],
  allowlist: readonly K[],
): Pick<T, K>[] {
  return records.map((record) => forBorrower(record, allowlist));
}

/**
 * Dev-time tripwire for allowlist reviews: returns the keys of `record` that the
 * allowlist strips. Useful in serializer unit tests to assert that a named
 * forbidden field (e.g. "authorUserId") is indeed absent from borrower output.
 */
export function strippedKeys<T extends object>(
  record: T,
  allowlist: BorrowerAllowlist<T>,
): string[] {
  const allowed = new Set(allowlist.map(String));
  return Object.keys(record).filter((key) => !allowed.has(key));
}
