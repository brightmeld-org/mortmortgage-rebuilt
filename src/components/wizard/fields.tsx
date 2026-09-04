"use client";

// UrlaWizard (task-016) — form primitives in the frame's design language
// (paper/card/ink/navy/copper tokens from src/app/globals.css @theme, sourced
// from frame/artifact.html). Every input carries data-testid
// `field-{fieldPath}` (dots -> dashes, per build-plan §C selectors) and renders
// its own label, hint, and inline validation message.

import { useEffect, useId, useState } from "react";
import type { EnumOption } from "./types";
import { formatCurrencyInput, parseCurrencyInput, testIdForPath } from "./format";

export const inputClass =
  "w-full rounded-md border border-line bg-card px-3 py-2 text-[15px] text-ink shadow-sm outline-none transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] placeholder:text-muted/70 focus:border-navy focus:ring-2 focus:ring-navy/20 disabled:cursor-not-allowed disabled:bg-gray-soft disabled:text-muted";

const errorInputClass = "border-danger focus:border-danger focus:ring-danger/20";

export interface FieldChrome {
  path: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
}

function LabelRow({ label, required, htmlFor }: { label: string; required?: boolean; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-[13px] font-semibold text-ink">
      {label}
      {required ? <span aria-hidden="true"> *</span> : null}
    </label>
  );
}

function UnderRow({
  hint,
  error,
  errorId,
  hintId,
}: {
  hint?: string;
  error?: string;
  errorId: string;
  hintId?: string;
}) {
  if (error) {
    return (
      <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
        {error}
      </p>
    );
  }
  if (hint)
    return (
      <p id={hintId} className="mt-1 text-xs text-muted">
        {hint}
      </p>
    );
  return null;
}

/**
 * NFR-025 (WCAG 2.1 AA), LENS-014 — the SINGLE rule for wiring a control to the
 * text UnderRow renders beneath it. UnderRow shows the error when there is one
 * and the hint otherwise, so exactly one id is ever live. Every field component
 * in this file uses this helper, so the association can never be omitted at one
 * call site again (the omission LENS-014 found in YesNoField).
 */
function describedBy(
  props: { hint?: string; error?: string },
  errorId: string,
  hintId: string,
): string | undefined {
  if (props.error) return errorId;
  if (props.hint) return hintId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Text / date / integer
// ---------------------------------------------------------------------------

export function TextField(
  props: FieldChrome & {
    value: string | undefined;
    onChange: (v: string) => void;
    type?: "text" | "email" | "tel" | "date";
    placeholder?: string;
    maxLength?: number;
  },
) {
  const id = useId();
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <LabelRow label={props.label} required={props.required} htmlFor={id} />
      <input
        id={id}
        data-testid={testIdForPath(props.path)}
        type={props.type ?? "text"}
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props, errorId, hintId)}
        className={`${inputClass} ${props.error ? errorInputClass : ""}`}
      />
      <UnderRow hint={props.hint} error={props.error} errorId={errorId} hintId={hintId} />
    </div>
  );
}

export function IntField(
  props: FieldChrome & {
    value: number | undefined;
    onChange: (v: number | undefined) => void;
    min?: number;
    max?: number;
    placeholder?: string;
  },
) {
  const id = useId();
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <LabelRow label={props.label} required={props.required} htmlFor={id} />
      <input
        id={id}
        data-testid={testIdForPath(props.path)}
        type="number"
        inputMode="numeric"
        value={props.value === undefined ? "" : String(props.value)}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return props.onChange(undefined);
          const n = Number(raw);
          props.onChange(Number.isInteger(n) ? n : Math.trunc(n));
        }}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props, errorId, hintId)}
        className={`${inputClass} ${props.error ? errorInputClass : ""}`}
      />
      <UnderRow hint={props.hint} error={props.error} errorId={errorId} hintId={hintId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Currency — dollars/cents with thousands separators (§4.2.4)
// ---------------------------------------------------------------------------

export function CurrencyField(
  props: FieldChrome & {
    value: number | undefined;
    onChange: (v: number | undefined) => void;
    allowNegative?: boolean;
  },
) {
  const id = useId();
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  const [text, setText] = useState(formatCurrencyInput(props.value));
  const [focused, setFocused] = useState(false);
  // Keep local text in sync with external value while not editing.
  useEffect(() => {
    if (!focused) setText(formatCurrencyInput(props.value));
  }, [props.value, focused]);

  return (
    <div>
      <LabelRow label={props.label} required={props.required} htmlFor={id} />
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted">
          $
        </span>
        <input
          id={id}
          data-testid={testIdForPath(props.path)}
          type="text"
          inputMode="decimal"
          value={text}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            const parsed = parseCurrencyInput(raw);
            if (parsed !== undefined && parsed < 0 && !props.allowNegative) return;
            props.onChange(parsed);
          }}
          onBlur={() => {
            setFocused(false);
            setText(formatCurrencyInput(props.value));
          }}
          placeholder="0.00"
          disabled={props.disabled}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy(props, errorId, hintId)}
          className={`${inputClass} pl-7 ${props.error ? errorInputClass : ""}`}
        />
      </div>
      <UnderRow hint={props.hint} error={props.error} errorId={errorId} hintId={hintId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select — options are contracts.json enum values VERBATIM
// ---------------------------------------------------------------------------

export function SelectField(
  props: FieldChrome & {
    value: string | undefined;
    onChange: (v: string | undefined) => void;
    options: EnumOption[];
    placeholder?: string;
  },
) {
  const id = useId();
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <LabelRow label={props.label} required={props.required} htmlFor={id} />
      <select
        id={id}
        data-testid={testIdForPath(props.path)}
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? undefined : e.target.value)}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props, errorId, hintId)}
        className={`${inputClass} ${props.error ? errorInputClass : ""}`}
      >
        <option value="">{props.placeholder ?? "Select…"}</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <UnderRow hint={props.hint} error={props.error} errorId={errorId} hintId={hintId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

export function CheckField(
  props: Omit<FieldChrome, "label"> & {
    label: React.ReactNode;
    checked: boolean;
    onChange: (v: boolean) => void;
  },
) {
  const id = useId();
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-sm text-ink">
        <input
          id={id}
          data-testid={testIdForPath(props.path)}
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
          disabled={props.disabled}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy(props, errorId, hintId)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-navy"
        />
        <span>{props.label}</span>
      </label>
      <UnderRow hint={props.hint} error={props.error} errorId={errorId} hintId={hintId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Yes/No radio pair (declarations, booleans with required answers)
// ---------------------------------------------------------------------------

export function YesNoField(
  props: Omit<FieldChrome, "label"> & {
    label: React.ReactNode;
    value: boolean | undefined;
    onChange: (v: boolean) => void;
  },
) {
  const id = useId();
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  const btn = (val: boolean, text: string) => {
    const active = props.value === val;
    return (
      <button
        type="button"
        data-testid={`${testIdForPath(props.path)}-${text.toLowerCase()}`}
        onClick={() => props.onChange(val)}
        disabled={props.disabled}
        aria-pressed={active}
        className={`rounded-md border px-4 py-1.5 text-sm font-semibold transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] disabled:cursor-not-allowed disabled:opacity-60 ${
          active
            ? "border-navy bg-navy text-white"
            : "border-line bg-card text-ink-soft hover:border-navy/50"
        }`}
      >
        {text}
      </button>
    );
  };
  return (
    // NFR-025 / LENS-014: the group is the labelled, described, validity-bearing
    // control here — the Yes/No buttons are its children. Without
    // aria-describedby the error text UnderRow renders carries an id that
    // nothing points at, so screen readers never announce it. Declarations A–M
    // in Step 8 are all YesNoFields.
    <div
      data-testid={testIdForPath(props.path)}
      role="group"
      aria-labelledby={`${id}-lbl`}
      aria-invalid={props.error ? true : undefined}
      aria-describedby={describedBy(props, errorId, hintId)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <span id={`${id}-lbl`} className="max-w-[46rem] text-sm text-ink">
          {props.label}
          {props.required ? <span aria-hidden="true"> *</span> : null}
        </span>
        <span className="flex gap-2">
          {btn(true, "Yes")}
          {btn(false, "No")}
        </span>
      </div>
      <UnderRow hint={props.hint} error={props.error} errorId={errorId} hintId={hintId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout + repeating-group scaffolding
// ---------------------------------------------------------------------------

export function FieldGrid({ children, cols = 3 }: { children: React.ReactNode; cols?: 2 | 3 | 4 }) {
  const cls = cols === 2 ? "sm:grid-cols-2" : cols === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3";
  return <div className={`grid grid-cols-1 gap-x-5 gap-y-4 ${cls}`}>{children}</div>;
}

export function GroupCard({
  title,
  onRemove,
  removeTestId,
  removeLabel,
  children,
  badge,
  disabled,
}: {
  title: string;
  onRemove?: () => void;
  removeTestId?: string;
  removeLabel?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-paper/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-ink-soft">
          {title}
          {badge}
        </p>
        {onRemove ? (
          <button
            type="button"
            data-testid={removeTestId}
            onClick={onRemove}
            disabled={disabled}
            className="text-xs font-semibold text-danger transition-opacity duration-200 hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {removeLabel ?? "Remove"}
          </button>
        ) : null}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function AddRowButton({
  onClick,
  label,
  testId,
  disabled,
}: {
  onClick: () => void;
  label: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-dashed border-navy/40 px-4 py-2 text-sm font-semibold text-navy transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-navy/5 disabled:cursor-not-allowed disabled:opacity-50"
    >
      + {label}
    </button>
  );
}

export function SectionHeading({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div>
      <h3 className="font-display text-lg font-semibold text-ink">{children}</h3>
      {sub ? <p className="mt-0.5 text-sm text-muted">{sub}</p> : null}
    </div>
  );
}
