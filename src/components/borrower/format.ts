// Shared display formatting for the borrower surfaces (task-017).
// ONE formatting approach, used consistently (contracts §A conventions):
//   dates    → "Mon D, YYYY"   (e.g. Aug 18, 2026)
//   currency → "$1,234.56"     (thousands separators, cents always shown)

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const CURRENCY_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ISO 8601 timestamp or date → "Mon D, YYYY"; em dash for absent values. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_FORMAT.format(date);
}

/** Dollars with cents → "$1,234.56"; em dash for absent values. */
export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  return CURRENCY_FORMAT.format(amount);
}

/**
 * Human-readable form of a kebab-case enum literal for display-only surfaces
 * where the contract defines machine values but no label table (e.g.
 * "single-family-detached" → "Single Family Detached"). Workflow states NEVER
 * go through this — their labels come from the server (workflowStateLabel).
 */
const ACRONYM_TOKENS: Record<string, string> = {
  us: "U.S.",
  fha: "FHA",
  va: "VA",
  usda: "USDA",
  cd: "CD",
  reo: "REO",
  hoa: "HOA",
  pud: "PUD",
  sms: "SMS",
};

export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split("-")
    .map((part) =>
      ACRONYM_TOKENS[part] ?? (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part),
    )
    .join(" ");
}
