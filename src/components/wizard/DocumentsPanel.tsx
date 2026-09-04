"use client";

// UrlaWizard (task-016) — Step 10 document checklist + upload dropzone
// (§4.2.9, REQ-038): checklist by loan type with per-item status; upload flow
// (1) select document type -> (2) choose or drop file -> (3) progress ->
// (4) confirmation; keyboard-accessible drop zone; per-document status badge
// and OCR job badge (queued/processing/completed/failed).
//
// BUG-33: per-document Delete (§4.2.9 "Deletion (Borrower, Draft only, with
// confirmation) removes all versions and is audited"). Draft-only is a NARROWER
// condition than the panel's `disabled` (which also permits Revision Requested
// and document-request replacement), so it rides on its own `canDelete` prop
// derived from the server workflow state.

import { useRef, useState } from "react";
import { deleteDocument, uploadDocument, uploadDocumentVersion, type ErrorResponseBody } from "./api";
import type { AppDocument, ChecklistItem, DocumentStatus } from "./types";
import { DOCUMENT_TYPE_OPTIONS } from "./types";
import { inputClass } from "./fields";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

/** §4.2.4 display label for a document type (falls back to the raw value). */
function documentTypeLabel(documentType: string): string {
  return DOCUMENT_TYPE_OPTIONS.find((o) => o.value === documentType)?.label ?? documentType;
}

const STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: "Pending review",
  accepted: "Accepted",
  insufficient: "Insufficient",
  waived: "Waived",
};

const STATUS_STYLES: Record<DocumentStatus, string> = {
  pending: "bg-info-soft text-info",
  accepted: "bg-success-soft text-success",
  insufficient: "bg-danger-soft text-danger",
  waived: "bg-gray-soft text-ink-soft",
};

const JOB_STYLES: Record<string, string> = {
  queued: "bg-gray-soft text-ink-soft",
  processing: "bg-warn-soft text-warn",
  completed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[status] ?? "bg-gray-soft text-ink-soft"}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function JobBadge({ jobStatus }: { jobStatus?: string }) {
  if (!jobStatus) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${JOB_STYLES[jobStatus] ?? "bg-gray-soft text-ink-soft"}`}>
      OCR: {jobStatus}
    </span>
  );
}

export function DocumentsPanel({
  applicationId,
  csrfToken,
  checklist,
  documents,
  disabled,
  canDelete,
  onUploaded,
  onDeleted,
  onError,
}: {
  applicationId: string;
  csrfToken: string;
  checklist: ChecklistItem[];
  documents: AppDocument[];
  disabled: boolean;
  /**
   * BUG-33 (§4.2.9): the application is in Draft, the ONLY state in which the
   * borrower may delete a document. Narrower than `!disabled` — deliberately a
   * separate prop, not derived from it.
   */
  canDelete: boolean;
  onUploaded: (doc: AppDocument) => void;
  onDeleted: (documentId: string) => void;
  onError: (message: string) => void;
}) {
  const [docType, setDocType] = useState("");
  const [description, setDescription] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Replacement upload (REQ-038/AC-17): one hidden picker shared by all
  // per-document Replace buttons; the target doc is latched before opening it.
  const [replacing, setReplacing] = useState<{ docId: string; pct: number } | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<AppDocument | null>(null);
  // Delete (BUG-33, §4.2.9 "with confirmation"): the pending document is held
  // while the confirm dialog is mounted; the server ErrorResponse (403/404/409)
  // stays in the dialog verbatim so the borrower sees why it was refused.
  const [pendingDelete, setPendingDelete] = useState<AppDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ErrorResponseBody | null>(null);

  const canUpload = !disabled && docType !== "" && progress === null;

  const doDelete = async () => {
    const doc = pendingDelete;
    if (!doc) return;
    setDeleting(true);
    setDeleteError(null);
    const r = await deleteDocument(doc.id, csrfToken);
    setDeleting(false);
    if (r.ok) {
      setPendingDelete(null);
      setConfirmation(`Deleted ${documentTypeLabel(doc.documentType)}`);
      onDeleted(doc.id);
    } else {
      setDeleteError(r.error);
    }
  };

  const doReplace = async (doc: AppDocument, file: File) => {
    setConfirmation(null);
    setReplacing({ docId: doc.id, pct: 0 });
    const r = await uploadDocumentVersion(
      doc.id,
      csrfToken,
      file,
      doc.documentType,
      doc.description || undefined,
      (pct) => setReplacing({ docId: doc.id, pct }),
    );
    setReplacing(null);
    if (r.ok) {
      setConfirmation(`Replaced with ${file.name} — now v${r.data.currentVersionNumber}`);
      onUploaded(r.data);
    } else {
      onError(r.error.message);
    }
  };

  const doUpload = async (file: File) => {
    if (!canUpload) return;
    setConfirmation(null);
    setProgress(0);
    const r = await uploadDocument(
      applicationId,
      csrfToken,
      file,
      docType,
      docType === "other" ? description || undefined : description || undefined,
      (pct) => setProgress(pct),
    );
    setProgress(null);
    if (r.ok) {
      setConfirmation(`Uploaded ${file.name}`);
      onUploaded(r.data);
    } else {
      onError(r.error.message);
    }
  };

  const docById = new Map(documents.map((d) => [d.id, d]));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-display text-lg font-semibold text-ink">Document checklist</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-wider text-muted">
                <th className="py-2 pr-4">Required item</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2">Document</th>
              </tr>
            </thead>
            <tbody>
              {checklist.map((item) => {
                const doc = item.documentId ? docById.get(item.documentId) : undefined;
                return (
                  <tr key={item.key} data-testid={`checklist-item-${item.key}`} className="border-b border-line/60">
                    <td className="py-2.5 pr-4 text-ink">
                      {item.label}
                      {!item.required ? <span className="ml-2 text-xs text-muted">(conditional)</span> : null}
                    </td>
                    <td className="py-2.5 pr-4">
                      {item.documentStatus ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge status={item.documentStatus} />
                          {doc ? <JobBadge jobStatus={doc.jobStatus} /> : null}
                        </span>
                      ) : (
                        <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">
                          Missing
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-ink-soft">
                      {doc?.versions?.find((v) => v.id === doc.currentVersionId)?.originalFileName ??
                        (doc ? `v${doc.currentVersionNumber}` : "—")}
                    </td>
                  </tr>
                );
              })}
              {checklist.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-3 text-sm text-muted">
                    Choose a loan type in Step 7 to see the required document checklist.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {!disabled ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="doc-type" className="mb-1 block text-[13px] font-semibold text-ink">
                Document type <span aria-hidden="true">*</span>
              </label>
              <select
                id="doc-type"
                data-testid="doc-type-select"
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
                className={inputClass}
              >
                <option value="">Select document type…</option>
                {DOCUMENT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {docType === "other" ? (
              <div>
                <label htmlFor="doc-desc" className="mb-1 block text-[13px] font-semibold text-ink">
                  Description (e.g. Certificate of Eligibility)
                </label>
                <input
                  id="doc-desc"
                  data-testid="doc-description-input"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={inputClass}
                />
              </div>
            ) : null}
          </div>

          <div
            data-testid="doc-dropzone"
            role="button"
            tabIndex={0}
            aria-label="Drop a file here or press Enter to browse"
            aria-disabled={!canUpload}
            onClick={() => canUpload && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && canUpload) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void doUpload(file);
            }}
            className={`flex min-h-24 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] focus:outline-none focus:ring-2 focus:ring-navy/30 ${
              dragOver ? "border-copper bg-copper-soft" : "border-line bg-paper/50 hover:border-navy/50"
            } ${!canUpload ? "cursor-not-allowed opacity-60" : ""}`}
          >
            {progress !== null ? (
              <div className="w-full max-w-sm">
                <p className="mb-2 text-sm font-semibold text-ink">Uploading… {progress}%</p>
                <div data-testid="doc-upload-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="h-2 w-full overflow-hidden rounded-full bg-line">
                  <div className="h-full bg-copper transition-[width] duration-200" style={{ width: `${progress}%` }} />
                </div>
              </div>
            ) : (
              <p className="text-ink-soft">
                Drop a file here or <span className="font-semibold text-copper">browse</span>
                {docType === "" ? " — select document type first" : ""} · PDF, JPEG, PNG · max 10 MB
              </p>
            )}
            <input
              ref={fileInputRef}
              data-testid="doc-file-input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void doUpload(file);
              }}
            />
          </div>
          {confirmation ? (
            <p data-testid="doc-upload-confirmation" className="text-sm font-semibold text-success">
              ✓ {confirmation}
            </p>
          ) : null}
        </div>
      ) : null}

      {documents.length > 0 ? (
        <div>
          <h4 className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">Uploaded documents</h4>
          <ul className="mt-2 space-y-2">
            {documents.map((d) => {
              const current = d.versions?.find((v) => v.id === d.currentVersionId);
              const typeLabel = documentTypeLabel(d.documentType);
              return (
                <li
                  key={d.id}
                  data-testid={`doc-item-${d.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-card px-3 py-2 text-sm"
                >
                  <span className="text-ink">
                    <span className="font-semibold">{typeLabel}</span>
                    {d.description ? <span className="text-muted"> — {d.description}</span> : null}
                    <span className="ml-2 text-muted">
                      {current?.originalFileName ?? ""} · v{d.currentVersionNumber}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <StatusBadge status={d.status} />
                    <JobBadge jobStatus={d.jobStatus} />
                    {!disabled ? (
                      <button
                        type="button"
                        data-testid={`doc-replace-${d.id}`}
                        disabled={replacing !== null}
                        aria-label={`Replace ${typeLabel} with a new file`}
                        onClick={() => {
                          replaceTargetRef.current = d;
                          replaceInputRef.current?.click();
                        }}
                        className="rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-navy transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {replacing?.docId === d.id ? `Replacing… ${replacing.pct}%` : "Replace"}
                      </button>
                    ) : null}
                    {/* BUG-33 — Draft only (§4.2.9); confirmation dialog below. */}
                    {canDelete ? (
                      <button
                        type="button"
                        data-testid={`doc-delete-${d.id}`}
                        disabled={replacing !== null || deleting}
                        aria-label={`Delete ${typeLabel} and all of its versions`}
                        onClick={() => {
                          setDeleteError(null);
                          setPendingDelete(d);
                        }}
                        className="rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-danger transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Delete
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {!disabled ? (
            <input
              ref={replaceInputRef}
              data-testid="doc-replace-file-input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                const target = replaceTargetRef.current;
                e.target.value = "";
                if (file && target) void doReplace(target, file);
              }}
            />
          ) : null}
        </div>
      ) : null}

      {/* BUG-33 (§4.2.9): "Deletion … with confirmation" — focus-trapped,
          Escape-dismissible, server refusal shown verbatim. */}
      {pendingDelete ? (
        <ConfirmActionDialog
          title={`Delete ${documentTypeLabel(pendingDelete.documentType)}?`}
          body={
            <p>
              This permanently removes the document and every version of it, and is recorded in the
              application audit trail. You can upload it again while the application is in Draft.
            </p>
          }
          confirmLabel="Delete document"
          confirmTestId="doc-delete-confirm-btn"
          busy={deleting}
          error={deleteError ? { message: deleteError.message, details: deleteError.details } : null}
          onConfirm={() => void doDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
