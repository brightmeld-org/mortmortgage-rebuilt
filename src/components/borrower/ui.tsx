"use client";

// Shared presentational pieces for the borrower surfaces (task-017), in the
// frame's design language (paper ground, white cards, navy primary, copper
// accent, soft semantic badges — frame/artifact.html tokens in globals.css).

import { type ReactNode } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import type { WorkflowState } from "./types";

// ---------------------------------------------------------------------------
// Workflow state badge — label text ALWAYS comes from the server
// (workflowStateLabel); this maps state → tone only, never invents labels.
// ---------------------------------------------------------------------------

type BadgeTone = "gray" | "info" | "warn" | "success" | "danger";

const STATE_TONES: Record<WorkflowState, BadgeTone> = {
  draft: "gray",
  application_received: "info",
  completeness_validated: "info",
  documents_received: "info",
  aus_executed: "info",
  preliminary_decision: "info",
  escalated_review: "info",
  conditional_approval: "success",
  approved: "success",
  denied: "danger",
  borrower_notified: "info",
  revision_requested: "warn",
  suspended: "warn",
  withdrawn: "gray",
  declined_by_borrower: "gray",
};

const TONE_CLASSES: Record<BadgeTone, string> = {
  gray: "bg-gray-soft text-ink-soft",
  info: "bg-info-soft text-info",
  warn: "bg-warn-soft text-warn",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
};

export function StateBadge({
  state,
  label,
  testId,
}: {
  state: WorkflowState;
  label: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASSES[STATE_TONES[state] ?? "info"]}`}
    >
      {label}
    </span>
  );
}

export function Badge({ tone, children, testId }: { tone: BadgeTone; children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cards + layout
// ---------------------------------------------------------------------------

export function Card({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <section data-testid={testId} className={`rounded-lg border border-line bg-card p-6 shadow-sm ${className ?? ""}`}>
      {children}
    </section>
  );
}

export function CardHeading({ children }: { children: ReactNode }) {
  return <h2 className="font-display text-xl font-bold text-ink">{children}</h2>;
}

export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{children}</h3>
  );
}

export function StatCard({ value, label, testId }: { value: number; label: string; testId: string }) {
  return (
    <div data-testid={testId} className="rounded-lg border border-line bg-card px-4 py-3 shadow-sm">
      <p className="font-display text-2xl font-bold text-ink">{value}</p>
      <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons (frame: navy primary, outline secondary, red-outline destructive)
// ---------------------------------------------------------------------------

const BTN_BASE =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export const btnPrimary = `${BTN_BASE} bg-navy text-white hover:bg-navy-deep active:translate-y-px`;
export const btnCopper = `${BTN_BASE} bg-copper text-white hover:bg-copper/85 active:translate-y-px`;
export const btnOutline = `${BTN_BASE} border border-navy/40 bg-card text-navy hover:border-navy hover:bg-navy/5`;
export const btnDanger = `${BTN_BASE} border border-danger/50 bg-card text-danger hover:border-danger hover:bg-danger-soft`;

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

/** Server ErrorResponse rendered VERBATIM (message + details) — NFR-025. */
export function ApiErrorBanner({
  message,
  details,
  testId,
}: {
  message: string;
  details?: string[];
  testId: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
    >
      <p>{message}</p>
      {details && details.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function InfoBanner({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-info/30 bg-info-soft px-3.5 py-2.5 text-sm text-info"
    >
      {children}
    </div>
  );
}

export function WarnBanner({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-sm text-warn"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

export function SkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-gray-soft ${className ?? "h-24 w-full"}`} />;
}

// ---------------------------------------------------------------------------
// Confirm dialog (destructive confirmations — frame confirm-dialog vocabulary)
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmTestId: string;
  /** Visual style of the confirm button. */
  destructive?: boolean;
  /** Renders an optional free-text reason field when set. */
  reasonLabel?: string;
  reasonTestId?: string;
  reasonValue?: string;
  onReasonChange?: (value: string) => void;
  busy?: boolean;
  error?: { message: string; details?: string[] } | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  confirmTestId,
  destructive,
  reasonLabel,
  reasonTestId,
  reasonValue,
  onReasonChange,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // NFR-025 / LENS-014 / LENS-022: focus move-in, a real bidirectional Tab
  // trap, Escape-to-close and focus restored to the invoker — the ONE modal
  // focus primitive. Every caller mounts this only while open (open == mounted),
  // so the hook is called unconditionally as required.
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-lg border border-line bg-card p-6 shadow-xl"
      >
        <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        <div className="mt-2 text-sm text-ink-soft">{body}</div>
        {reasonLabel ? (
          <div className="mt-4">
            <label htmlFor={reasonTestId} className="mb-1.5 block text-sm font-medium text-ink">
              {reasonLabel}
            </label>
            <textarea
              id={reasonTestId}
              data-testid={reasonTestId}
              rows={3}
              value={reasonValue ?? ""}
              onChange={(event) => onReasonChange?.(event.target.value)}
              className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
            />
          </div>
        ) : null}
        {error ? (
          <div className="mt-4">
            <ApiErrorBanner message={error.message} details={error.details} testId={`${confirmTestId}-error`} />
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            data-testid={`${confirmTestId}-cancel`}
            onClick={onCancel}
            className={btnOutline}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={busy}
            className={destructive ? btnDanger : btnPrimary}
          >
            {busy ? "Please wait…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
