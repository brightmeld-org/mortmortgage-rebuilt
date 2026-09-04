"use client";

// SystemStatusView (contracts §C SystemStatusPage, task-045, NFR-027 / INT-001)
// — the /supervisor/system observability surface.
//
// Reached from: (app) shell supervisor nav → "System Status" (task-044 wires
// the link) → /supervisor/system (src/app/(app)/supervisor/system/page.tsx).
//
// Selector contract (build-plan §C SystemStatusPage): `sysstatus-jobs-{metric}`,
// `sysstatus-integration-{name}`, `sysstatus-demo-indicator` — extended within
// the namespace only: `sysstatus-refresh-btn`, `sysstatus-error`.
//
// LIVE DATA: everything renders from GET /api/admin/system-status (real
// DocumentJob / notification-delivery / decision-dispatch rows + live env
// state). Status is conveyed by TEXT as well as color (WCAG — §7.4), the
// metrics region is a described list, and refresh is a keyboard-reachable
// button with a polite live region.
//
// Design language: increment-6 supervisor pattern (Card + Badge + StatCard —
// same as OutboundMessagesView / DemoDataView).

import { useCallback, useEffect, useState } from "react";
import { getJson, type ErrorResponseBody } from "@/components/borrower/api";
import { ApiErrorBanner, Badge, Card, CardHeading, SkeletonBlock, btnOutline } from "@/components/borrower/ui";

// contracts.json models — exact field names.
interface JobMetrics {
  queued: number;
  processing: number;
  failed: number;
}
interface IntegrationMode {
  integration: string;
  mode: "simulated" | "real";
}
interface SystemStatusResponse {
  jobs: JobMetrics;
  integrationModes: IntegrationMode[];
  demoMode: boolean;
}

const JOB_METRIC_LABELS: ReadonlyArray<{ key: keyof JobMetrics; label: string; description: string }> = [
  { key: "queued", label: "Queued", description: "Waiting to run — OCR jobs, pending notification deliveries, pending decision dispatches" },
  { key: "processing", label: "Processing", description: "Currently executing" },
  { key: "failed", label: "Failed", description: "Failed — automatic retry when scheduled, manual retry available" },
];

function integrationLabel(name: string): string {
  return name
    .split("-")
    .map((part) => (part === "avm" || part === "aus" || part === "ocr" || part === "sms" ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace("Email SMS", "Email / SMS");
}

export function SystemStatusView() {
  const [data, setData] = useState<SystemStatusResponse | null>(null);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await getJson<SystemStatusResponse>("/api/admin/system-status");
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setData(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">System Status</h1>
          <p className="mt-1 text-sm text-muted">
            Background job metrics, integration modes, and the demonstration-mode state of this
            environment.
          </p>
        </div>
        <button
          type="button"
          data-testid="sysstatus-refresh-btn"
          className={btnOutline}
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error ? <ApiErrorBanner message={error.message} details={error.details} testId="sysstatus-error" /> : null}

      <div aria-live="polite">
        <Card>
          <CardHeading>Background jobs</CardHeading>
          {data === null && error === null ? (
            <SkeletonBlock className="h-24" />
          ) : data !== null ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {JOB_METRIC_LABELS.map(({ key, label, description }) => (
                <div
                  key={key}
                  data-testid={`sysstatus-jobs-${key}`}
                  className="rounded-lg border border-line bg-surface p-4"
                >
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
                  <dd className="mt-1 font-display text-3xl font-bold text-ink">
                    {data.jobs[key].toLocaleString("en-US")}
                  </dd>
                  <dd className="mt-1 text-xs text-muted">{description}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </Card>

        <div className="mt-4">
          <Card>
            <CardHeading>Integrations</CardHeading>
            {data === null && error === null ? (
              <SkeletonBlock className="h-40" />
            ) : data !== null ? (
              <ul className="divide-y divide-line">
                {data.integrationModes.map(({ integration, mode }) => (
                  <li
                    key={integration}
                    data-testid={`sysstatus-integration-${integration}`}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <span className="text-sm text-ink">{integrationLabel(integration)}</span>
                    {/* Status by text as well as color (§7.4). */}
                    <Badge tone={mode === "real" ? "success" : "info"}>
                      {mode === "real" ? "Real provider" : "Simulated"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>

        {data !== null ? (
          <div className="mt-4">
            <Card testId="sysstatus-demo-indicator">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardHeading>Demonstration mode</CardHeading>
                  <p className="text-sm text-ink-soft">
                    {data.demoMode
                      ? "DEMO_MODE is ON — demo quick logins, demonstration attestation, and demo seeding are enabled. Must be off in production."
                      : "DEMO_MODE is OFF — production posture; demo-only surfaces are absent."}
                  </p>
                </div>
                <Badge tone={data.demoMode ? "warn" : "success"}>
                  {data.demoMode ? "Demo mode on" : "Demo mode off"}
                </Badge>
              </div>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
