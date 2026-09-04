// Custom 404 (task-018, REQ-046). Frame authority: frame/gui-spec.md
// "not-found — public header; 404 message; link home". Root-level not-found
// sits OUTSIDE the (public) route group, so the frame's public header is
// rendered here directly (same markup as src/app/(public)/layout.tsx minus the
// session-aware actions, which a lost route should not need).
//
// Reached from: any unmatched route (e.g. /no-such-page).
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
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
          <a
            href="/sign-in"
            className="rounded-md border border-line bg-card px-3.5 py-1.5 text-sm font-semibold text-ink transition-colors duration-200 hover:border-navy hover:text-navy"
          >
            Sign In
          </a>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4">
        <div data-testid="not-found-page" className="max-w-md py-20 text-center">
          <p className="font-display text-6xl font-semibold text-copper">404</p>
          <h1 className="mt-4 font-display text-2xl font-semibold text-ink">
            This page doesn&rsquo;t exist.
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            The page you&rsquo;re looking for may have moved, or the address was
            mistyped.
          </p>
          <a
            href="/"
            data-testid="not-found-home-link"
            className="mt-6 inline-block rounded-md bg-copper px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy"
          >
            Back to the home page
          </a>
        </div>
      </main>
      <footer className="border-t border-line py-6">
        <p className="mx-auto max-w-6xl px-4 text-xs text-muted sm:px-6">
          MortMortgage — Mortgage Application Management System. Equal Housing Opportunity.
        </p>
      </footer>
    </div>
  );
}
