"use client";

// Global export cards (task-044) — frame gui-spec "sup-exports": HMDA LAR
// (year select), data-warehouse extract (full/incremental + since timestamp),
// and the note pointing to per-application exports on the staff detail page.
//
// Download mechanics follow the established AuditLogViewer fetch → blob →
// anchor pattern (streamed server-side; the fetch consumes the stream). Both
// downloads show a busy/progress state (>1s rule) and surface the server
// ErrorResponse verbatim on failure; the LAR 409 (HMDA LEI/agency not yet
// configured) additionally points the supervisor at Settings.

import { useState } from "react";
import type { ErrorResponseBody } from "@/components/auth/api";
// Shared button primitive — the supervisor area's dominant primary action style
// (navy, darken-on-hover). Previously hand-rolled here as copper-with-navy-hover,
// which was the only copper primary in the supervisor area and the only button
// whose hover shifted hue rather than darkening in place.
import { btnPrimary } from "@/components/borrower/ui";

const CURRENT_YEAR = new Date().getUTCFullYear();
/** Calendar-year choices: current filing year back 5 years. */
const YEAR_CHOICES = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

type DownloadState = { busy: boolean; error: ErrorResponseBody | null; done: string | null };

const IDLE: DownloadState = { busy: false, error: null, done: null };

async function downloadTo(url: string, fallbackName: string): Promise<{ error: ErrorResponseBody | null; fileName: string | null }> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) {
      let body: ErrorResponseBody | null = null;
      try {
        body = (await response.json()) as ErrorResponseBody;
      } catch {
        body = null;
      }
      return {
        error:
          body && typeof body.message === "string"
            ? body
            : { code: "unavailable", message: "The export could not be generated. Please try again." },
        fileName: null,
      };
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const nameMatch = disposition.match(/filename="([^"]+)"/);
    const fileName = nameMatch?.[1] ?? fallbackName;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    return { error: null, fileName };
  } catch {
    return {
      error: { code: "network_error", message: "Could not reach the server. Check your connection and try again." },
      fileName: null,
    };
  }
}

function ErrorBanner({ error, testId, settingsPointer }: { error: ErrorResponseBody; testId: string; settingsPointer?: boolean }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mt-3 rounded-md border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
    >
      <p>{error.message}</p>
      {error.details && error.details.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {settingsPointer ? (
        <p className="mt-1.5">
          Configure the HMDA LEI and agency code under{" "}
          <a href="/supervisor/settings" data-testid="exports-lar-settings-link" className="font-semibold underline">
            Settings
          </a>{" "}
          first.
        </p>
      ) : null}
    </div>
  );
}

export function ExportsClient() {
  const [larYear, setLarYear] = useState(String(CURRENT_YEAR));
  const [lar, setLar] = useState<DownloadState>(IDLE);
  const [mode, setMode] = useState<"full" | "incremental">("full");
  const [since, setSince] = useState("");
  const [sinceError, setSinceError] = useState<string | null>(null);
  const [warehouse, setWarehouse] = useState<DownloadState>(IDLE);

  async function downloadLar() {
    setLar({ busy: true, error: null, done: null });
    const { error, fileName } = await downloadTo(
      `/api/admin/exports/hmda-lar?year=${encodeURIComponent(larYear)}`,
      `hmda-lar-${larYear}.txt`,
    );
    setLar({ busy: false, error, done: fileName });
  }

  async function downloadWarehouse() {
    setSinceError(null);
    let url = `/api/admin/exports/warehouse?mode=${mode}`;
    if (mode === "incremental") {
      if (!since) {
        setSinceError("A since timestamp is required for an incremental extract.");
        return;
      }
      const parsed = new Date(since);
      if (Number.isNaN(parsed.getTime())) {
        setSinceError("Enter a valid date and time.");
        return;
      }
      url += `&since=${encodeURIComponent(parsed.toISOString())}`;
    }
    setWarehouse({ busy: true, error: null, done: null });
    const { error, fileName } = await downloadTo(url, `warehouse-${mode}.zip`);
    setWarehouse({ busy: false, error, done: fileName });
  }

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold text-ink">Exports</h1>
        <p className="mt-1 text-sm text-muted">
          Institution-wide compliance and analytics exports. Per-application exports (MISMO JSON,
          MISMO XML, URLA PDF) live on each application&rsquo;s detail page under All Applications.
        </p>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        {/* ------------------------- HMDA LAR ------------------------- */}
        <section
          aria-labelledby="exports-lar-title"
          className="rounded-lg border border-line bg-card p-5 shadow-sm"
        >
          <h2 id="exports-lar-title" className="font-display text-lg font-bold text-ink">
            HMDA Loan Application Register
          </h2>
          <p className="mt-1.5 text-sm text-ink-soft">
            Pipe-delimited LAR in the FFIEC filing format — an institution header plus one record
            per reportable application in the selected calendar year. Requires the HMDA LEI and
            agency code to be configured in Settings.
          </p>
          <div className="mt-4">
            <label htmlFor="exports-lar-year" className="block text-sm font-medium text-ink">
              Filing year
            </label>
            <select
              id="exports-lar-year"
              data-testid="exports-lar-year"
              value={larYear}
              onChange={(e) => setLarYear(e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30"
            >
              {YEAR_CHOICES.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            data-testid="exports-lar-download"
            onClick={() => void downloadLar()}
            disabled={lar.busy}
            className={`mt-4 ${btnPrimary} disabled:opacity-60`}
          >
            {lar.busy ? "Preparing download…" : "Download LAR"}
          </button>
          {lar.busy ? (
            <p role="status" data-testid="exports-lar-busy" className="mt-2 text-sm text-muted">
              Generating the LAR file — the download starts automatically.
            </p>
          ) : null}
          {lar.done ? (
            <p role="status" data-testid="exports-lar-done" className="mt-2 text-sm text-success">
              Downloaded {lar.done}.
            </p>
          ) : null}
          {lar.error ? (
            <ErrorBanner
              error={lar.error}
              testId="exports-lar-error"
              settingsPointer={lar.error.code !== "network_error" && lar.error.code !== "unavailable"}
            />
          ) : null}
        </section>

        {/* --------------------- Warehouse extract --------------------- */}
        <section
          aria-labelledby="exports-warehouse-title"
          className="rounded-lg border border-line bg-card p-5 shadow-sm"
        >
          <h2 id="exports-warehouse-title" className="font-display text-lg font-bold text-ink">
            Data-warehouse extract
          </h2>
          <p className="mt-1.5 text-sm text-ink-soft">
            ZIP of star-schema CSVs (facts + dimensions, no SSNs, birth dates as age bands) with a
            schema description. Full extract, or incremental — rows touched since a timestamp.
          </p>
          <div className="mt-4">
            <label htmlFor="exports-warehouse-mode" className="block text-sm font-medium text-ink">
              Extract mode
            </label>
            <select
              id="exports-warehouse-mode"
              data-testid="exports-warehouse-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value === "incremental" ? "incremental" : "full")}
              className="mt-1 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30"
            >
              <option value="full">Full — every row</option>
              <option value="incremental">Incremental — rows changed since…</option>
            </select>
          </div>
          {mode === "incremental" ? (
            <div className="mt-3">
              <label htmlFor="exports-warehouse-since" className="block text-sm font-medium text-ink">
                Changed since
              </label>
              <input
                id="exports-warehouse-since"
                data-testid="exports-warehouse-since"
                type="datetime-local"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                aria-describedby={sinceError ? "exports-warehouse-since-error" : undefined}
                aria-invalid={sinceError ? true : undefined}
                className="mt-1 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30"
              />
              {sinceError ? (
                <p id="exports-warehouse-since-error" data-testid="exports-warehouse-since-error" className="mt-1 text-sm text-danger">
                  {sinceError}
                </p>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            data-testid="exports-warehouse-download"
            onClick={() => void downloadWarehouse()}
            disabled={warehouse.busy}
            className={`mt-4 ${btnPrimary} disabled:opacity-60`}
          >
            {warehouse.busy ? "Preparing download…" : "Download extract"}
          </button>
          {warehouse.busy ? (
            <p role="status" data-testid="exports-warehouse-busy" className="mt-2 text-sm text-muted">
              Building the ZIP — the download starts automatically.
            </p>
          ) : null}
          {warehouse.done ? (
            <p role="status" data-testid="exports-warehouse-done" className="mt-2 text-sm text-success">
              Downloaded {warehouse.done}.
            </p>
          ) : null}
          {warehouse.error ? <ErrorBanner error={warehouse.error} testId="exports-warehouse-error" /> : null}
        </section>
      </div>

      <p data-testid="exports-per-app-note" className="mt-5 text-sm text-muted">
        Looking for a single application&rsquo;s files? Open the application from{" "}
        <a href="/supervisor" className="font-medium text-copper underline">
          All Applications
        </a>{" "}
        — MISMO JSON/XML and the URLA PDF export are on its detail page.
      </p>
    </div>
  );
}
