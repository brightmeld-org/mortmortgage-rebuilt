"use client";

// Client half of the ConfigurationPage (task-004, REQ-065).
//
// Lists every §4.6.11 setting grouped by area with an edit control matched to
// the declared type, and saves one setting at a time via
// PUT /api/admin/config with the session-bound CSRF token from
// GET /api/auth/session (SessionInfo.csrfToken). Inline validation errors come
// verbatim from the API's ErrorResponse.details; a successful save swaps in the
// server's returned SystemConfigResponse (live values, updatedBy/updatedAt).
//
// Selector contract (build-plan §C): `config-{key}`, `config-save-{key}` —
// dotted key segments become dashes (kebab-case testids).

import { useCallback, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Wire + metadata types (mirrors of the server shapes; no server imports here)
// ---------------------------------------------------------------------------

/** contracts §A ConfigSetting. */
export interface ConfigSettingWireClient {
  key: string;
  value: string;
  description?: string;
  updatedByName?: string;
  updatedAt?: string;
}

/** Client-safe slice of the server registry entry (built by the server page). */
export interface ConfigSettingMeta {
  key: string;
  label: string;
  group: string;
  description: string;
  type: "number" | "percent" | "boolean" | "string" | "enum-list";
  /** JSON-encoded §4.6.11 default, for the "Default: …" hint. */
  defaultEncoded: string;
  min?: number;
  max?: number;
  integer: boolean;
  allowedValues?: string[];
  allowBlank: boolean;
  patternHint?: string;
}

interface Props {
  initialSettings: ConfigSettingWireClient[];
  meta: ConfigSettingMeta[];
}

/** Editable control state per key: strings for text/number inputs, native types otherwise. */
type EditValue = string | boolean | string[];

interface SaveState {
  saving: boolean;
  errors?: string[];
  saved?: boolean;
}

const testId = (key: string) => key.replace(/\./g, "-");

function decode(encoded: string): unknown {
  try {
    return JSON.parse(encoded);
  } catch {
    return undefined;
  }
}

/** Initial control value from the wire value (falls back to a blank control). */
function toEditValue(meta: ConfigSettingMeta, encoded: string): EditValue {
  const value = decode(encoded);
  switch (meta.type) {
    case "boolean":
      return typeof value === "boolean" ? value : false;
    case "enum-list":
      return Array.isArray(value) ? value.map(String) : [];
    case "number":
    case "percent":
      return typeof value === "number" ? String(value) : "";
    case "string":
      return typeof value === "string" ? value : "";
  }
}

/** JSON-encode the control value for ConfigUpdateRequest.value. */
function encodeEditValue(meta: ConfigSettingMeta, edit: EditValue): string {
  switch (meta.type) {
    case "boolean":
      return JSON.stringify(edit === true);
    case "enum-list":
      return JSON.stringify(Array.isArray(edit) ? edit : []);
    case "number":
    case "percent": {
      const raw = typeof edit === "string" ? edit.trim() : "";
      if (raw === "") return "null"; // server reports the typed error inline
      const n = Number(raw);
      return Number.isFinite(n) ? JSON.stringify(n) : "null";
    }
    case "string":
      return JSON.stringify(typeof edit === "string" ? edit : "");
  }
}

/** Human display of a JSON-encoded value ("on"/"off", comma list, plain scalar). */
function displayValue(meta: ConfigSettingMeta, encoded: string): string {
  const value = decode(encoded);
  if (meta.type === "boolean") return value === true ? "On" : "Off";
  if (meta.type === "enum-list") return Array.isArray(value) && value.length > 0 ? value.join(", ") : "none";
  if (typeof value === "string") return value === "" ? "(blank)" : value;
  return String(value);
}

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ConfigSettingsPanel({ initialSettings, meta }: Props) {
  const [settings, setSettings] = useState<ConfigSettingWireClient[]>(initialSettings);
  const [edits, setEdits] = useState<Record<string, EditValue>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const settingsByKey = useMemo(
    () => new Map(settings.map((s) => [s.key, s])),
    [settings],
  );

  // The CSRF token is served only by GET /api/auth/session (SessionInfo.csrfToken).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/session");
        if (!res.ok) {
          if (!cancelled) setSessionError("Your session could not be verified — sign in as a Supervisor to edit settings.");
          return;
        }
        const body = (await res.json()) as { csrfToken?: string };
        if (!cancelled) setCsrfToken(body.csrfToken ?? null);
      } catch {
        if (!cancelled) setSessionError("Your session could not be verified — sign in as a Supervisor to edit settings.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    const ordered: { name: string; entries: ConfigSettingMeta[] }[] = [];
    for (const entry of meta) {
      let group = ordered.find((g) => g.name === entry.group);
      if (!group) {
        group = { name: entry.group, entries: [] };
        ordered.push(group);
      }
      group.entries.push(entry);
    }
    return ordered;
  }, [meta]);

  const currentEdit = useCallback(
    (entry: ConfigSettingMeta): EditValue => {
      if (entry.key in edits) return edits[entry.key]!;
      const setting = settingsByKey.get(entry.key);
      return toEditValue(entry, setting?.value ?? entry.defaultEncoded);
    },
    [edits, settingsByKey],
  );

  const setEdit = useCallback((key: string, value: EditValue) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
    setSaveStates((prev) => ({ ...prev, [key]: { saving: false } }));
  }, []);

  const save = useCallback(
    async (entry: ConfigSettingMeta) => {
      const encoded = encodeEditValue(entry, currentEdit(entry));
      setSaveStates((prev) => ({ ...prev, [entry.key]: { saving: true } }));
      try {
        const res = await fetch("/api/admin/config", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
          },
          body: JSON.stringify({ key: entry.key, value: encoded }),
        });
        if (res.ok) {
          const body = (await res.json()) as { settings: ConfigSettingWireClient[] };
          setSettings(body.settings);
          setEdits((prev) => {
            const next = { ...prev };
            delete next[entry.key];
            return next;
          });
          setSaveStates((prev) => ({ ...prev, [entry.key]: { saving: false, saved: true } }));
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | { message?: string; details?: string[] }
          | null;
        const errors =
          body?.details && body.details.length > 0
            ? body.details
            : [body?.message ?? `Save failed (HTTP ${res.status})`];
        setSaveStates((prev) => ({ ...prev, [entry.key]: { saving: false, errors } }));
      } catch {
        setSaveStates((prev) => ({
          ...prev,
          [entry.key]: { saving: false, errors: ["Network error — the setting was not saved."] },
        }));
      }
    },
    [csrfToken, currentEdit],
  );

  return (
    <div className="space-y-6">
      {sessionError && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          data-testid="config-session-warning"
        >
          {sessionError}
        </div>
      )}

      {groups.map((group) => (
        <section
          key={group.name}
          className="rounded-lg border border-slate-200 bg-white shadow-sm"
        >
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">
            {group.name}
          </h2>
          <ul className="divide-y divide-slate-100">
            {group.entries.map((entry) => {
              const setting = settingsByKey.get(entry.key);
              const state = saveStates[entry.key] ?? { saving: false };
              const kebab = testId(entry.key);
              return (
                <li key={entry.key} className="px-5 py-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="md:max-w-md">
                      <label
                        htmlFor={`config-input-${kebab}`}
                        className="block text-sm font-medium text-ink"
                      >
                        {entry.label}
                      </label>
                      <p className="mt-1 text-xs text-muted">{entry.description}</p>
                      <p className="mt-1 text-xs text-muted">
                        Default: {displayValue(entry, entry.defaultEncoded)}
                        {setting?.updatedByName && setting.updatedAt && (
                          <>
                            {" · "}Last changed by {setting.updatedByName} on{" "}
                            {formatUpdatedAt(setting.updatedAt)}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-start gap-2">
                      <SettingControl
                        entry={entry}
                        kebab={kebab}
                        value={currentEdit(entry)}
                        onChange={(v) => setEdit(entry.key, v)}
                      />
                      <button
                        type="button"
                        data-testid={`config-save-${kebab}`}
                        onClick={() => save(entry)}
                        // Also disabled until the CSRF token from GET /api/auth/session
                        // has arrived: PUT /api/admin/config is CSRF-guarded, so a save
                        // pressed before then issues a request that is certain to be
                        // rejected and shows the operator "Missing or invalid CSRF token"
                        // for an edit that was perfectly valid.
                        disabled={state.saving || csrfToken === null}
                        className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-50"
                      >
                        {state.saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                  {/* NFR-025: save outcomes are announced to assistive
                      technology — a failed save is assertive, a successful one
                      polite. */}
                  {state.errors && (
                    <ul
                      role="alert"
                      className="mt-2 space-y-0.5 text-xs text-red-600"
                      data-testid={`config-error-${kebab}`}
                    >
                      {state.errors.map((err) => (
                        <li key={err}>{err}</li>
                      ))}
                    </ul>
                  )}
                  {state.saved && (
                    <p
                      role="status"
                      aria-live="polite"
                      className="mt-2 text-xs text-green-700"
                      data-testid={`config-saved-${kebab}`}
                    >
                      Saved.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-type edit control
// ---------------------------------------------------------------------------

function SettingControl({
  entry,
  kebab,
  value,
  onChange,
}: {
  entry: ConfigSettingMeta;
  kebab: string;
  value: EditValue;
  onChange: (value: EditValue) => void;
}) {
  const inputClass =
    "w-40 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-ink focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  switch (entry.type) {
    case "number":
    case "percent":
      return (
        <input
          id={`config-input-${kebab}`}
          data-testid={`config-${kebab}`}
          type="number"
          inputMode={entry.integer ? "numeric" : "decimal"}
          step={entry.integer ? 1 : "any"}
          min={entry.min}
          max={entry.max}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      );
    case "boolean":
      return (
        <label className="flex items-center gap-2 py-1.5 text-sm text-ink-soft">
          <input
            id={`config-input-${kebab}`}
            data-testid={`config-${kebab}`}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-500"
          />
          {value === true ? "On" : "Off"}
        </label>
      );
    case "enum-list": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset id={`config-input-${kebab}`} data-testid={`config-${kebab}`} className="flex flex-wrap gap-3 py-1.5">
          <legend className="sr-only">{entry.label}</legend>
          {(entry.allowedValues ?? []).map((member) => (
            <label key={member} className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input
                type="checkbox"
                data-testid={`config-${kebab}-${member}`}
                checked={selected.includes(member)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, member]
                      : selected.filter((m) => m !== member),
                  )
                }
                className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-500"
              />
              {member.toUpperCase()}
            </label>
          ))}
        </fieldset>
      );
    }
    case "string":
      return (
        <input
          id={`config-input-${kebab}`}
          data-testid={`config-${kebab}`}
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={entry.allowBlank ? "(blank)" : undefined}
          title={entry.patternHint}
          className={inputClass}
        />
      );
  }
}
