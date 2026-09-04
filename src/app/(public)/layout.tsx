// Public-page chrome (task-009) — shared by the landing page and the whole
// AuthPages suite. Frame authority: frame/gui-spec.md "Public header: logo,
// Pre-Qualify, Compare, Sign In, Create Account" + frame/screen-landing.png /
// screen-signin.png (white header bar, paper ground, footer legal line).
//
// The /pre-qualify and /compare tools are task-018 (later increment): the frame
// shows their links on every public screen, so they render now and resolve when
// that task lands. Plain anchors keep typedRoutes satisfied until then.
import { PublicHeaderActions } from "./PublicHeaderActions";

export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to main content
      </a>
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <a href="/" data-testid="public-logo-link" className="font-display text-xl font-bold tracking-tight">
              <span className="text-navy-deep">Mort</span>
              <span className="text-copper">Mortgage</span>
            </a>
            <nav aria-label="Public" className="hidden items-center gap-4 sm:flex">
              <a
                href="/pre-qualify"
                data-testid="public-nav-prequalify"
                className="text-sm font-medium text-ink-soft transition-colors duration-200 hover:text-copper"
              >
                Pre-Qualify
              </a>
              <a
                href="/compare"
                data-testid="public-nav-compare"
                className="text-sm font-medium text-ink-soft transition-colors duration-200 hover:text-copper"
              >
                Compare Loans
              </a>
            </nav>
          </div>
          <PublicHeaderActions />
        </div>
      </header>
      <main id="main-content" className="flex-1">{children}</main>
      <footer className="border-t border-line py-6">
        <p className="mx-auto max-w-6xl px-4 text-xs text-muted sm:px-6">
          MortMortgage — Mortgage Application Management System. Equal Housing Opportunity.
        </p>
      </footer>
    </div>
  );
}
