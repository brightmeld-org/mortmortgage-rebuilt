// /pre-qualify — public pre-qualification calculator (task-018, REQ-043,
// FLOW-001 entry screen). Frame authority: frame/screen-prequalify.png +
// frame/gui-spec.md "pre-qualify" (two-column: input form left, live results
// right, CTA below results).
//
// Reached from: public header "Pre-Qualify" link (every public page) and the
// landing page's "Check what you can afford" hero CTA + tools-row card.
import type { Metadata } from "next";
import { PreQualifyClient } from "./PreQualifyClient";

export const metadata: Metadata = {
  title: "Pre-Qualification Calculator — MortMortgage",
};

export default function PreQualifyPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Pre-Qualification Calculator
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        Anonymous — nothing is stored. Results recalculate as you type.
      </p>
      <PreQualifyClient />
    </div>
  );
}
