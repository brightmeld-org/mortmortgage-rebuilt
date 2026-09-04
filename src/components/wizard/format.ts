// UrlaWizard (task-016) — display/parse helpers for currency inputs
// (§4.2.4: "Every currency field accepts dollars and cents and displays with
// thousands separators") and save-indicator timestamps.

/** Format a number for a currency input: 1234.56 -> "1,234.56". */
export function formatCurrencyInput(value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Display form with $ prefix: 1234.56 -> "$1,234.56". */
export function formatCurrencyDisplay(value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return (
    "$" +
    value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/**
 * Parse a currency input string: accepts dollars/cents, thousands separators,
 * optional leading $ and whitespace, optional leading minus (rejected upstream
 * for all fields except self-employment loss). Returns undefined for empty or
 * unparseable input.
 */
export function parseCurrencyInput(text: string): number | undefined {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return undefined;
  if (!/^-?\d*(\.\d{0,4})?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** "Saved at HH:MM:SS" clock text from an ISO timestamp (local time). */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Signature timestamp: "Aug 27, 2026 15:01 UTC" (frame wizard10). */
export function formatSignedAt(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Field path -> data-testid suffix: dots to dashes (build-plan §C selectors). */
export function testIdForPath(path: string): string {
  return `field-${path.replace(/[.[\]]+/g, "-").replace(/-+$/, "")}`;
}
