"use client";

// Per-application state-scoped actions (task-017, REQ-020/REQ-042, FLOW-005).
//
// Action AVAILABILITY is driven entirely by server-provided data — the
// dashboard rows carry BorrowerApplicationRow.availableActions and the
// application view derives the same action ids from
// Application.availableTransitions — the client never re-derives the §4.5.3
// state machine (live-state rule). Action ids (server values, verbatim):
//   "continue" | "view" | "withdraw" | "decline" | "delete-draft"
//
// Withdraw → confirm dialog + OPTIONAL reason → POST transition toState
// "withdrawn". Decline (approved outcomes only — server decides) → confirm →
// toState "declined_by_borrower". Delete draft → confirm → DELETE (audited
// server-side). Errors surface the server ErrorResponse verbatim (NFR-025).

import { useState } from "react";
import { borrowerTransition, deleteWithCsrf } from "./api";
import { btnDanger, btnOutline, btnPrimary, ConfirmDialog } from "./ui";

type DialogKind = "withdraw" | "decline" | "delete" | null;

export function ApplicationActions({
  applicationId,
  applicationNumber,
  availableActions,
  onChanged,
  size = "row",
}: {
  applicationId: string;
  applicationNumber: string;
  /** Server-provided action ids (BorrowerApplicationRow.availableActions). */
  availableActions: string[];
  /** Called after a successful state change so the parent refetches. */
  onChanged: () => void;
  /** "row" = compact table buttons; "panel" = full-width stacked (view page). */
  size?: "row" | "panel";
}) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);

  const wide = size === "panel" ? " w-full" : "";

  function open(kind: DialogKind) {
    setReason("");
    setError(null);
    setDialog(kind);
  }

  async function onConfirm() {
    setBusy(true);
    setError(null);
    if (dialog === "withdraw") {
      const result = await borrowerTransition(applicationId, "withdrawn", reason);
      setBusy(false);
      if (!result.ok) return setError({ message: result.error.message, details: result.error.details });
    } else if (dialog === "decline") {
      const result = await borrowerTransition(applicationId, "declined_by_borrower");
      setBusy(false);
      if (!result.ok) return setError({ message: result.error.message, details: result.error.details });
    } else if (dialog === "delete") {
      const result = await deleteWithCsrf(`/api/applications/${applicationId}`);
      setBusy(false);
      if (!result.ok) return setError({ message: result.error.message, details: result.error.details });
    }
    setDialog(null);
    onChanged();
  }

  return (
    <>
      <div className={size === "panel" ? "flex flex-col gap-2.5" : "flex flex-wrap items-center gap-1.5"}>
        {availableActions.includes("continue") ? (
          <a
            href={`/applications/${applicationId}`}
            data-testid={`action-continue-${applicationId}`}
            className={btnPrimary + wide}
          >
            Continue
          </a>
        ) : null}
        {availableActions.includes("view") ? (
          <a
            href={`/applications/${applicationId}/view`}
            data-testid={`action-view-${applicationId}`}
            className={btnOutline + wide}
          >
            View
          </a>
        ) : null}
        {availableActions.includes("withdraw") ? (
          <button
            type="button"
            data-testid={`action-withdraw-${applicationId}`}
            onClick={() => open("withdraw")}
            className={btnOutline + wide}
          >
            Withdraw
          </button>
        ) : null}
        {availableActions.includes("decline") ? (
          <button
            type="button"
            data-testid={`action-decline-${applicationId}`}
            onClick={() => open("decline")}
            className={btnDanger + wide}
          >
            {size === "panel" ? "Decline this approved loan" : "Decline"}
          </button>
        ) : null}
        {availableActions.includes("delete-draft") ? (
          <button
            type="button"
            data-testid={`action-delete-draft-${applicationId}`}
            onClick={() => open("delete")}
            className={btnDanger + wide}
          >
            Delete draft
          </button>
        ) : null}
      </div>

      {dialog === "withdraw" ? (
        <ConfirmDialog
          title={`Withdraw application ${applicationNumber}?`}
          body={
            <p>
              Withdrawing permanently closes this application. It cannot be reopened — you would
              need to start a new application.
            </p>
          }
          confirmLabel="Withdraw application"
          confirmTestId="withdraw-confirm-btn"
          destructive
          reasonLabel="Reason (optional)"
          reasonTestId="withdraw-reason-input"
          reasonValue={reason}
          onReasonChange={setReason}
          busy={busy}
          error={error}
          onConfirm={onConfirm}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {dialog === "decline" ? (
        <ConfirmDialog
          title={`Decline the approved loan on ${applicationNumber}?`}
          body={
            <p>
              Declining tells your loan team you are not moving forward with this approved loan.
              The application closes as Declined by Borrower and cannot be reopened.
            </p>
          }
          confirmLabel="Decline loan"
          confirmTestId="decline-confirm-btn"
          destructive
          busy={busy}
          error={error}
          onConfirm={onConfirm}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {dialog === "delete" ? (
        <ConfirmDialog
          title={`Delete draft ${applicationNumber}?`}
          body={<p>This permanently deletes the draft and everything entered in it.</p>}
          confirmLabel="Delete draft"
          confirmTestId="delete-draft-confirm-btn"
          destructive
          busy={busy}
          error={error}
          onConfirm={onConfirm}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
