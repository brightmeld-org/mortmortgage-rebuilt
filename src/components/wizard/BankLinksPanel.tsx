"use client";

// UrlaWizard — linked bank accounts list + the Unlink control (BUG-28, REQ-039,
// §4.2.10: "an 'Unlink' action removes the link token and marks imported rows as
// manual").
//
// The rows come from Application.bankLinks (contract CH-018) — ACTIVE links
// only, so an unlinked link simply disappears. That field is what makes the
// contracted DELETE /api/applications/:id/bank-links/:linkId addressable at all:
// before CH-018 the only carrier of a linkId was the BankLinkSession returned
// during the linking dialog, which does not survive a page reload.
//
// Unlink is destructive and not trivially reversible (the borrower must
// re-authenticate with the institution), so it is confirmed first. The server
// enforces the borrower-editable states and answers 403 otherwise; that message
// is rendered VERBATIM in the dialog (NFR-025).

import { useState } from "react";
import { deleteBankLink, type ErrorResponseBody } from "./api";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { formatSignedAt } from "./format";
import type { Application, BankLinkInfo } from "./types";

export function BankLinksPanel({
  applicationId,
  csrfToken,
  links,
  disabled,
  onUnlinked,
}: {
  applicationId: string;
  csrfToken: string;
  /** Application.bankLinks — active links only (CH-018). */
  links: BankLinkInfo[];
  /** Read-only wizard (same condition as every other Step-4 control). */
  disabled: boolean;
  /** Unlink succeeded: the refreshed §A Application the endpoint returned. */
  onUnlinked: (app: Application) => void;
}) {
  const [pending, setPending] = useState<BankLinkInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);

  if (links.length === 0) return null;

  const doUnlink = async () => {
    const link = pending;
    if (!link) return;
    setBusy(true);
    setError(null);
    const r = await deleteBankLink(applicationId, link.id, csrfToken);
    setBusy(false);
    if (r.ok) {
      setPending(null);
      onUnlinked(r.data);
    } else {
      setError(r.error);
    }
  };

  return (
    <div data-testid="bank-links-list" className="mt-3">
      <h4 className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">Linked bank accounts</h4>
      <ul className="mt-2 space-y-2">
        {links.map((link) => (
          <li
            key={link.id}
            data-testid={`bank-link-item-${link.id}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-card px-3 py-2 text-sm"
          >
            <span className="text-ink">
              <span className="font-semibold">{link.institution}</span>
              <span className="ml-2 text-muted">
                linked {formatSignedAt(link.linkedAt)} · {link.importedAccountCount} account
                {link.importedAccountCount === 1 ? "" : "s"} imported
              </span>
            </span>
            {!disabled ? (
              <button
                type="button"
                data-testid={`bank-link-unlink-${link.id}`}
                disabled={busy}
                aria-label={`Unlink ${link.institution}`}
                onClick={() => {
                  setError(null);
                  setPending(link);
                }}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-danger transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Unlink
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {pending ? (
        <ConfirmActionDialog
          title={`Unlink ${pending.institution}?`}
          body={
            <p>
              This deletes the stored link and marks the {pending.importedAccountCount} imported account
              {pending.importedAccountCount === 1 ? "" : "s"} as manually entered — the rows stay on this
              step and you keep editing them yourself. To import from {pending.institution} again you
              would have to sign in to the institution once more.
            </p>
          }
          confirmLabel="Unlink"
          confirmTestId="bank-link-unlink-confirm-btn"
          busy={busy}
          error={error ? { message: error.message, details: error.details } : null}
          onConfirm={() => void doUnlink()}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
