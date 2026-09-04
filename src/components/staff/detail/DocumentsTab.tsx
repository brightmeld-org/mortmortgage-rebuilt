"use client";

// Documents tab (task-029 — §4.4.7 / REQ-053).
//
// - Checklist items with status + the current document version each; unmatched
//   documents listed separately.
// - Per document: inline preview (PDF/image fetched to a blob URL so the
//   attachment Content-Disposition of GET /api/documents/:id/download cannot
//   force a download), download, version list with per-version downloads
//   (GET /api/documents/:id/versions/:versionId/download), OCR panel mount
//   (data-testid="ocr-panel-mount" — FILLED by task-035 OcrPanel), and status
//   actions Accept / Mark insufficient (reason required, VR-098) / Waive
//   (reason required) via PATCH /api/documents/:id/status — every status
//   action goes through an explicit confirmation dialog (§4.4.7 destructive
//   confirmations; DELETE /api/documents/:id is borrower-only per §B, so the
//   staff surface offers no delete).
// - "Request document" (doc-request-btn) → dialog naming type + reason →
//   POST /api/applications/:id/document-requests (borrower notification named
//   after both, server-side). Open requests listed below the checklist.
//
// Selector contract (§C): doc-status-accept-{id}, doc-status-insufficient-{id},
// doc-status-waive-{id}, doc-request-btn, doc-preview-{id},
// doc-version-list-{id} (+ doc-download-{id}, doc-request-type,
// doc-request-reason, doc-request-submit, doc-status-confirm-btn,
// doc-status-reason-input namespace extensions).

import { useCallback, useEffect, useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import { formatDate, humanizeEnum } from "@/components/borrower/format";
import type {
  ChecklistItemWire,
  DocumentListResponse,
  DocumentRequestList,
  DocumentStatus,
  DocumentWire,
} from "@/components/borrower/types";
import { ApiErrorBanner, Badge, ConfirmDialog, btnOutline, btnPrimary } from "@/components/borrower/ui";
import { getJson, patchWithCsrf, postWithCsrf, type ErrorResponseBody } from "./api";
import { OcrPanel } from "./OcrPanel";
import { DetailSection, EmptyLine } from "./ui";
import { DOCUMENT_TYPES, type DocumentRequestInfo } from "./types";

const STATUS_TONES: Record<DocumentStatus, "gray" | "success" | "danger" | "warn"> = {
  pending: "gray",
  accepted: "success",
  insufficient: "danger",
  waived: "warn",
};

const JOB_LABELS: Record<string, string> = {
  queued: "OCR queued",
  processing: "OCR processing",
  completed: "OCR complete",
  failed: "OCR failed",
};

interface PendingStatus {
  document: DocumentWire;
  status: DocumentStatus;
}

export function DocumentsTab({
  applicationId,
  versionStamp,
  canAct,
  onConflict,
}: {
  applicationId: string;
  /** Application.versionStamp from the surface's most recent GET (§A, VR-130). */
  versionStamp: number;
  /** Status/request actions only in staff-editable context (server authoritative). */
  canAct: boolean;
  /** Verbatim 409 message from a correction-bearing write (OCR apply-suggestion). */
  onConflict: (message: string) => void;
}) {
  const [list, setList] = useState<DocumentListResponse | null>(null);
  const [requests, setRequests] = useState<DocumentRequestInfo[]>([]);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);

  const [pending, setPending] = useState<PendingStatus | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<ErrorResponseBody | null>(null);

  const [requestOpen, setRequestOpen] = useState(false);
  const [preview, setPreview] = useState<{ document: DocumentWire; url: string; contentType: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [docsResult, requestsResult] = await Promise.all([
      getJson<DocumentListResponse>(`/api/applications/${applicationId}/documents`),
      getJson<DocumentRequestList>(`/api/applications/${applicationId}/document-requests`),
    ]);
    if (docsResult.ok) {
      setList(docsResult.data);
      setLoadError(null);
    } else {
      setList({ checklist: [], documents: [] });
      setLoadError(docsResult.error);
    }
    setRequests(requestsResult.ok ? requestsResult.data.rows : []);
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Revoke blob URLs when the preview closes.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  async function openPreview(document: DocumentWire) {
    setPreviewError(null);
    try {
      const response = await fetch(`/api/documents/${document.id}/download`, { credentials: "same-origin" });
      if (!response.ok) {
        setPreviewError(`Preview failed (${response.status}).`);
        return;
      }
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const blob = await response.blob();
      setPreview({ document, url: URL.createObjectURL(blob), contentType });
    } catch {
      setPreviewError("Could not load the document preview.");
    }
  }

  async function confirmStatus() {
    if (!pending) return;
    setStatusBusy(true);
    setStatusError(null);
    const body: Record<string, unknown> = { status: pending.status };
    if (statusReason.trim()) body.reason = statusReason.trim();
    const result = await patchWithCsrf<DocumentWire>(`/api/documents/${pending.document.id}/status`, body);
    setStatusBusy(false);
    if (result.ok) {
      setPending(null);
      setStatusReason("");
      await load();
    } else {
      setStatusError(result.error);
    }
  }

  function beginStatus(document: DocumentWire, status: DocumentStatus) {
    setPending({ document, status });
    setStatusReason("");
    setStatusError(null);
  }

  function toggleVersions(id: string) {
    setVersionsOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const checklist = list?.checklist ?? [];
  const documents = list?.documents ?? [];
  const documentsByChecklistKey = new Map<string, DocumentWire[]>();
  const unmatched: DocumentWire[] = [];
  for (const document of documents) {
    if (document.checklistItemKey) {
      const bucket = documentsByChecklistKey.get(document.checklistItemKey) ?? [];
      bucket.push(document);
      documentsByChecklistKey.set(document.checklistItemKey, bucket);
    } else {
      unmatched.push(document);
    }
  }

  const reasonRequired = pending?.status === "insufficient" || pending?.status === "waived";

  return (
    <div className="space-y-5">
      {loadError ? <ApiErrorBanner message={loadError.message} details={loadError.details} testId="documents-load-error" /> : null}
      {previewError ? <ApiErrorBanner message={previewError} testId="doc-preview-error" /> : null}

      <DetailSection
        title="Document checklist"
        testId="documents-checklist"
        aside={
          canAct ? (
            <button type="button" data-testid="doc-request-btn" onClick={() => setRequestOpen(true)} className={btnPrimary}>
              Request document
            </button>
          ) : undefined
        }
      >
        {list === null ? (
          <p className="text-sm text-muted">Loading documents…</p>
        ) : checklist.length === 0 ? (
          <EmptyLine>No checklist items for this application.</EmptyLine>
        ) : (
          <ul className="divide-y divide-line/60">
            {checklist.map((item) => (
              <ChecklistRow
                key={item.key}
                item={item}
                documents={documentsByChecklistKey.get(item.key) ?? []}
                canAct={canAct}
                versionStamp={versionStamp}
                onConflict={onConflict}
                versionsOpen={versionsOpen}
                onToggleVersions={toggleVersions}
                onPreview={openPreview}
                onStatus={beginStatus}
              />
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Unmatched documents" testId="documents-unmatched">
        {unmatched.length === 0 ? (
          <EmptyLine>No unmatched documents.</EmptyLine>
        ) : (
          <ul className="divide-y divide-line/60">
            {unmatched.map((document) => (
              <li key={document.id} className="py-3">
                <DocumentCard
                  document={document}
                  canAct={canAct}
                  versionStamp={versionStamp}
                  onConflict={onConflict}
                  versionsOpen={versionsOpen}
                  onToggleVersions={toggleVersions}
                  onPreview={openPreview}
                  onStatus={beginStatus}
                />
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Open document requests" testId="document-requests-list">
        {requests.length === 0 ? (
          <EmptyLine>No document requests.</EmptyLine>
        ) : (
          <ul className="divide-y divide-line/60">
            {requests.map((request) => (
              <li key={request.id} data-testid={`doc-request-row-${request.id}`} className="py-2 text-sm">
                <span className="font-semibold text-ink">{humanizeEnum(request.documentType)}</span>{" "}
                <span className="text-ink-soft">
                  — {request.reason}
                  {request.requestedByName ? ` · requested by ${request.requestedByName}` : ""} ·{" "}
                  {formatDate(request.createdAt)}
                </span>{" "}
                {request.fulfilledByDocumentId ? (
                  <Badge tone="success">Fulfilled</Badge>
                ) : (
                  <Badge tone="warn">Awaiting borrower</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      {pending ? (
        <ConfirmDialog
          title={
            pending.status === "accepted"
              ? "Accept document"
              : pending.status === "insufficient"
                ? "Mark document insufficient"
                : "Waive document"
          }
          body={
            <>
              {humanizeEnum(pending.document.documentType)} — version {pending.document.currentVersionNumber}.{" "}
              {pending.status === "accepted"
                ? "Confirm you have reviewed this document."
                : pending.status === "insufficient"
                  ? "The borrower will need to provide a better copy. A reason is required."
                  : "The checklist requirement will be waived for this application. A reason is required."}
            </>
          }
          confirmLabel={
            pending.status === "accepted" ? "Accept" : pending.status === "insufficient" ? "Mark insufficient" : "Waive"
          }
          confirmTestId="doc-status-confirm-btn"
          destructive={pending.status !== "accepted"}
          reasonLabel={reasonRequired ? "Reason (required)" : undefined}
          reasonTestId={reasonRequired ? "doc-status-reason-input" : undefined}
          reasonValue={statusReason}
          onReasonChange={setStatusReason}
          busy={statusBusy}
          error={statusError ? { message: statusError.message, details: statusError.details } : null}
          onConfirm={confirmStatus}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {requestOpen ? (
        <RequestDocumentDialog
          applicationId={applicationId}
          onCreated={async () => {
            setRequestOpen(false);
            await load();
          }}
          onCancel={() => setRequestOpen(false)}
        />
      ) : null}

      {preview ? <DocumentPreviewDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document preview dialog
// ---------------------------------------------------------------------------

/**
 * Extracted from the parent's JSX so `useModalFocus` can be called
 * unconditionally (open = mounted) — NFR-025 / LENS-014: focus move-in, focus
 * trap, Escape-to-close.
 */
function DocumentPreviewDialog({
  preview,
  onClose,
}: {
  preview: { document: DocumentWire; url: string; contentType: string };
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Document preview"
        data-testid="doc-preview-dialog"
        className="flex h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-line bg-card p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-ink">
            {humanizeEnum(preview.document.documentType)} — v{preview.document.currentVersionNumber}
          </h2>
          <button type="button" data-testid="doc-preview-close" onClick={onClose} className={btnOutline}>
            Close
          </button>
        </div>
        {preview.contentType.startsWith("image/") ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob URL preview
          <img src={preview.url} alt="Document preview" className="min-h-0 flex-1 object-contain" />
        ) : preview.contentType === "application/pdf" ? (
          // tabIndex -1: the PDF viewer is a SEPARATE browsing context, so keys
          // pressed while focus is inside it never reach this document — Escape
          // would not close the dialog and Tab would walk straight out of it
          // (LENS-014). Keeping it out of the sequential tab order preserves the
          // dialog's keyboard contract; the PDF still scrolls on click/wheel and
          // Download remains available.
          <iframe
            src={preview.url}
            title="Document preview"
            tabIndex={-1}
            className="min-h-0 flex-1 rounded border border-line"
          />
        ) : (
          <p className="text-sm text-muted">
            Inline preview supports PDF and images; this file is {preview.contentType}. Use Download instead.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checklist row + document card
// ---------------------------------------------------------------------------

interface DocumentActionProps {
  canAct: boolean;
  /** Application.versionStamp for the OCR panel's correction-bearing write. */
  versionStamp: number;
  onConflict: (message: string) => void;
  versionsOpen: Set<string>;
  onToggleVersions: (id: string) => void;
  onPreview: (document: DocumentWire) => void;
  onStatus: (document: DocumentWire, status: DocumentStatus) => void;
}

function ChecklistRow({
  item,
  documents,
  ...actions
}: { item: ChecklistItemWire; documents: DocumentWire[] } & DocumentActionProps) {
  return (
    <li data-testid={`checklist-item-${item.key}`} className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{item.label}</span>
        {item.required ? <Badge tone="info">Required</Badge> : <Badge tone="gray">Optional</Badge>}
        {item.satisfied ? <Badge tone="success">Satisfied</Badge> : <Badge tone="warn">Outstanding</Badge>}
      </div>
      {documents.length === 0 ? (
        <p className="mt-1 text-sm text-muted">No document uploaded for this item.</p>
      ) : (
        documents.map((document) => (
          <div key={document.id} className="mt-2">
            <DocumentCard document={document} {...actions} />
          </div>
        ))
      )}
    </li>
  );
}

function DocumentCard({
  document,
  canAct,
  versionStamp,
  onConflict,
  versionsOpen,
  onToggleVersions,
  onPreview,
  onStatus,
}: { document: DocumentWire } & DocumentActionProps) {
  const currentVersion = (document.versions ?? []).find((version) => version.id === document.currentVersionId);
  return (
    <div data-testid={`document-card-${document.id}`} className="rounded-md border border-line/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{humanizeEnum(document.documentType)}</span>
        <Badge tone={STATUS_TONES[document.status]} testId={`doc-status-badge-${document.id}`}>
          <span className="capitalize">{document.status}</span>
        </Badge>
        {document.jobStatus ? <Badge tone={document.jobStatus === "failed" ? "danger" : "gray"}>{JOB_LABELS[document.jobStatus] ?? document.jobStatus}</Badge> : null}
        <span className="text-xs text-ink-soft">
          v{document.currentVersionNumber}
          {currentVersion ? ` · ${currentVersion.originalFileName} · ${formatDate(currentVersion.createdAt)}` : ""}
          {document.uploadedByName ? ` · uploaded by ${document.uploadedByName}` : ""}
        </span>
      </div>
      {document.statusReason ? (
        <p className="mt-1 text-xs text-ink-soft">Status reason: {document.statusReason}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" data-testid={`doc-preview-${document.id}`} onClick={() => onPreview(document)} className={btnOutline}>
          Preview
        </button>
        <a
          data-testid={`doc-download-${document.id}`}
          href={`/api/documents/${document.id}/download`}
          className={btnOutline}
        >
          Download
        </a>
        <button
          type="button"
          data-testid={`doc-version-list-${document.id}`}
          onClick={() => onToggleVersions(document.id)}
          aria-expanded={versionsOpen.has(document.id)}
          className={btnOutline}
        >
          Versions ({(document.versions ?? []).length})
        </button>
        {canAct ? (
          <>
            <button
              type="button"
              data-testid={`doc-status-accept-${document.id}`}
              onClick={() => onStatus(document, "accepted")}
              className={btnPrimary}
            >
              Accept
            </button>
            <button
              type="button"
              data-testid={`doc-status-insufficient-${document.id}`}
              onClick={() => onStatus(document, "insufficient")}
              className={btnOutline}
            >
              Insufficient
            </button>
            <button
              type="button"
              data-testid={`doc-status-waive-${document.id}`}
              onClick={() => onStatus(document, "waived")}
              className={btnOutline}
            >
              Waive
            </button>
          </>
        ) : null}
      </div>

      {versionsOpen.has(document.id) ? (
        <ul data-testid={`doc-versions-${document.id}`} className="mt-2 divide-y divide-line/60 rounded border border-line/70 px-3">
          {(document.versions ?? []).map((version) => (
            <li key={version.id} className="flex items-center justify-between gap-2 py-1.5 text-xs text-ink-soft">
              <span>
                v{version.versionNumber} · {version.originalFileName} · {version.sniffedContentType} ·{" "}
                {formatDate(version.createdAt)}
                {version.id === document.currentVersionId ? " · current" : ""}
              </span>
              <a
                href={`/api/documents/${document.id}/versions/${version.id}/download`}
                className="font-semibold text-navy hover:underline"
              >
                Download
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {/* OCR panel mount point — filled by task-035 (OcrPanel, per §4.4.7). */}
      <div data-testid="ocr-panel-mount" data-document-id={document.id}>
        <OcrPanel
          documentId={document.id}
          versionStamp={versionStamp}
          onConflict={onConflict}
          fileName={currentVersion?.originalFileName}
          versionNumber={document.currentVersionNumber}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request-document dialog (type + reason → borrower notification)
// ---------------------------------------------------------------------------

function RequestDocumentDialog({
  applicationId,
  onCreated,
  onCancel,
}: {
  applicationId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [documentType, setDocumentType] = useState<string>("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  // NFR-025 / LENS-014: same omission as the preview dialog above — this one
  // had Escape but no focus move-in and no trap. One shared primitive covers
  // all three behaviours.
  const dialogRef = useModalFocus<HTMLDivElement>(onCancel);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await postWithCsrf<DocumentRequestInfo>(`/api/applications/${applicationId}/document-requests`, {
      documentType,
      reason: reason.trim(),
    });
    setBusy(false);
    if (result.ok) onCreated();
    else setError(result.error);
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
        aria-label="Request a document"
        data-testid="doc-request-dialog"
        className="w-full max-w-md rounded-lg border border-line bg-card p-6 shadow-xl"
      >
        <h2 className="font-display text-lg font-bold text-ink">Request a document</h2>
        <p className="mt-1 text-sm text-ink-soft">
          The borrower receives a notification naming the document type and reason.
        </p>
        <div className="mt-4">
          <label htmlFor="doc-request-type" className="mb-1.5 block text-sm font-medium text-ink">
            Document type
          </label>
          <select
            id="doc-request-type"
            data-testid="doc-request-type"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value)}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
          >
            <option value="">Select…</option>
            {DOCUMENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {humanizeEnum(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-4">
          <label htmlFor="doc-request-reason" className="mb-1.5 block text-sm font-medium text-ink">
            Reason (required)
          </label>
          <textarea
            id="doc-request-reason"
            data-testid="doc-request-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
          />
        </div>
        {error ? (
          <div className="mt-3">
            <ApiErrorBanner message={error.message} details={error.details} testId="doc-request-error" />
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2.5">
          <button type="button" data-testid="doc-request-cancel" onClick={onCancel} disabled={busy} className={btnOutline}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="doc-request-submit"
            onClick={submit}
            disabled={busy || !documentType || !reason.trim()}
            className={btnPrimary}
          >
            {busy ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </div>
  );
}
