"use client";

// Shared presentational primitives for the Underwriting panel (task-026) in
// the frame's design language (paper ground, white cards, navy primary,
// copper accent, soft semantic badges — same tokens as src/components/borrower/ui.tsx).

import type { ReactNode } from "react";
import type { RiskBadge } from "./types";

// ---------------------------------------------------------------------------
// Risk badge (contracts enum green/yellow/red — value comes from the SERVER's
// UnderwritingResultInfo.riskBadge, which implements the §4.6.5 thresholds;
// the panel renders it and never re-derives thresholds).
// ---------------------------------------------------------------------------

const RISK_CLASSES: Record<RiskBadge, string> = {
  green: "bg-success-soft text-success",
  yellow: "bg-warn-soft text-warn",
  red: "bg-danger-soft text-danger",
};

export function RiskBadgePill({
  badge,
  label,
  testId,
}: {
  badge: RiskBadge;
  label: string;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      data-badge={badge}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${RISK_CLASSES[badge]}`}
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stale indicator (§4.6.5 / ASM-006)
// ---------------------------------------------------------------------------

export function StalePill({ text, testId }: { text: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-block whitespace-nowrap rounded-full border border-warn/40 bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn"
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Key/value metric row (frame: label left, value right, hairline dividers)
// ---------------------------------------------------------------------------

export function MetricRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-baseline justify-between gap-4 border-b border-line/70 py-2 last:border-b-0"
    >
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="text-right text-sm font-semibold text-ink">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data table (frame: tiny uppercase headers, hairline rows)
// ---------------------------------------------------------------------------

export function MiniTable({
  headers,
  children,
  testId,
  caption,
}: {
  headers: string[];
  children: ReactNode;
  testId?: string;
  caption?: string;
}) {
  return (
    <div data-testid={testId} className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                scope="col"
                className="border-b border-line px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted first:pl-0 last:pr-0"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <td
      className={`border-b border-line/60 px-2 py-1.5 text-ink first:pl-0 last:pr-0 ${right ? "text-right tabular-nums" : "text-left"}`}
    >
      {children}
    </td>
  );
}

/** Section sub-heading inside an expanded check body. */
export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted first:mt-0">
      {children}
    </h4>
  );
}
