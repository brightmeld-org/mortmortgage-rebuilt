"use client";

// Shared presentational pieces for the staff application detail (task-029), in
// the frame's design language (paper ground, white cards, navy primary, copper
// accent — same vocabulary as src/components/borrower/ui.tsx and
// src/components/caseworker/ui.tsx).
//
// The FieldRow here is the single rendering path for every data-tab field:
// read-only value, the inline-correction edit affordance (staff-editable
// states only), the corrected-field indicator, and its hover/focus provenance
// popover (original value, who, when, why — §4.4.4).

import { useState, type ReactNode } from "react";
import { formatDate } from "@/components/borrower/format";
import {
  correctionKey,
  fieldPathTestId,
  type CorrectableField,
  type CorrectionsContext,
} from "./types";

// ---------------------------------------------------------------------------
// Section + field grid
// ---------------------------------------------------------------------------

export function DetailSection({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="rounded-lg border border-line bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Co-borrower data is CLEARLY labeled (§4.4.3): every per-borrower section
 * carries this badge — copper for the co-borrower so it can never be mistaken
 * for primary-borrower data.
 */
export function BorrowerScopeBadge({ ordinal, name }: { ordinal: number; name?: string }) {
  const isCo = ordinal !== 1;
  return (
    <span
      data-testid={`borrower-scope-${ordinal}`}
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        isCo ? "bg-copper-soft text-copper" : "bg-navy/10 text-navy"
      }`}
    >
      {isCo ? "Co-borrower" : "Primary borrower"}
      {name ? ` — ${name}` : ""}
    </span>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 gap-x-8 gap-y-0 sm:grid-cols-2">{children}</dl>;
}

// ---------------------------------------------------------------------------
// FieldRow — one labeled value with optional correction affordance
// ---------------------------------------------------------------------------

export interface FieldRowProps {
  label: string;
  /** Pre-formatted display value (Mon D, YYYY / $1,234.56 / masked SSN…). */
  value: ReactNode;
  /**
   * When set, the field is correctable: renders the edit affordance in
   * staff-editable states and the corrected-field indicator + provenance
   * popover when a correction exists for the path.
   */
  correctable?: CorrectableField;
  corrections?: CorrectionsContext;
}

export function FieldRow({ label, value, correctable, corrections }: FieldRowProps) {
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const correction =
    correctable && corrections
      ? corrections.byField.get(correctionKey(correctable.fieldPath, correctable.borrowerOrdinal))
      : undefined;
  const tid = correctable
    ? fieldPathTestId(correctable.fieldPath, correctable.borrowerOrdinal)
    : undefined;

  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 py-2 last:border-b-0">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="flex items-center gap-1.5 text-right text-sm font-semibold text-ink">
        {correction && tid ? (
          <span
            data-testid={`correction-indicator-${tid}`}
            tabIndex={0}
            role="note"
            aria-label={`Corrected field — ${label}`}
            className="relative inline-flex items-center gap-1 rounded border border-dashed border-copper px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-copper/40"
            onMouseEnter={() => setProvenanceOpen(true)}
            onMouseLeave={() => setProvenanceOpen(false)}
            onFocus={() => setProvenanceOpen(true)}
            onBlur={() => setProvenanceOpen(false)}
          >
            <span aria-hidden className="text-copper">
              ✎
            </span>
            {value}
            {provenanceOpen ? (
              <span
                data-testid={`correction-provenance-${tid}`}
                role="tooltip"
                className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-md border border-line bg-card p-3 text-left text-xs font-normal shadow-lg"
              >
                <span className="block font-semibold text-copper">Corrected field</span>
                <span className="mt-1 block text-ink-soft">
                  Original value:{" "}
                  <span className="font-semibold text-ink">
                    {correction.beforeValue === undefined || correction.beforeValue === ""
                      ? "(empty)"
                      : correction.beforeValue}
                  </span>
                </span>
                <span className="block text-ink-soft">
                  Changed by: <span className="font-semibold text-ink">{correction.correctedByName}</span>{" "}
                  ({correction.correctedByRole})
                </span>
                <span className="block text-ink-soft">
                  When: <span className="font-semibold text-ink">{formatDate(correction.correctedAt)}</span>
                </span>
                <span className="block text-ink-soft">
                  Why: <span className="font-semibold text-ink">{correction.reason}</span>
                </span>
              </span>
            ) : null}
          </span>
        ) : (
          <span>{value}</span>
        )}
        {correctable && corrections?.canCorrect && tid ? (
          <button
            type="button"
            data-testid={`correction-edit-${tid}`}
            aria-label={`Correct ${label}`}
            title={`Correct ${label}`}
            onClick={() => corrections.openEditor(correctable)}
            className="rounded p-0.5 text-muted transition-colors duration-200 hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
              <path d="M11.5 1.6a1.9 1.9 0 0 1 2.7 2.7l-.9.9-2.7-2.7.9-.9ZM9.6 3.6l2.7 2.7-6.8 6.8-3 .4.4-3 6.7-6.9Z" />
            </svg>
          </button>
        ) : null}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty-state line for lists with no rows ("None recorded" — never blank)
// ---------------------------------------------------------------------------

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-muted">{children}</p>;
}
