// ConfigurationPage (contracts §C, task-004, REQ-065) — /supervisor/settings.
//
// Reached from: (app) shell nav → Supervisor → Settings (the full role-aware nav
// lands with task-044's AppShell; a skeleton nav link exists in the (app) layout
// now). Route directly addressable at /supervisor/settings.
//
// Server component: resolves the session from the request cookies and fetches
// every §4.6.11 setting via the config service (live SystemConfig rows). Edits
// happen in the client panel via PUT /api/admin/config (guarded, CSRF, audited).
// Sign-in pages land in increment 2 — until then unauthenticated visitors are
// redirected to /sign-in (the guard-equivalent page behavior; the API itself
// returns 401/403 via the shared guard).

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { requireAppSession } from "@/components/borrower/server-session";
import { ROLE_HOME } from "@/lib/role-home";
import { CONFIG_REGISTRY, listSettings } from "@/lib/services/config";
import { ConfigSettingsPanel, type ConfigSettingMeta } from "@/components/config/ConfigSettingsPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings — MortMortgage" };

export default async function SupervisorSettingsPage() {
  // Page-level role gate (task-044 consistency pass): shared session helper —
  // unauthenticated → /sign-in with return path; wrong role → own role home
  // (was a pre-shell "/" redirect straggler).
  const user = await requireAppSession("/supervisor/settings");
  if (user.role !== "SUPERVISOR") redirect(ROLE_HOME[user.role] as Route);

  const settings = await listSettings();

  // Client-safe registry metadata (no RegExp crosses the boundary).
  const meta: ConfigSettingMeta[] = CONFIG_REGISTRY.map((entry) => ({
    key: entry.key,
    label: entry.label,
    group: entry.group,
    description: entry.description,
    type: entry.type,
    defaultEncoded: JSON.stringify(entry.defaultValue),
    min: entry.min,
    max: entry.max,
    integer: entry.integer !== false,
    allowedValues: entry.allowedValues ? [...entry.allowedValues] : undefined,
    allowBlank: entry.allowBlank ?? false,
    patternHint: entry.patternHint,
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold text-ink">System Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Thresholds, SLAs, and policies (requirements §4.6.11). Every change is audited with
          before/after values.
        </p>
      </header>
      <ConfigSettingsPanel initialSettings={settings} meta={meta} />
    </div>
  );
}
