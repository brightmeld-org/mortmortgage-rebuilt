"use client";

// OcrPanel (task-035 — §4.7 / REQ-067, NFR-017, AC-45/AC-46, FLOW-007).
//
// NAVIGATION PATH: /staff/applications/:id → Documents tab → per-document
// card → this panel (mounted in the reserved ocr-panel-mount container of
// DocumentsTab.tsx — StaffApplicationDetail per contracts §C).
//
// - Extracted fields with per-field confidence chips color-coded per §4.7:
//   green ≥ 85, yellow 60–84, red < 60 — and the provider attribution string
//   from the server verbatim ("via configured AI provider" / "via built-in
//   simulated extraction").
// - Comparison view: extracted vs borrower-entered value for mapped fields
//   with the variance highlighted (row tint + Δ% where the server computed
//   variancePct).
// - Apply suggestion → POST /api/documents/:id/ocr/apply-suggestion. The
//   server is authoritative for WHEN apply is allowed (staff-editable states,
//   assignment): the button renders regardless of state and every rejection
//   is surfaced VERBATIM (no client-side state-machine re-derivation).
//   Applyable fieldPaths come from the shared pure catalog
//   (src/lib/pure/ocr-apply-targets.ts) so panel and server never disagree;
//   compare-only name fields show why apply is unavailable.
// - OPTIMISTIC CONCURRENCY (§A, INV-039, VR-130): applying a suggestion is a
//   correction-bearing write, so the request carries the versionStamp captured
//   by the detail surface's most recent GET /api/applications/:id — NOT a value
//   refetched at apply time, which would defeat the check. A 409 is escalated
//   to the parent's reload prompt, the same affordance the inline
//   CorrectionModal uses; other rejections stay verbatim in this panel.
// - Retry → POST /api/documents/:id/ocr/retry (202) then re-poll.
// - Job status badge; the panel polls GET /api/documents/:id/ocr while a job
//   is queued/processing (the GET also lazily advances the job scheduler).
//
// Selector contract (build-plan §C OcrPanel): ocr-panel-{documentId},
// ocr-field-{fieldPath}, ocr-confidence-{fieldPath}, ocr-compare-{fieldPath},
// ocr-apply-{fieldPath}, ocr-retry-btn, ocr-provider-attribution,
// ocr-job-status.

import { useCallback, useEffect, useState } from "react";
import { ApiErrorBanner, btnOutline, btnPrimary } from "@/components/borrower/ui";
import { OCR_APPLY_TARGETS, OCR_NAME_SPANNING_PATHS } from "@/lib/pure/ocr-apply-targets";
import { getJson, postWithCsrf, type ErrorResponseBody } from "./api";
import type { CorrectionInfo } from "./types";

// ---------------------------------------------------------------------------
// Wire shapes (contracts §A — exact field names)
// ---------------------------------------------------------------------------

type DocumentJobStatus = "queued" | "processing" | "completed" | "failed";

interface DocumentJobInfoWire {
  id: string;
  documentVersionId: string;
  status: DocumentJobStatus;
  attempt: number;
  maxAttempts: number;
  provider?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

interface OcrFieldResultWire {
  fieldPath: string;
  extractedValue: string;
  enteredValue?: string;
  confidence: number;
  variancePct?: number;
  mapped?: boolean;
}

interface OcrExtractionInfoWire {
  id: string;
  documentVersionId: string;
  provider: string;
  providerAttribution: string;
  fields: OcrFieldResultWire[];
  createdAt: string;
}

interface OcrPanelResponseWire {
  job?: DocumentJobInfoWire;
  extraction?: OcrExtractionInfoWire;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const JOB_BADGE_LABELS: Record<DocumentJobStatus, string> = {
  queued: "OCR queued",
  processing: "OCR processing",
  completed: "OCR complete",
  failed: "OCR failed",
};

const JOB_BADGE_STYLES: Record<DocumentJobStatus, string> = {
  queued: "bg-gray-soft text-ink-soft",
  processing: "bg-warn-soft text-warn",
  completed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
};

/** §4.7 confidence color coding: green ≥ 85, yellow 60–84, red < 60. */
function confidenceChipClass(confidence: number): string {
  if (confidence >= 85) return "bg-success-soft text-success";
  if (confidence >= 60) return "bg-warn-soft text-warn";
  return "bg-danger-soft text-danger";
}

/** "employment.baseMonthlyIncome" → "Base Monthly Income". */
function fieldLabel(fieldPath: string): string {
  const leaf = fieldPath.split(".").pop() ?? fieldPath;
  const spaced = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/(\d+)/g, " $1")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Variance highlight: numeric variance > 0, or a textual mismatch. */
function isMismatch(field: OcrFieldResultWire): boolean {
  if (field.mapped !== true || field.enteredValue === undefined) return false;
  if (field.variancePct !== undefined) return field.variancePct > 0;
  return normalizedText(field.extractedValue) !== normalizedText(field.enteredValue);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function OcrPanel({
  documentId,
  versionStamp,
  onConflict,
  fileName,
  versionNumber,
}: {
  documentId: string;
  /** Application.versionStamp from the surface's most recent GET (§A, VR-130). */
  versionStamp: number;
  /** Called with the verbatim server message on a 409 (changed elsewhere). */
  onConflict: (message: string) => void;
  /** Current version's original file name (frame header "OCR — FILE (VN)"). */
  fileName?: string;
  versionNumber?: number;
}) {
  const [panel, setPanel] = useState<OcrPanelResponseWire | null>(null);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  const [applyingPath, setApplyingPath] = useState<string | null>(null);
  const [appliedPaths, setAppliedPaths] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<CorrectionInfo | null>(null);
  const [actionError, setActionError] = useState<ErrorResponseBody | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await getJson<OcrPanelResponseWire>(`/api/documents/${documentId}/ocr`);
    if (result.ok) {
      setPanel(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.error);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a job is in flight so the status badge and the arriving
  // extraction refresh without a manual reload (§4.7 "refreshed by polling").
  const jobActive = panel?.job?.status === "queued" || panel?.job?.status === "processing";
  useEffect(() => {
    if (!jobActive) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [jobActive, load]);

  async function applySuggestion(fieldPath: string) {
    const extraction = panel?.extraction;
    if (!extraction || applyingPath !== null) return;
    setApplyingPath(fieldPath);
    setActionError(null);
    const result = await postWithCsrf<CorrectionInfo>(
      `/api/documents/${documentId}/ocr/apply-suggestion`,
      { versionStamp, extractionId: extraction.id, fieldPath },
    );
    setApplyingPath(null);
    if (result.ok) {
      setApplied(result.data);
      setAppliedPaths((previous) => new Set(previous).add(fieldPath));
    } else if (result.status === 409) {
      // INV-039: the write was REJECTED, not partially applied — hand the
      // verbatim message to the surface's reload prompt, exactly as the
      // inline CorrectionModal does for the same correction write path.
      onConflict(result.error.message);
    } else {
      // Other server rejections (403, 400…) surfaced VERBATIM — the server
      // owns the decision.
      setActionError(result.error);
    }
  }

  async function retry() {
    if (retryBusy) return;
    setRetryBusy(true);
    setActionError(null);
    const result = await postWithCsrf<DocumentJobInfoWire>(`/api/documents/${documentId}/ocr/retry`, {});
    setRetryBusy(false);
    if (result.ok) {
      setPanel((previous) => ({ ...(previous ?? {}), job: result.data }));
      await load();
    } else {
      setActionError(result.error);
    }
  }

  const job = panel?.job;
  const extraction = panel?.extraction;

  return (
    <div data-testid={`ocr-panel-${documentId}`} className="mt-2 rounded-md border border-line bg-paper/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-ink">
          OCR{fileName ? ` — ${fileName}` : ""}
          {versionNumber !== undefined ? ` (v${versionNumber})` : ""}
        </span>
        <span
          data-testid="ocr-job-status"
          data-job-status={job?.status ?? "none"}
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            job ? JOB_BADGE_STYLES[job.status] : "bg-gray-soft text-ink-soft"
          }`}
        >
          {job ? `${JOB_BADGE_LABELS[job.status]} (attempt ${job.attempt}/${job.maxAttempts})` : "No extraction job"}
        </span>
      </div>

      {extraction ? (
        <span
          data-testid="ocr-provider-attribution"
          className="mt-1.5 inline-block rounded bg-copper-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-copper"
        >
          {extraction.providerAttribution}
        </span>
      ) : null}

      {job?.status === "failed" && job.error ? (
        <p data-testid="ocr-job-error" className="mt-1.5 text-xs text-danger">
          {job.error}
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-2">
          <ApiErrorBanner message={loadError.message} details={loadError.details} testId="ocr-load-error" />
        </div>
      ) : null}

      {panel !== null && !extraction && !job && !loadError ? (
        <p className="mt-1.5 text-xs text-muted">No extraction has run for this document yet.</p>
      ) : null}

      {extraction && extraction.fields.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted">
          No structured extraction targets are defined for this document type — manual review.
        </p>
      ) : null}

      {extraction && extraction.fields.length > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <th scope="col" className="py-1.5 pr-3 font-semibold">Field</th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">Extracted</th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">Entered</th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">Conf.</th>
                <th scope="col" className="py-1.5 font-semibold">
                  <span className="sr-only">Apply</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {extraction.fields.map((field) => {
                const mismatch = isMismatch(field);
                const applyable = field.mapped === true && OCR_APPLY_TARGETS[field.fieldPath] !== undefined;
                const compareOnly = field.mapped === true && OCR_NAME_SPANNING_PATHS.has(field.fieldPath);
                const alreadyApplied = appliedPaths.has(field.fieldPath);
                return (
                  <tr
                    key={field.fieldPath}
                    data-testid={`ocr-field-${field.fieldPath}`}
                    data-mismatch={mismatch ? "true" : "false"}
                    className={`border-b border-line/60 last:border-b-0 ${mismatch ? "bg-danger-soft/40" : ""}`}
                  >
                    <td className="py-1.5 pr-3 font-semibold text-ink">{fieldLabel(field.fieldPath)}</td>
                    <td className="py-1.5 pr-3 text-ink">{field.extractedValue}</td>
                    <td className="py-1.5 pr-3 text-ink-soft">
                      {field.mapped === true && field.enteredValue !== undefined ? (
                        <span data-testid={`ocr-compare-${field.fieldPath}`}>
                          {field.enteredValue}
                          {field.variancePct !== undefined && field.variancePct > 0 ? (
                            <span className="ml-1 font-semibold text-danger">Δ {field.variancePct}%</span>
                          ) : null}
                        </span>
                      ) : (
                        <span aria-hidden>—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        data-testid={`ocr-confidence-${field.fieldPath}`}
                        data-confidence={field.confidence}
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${confidenceChipClass(field.confidence)}`}
                      >
                        {field.confidence}
                      </span>
                    </td>
                    <td className="py-1.5 text-right">
                      {applyable ? (
                        <button
                          type="button"
                          data-testid={`ocr-apply-${field.fieldPath}`}
                          onClick={() => applySuggestion(field.fieldPath)}
                          disabled={applyingPath !== null || alreadyApplied}
                          className={`${btnPrimary} !px-2.5 !py-1 !text-[11px]`}
                        >
                          {alreadyApplied ? "Applied ✓" : applyingPath === field.fieldPath ? "Applying…" : "Apply suggestion"}
                        </button>
                      ) : compareOnly ? (
                        <span className="text-[11px] text-muted" title="Spans first and last name — use inline corrections">
                          compare only
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {applied ? (
        <p data-testid="ocr-apply-success" className="mt-2 text-xs font-semibold text-success">
          Suggestion applied as an audited correction ({applied.fieldPath}). The persisted value shows on
          the data tabs after reload.
        </p>
      ) : null}

      {actionError ? (
        <div className="mt-2">
          <ApiErrorBanner message={actionError.message} details={actionError.details} testId="ocr-action-error" />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="ocr-retry-btn"
          onClick={retry}
          disabled={retryBusy || jobActive}
          className={btnOutline}
        >
          {retryBusy ? "Requesting…" : "Retry OCR"}
        </button>
      </div>

      <p className="mt-2 text-[11px] leading-4 text-muted">
        Apply persists server-side as an audited correction; rejected when the state disallows
        corrections. Job status: queued → processing → completed/failed (retryable).
      </p>
    </div>
  );
}
