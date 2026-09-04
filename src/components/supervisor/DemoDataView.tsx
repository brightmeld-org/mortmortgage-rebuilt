"use client";

// DemoDataView (contracts §C DemoDataPage, task-043, REQ-066 / FLOW-012) —
// the /supervisor/demo-data Seed / Remove Demo Data surface.
//
// Reached from: (app) shell supervisor nav → "Demo Data" (task-044 wires the
// link) → /supervisor/demo-data (src/app/(app)/supervisor/demo-data/page.tsx).
//
// Selector contract (build-plan §C DemoDataPage): `seed-btn`,
// `seed-remove-btn`, `seed-summary` — extended within the namespace only:
// `seed-progress`, `seed-error`, `seed-remove-confirm-btn`,
// `seed-confirm-btn`, `seed-removed-banner`.
//
// Behavior:
//   Seed   → destructive: a re-seed FIRST removes any prior seed set and then
//            rebuilds it, so it is confirmation-gated exactly like Remove
//            (NFR-025 "confirmation on destructive actions"); the confirmation
//            names what is destroyed. Then POST /api/admin/demo-data/seed. The
//            request performs the whole run (single transaction, ASYNC-006
//            interpretation) — the pending state here IS the progress
//            affordance (spinner + disabled actions); the 202 response carries
//            the completed SeedRunInfo whose JSON-encoded recordCounts render
//            as the run summary.
//   Remove → destructive: explicit confirmation dialog first, then
//            DELETE /api/admin/demo-data (204). Deletes ONLY seed-flagged
//            records including their seed-flagged audit entries.
// API error bodies are surfaced verbatim (NFR-025). A concurrent run's 409 is
// shown verbatim too.
//
// Design language: increment-6 supervisor pattern (Card + Badge + btn classes
// — same as OutboundMessagesView).

import { useState } from "react";
import { deleteWithCsrf, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import {
  ApiErrorBanner, Card, CardHeading, ConfirmDialog, InfoBanner, WarnBanner,
  btnDanger, btnPrimary,
} from "@/components/borrower/ui";

// contracts.json models.SeedRunInfo — exact field names.
interface SeedRunInfo {
  id: string;
  createdAt: string;
  /** JSON-encoded per-entity record counts created by the seed. */
  recordCounts: string;
  removedAt?: string;
}

type Busy = "seed" | "remove" | null;

function parseCounts(encoded: string): Array<[string, number]> {
  try {
    const decoded: unknown = JSON.parse(encoded);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      return Object.entries(decoded as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .sort((a, b) => a[0].localeCompare(b[0]));
    }
  } catch {
    /* fall through to empty */
  }
  return [];
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function DemoDataView() {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  const [lastRun, setLastRun] = useState<SeedRunInfo | null>(null);
  const [removed, setRemoved] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmSeed, setConfirmSeed] = useState(false);

  async function runSeed() {
    setBusy("seed");
    setError(null);
    setRemoved(false);
    const result = await postWithCsrf<SeedRunInfo>("/api/admin/demo-data/seed");
    setBusy(null);
    setConfirmSeed(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setLastRun(result.data);
  }

  async function runRemove() {
    setBusy("remove");
    setError(null);
    const result = await deleteWithCsrf<null>("/api/admin/demo-data");
    setBusy(null);
    setConfirmRemove(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setLastRun(null);
    setRemoved(true);
  }

  const counts = lastRun ? parseCounts(lastRun.recordCounts) : [];
  const totalRows = counts.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h1 className="font-display text-2xl font-bold text-ink">Demo Data</h1>
        <p className="mt-1 text-sm text-muted">
          Seed the full demonstration dataset (50+ applications, staged demo-persona positions, staff
          roster) or remove every seeded record. Available in demonstration mode only.
        </p>
      </div>

      {error ? <ApiErrorBanner message={error.message} details={error.details} testId="seed-error" /> : null}
      {removed ? (
        <div className="mb-4">
          <InfoBanner testId="seed-removed-banner">
            Demo data removed. Only seed-flagged records (including their seed-flagged audit entries)
            were deleted; everything else was left untouched.
          </InfoBanner>
        </div>
      ) : null}

      <Card>
        <CardHeading>Actions</CardHeading>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="seed-btn"
            className={btnPrimary}
            disabled={busy !== null}
            onClick={() => setConfirmSeed(true)}
          >
            {busy === "seed" ? "Seeding…" : "Seed Demo Data"}
          </button>
          <button
            type="button"
            data-testid="seed-remove-btn"
            className={btnDanger}
            disabled={busy !== null}
            onClick={() => setConfirmRemove(true)}
          >
            {busy === "remove" ? "Removing…" : "Remove Demo Data"}
          </button>
        </div>

        {busy !== null ? (
          <div
            data-testid="seed-progress"
            role="status"
            aria-live="polite"
            className="mt-4 flex items-center gap-2 text-sm text-ink-soft"
          >
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-navy border-t-transparent" aria-hidden="true" />
            {busy === "seed"
              ? "Seeding the demonstration dataset — this runs in one transaction and can take a minute…"
              : "Removing seed-flagged records…"}
          </div>
        ) : (
          <div className="mt-4">
            <WarnBanner>
              Removing demo data is destructive: every seed-flagged record — applications, accounts,
              documents, and their seed-flagged audit entries — is permanently deleted. Re-seeding
              first removes any prior seed set, then rebuilds it.
            </WarnBanner>
          </div>
        )}
      </Card>

      {lastRun ? (
        <div className="mt-4">
          <Card testId="seed-summary">
            <CardHeading>
              Seed run summary
            </CardHeading>
            <p className="text-sm text-ink-soft">
              Run <span className="font-mono text-xs">{lastRun.id}</span> completed{" "}
              {formatTimestamp(lastRun.createdAt)} — {totalRows.toLocaleString("en-US")} records across{" "}
              {counts.length} entity types.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    <th className="px-2 py-2">Entity</th>
                    <th className="px-2 py-2 text-right">Records created</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map(([entity, count]) => (
                    <tr key={entity} className="border-b border-line last:border-b-0">
                      <td className="px-2 py-1.5 font-mono text-xs text-ink">{entity}</td>
                      <td className="px-2 py-1.5 text-right text-ink-soft">{count.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {confirmSeed ? (
        <ConfirmDialog
          title="Re-seed demo data?"
          body="Seeding is destructive: it FIRST permanently deletes every existing seed-flagged record — seeded applications, borrower and staff accounts, documents, and their seed-flagged audit entries — and then rebuilds the dataset from scratch. Application numbers change, and any in-flight work on a seeded application is lost. Records you created outside the seed are not affected."
          confirmLabel="Delete and re-seed"
          confirmTestId="seed-confirm-btn"
          destructive
          busy={busy === "seed"}
          onConfirm={() => void runSeed()}
          onCancel={() => setConfirmSeed(false)}
        />
      ) : null}

      {confirmRemove ? (
        <ConfirmDialog
          title="Remove demo data?"
          body="This permanently deletes every seed-flagged record — seeded applications, borrower and staff accounts, documents, and their seed-flagged audit entries. Records you created outside the seed are not affected."
          confirmLabel="Remove Demo Data"
          confirmTestId="seed-remove-confirm-btn"
          destructive
          busy={busy === "remove"}
          onConfirm={() => void runRemove()}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </div>
  );
}
