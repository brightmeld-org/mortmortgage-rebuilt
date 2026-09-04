// Authenticated app shell (task-017, completed by task-044 AppShell) —
// frame/gui-spec.md global layout model: persistent TOP-NAV header (no side
// nav), role-appropriate links, user menu, responsive ≥360px.
//
// Session: resolved server-side from request cookies (same source as the API
// guard). Unauthenticated hits redirect to /sign-in — the edge middleware
// already covers cookie-LESS requests with a return path; this layout covers
// present-but-dead cookies (it cannot know the requested path, so no
// redirectTo here).
//
// Task-044 additions: skip-to-content link (WCAG 2.4.1), session idle warning
// dialog (contracts §C AppShell — 2 min before idle expiry), DEMO_MODE flag
// derived server-side (only the boolean crosses to the client — same pattern
// as the sign-in page) gating the supervisor Demo Data nav link.

import type { Route } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/borrower/AppHeader";
import { SessionIdleWarning } from "@/components/borrower/SessionIdleWarning";
import { resolveAppSession } from "@/components/borrower/server-session";

export const dynamic = "force-dynamic";

export default async function AppShellLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await resolveAppSession();
  if (!user) redirect("/sign-in" as Route);

  const demoMode = process.env.DEMO_MODE === "true";

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to main content
      </a>
      <AppHeader
        session={{
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
        }}
        demoMode={demoMode}
      />
      <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
      <SessionIdleWarning />
    </div>
  );
}
