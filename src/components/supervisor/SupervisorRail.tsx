"use client";

// Supervisor-only right-rail additions to the staff application detail
// (task-031 supervisor detail composition — §4.6.3/§4.6.4, REQ-057/REQ-058).
//
// Rendered by StaffApplicationDetailClient for SUPERVISOR sessions only, under
// the workflow action panel (which already carries suspend/resume — task-029)
// and the approval-panel mount (task-032). This rail adds the pieces §4.6.4
// composes on top of the caseworker detail:
//   1. Priority override (§4.6.3) — PATCH /api/applications/:id/priority,
//      audited + caseworker-notified server-side.
//   2. Assignment history (REQ-058) — GET /api/applications/:id/assignments
//      (supervisor-only per §B; max 50, newest first).
//   3. Export actions (§4.9 via §4.6.4) — the §B per-application export
//      endpoints, paths verbatim:
//        GET /api/applications/:id/exports/mismo-json
//        GET /api/applications/:id/exports/mismo-xml
//        GET /api/applications/:id/exports/urla-pdf
//      SEQUENCING SEAM: these endpoints are increment-10 deliverables and do
//      not exist yet — the buttons are wired to the contracted paths and
//      surface the server response (currently a 404) VERBATIM (NFR-025).
//      Recorded as a namedOpenDefects candidate; do not hide the actions.
//
// Selector contract (§C SupervisorApplications): priority-select-{id},
// export-mismo-json-btn, export-mismo-xml-btn, export-urla-pdf-btn
// (+ assignment-history / priority-override namespace extensions).

import { useEffect, useState } from "react";
import { getJson, type ErrorResponseBody } from "@/components/borrower/api";
import { patchWithCsrf } from "@/components/staff/detail/api";
import { formatDate, humanizeEnum } from "@/components/borrower/format";
import type { ApplicationWire } from "@/components/borrower/types";
import { ApiErrorBanner, btnOutline } from "@/components/borrower/ui";
import { PRIORITY_VALUES, type AssignmentList, type Priority } from "./list-types";

const sectionClass = "rounded-lg border border-line bg-card p-5 shadow-sm";
const headingClass = "text-xs font-bold uppercase tracking-wider text-ink";

export function SupervisorRail({
  app,
  onApplicationChange,
}: {
  app: ApplicationWire;
  onApplicationChange: (app: ApplicationWire) => void;
}) {
  return (
    <>
      <PriorityOverrideCard app={app} onApplicationChange={onApplicationChange} />
      <AssignmentHistoryCard applicationId={app.id} />
      <ExportActionsCard applicationId={app.id} applicationNumber={app.applicationNumber} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Priority override (§4.6.3)
// ---------------------------------------------------------------------------

function PriorityOverrideCard({
  app,
  onApplicationChange,
}: {
  app: ApplicationWire;
  onApplicationChange: (app: ApplicationWire) => void;
}) {
  const [priority, setPriority] = useState<Priority>(app.priority as Priority);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setPriority(app.priority as Priority);
  }, [app.priority]);

  async function apply() {
    setBusy(true);
    setError(null);
    setSaved(null);
    const body: Record<string, unknown> = { priority };
    if (reason.trim()) body.reason = reason.trim();
    const result = await patchWithCsrf<ApplicationWire>(
      `/api/applications/${app.id}/priority`,
      body,
    );
    setBusy(false);
    if (result.ok) {
      onApplicationChange(result.data);
      setReason("");
      setSaved(`Priority overridden to ${humanizeEnum(priority)}. The assigned caseworker was notified.`);
    } else {
      setError(result.error);
    }
  }

  return (
    <section data-testid="priority-override-card" className={sectionClass}>
      <h2 className={headingClass}>Priority override</h2>
      <p className="mt-1 text-xs text-muted">
        Overrides pin the priority (automatic rules no longer apply). Audited; the assigned
        caseworker is notified.
      </p>
      {error ? (
        <div className="mt-2">
          <ApiErrorBanner message={error.message} details={error.details} testId="priority-override-error" />
        </div>
      ) : null}
      {saved ? (
        <p
          data-testid="priority-override-saved"
          role="status"
          className="mt-2 rounded-md border border-success/30 bg-success-soft px-2.5 py-1.5 text-xs text-success"
        >
          {saved}
        </p>
      ) : null}
      <div className="mt-3 space-y-2.5">
        <select
          data-testid={`priority-select-${app.id}`}
          aria-label="Priority override value"
          value={priority}
          onChange={(event) => setPriority(event.target.value as Priority)}
          className="w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
        >
          {PRIORITY_VALUES.map((p) => (
            <option key={p} value={p}>
              {humanizeEnum(p)}
            </option>
          ))}
        </select>
        <input
          type="text"
          data-testid="priority-override-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (optional)"
          aria-label="Priority override reason"
          className="w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
        />
        <button
          type="button"
          data-testid="priority-override-apply-btn"
          onClick={apply}
          disabled={busy || priority === (app.priority as Priority)}
          className={`w-full ${btnOutline}`}
        >
          {busy ? "Applying…" : "Apply override"}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Assignment history (REQ-058 — GET /api/applications/:id/assignments)
// ---------------------------------------------------------------------------

function AssignmentHistoryCard({ applicationId }: { applicationId: string }) {
  const [rows, setRows] = useState<AssignmentList["rows"] | null>(null);
  const [error, setError] = useState<ErrorResponseBody | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<AssignmentList>(`/api/applications/${applicationId}/assignments`);
      if (cancelled) return;
      if (result.ok) setRows(result.data.rows);
      else setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  return (
    <section data-testid="assignment-history" className={sectionClass}>
      <h2 className={headingClass}>Assignment history</h2>
      {error ? (
        <div className="mt-2">
          <ApiErrorBanner message={error.message} details={error.details} testId="assignment-history-error" />
        </div>
      ) : rows === null ? (
        <p className="mt-2 text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p data-testid="assignment-history-empty" className="mt-2 text-sm text-muted">
          No assignments recorded yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid={`assignment-history-row-${row.id}`}
              className="rounded-md border border-line/70 p-2.5 text-sm"
            >
              <p className="font-semibold text-ink">
                {row.caseworkerName}
                <span className="ml-1.5 inline-block rounded-full bg-gray-soft px-2 py-0.5 text-[11px] font-semibold capitalize text-ink-soft">
                  {row.method}
                </span>
                {row.endedAt === undefined ? (
                  <span className="ml-1.5 inline-block rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success">
                    active
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-ink-soft">
                {formatDate(row.assignedAt)}
                {row.assignedByName ? ` · by ${row.assignedByName}` : ""}
                {row.endedAt ? ` · ended ${formatDate(row.endedAt)}` : ""}
                {row.endReason ? ` (${humanizeEnum(row.endReason)})` : ""}
              </p>
              {row.reason ? <p className="mt-0.5 text-xs text-muted">Reason: {row.reason}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Export actions (§4.9 — endpoints land in increment 10; errors verbatim)
// ---------------------------------------------------------------------------

const EXPORTS = [
  { key: "mismo-json", label: "MISMO JSON", testId: "export-mismo-json-btn", filename: "mismo.json" },
  { key: "mismo-xml", label: "MISMO XML", testId: "export-mismo-xml-btn", filename: "mismo.xml" },
  { key: "urla-pdf", label: "URLA PDF", testId: "export-urla-pdf-btn", filename: "urla.pdf" },
] as const;

function ExportActionsCard({
  applicationId,
  applicationNumber,
}: {
  applicationId: string;
  applicationNumber: string;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<ErrorResponseBody | null>(null);

  async function download(key: (typeof EXPORTS)[number]["key"], filename: string) {
    setBusyKey(key);
    setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/exports/${key}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        // Error body VERBATIM (NFR-025) — including the 404 until the export
        // endpoints ship in increment 10.
        let body: ErrorResponseBody | null = null;
        try {
          body = (await response.json()) as ErrorResponseBody;
        } catch {
          body = null;
        }
        setError(
          body && typeof body.message === "string"
            ? body
            : { code: "unavailable", message: `Export failed with status ${response.status}.` },
        );
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${applicationNumber}-${filename}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError({
        code: "network_error",
        message: "Could not reach the server. Check your connection and try again.",
      });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section data-testid="export-actions" className={sectionClass}>
      <h2 className={headingClass}>Export</h2>
      <p className="mt-1 text-xs text-muted">
        Compliance exports for this application. SSNs are masked by default.
      </p>
      {error ? (
        <div className="mt-2">
          <ApiErrorBanner message={error.message} details={error.details} testId="export-error-banner" />
        </div>
      ) : null}
      <div className="mt-3 space-y-2">
        {EXPORTS.map((item) => (
          <button
            key={item.key}
            type="button"
            data-testid={item.testId}
            onClick={() => void download(item.key, item.filename)}
            disabled={busyKey !== null}
            className={`w-full ${btnOutline}`}
          >
            {busyKey === item.key ? "Exporting…" : `Download ${item.label}`}
          </button>
        ))}
      </div>
    </section>
  );
}
