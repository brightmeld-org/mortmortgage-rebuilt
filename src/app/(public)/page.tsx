// Public landing page — full frame layout (task-018, REQ-046). Frame authority:
// frame/screen-landing.png + frame/gui-spec.md "landing" (hero + CTAs, tools
// row, how-it-works strip; header/footer come from the (public) layout).
//
// Reached from: "/" (root). Header: pre-qualify ↔ compare ↔ sign-in ↔ sign-up.
export default function LandingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      {/* ---- Hero ---- */}
      <section className="max-w-2xl">
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">
          A mortgage application you can actually finish.
        </h1>
        <p className="mt-5 max-w-xl text-base text-ink-soft">
          Save as you go, upload documents once, and track your application from
          submission to decision.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="/pre-qualify"
            data-testid="landing-prequalify-cta"
            className="rounded-md bg-copper px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy"
          >
            Check what you can afford
          </a>
          <a
            href="/sign-up"
            data-testid="landing-signup-cta"
            className="rounded-md border border-line bg-card px-5 py-2.5 text-sm font-semibold text-ink transition-colors duration-200 hover:border-navy hover:text-navy"
          >
            Start an application
          </a>
        </div>
      </section>

      {/* ---- Tools row ---- */}
      <section aria-label="Tools" className="mt-12 grid gap-5 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-card p-6 shadow-sm">
          <h2 className="font-display text-xl font-semibold text-ink">Pre-Qualification Calculator</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Estimate your maximum loan, monthly payment, and purchase price — no
            sign-in needed.
          </p>
          <a
            href="/pre-qualify"
            data-testid="landing-tool-prequalify"
            className="mt-4 inline-block text-sm font-semibold text-copper transition-colors duration-200 hover:text-navy"
          >
            Open calculator &rarr;
          </a>
        </div>
        <div className="rounded-lg border border-line bg-card p-6 shadow-sm">
          <h2 className="font-display text-xl font-semibold text-ink">Loan Comparison</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Compare 15 vs 30 year, down payments, and loan programs side by side.
          </p>
          <a
            href="/compare"
            data-testid="landing-tool-compare"
            className="mt-4 inline-block text-sm font-semibold text-copper transition-colors duration-200 hover:text-navy"
          >
            Compare scenarios &rarr;
          </a>
        </div>
      </section>

      {/* ---- How-it-works strip ---- */}
      <section aria-label="How it works" data-testid="landing-how-it-works" className="mt-6 grid gap-5 md:grid-cols-3">
        <div className="rounded-lg border border-line bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-ink">1 &middot; Apply online</h3>
          <p className="mt-1.5 text-xs text-ink-soft">
            Complete the URLA 1003 in 10 guided steps, with auto-save.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-ink">2 &middot; We review</h3>
          <p className="mt-1.5 text-xs text-ink-soft">
            A dedicated caseworker verifies your file and runs underwriting.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-ink">3 &middot; Get a decision</h3>
          <p className="mt-1.5 text-xs text-ink-soft">
            Track status live; decisions typically within 30 days.
          </p>
        </div>
      </section>
    </div>
  );
}
