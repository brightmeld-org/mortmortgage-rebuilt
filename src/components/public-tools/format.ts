// Display formatting for the public tools (task-018) — frame authority:
// screen-prequalify.png / screen-compare.png show whole-dollar currency
// ("$412,000") and two-decimal rates ("6.50%").

/** "$412,000" — whole-dollar US currency (calculator outputs). */
export function fmtCurrency(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** "6.50%" — rate percent with two decimals. */
export function fmtRate(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** "80%" — LTV percent, trimming trailing zeros ("80%", "88.89%"). */
export function fmtLtv(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}%`;
}

/** Digits-with-commas for currency INPUT display ("8,400"); empty for null. */
export function fmtInputAmount(value: number | null): string {
  return value === null ? "" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Parse a currency input string ("$8,400", "8400.50") to a number, or null when
 * no digits are present. Never throws.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
