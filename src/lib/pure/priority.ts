// Pure automatic-priority rules (task-021) — REQ-057, RFP §4.4.1 verbatim:
//
//   "Priority values: Urgent, High, Normal, Low ... Default Normal. Automatic
//    rules: purchase with target closing date within 14 days → Urgent; within
//    30 days → High; loan amount ≥ $1,000,000 → High. A Supervisor may
//    override priority manually; overrides are audited."
//
// Semantics implemented:
//   - The closing-date rules apply to PURCHASE loans only (RFP wording:
//     "purchase with target closing date ...").
//   - "Within N days" is measured in calendar days between the local calendar
//     date of `now` (company time zone) and the plain targetClosingDate
//     (ISO YYYY-MM-DD). A closing date that is today or already past is
//     "within 14 days" — an at-or-past-due closing is treated as most urgent.
//   - Urgent wins over High when both closing-date and loan-amount rules fire.
//   - 'low' is NEVER produced automatically — it is reachable only through a
//     Supervisor override (RFP lists no automatic rule that yields Low).
//   - Automatic evaluation NEVER overwrites a Supervisor override — enforced
//     by the service layer (priorityOverride pins the stored value); this pure
//     function just computes what the automatic rules say.
//
// Deterministic: the clock and time zone are passed in; no Date.now().

import { localEpochDay } from "@/lib/pure/sla";

/** Automatic rules can only produce these Priority values (contracts.json-verbatim literals). */
export type AutomaticPriority = "urgent" | "high" | "normal";

/** RFP §4.4.1: loan amount at or above this triggers High priority (not configurable — not in §4.6.11). */
export const HIGH_PRIORITY_LOAN_AMOUNT = 1_000_000;

export const URGENT_CLOSING_WINDOW_DAYS = 14;
export const HIGH_CLOSING_WINDOW_DAYS = 30;

export interface AutomaticPriorityInput {
  /** LoanDetails.loanPurpose (ApplicationData.loan JSON). */
  loanPurpose?: string | null;
  /** SubjectProperty.targetClosingDate — plain ISO date YYYY-MM-DD (ApplicationData.subjectProperty JSON). */
  targetClosingDate?: string | null;
  /** LoanDetails.requestedLoanAmount (ApplicationData.loan JSON). */
  requestedLoanAmount?: number | null;
}

const PLAIN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch day of a plain YYYY-MM-DD date (zone-free — plain dates have no zone). */
function plainDateEpochDay(value: string): number | null {
  const match = PLAIN_DATE_RE.exec(value);
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(utc)) return null;
  return Math.floor(utc / 86_400_000);
}

/**
 * Evaluate the RFP §4.4.1 automatic priority rules from live application data.
 * Returns 'urgent' | 'high' | 'normal' — never 'low'.
 */
export function evaluateAutomaticPriority(
  input: AutomaticPriorityInput,
  now: Date,
  timeZone: string,
): AutomaticPriority {
  let closingRule: AutomaticPriority = "normal";

  if (
    input.loanPurpose === "purchase" &&
    typeof input.targetClosingDate === "string" &&
    input.targetClosingDate.length > 0
  ) {
    const closingDay = plainDateEpochDay(input.targetClosingDate);
    if (closingDay !== null) {
      const daysUntilClosing = closingDay - localEpochDay(now, timeZone);
      if (daysUntilClosing <= URGENT_CLOSING_WINDOW_DAYS) closingRule = "urgent";
      else if (daysUntilClosing <= HIGH_CLOSING_WINDOW_DAYS) closingRule = "high";
    }
  }

  if (closingRule === "urgent") return "urgent";

  const amount = input.requestedLoanAmount;
  if (typeof amount === "number" && Number.isFinite(amount) && amount >= HIGH_PRIORITY_LOAN_AMOUNT) {
    return "high";
  }

  return closingRule;
}
