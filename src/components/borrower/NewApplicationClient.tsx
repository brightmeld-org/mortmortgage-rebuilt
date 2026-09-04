"use client";

// /applications/new — source selection + per-section copy picker (task-017,
// REQ-022, §4.2.3, frame gui-spec "application-new").
//
// Copy is a SERVER-side operation: this screen only collects
// CreateApplicationRequest { requestToken, copyFromApplicationId?,
// copySections? } and POSTs /api/applications. requestToken is generated once
// per page visit (idempotency — a retried Create never makes two drafts).
//
// Staleness advisory (inline, pre-create): the borrower-readable wire shape
// carries ONE staleness datum for a prior application — Application.updatedAt
// (per-section save times are not serialized). Sections are flagged when the
// source application was last saved more than 90 days ago (the
// application.staleCopyThresholdDays default). The AUTHORITATIVE per-section
// advisories are computed server-side at create time against the configured
// threshold and persist on the draft until edited/confirmed (REQ-022) — the
// wizard surfaces those; this inline hint mirrors them before the copy.

import { useEffect, useMemo, useState } from "react";
import { getJson, postWithCsrf } from "./api";
import { formatDate } from "./format";
import type { ApplicationWire, BorrowerApplicationList, BorrowerApplicationRow, WizardSection } from "./types";
import { WIZARD_SECTIONS } from "./types";
import { ApiErrorBanner, btnPrimary, Card, CardHeading, SkeletonBlock, WarnBanner } from "./ui";

const STALE_THRESHOLD_DAYS = 90;

type Mode = "blank" | "copy";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string; details?: string[] }
  | { phase: "ready"; priorApps: BorrowerApplicationRow[] };

export function NewApplicationClient() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [mode, setMode] = useState<Mode>("blank");
  const [sourceId, setSourceId] = useState<string>("");
  const [source, setSource] = useState<ApplicationWire | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [selected, setSelected] = useState<Set<WizardSection>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ message: string; details?: string[] } | null>(null);

  // One idempotency token per visit (NFR-022): retries replay the same draft.
  const requestToken = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    void (async () => {
      const result = await getJson<BorrowerApplicationList>("/api/applications?page=1&pageSize=100");
      if (!result.ok) {
        setState({ phase: "error", message: result.error.message, details: result.error.details });
        return;
      }
      setState({ phase: "ready", priorApps: result.data.rows });
    })();
  }, []);

  useEffect(() => {
    if (!sourceId) {
      setSource(null);
      return;
    }
    setSourceLoading(true);
    void (async () => {
      const result = await getJson<ApplicationWire>(`/api/applications/${sourceId}`);
      setSourceLoading(false);
      setSource(result.ok ? result.data : null);
    })();
  }, [sourceId]);

  const sourceIsStale = useMemo(() => {
    if (!source) return false;
    const savedAt = new Date(source.updatedAt).getTime();
    return Date.now() - savedAt > STALE_THRESHOLD_DAYS * 86_400_000;
  }, [source]);

  function toggleSection(section: WizardSection) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  async function onCreate() {
    setCreating(true);
    setCreateError(null);
    const body: Record<string, unknown> = { requestToken };
    if (mode === "copy" && sourceId) {
      body.copyFromApplicationId = sourceId;
      body.copySections = WIZARD_SECTIONS.filter((s) => selected.has(s.section)).map((s) => s.section);
    }
    const result = await postWithCsrf<ApplicationWire>("/api/applications", body);
    if (!result.ok) {
      setCreating(false);
      setCreateError({ message: result.error.message, details: result.error.details });
      return;
    }
    // Wizard step 1 (task-016) owns /applications/:id.
    window.location.assign(`/applications/${result.data.id}`);
  }

  if (state.phase === "loading") {
    return (
      <div className="space-y-4">
        <SkeletonBlock className="h-10 w-72" />
        <SkeletonBlock className="h-64 w-full" />
      </div>
    );
  }

  if (state.phase === "error") {
    return <ApiErrorBanner message={state.message} details={state.details} testId="new-application-error" />;
  }

  const { priorApps } = state;
  const copyDisabled = priorApps.length === 0;
  const createDisabled =
    creating || (mode === "copy" && (!sourceId || selected.size === 0));

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold text-ink">Start a new application</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Begin with a blank application, or save time by copying sections from one of your previous
        applications. Documents and signatures are never copied.
      </p>

      <Card className="mt-6">
        <CardHeading>Where should we start?</CardHeading>
        <fieldset className="mt-4 space-y-3">
          <legend className="sr-only">Application source</legend>
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3.5 transition-colors duration-200 ${
              mode === "blank" ? "border-navy bg-navy/5" : "border-line hover:border-navy/40"
            }`}
          >
            <input
              type="radio"
              name="source-mode"
              data-testid="new-app-mode-blank"
              checked={mode === "blank"}
              onChange={() => setMode("blank")}
              className="mt-0.5 h-4 w-4 accent-navy"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">Start blank</span>
              <span className="block text-sm text-ink-soft">
                Begin with an empty application and enter everything fresh.
              </span>
            </span>
          </label>

          <label
            className={`flex items-start gap-3 rounded-md border p-3.5 transition-colors duration-200 ${
              copyDisabled
                ? "cursor-not-allowed border-line opacity-60"
                : mode === "copy"
                  ? "cursor-pointer border-navy bg-navy/5"
                  : "cursor-pointer border-line hover:border-navy/40"
            }`}
          >
            <input
              type="radio"
              name="source-mode"
              data-testid="new-app-mode-copy"
              checked={mode === "copy"}
              disabled={copyDisabled}
              onChange={() => setMode("copy")}
              className="mt-0.5 h-4 w-4 accent-navy"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">
                Copy from a previous application
              </span>
              <span className="block text-sm text-ink-soft">
                {copyDisabled
                  ? "You have no previous applications to copy from yet."
                  : "Pick a previous application and choose which sections to bring over."}
              </span>
            </span>
          </label>
        </fieldset>

        {mode === "copy" && !copyDisabled ? (
          <div className="mt-5 border-t border-line pt-5">
            <label htmlFor="copy-source-select" className="mb-1.5 block text-sm font-medium text-ink">
              Copy from
            </label>
            <select
              id="copy-source-select"
              data-testid="copy-source-select"
              value={sourceId}
              onChange={(event) => {
                setSourceId(event.target.value);
                setSelected(new Set());
              }}
              className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/25"
            >
              <option value="">Select a previous application…</option>
              {priorApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.applicationNumber} — {app.workflowStateLabel} — created {formatDate(app.createdAt)}
                </option>
              ))}
            </select>

            {sourceLoading ? <SkeletonBlock className="mt-4 h-40 w-full" /> : null}

            {source && !sourceLoading ? (
              <div className="mt-4">
                <p className="text-sm font-medium text-ink">Sections to copy</p>
                <p className="mt-0.5 text-xs text-muted">
                  Source last saved {formatDate(source.updatedAt)}.
                </p>
                <ul className="mt-3 space-y-2">
                  {WIZARD_SECTIONS.map(({ section, label }) => (
                    <li key={section}>
                      <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line px-3 py-2 transition-colors duration-200 hover:border-navy/40">
                        <input
                          type="checkbox"
                          data-testid={`copy-section-${section}`}
                          checked={selected.has(section)}
                          onChange={() => toggleSection(section)}
                          className="h-4 w-4 accent-navy"
                        />
                        <span className="text-sm text-ink">{label}</span>
                      </label>
                      {sourceIsStale ? (
                        <div className="mt-1.5">
                          <WarnBanner testId={`staleness-advisory-${section}`}>
                            The {label} section you are copying is from an application dated{" "}
                            {formatDate(source.updatedAt)} — more than {STALE_THRESHOLD_DAYS} days
                            ago. Please review and update it before submitting.
                          </WarnBanner>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {createError ? (
        <div className="mt-4">
          <ApiErrorBanner
            message={createError.message}
            details={createError.details}
            testId="create-application-error"
          />
        </div>
      ) : null}

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          data-testid="create-application-btn"
          onClick={() => void onCreate()}
          disabled={createDisabled}
          className={btnPrimary}
        >
          {creating ? "Creating…" : "Create application"}
        </button>
      </div>
    </div>
  );
}
