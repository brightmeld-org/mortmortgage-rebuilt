/**
 * THE single masking module (SEC-1, SEC-2, NFR-003, REQ-006).
 *
 * Every serializer that emits SSN or date-of-birth data MUST import from this module —
 * there is no other masking implementation in the system. BorrowerRecord.ssnMasked is
 * always the output of maskSsn(); BorrowerRecord.dateOfBirthDisplay is always the
 * output of formatDobDisplay().
 *
 * The ONLY unmasked SSN egress in the whole system is
 * `GET /api/applications/:id/borrowers/:ordinal/identity` (BorrowerIdentityOwn) —
 * the owner-only identity endpoint (S-5). Every other read surface carries
 * `ssnMasked` (`***-**-NNNN`) and `dateOfBirthDisplay` ("Mon D, YYYY") produced here;
 * raw ISO DOB never leaves the identity-own endpoint (SEC-2).
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Mask an SSN from its stored last four digits: `***-**-NNNN`.
 * Input is Borrower.ssnLast4 (exactly 4 digits) — never a full SSN.
 */
export function maskSsn(last4: string): string {
  if (!/^\d{4}$/.test(last4)) {
    throw new Error("maskSsn expects exactly the 4 last digits of the SSN");
  }
  return `***-**-${last4}`;
}

/**
 * Human-readable date of birth for display: "Mon D, YYYY" (e.g. "Mar 5, 1984").
 * Never emits raw ISO. Accepts the decrypted ISO 8601 date string ("1984-03-05")
 * or a Date; date-only strings are interpreted as calendar dates (UTC) so the
 * rendered day never shifts with server timezone.
 */
export function formatDobDisplay(date: string | Date): string {
  let year: number;
  let monthIndex: number;
  let day: number;

  if (typeof date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
    if (!m) {
      throw new Error("formatDobDisplay expects an ISO 8601 date (YYYY-MM-DD) or a Date");
    }
    year = Number(m[1]);
    monthIndex = Number(m[2]) - 1;
    day = Number(m[3]);
    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) {
      throw new Error("formatDobDisplay received an out-of-range calendar date");
    }
  } else {
    if (Number.isNaN(date.getTime())) {
      throw new Error("formatDobDisplay received an invalid Date");
    }
    year = date.getUTCFullYear();
    monthIndex = date.getUTCMonth();
    day = date.getUTCDate();
  }

  return `${MONTHS[monthIndex]} ${day}, ${year}`;
}
