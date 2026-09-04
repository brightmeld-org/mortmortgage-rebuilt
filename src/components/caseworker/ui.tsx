"use client";

// Shared presentational pieces for the caseworker workbench (task-028), in the
// frame's design language (paper ground, white cards, navy primary, copper
// accent — frame/artifact.html tokens in globals.css; same vocabulary as
// src/components/borrower/ui.tsx).

import type { ReactNode } from "react";
import type { Priority, SlaStatus } from "./types";

// ---------------------------------------------------------------------------
// Priority badge — §4.4.1 values Urgent/High/Normal/Low, color-coded
// red/orange/blue/gray (labels derived 1:1 from the contract enum).
// ---------------------------------------------------------------------------

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

const PRIORITY_CLASSES: Record<Priority, string> = {
  urgent: "bg-danger-soft text-danger",
  high: "bg-copper-soft text-copper",
  normal: "bg-info-soft text-info",
  low: "bg-gray-soft text-ink-soft",
};

export function PriorityBadge({ priority, testId }: { priority: Priority; testId: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        PRIORITY_CLASSES[priority] ?? "bg-gray-soft text-ink-soft"
      }`}
    >
      {PRIORITY_LABELS[priority] ?? priority}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SLA badge — On track (green) / At risk (yellow) / Overdue (red), §4.4.1.
// ---------------------------------------------------------------------------

const SLA_LABELS: Record<SlaStatus, string> = {
  "on-track": "On track",
  "at-risk": "At risk",
  overdue: "Overdue",
};

const SLA_CLASSES: Record<SlaStatus, string> = {
  "on-track": "bg-success-soft text-success",
  "at-risk": "bg-warn-soft text-warn",
  overdue: "bg-danger-soft text-danger",
};

export function SlaBadge({ slaStatus, testId }: { slaStatus: SlaStatus; testId: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        SLA_CLASSES[slaStatus] ?? "bg-gray-soft text-ink-soft"
      }`}
    >
      {SLA_LABELS[slaStatus] ?? slaStatus}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stats-strip card (value already formatted — e.g. "17.2", "72%").
// ---------------------------------------------------------------------------

export function StatStripCard({
  value,
  label,
  tone,
  testId,
}: {
  value: string;
  label: string;
  tone?: "danger";
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-lg border border-line bg-card px-4 py-3 shadow-sm">
      <p className={`font-display text-2xl font-bold ${tone === "danger" ? "text-danger" : "text-ink"}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast (claim conflict / claim success — frame "claim conflict toast").
// ---------------------------------------------------------------------------

export interface ToastState {
  kind: "success" | "error";
  message: string;
}

export function Toast({ toast, onDismiss, testId }: { toast: ToastState; onDismiss: () => void; testId: string }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={`fixed bottom-6 right-6 z-50 flex max-w-md items-start gap-3 rounded-lg border px-4 py-3 shadow-lg ${
        toast.kind === "error"
          ? "border-danger/40 bg-danger-soft text-danger"
          : "border-success/40 bg-success-soft text-success"
      }`}
    >
      <p className="text-sm font-medium">{toast.message}</p>
      <button
        type="button"
        aria-label="Dismiss notification"
        data-testid={`${testId}-dismiss`}
        onClick={onDismiss}
        className="ml-1 text-lg leading-none opacity-60 transition-opacity duration-200 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination footer (shared list convention: rows/page/pageSize/total).
// ---------------------------------------------------------------------------

export function PaginationBar({
  page,
  pageSize,
  total,
  onPage,
  testIdPrefix,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  testIdPrefix: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page === 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-ink-soft">
      <span>
        Page {page} of {pageCount} · {total} {total === 1 ? "row" : "rows"}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid={`${testIdPrefix}-prev`}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="rounded-md border border-line px-2.5 py-1 text-sm font-medium transition-colors duration-200 hover:border-navy hover:text-navy disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-next`}
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          className="rounded-md border border-line px-2.5 py-1 text-sm font-medium transition-colors duration-200 hover:border-navy hover:text-navy disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
