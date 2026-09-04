"use client";

// UrlaWizard — destructive-confirmation dialog for the wizard's own surfaces:
// document delete (BUG-33, §4.2.9 "Deletion … with confirmation") and bank-link
// unlink (BUG-28, §4.2.10). Same vocabulary as the borrower ConfirmDialog
// (title / body / danger confirm + Cancel, server ErrorResponse rendered
// VERBATIM — NFR-025), but built on the ONE modal focus primitive:
// `useModalFocus` gives focus move-in, a real Tab trap, Escape-to-close and
// focus restored to the invoker (NFR-025 / LENS-014). The hook must be called
// unconditionally, so open = mounted — the parent mounts/unmounts this.

import type { ReactNode } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import { ApiErrorBanner, btnDanger, btnOutline } from "@/components/borrower/ui";

export function ConfirmActionDialog({
  title,
  body,
  confirmLabel,
  confirmTestId,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Cancel is `${confirmTestId}-cancel`; the error banner `${confirmTestId}-error`. */
  confirmTestId: string;
  busy?: boolean;
  error?: { message: string; details?: string[] } | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
        data-testid={`${confirmTestId}-dialog`}
        className="w-full max-w-md rounded-lg border border-line bg-card p-6 shadow-xl"
      >
        <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        <div className="mt-2 text-sm text-ink-soft">{body}</div>
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
            disabled={busy}
            className={btnOutline}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={busy}
            className={btnDanger}
          >
            {busy ? "Please wait…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
