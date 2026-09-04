"use client";

// Shared version list + two-version field-level diff (REQ-052, §4.4.6).
//
// Extracted VERBATIM from ApplicationViewClient (task-017) in task-030 so the
// staff Versions tab (NotesAndVersionsPanel) renders the SAME list and diff
// the owning Borrower sees — one differ, one renderer, zero drift. The diff
// itself is computed server-side (GET /api/applications/:id/versions/diff,
// masked snapshots) — this component only renders SectionDiff/FieldChange rows
// grouped by URLA section.
//
// Selector contract (BorrowerDashboard/BorrowerApplicationView §C, reused on
// the staff tab): versions-list, version-row-{n}, diff-view.

import { useMemo, useState } from "react";
import { getJson } from "./api";
import { formatDate } from "./format";
import type { VersionDiffResponse, VersionPage } from "./types";
import { sectionLabel } from "./types";
import { ApiErrorBanner, btnOutline, Card, CardHeading } from "./ui";

export function VersionsCard({ applicationId, versions }: { applicationId: string; versions: VersionPage | null }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [diff, setDiff] = useState<VersionDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<{ message: string; details?: string[] } | null>(null);
  const [comparing, setComparing] = useState(false);

  const rows = useMemo(
    () => (versions ? [...versions.rows].sort((a, b) => b.versionNumber - a.versionNumber) : []),
    [versions],
  );

  function toggle(versionNumber: number) {
    setSelected((current) =>
      current.includes(versionNumber)
        ? current.filter((n) => n !== versionNumber)
        : [...current, versionNumber].slice(-2),
    );
  }

  async function onCompare() {
    if (selected.length !== 2) return;
    const [from, to] = [...selected].sort((a, b) => a - b);
    setComparing(true);
    setDiffError(null);
    const result = await getJson<VersionDiffResponse>(
      `/api/applications/${applicationId}/versions/diff?from=${from}&to=${to}`,
    );
    setComparing(false);
    if (!result.ok) {
      setDiff(null);
      setDiffError({ message: result.error.message, details: result.error.details });
      return;
    }
    setDiff(result.data);
  }

  const reasonLabel = (reason: string) =>
    reason === "initial-submission" ? "Initial submission" : "Resubmission after revision request";

  return (
    <Card testId="versions-card">
      <CardHeading>Versions</CardHeading>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-soft">
          Versions are created when the application is submitted.
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table data-testid="versions-list" className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="w-10 px-2 py-2">
                    <span className="sr-only">Select</span>
                  </th>
                  {["Version", "Created", "Reason"].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((version) => (
                  <tr
                    key={version.id}
                    data-testid={`version-row-${version.versionNumber}`}
                    className="border-b border-line last:border-b-0"
                  >
                    <td className="px-2 py-2.5">
                      <input
                        type="checkbox"
                        data-testid={`version-select-${version.versionNumber}`}
                        aria-label={`Select version ${version.versionNumber}`}
                        checked={selected.includes(version.versionNumber)}
                        onChange={() => toggle(version.versionNumber)}
                        className="h-4 w-4 accent-navy"
                      />
                    </td>
                    <td className="px-2 py-2.5 font-semibold text-ink">
                      {version.versionNumber}
                      {version.isCurrent ? <span className="text-muted"> (current)</span> : null}
                    </td>
                    <td className="px-2 py-2.5 text-ink-soft">{formatDate(version.createdAt)}</td>
                    <td className="px-2 py-2.5 text-ink-soft">{reasonLabel(version.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <button
              type="button"
              data-testid="version-compare-btn"
              onClick={() => void onCompare()}
              disabled={selected.length !== 2 || comparing}
              className={btnOutline}
            >
              {comparing ? "Comparing…" : "Compare selected versions"}
            </button>
          </div>
          {diffError ? (
            <div className="mt-3">
              <ApiErrorBanner message={diffError.message} details={diffError.details} testId="diff-error" />
            </div>
          ) : null}
          {diff ? (
            <div data-testid="diff-view" className="mt-4 rounded-md border border-line bg-paper p-4">
              <p className="text-sm font-semibold text-ink">
                Changes from version {diff.fromVersion} to version {diff.toVersion}
              </p>
              {diff.sections.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">No differences between these versions.</p>
              ) : (
                diff.sections.map((section) => (
                  <div key={section.section} className="mt-3" data-testid={`diff-section-${section.section}`}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                      {sectionLabel(section.section)}
                    </p>
                    <ul className="mt-1 space-y-1">
                      {section.changes.map((change) => (
                        <li
                          key={`${change.fieldPath}-${change.changeType}`}
                          className="rounded border border-line bg-card px-3 py-1.5 text-xs text-ink"
                        >
                          <span className="font-mono">{change.fieldPath}</span>{" "}
                          <span className="font-semibold text-copper">({change.changeType})</span>
                          {change.changeType !== "added" && change.before !== undefined ? (
                            <span className="text-danger"> {change.before}</span>
                          ) : null}
                          {change.changeType !== "removed" ? (
                            <span className="text-success"> → {change.after ?? ""}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
