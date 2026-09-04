"use client";

// UnderwritingPanel (task-026 — REQ-059, INT-011, ASM-006, ASM-008).
//
// Contracts §C: five expandable check sections with the exact §4.6.5
// displayed-result tables and badge thresholds, loading / error + Retry
// states, staleness indicators ("AVM re-run pending" per ASM-006), the
// qualification summary card, and the keyless AVM map with subject +
// comparable markers and comparables-table + placeholder fallback.
//
// Mounted by StaffApplicationDetail (task-029) on the Underwriting tab of
// /staff/applications/:id.
//
// Props (wired by the detail page):
//   - applicationId  (required) — Application.id; drives the three §B calls
//     this panel makes: GET  /api/applications/:id/checks
//                       POST /api/applications/:id/checks/:checkType
//                       GET  /api/applications/:id/qualification
//   - subject        (optional) — geocoded subject property for the AVM map
//     ({ latitude, longitude, label? } from SubjectProperty.geocode +
//     address; §A GeoPoint field names). Without it the map area renders its
//     placeholder and the comparables table remains the fallback.
//   - canRunChecks   (optional, default true) — role/state context from the
//     parent (checks are permitted only in workflow states 3–8 for the
//     assigned caseworker or a Supervisor). When false the Run/Re-run/Retry
//     buttons are hidden; the server gate stays authoritative either way and
//     its 403/404/409 error bodies are surfaced VERBATIM.
//
// Badge authority: UnderwritingResultInfo.riskBadge is computed server-side
// from the §4.6.5 thresholds (credit tier Good≥700/Fair 640–699/Poor<640;
// income variance ≤5 green / ≤10 yellow / >10 or unverified red; AVM-LTV
// ≤80/≤95/>95; pricing par−base ≤+0.25/≤+0.75/>+0.75) — the panel renders
// that enum and never re-derives thresholds, so display and audit summary
// can never disagree.
//
// Selector contract (§C build-plan): check-section-{checkType},
// check-run-{checkType}, check-retry-{checkType}, check-badge-{checkType},
// check-stale-{checkType}, avm-map, avm-comparables-table, avm-map-fallback,
// qualification-{metric} — extended only within those namespaces.

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/borrower/api";
import { formatDate, humanizeEnum } from "@/components/borrower/format";
import { ApiErrorBanner, Card, SkeletonBlock, btnOutline, btnPrimary } from "@/components/borrower/ui";
import { AvmBody } from "./AvmSection";
import { AusBody, CreditBody, IncomeBody, PricingBody, ausRecommendationLabel, formatPct, formatRate } from "./check-bodies";
import { QualificationCard } from "./QualificationCard";
import { RiskBadgePill, StalePill } from "./ui";
import {
  CHECK_TYPES,
  type CheckType,
  type QualificationSummary,
  type SubjectMapPoint,
  type UnderwritingResultInfo,
  type UnderwritingResultList,
} from "./types";

const POLL_INTERVAL_MS = 2_500;
/** NFR-022: past this, a running check gets "still running" messaging. */
const SLOW_RUNNING_NOTICE_MS = 30_000;

const CHECK_TITLES: Record<CheckType, string> = {
  credit: "Credit — tri-bureau",
  income: "Income verification",
  avm: "Property valuation — AVM",
  pricing: "Loan pricing",
  aus: "AUS — automated underwriting",
};

// ---------------------------------------------------------------------------
// Badge label (contextual text next to the server-computed color, per frame:
// "Good · 742", "Variance 23%", "LTV 86.5%", "Par +0.125%", "Refer")
// ---------------------------------------------------------------------------

function badgeLabel(row: UnderwritingResultInfo): string {
  switch (row.checkType) {
    case "credit": {
      const score = row.credit?.qualifyingScore ?? row.credit?.middleScore;
      const tier = row.credit?.riskTier ? humanizeEnum(row.credit.riskTier) : null;
      return tier ? `${tier}${score !== undefined ? ` · ${score}` : ""}` : (row.riskBadge ?? "");
    }
    case "income": {
      const rows = row.income?.employments ?? [];
      if (rows.some((r) => !r.employerVerified)) return "Unverified employer";
      const max = rows.reduce(
        (acc, r) => (typeof r.variancePct === "number" && r.variancePct > acc ? r.variancePct : acc),
        0,
      );
      return `Variance ${formatPct(max)}`;
    }
    case "avm":
      return row.avm?.recomputedLtv !== undefined
        ? `LTV ${formatPct(row.avm.recomputedLtv)}`
        : (row.riskBadge ?? "");
    case "pricing": {
      const par =
        row.pricing?.scenarios.find((s) => s.name === "par") ?? row.pricing?.scenarios[0];
      if (par && typeof row.pricing?.baseRate === "number") {
        const delta = par.interestRate - row.pricing.baseRate;
        return `Par ${delta >= 0 ? "+" : "−"}${formatRate(Math.abs(delta)).replace("%", "")}%`;
      }
      return row.riskBadge ?? "";
    }
    case "aus":
      return row.aus ? ausRecommendationLabel(row.aus.recommendation) : (row.riskBadge ?? "");
  }
}

// ---------------------------------------------------------------------------
// One expandable check section
// ---------------------------------------------------------------------------

function CheckSection({
  checkType,
  current,
  history,
  subject,
  canRunChecks,
  busy,
  actionError,
  onRun,
  now,
}: {
  checkType: CheckType;
  current: UnderwritingResultInfo | null;
  history: UnderwritingResultInfo[];
  subject: SubjectMapPoint | null;
  canRunChecks: boolean;
  busy: boolean;
  actionError: ErrorResponseBody | null;
  onRun: (checkType: CheckType) => void;
  now: number;
}) {
  const [expanded, setExpanded] = useState(true);

  const running = current?.status === "running";
  const completed = current?.status === "completed";
  const errored = current?.status === "error";
  const slowRunning =
    running && current !== null && now - Date.parse(current.requestedAt) > SLOW_RUNNING_NOTICE_MS;

  const staleText =
    checkType === "avm" ? "Stale — AVM re-run pending" : "Stale — re-run pending";

  return (
    <Card testId={`check-section-${checkType}`} className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line/70 px-5 py-3.5">
        <button
          type="button"
          data-testid={`check-section-${checkType}-toggle`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40"
        >
          <span
            aria-hidden
            className={`text-xs text-muted transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${expanded ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span className="truncate font-display text-lg font-bold text-ink">
            {CHECK_TITLES[checkType]}
          </span>
        </button>

        {current?.isStale ? (
          <StalePill testId={`check-stale-${checkType}`} text={staleText} />
        ) : null}

        {completed && current?.riskBadge ? (
          <RiskBadgePill
            testId={`check-badge-${checkType}`}
            badge={current.riskBadge}
            label={badgeLabel(current)}
          />
        ) : null}

        {running ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-info">
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-info/30 border-t-info"
            />
            Running…
          </span>
        ) : null}

        {canRunChecks && !running ? (
          errored ? (
            <button
              type="button"
              data-testid={`check-retry-${checkType}`}
              onClick={() => onRun(checkType)}
              disabled={busy}
              className={btnPrimary}
            >
              Retry
            </button>
          ) : (
            <button
              type="button"
              data-testid={`check-run-${checkType}`}
              onClick={() => onRun(checkType)}
              disabled={busy}
              className={completed ? btnOutline : btnPrimary}
            >
              {completed ? "Re-run" : "Run"}
            </button>
          )
        ) : null}
      </div>

      <div className="px-5 py-4">
        {actionError ? (
          <ApiErrorBanner
            message={actionError.message}
            details={actionError.details}
            testId={`check-run-${checkType}-error`}
          />
        ) : null}

        {errored && current?.error ? (
          <ApiErrorBanner
            message={current.error}
            testId={`check-section-${checkType}-error`}
          />
        ) : null}

        {running ? (
          <div>
            <SkeletonBlock className="h-20 w-full" />
            <p className="mt-2 text-sm text-muted" role="status">
              {slowRunning
                ? "Still running — this check is taking longer than usual. Results will appear here when it completes."
                : "Check in progress — results will appear here when it completes."}
            </p>
          </div>
        ) : null}

        {!current && !running ? (
          <p className="text-sm text-muted">
            {checkType === "aus"
              ? "Not run yet. AUS runs after the credit, income, AVM, and pricing checks complete."
              : "Not run yet."}
          </p>
        ) : null}

        {expanded && completed && current ? (
          <>
            {current.checkType === "credit" && current.credit ? (
              <CreditBody result={current.credit} />
            ) : null}
            {current.checkType === "income" && current.income ? (
              <IncomeBody result={current.income} />
            ) : null}
            {current.checkType === "avm" && current.avm ? (
              <AvmBody result={current.avm} subject={subject} />
            ) : null}
            {current.checkType === "pricing" && current.pricing ? (
              <PricingBody result={current.pricing} />
            ) : null}
            {current.checkType === "aus" && current.aus ? <AusBody result={current.aus} /> : null}
          </>
        ) : null}

        {current ? (
          <p className="mt-3 border-t border-line/60 pt-2.5 text-xs text-muted">
            {current.provider ? `Via ${current.provider}` : null}
            {current.requestedByName ? ` · requested by ${current.requestedByName}` : null}
            {` · requested ${formatDate(current.requestedAt)}`}
            {current.completedAt ? ` · completed ${formatDate(current.completedAt)}` : null}
          </p>
        ) : null}

        {expanded && history.length > 0 ? (
          <div data-testid={`check-section-${checkType}-history`} className="mt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Previous runs ({history.length})
            </p>
            <ul className="mt-1 space-y-1">
              {history.map((row) => (
                <li key={row.id} className="text-xs text-ink-soft">
                  {formatDate(row.requestedAt)} — {row.status}
                  {row.summary ? ` — ${row.summary}` : ""}
                  {row.error ? ` — ${row.error}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface UnderwritingPanelProps {
  applicationId: string;
  subject?: SubjectMapPoint | null;
  canRunChecks?: boolean;
}

export function UnderwritingPanel({
  applicationId,
  subject = null,
  canRunChecks = true,
}: UnderwritingPanelProps) {
  const [rows, setRows] = useState<UnderwritingResultInfo[] | null>(null);
  const [listError, setListError] = useState<ErrorResponseBody | null>(null);
  const [qualification, setQualification] = useState<QualificationSummary | null>(null);
  const [qualificationError, setQualificationError] = useState<ErrorResponseBody | null>(null);
  const [qualificationLoading, setQualificationLoading] = useState(true);
  const [busyChecks, setBusyChecks] = useState<Partial<Record<CheckType, boolean>>>({});
  const [actionErrors, setActionErrors] = useState<Partial<Record<CheckType, ErrorResponseBody>>>({});
  const [now, setNow] = useState(() => Date.now());
  const runningIdsRef = useRef<string>("");

  const fetchQualification = useCallback(async () => {
    setQualificationLoading(true);
    const result = await getJson<QualificationSummary>(
      `/api/applications/${applicationId}/qualification`,
    );
    if (result.ok) {
      setQualification(result.data);
      setQualificationError(null);
    } else {
      setQualificationError(result.error);
    }
    setQualificationLoading(false);
  }, [applicationId]);

  const fetchChecks = useCallback(async () => {
    const result = await getJson<UnderwritingResultList>(`/api/applications/${applicationId}/checks`);
    if (!result.ok) {
      setListError(result.error);
      return;
    }
    setListError(null);
    setRows(result.data.rows);

    // When a previously-running check settles, refresh the qualification card
    // (score / PITI / AUS recommendation / escalation all follow check results).
    const runningIds = result.data.rows
      .filter((r) => r.status === "running")
      .map((r) => r.id)
      .sort()
      .join(",");
    if (runningIdsRef.current !== runningIds) {
      const settled = runningIdsRef.current !== "" && runningIds.length < runningIdsRef.current.length;
      runningIdsRef.current = runningIds;
      if (settled) void fetchQualification();
    }
  }, [applicationId, fetchQualification]);

  useEffect(() => {
    void fetchChecks();
    void fetchQualification();
  }, [fetchChecks, fetchQualification]);

  const anyRunning = (rows ?? []).some((r) => r.status === "running");

  // Poll while any check is running (modest interval, stops when settled).
  useEffect(() => {
    if (!anyRunning) return;
    const interval = setInterval(() => {
      setNow(Date.now());
      void fetchChecks();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [anyRunning, fetchChecks]);

  const runCheck = useCallback(
    async (checkType: CheckType) => {
      setBusyChecks((prev) => ({ ...prev, [checkType]: true }));
      setActionErrors((prev) => ({ ...prev, [checkType]: undefined }));
      const result = await postWithCsrf<UnderwritingResultInfo>(
        `/api/applications/${applicationId}/checks/${checkType}`,
      );
      if (!result.ok) {
        // 403 / 404 / 409 bodies rendered VERBATIM (NFR-025).
        setActionErrors((prev) => ({ ...prev, [checkType]: result.error }));
      } else {
        await fetchChecks();
      }
      setBusyChecks((prev) => ({ ...prev, [checkType]: false }));
    },
    [applicationId, fetchChecks],
  );

  // Current result per check type = the newest non-superseded row (the server
  // guarantees exactly one per type); history = superseded rows, newest first.
  const currentByType = new Map<CheckType, UnderwritingResultInfo>();
  const historyByType = new Map<CheckType, UnderwritingResultInfo[]>();
  for (const row of rows ?? []) {
    if (row.supersededById === undefined) {
      const existing = currentByType.get(row.checkType);
      if (!existing || Date.parse(row.requestedAt) > Date.parse(existing.requestedAt)) {
        currentByType.set(row.checkType, row);
      }
    } else {
      const list = historyByType.get(row.checkType) ?? [];
      list.push(row);
      historyByType.set(row.checkType, list);
    }
  }

  if (rows === null && listError === null) {
    return (
      <div data-testid="underwriting-panel" className="space-y-4">
        <SkeletonBlock className="h-28 w-full" />
        <SkeletonBlock className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div data-testid="underwriting-panel" className="space-y-4">
      <QualificationCard
        summary={qualification}
        loading={qualificationLoading}
        error={qualificationError}
        onRetry={() => void fetchQualification()}
      />

      {listError ? (
        <div>
          <ApiErrorBanner
            message={listError.message}
            details={listError.details}
            testId="underwriting-panel-error"
          />
          <button
            type="button"
            data-testid="underwriting-panel-reload"
            onClick={() => void fetchChecks()}
            className={btnOutline}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            {(["credit", "income", "avm", "pricing"] as const).map((checkType) => (
              <CheckSection
                key={checkType}
                checkType={checkType}
                current={currentByType.get(checkType) ?? null}
                history={historyByType.get(checkType) ?? []}
                subject={subject}
                canRunChecks={canRunChecks}
                busy={busyChecks[checkType] === true}
                actionError={actionErrors[checkType] ?? null}
                onRun={(t) => void runCheck(t)}
                now={now}
              />
            ))}
          </div>
          <CheckSection
            checkType="aus"
            current={currentByType.get("aus") ?? null}
            history={historyByType.get("aus") ?? []}
            subject={subject}
            canRunChecks={canRunChecks}
            busy={busyChecks.aus === true}
            actionError={actionErrors.aus ?? null}
            onRun={(t) => void runCheck(t)}
            now={now}
          />
        </>
      )}
    </div>
  );
}

export { CHECK_TYPES };
export type { CheckType, SubjectMapPoint, UnderwritingResultInfo, QualificationSummary };
