"use client";

// UrlaWizard (task-016) — Step 10: Documents, Review & Signature (§4.2.4).
// Frame anchor: frame/screen-wizard10.png. Document checklist by loan type +
// upload dropzone; review summary of all steps with edit links; outstanding
// errors/warnings; signature & attestation panel per borrower with the exact
// certification statement; the Submit card itself lives in the wizard's right
// rail (frame layout).

import type {
  Application,
  AppDocument,
  ChecklistItem,
  SignatureInfo,
  StepCompletion,
  ValidationSummary,
} from "../types";
import { STEP_TITLES } from "../types";
import { DocumentsPanel } from "../DocumentsPanel";
import { ATTESTATION_TEXT, SignaturePanel } from "../SignaturePanel";

const STATUS_BADGE: Record<StepCompletion, { label: string; cls: string }> = {
  complete: { label: "Complete", cls: "bg-success-soft text-success" },
  "in-progress": { label: "In progress", cls: "bg-warn-soft text-warn" },
  "not-started": { label: "Not started", cls: "bg-gray-soft text-ink-soft" },
};

export function Step10Review({
  app,
  validation,
  checklist,
  documents,
  csrfToken,
  demoMode,
  disabled,
  canDeleteDocuments,
  attestationAccepted,
  onAttestationChange,
  goToStep,
  onUploaded,
  onDocumentDeleted,
  onSigned,
  onError,
}: {
  app: Application;
  validation: ValidationSummary | null;
  checklist: ChecklistItem[];
  documents: AppDocument[];
  csrfToken: string;
  demoMode: boolean;
  disabled: boolean;
  /** BUG-33 (§4.2.9): document deletion is Draft-only — narrower than !disabled. */
  canDeleteDocuments: boolean;
  attestationAccepted: boolean;
  onAttestationChange: (v: boolean) => void;
  goToStep: (n: number) => void;
  onUploaded: (doc: AppDocument) => void;
  onDocumentDeleted: (documentId: string) => void;
  onSigned: (sig: SignatureInfo) => void;
  onError: (message: string) => void;
}) {
  const issues = validation?.issues ?? [];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  // Latest signature per borrower (server returns them signedAt ascending).
  const latestSignature = (borrowerId: string): SignatureInfo | null => {
    const sigs = (app.signatures ?? []).filter((s) => s.borrowerId === borrowerId);
    return sigs.length > 0 ? sigs[sigs.length - 1] : null;
  };

  const stepStatus = (n: number): StepCompletion =>
    validation?.stepStatuses.find((s) => s.step === n)?.status ?? "not-started";

  return (
    <div className="space-y-8">
      <section aria-label="Documents">
        <DocumentsPanel
          applicationId={app.id}
          csrfToken={csrfToken}
          checklist={checklist}
          documents={documents}
          disabled={disabled}
          canDelete={canDeleteDocuments}
          onUploaded={onUploaded}
          onDeleted={onDocumentDeleted}
          onError={onError}
        />
      </section>

      <section aria-label="Review your application">
        <h3 className="font-display text-lg font-semibold text-ink">Review your application</h3>
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-card">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
            const st = STATUS_BADGE[stepStatus(n)];
            return (
              <li key={n} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm text-ink">
                  <span className="mr-2 font-display font-semibold text-copper">{n}</span>
                  {STEP_TITLES[n]}
                </span>
                <span className="flex items-center gap-3">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>{st.label}</span>
                  <button
                    type="button"
                    data-testid={`review-edit-${n}`}
                    onClick={() => goToStep(n)}
                    className="text-sm font-semibold text-navy transition-opacity duration-200 hover:opacity-70"
                  >
                    Edit
                  </button>
                </span>
              </li>
            );
          })}
        </ul>

        {errors.length > 0 || warnings.length > 0 ? (
          <div data-testid="review-outstanding-issues" className="mt-4 space-y-2">
            {errors.length > 0 ? (
              <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
                <p className="font-semibold">
                  {errors.length} error{errors.length === 1 ? "" : "s"} must be resolved before submission:
                </p>
                <ul className="mt-1 list-inside list-disc">
                  {errors.map((i, idx) => (
                    <li key={idx}>
                      {i.message}
                      {i.borrowerOrdinal ? ` (${i.borrowerOrdinal === 1 ? "Primary" : "Co-borrower"})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <div className="rounded-lg border border-warn/30 bg-warn-soft p-3 text-sm text-warn">
                <p className="font-semibold">
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"} — submission allowed:
                </p>
                <ul className="mt-1 list-inside list-disc">
                  {warnings.map((i, idx) => (
                    <li key={idx}>{i.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-label="Signature and attestation">
        <h3 className="font-display text-lg font-semibold text-ink">Signature &amp; attestation</h3>
        <div className="mt-2 rounded-lg border border-line bg-paper/50 p-4 text-sm text-ink-soft">
          <p className="font-semibold text-ink">URLA Section 6 — Acknowledgments and Agreements</p>
          <p className="mt-1">
            By signing below, each borrower acknowledges and agrees that: (1) the information provided
            in this application is complete and given for the purpose of obtaining a mortgage loan;
            (2) the lender and its agents may verify any information contained in this application;
            (3) the property will not be used for any illegal or prohibited purpose; and (4) electronic
            signatures on this application are as effective and enforceable as handwritten signatures.
          </p>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {app.borrowers.map((b) => (
            <SignaturePanel
              key={b.id}
              applicationId={app.id}
              borrower={b}
              label={b.ordinal === 1 ? "primary" : "co-borrower"}
              signature={latestSignature(b.id)}
              csrfToken={csrfToken}
              demoMode={demoMode}
              disabled={disabled}
              attestationAccepted={attestationAccepted}
              onSigned={onSigned}
              onError={onError}
            />
          ))}
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-ink">
          <input
            data-testid="attestation-checkbox"
            type="checkbox"
            checked={attestationAccepted}
            onChange={(e) => onAttestationChange(e.target.checked)}
            disabled={disabled}
            className="mt-0.5 h-4 w-4 shrink-0 accent-navy"
          />
          <span>
            <span className="font-semibold">{ATTESTATION_TEXT}.</span>{" "}
            <span className="text-muted">(URLA Section 6 acknowledgments shown above)</span>
          </span>
        </label>
      </section>
    </div>
  );
}
