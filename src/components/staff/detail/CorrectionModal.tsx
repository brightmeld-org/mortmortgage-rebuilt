"use client";

// Inline-correction modal (task-029 — §4.4.4 / REQ-050). Edit icon per field
// opens this modal with the new value + REQUIRED reason (frame: "modal with
// new value + required reason"). POST /api/applications/:id/corrections with
// CorrectionRequest { fieldPath, borrowerOrdinal?, newValue, reason } —
// newValue is a JSON-encoded scalar per the contract; the server validates it
// against the field schema and 409s outside staff-editable states. Error
// bodies surface VERBATIM.
//
// OPTIMISTIC CONCURRENCY (§A, INV-039): the request carries the versionStamp
// captured by the detail surface's most recent GET /api/applications/:id —
// NOT a value refetched at save time, which would defeat the check. A 409
// means the application changed in another tab or session; it is escalated to
// the parent so the surface can raise the same reload prompt the wizard's
// stale section save raises, rather than being reported as a field error.
//
// Selector contract (§C): correction-reason-input, correction-save-btn (+
// correction-value-input / correction-cancel-btn namespace extensions).

import { useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import { postWithCsrf } from "./api";
import { ApiErrorBanner, btnOutline, btnPrimary } from "@/components/borrower/ui";
import type { CorrectableField, CorrectionInfo } from "./types";

/** JSON-encode the typed value per the field's kind (VR-091 scalar). */
function encodeNewValue(kind: CorrectableField["kind"], raw: string): { ok: true; json: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (kind === "number") {
    if (trimmed === "") return { ok: false, message: "Enter a number." };
    const cleaned = trimmed.replace(/[$,]/g, "");
    const num = Number(cleaned);
    if (!Number.isFinite(num)) return { ok: false, message: "Enter a valid number." };
    return { ok: true, json: JSON.stringify(num) };
  }
  if (kind === "boolean") {
    const lowered = trimmed.toLowerCase();
    if (lowered === "true" || lowered === "yes") return { ok: true, json: "true" };
    if (lowered === "false" || lowered === "no") return { ok: true, json: "false" };
    return { ok: false, message: "Enter yes or no." };
  }
  return { ok: true, json: JSON.stringify(trimmed) };
}

export function CorrectionModal({
  applicationId,
  versionStamp,
  field,
  onSaved,
  onConflict,
  onCancel,
}: {
  applicationId: string;
  /** Application.versionStamp from the surface's most recent GET (§A). */
  versionStamp: number;
  field: CorrectableField;
  /** Called with the created CorrectionInfo after a successful save. */
  onSaved: (correction: CorrectionInfo) => void;
  /** Called with the verbatim server message on a 409 (changed elsewhere). */
  onConflict: (message: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(
    field.currentValue === undefined || field.currentValue === null ? "" : String(field.currentValue),
  );
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<{ message: string; details?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  // NFR-025 / LENS-014: focus move-in (the value input is the first tabbable
  // control), focus trap, and Escape-to-close — one shared primitive instead of
  // the ad-hoc effect this modal used to carry, which had no trap.
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel);

  async function save() {
    setLocalError(null);
    setApiError(null);
    if (!reason.trim()) {
      setLocalError("A reason is required for every correction.");
      return;
    }
    const encoded = encodeNewValue(field.kind, value);
    if (!encoded.ok) {
      setLocalError(encoded.message);
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = {
      versionStamp,
      fieldPath: field.fieldPath,
      newValue: encoded.json,
      reason: reason.trim(),
    };
    if (field.borrowerOrdinal !== undefined) body.borrowerOrdinal = field.borrowerOrdinal;
    const result = await postWithCsrf<CorrectionInfo>(`/api/applications/${applicationId}/corrections`, body);
    setBusy(false);
    if (result.ok) {
      onSaved(result.data);
    } else if (result.status === 409) {
      // INV-039: the write was REJECTED, not partially applied — hand the
      // verbatim message to the surface's reload prompt.
      onConflict(result.error.message);
    } else {
      setApiError({ message: result.error.message, details: result.error.details });
    }
  }

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
        aria-label={`Correct ${field.label}`}
        data-testid="correction-dialog"
        className="w-full max-w-md rounded-lg border border-line bg-card p-6 shadow-xl"
      >
        <h2 className="font-display text-lg font-bold text-ink">Correct field</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {field.label}
          {field.borrowerOrdinal !== undefined ? (
            <span className="ml-1.5 text-xs font-semibold text-copper">
              ({field.borrowerOrdinal === 1 ? "Primary borrower" : "Co-borrower"})
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 font-mono text-xs text-muted">{field.fieldPath}</p>

        <div className="mt-4">
          <label htmlFor="correction-value-input" className="mb-1.5 block text-sm font-medium text-ink">
            New value
          </label>
          <input
            id="correction-value-input"
            data-testid="correction-value-input"
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
          />
          {field.kind === "boolean" ? (
            <p className="mt-1 text-xs text-muted">Enter yes or no.</p>
          ) : null}
        </div>

        <div className="mt-4">
          <label htmlFor="correction-reason-input" className="mb-1.5 block text-sm font-medium text-ink">
            Reason (required)
          </label>
          <textarea
            id="correction-reason-input"
            data-testid="correction-reason-input"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this value is being corrected (kept with the audit record)"
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
          />
        </div>

        {localError ? (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">
            {localError}
          </p>
        ) : null}
        {apiError ? (
          <div className="mt-3">
            <ApiErrorBanner message={apiError.message} details={apiError.details} testId="correction-error-banner" />
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            data-testid="correction-cancel-btn"
            onClick={onCancel}
            disabled={busy}
            className={btnOutline}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="correction-save-btn"
            onClick={save}
            disabled={busy}
            className={btnPrimary}
          >
            {busy ? "Saving…" : "Save correction"}
          </button>
        </div>
      </div>
    </div>
  );
}
