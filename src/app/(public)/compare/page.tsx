// /compare — public loan comparison tool (task-018, REQ-044). Frame authority:
// frame/screen-compare.png + frame/gui-spec.md "compare" (preset chip bar,
// 3+ scenario columns with horizontal scroll on mobile, best-value highlight,
// CTA below).
//
// Reached from: public header "Compare Loans" link (every public page) and the
// landing page tools-row "Loan Comparison" card.
import type { Metadata } from "next";
import { CompareClient } from "./CompareClient";

export const metadata: Metadata = {
  title: "Loan Comparison — MortMortgage",
};

export default function ComparePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Loan Comparison
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        Compare at least three scenarios side by side. Best value highlighted.
      </p>
      <CompareClient />
    </div>
  );
}
