"use client";

// AVM (property valuation) result body — §4.6.5 row 3 (task-026, INT-011,
// ASM-008). Estimated value, value range, confidence, market trend,
// recomputed LTV, the keyless map (subject + comparable markers with popups)
// and the comparables table. Per the frame, the comparables table is ALWAYS
// rendered below the map — when tiles are unreachable the map area itself
// swaps to the placeholder (see AvmMap) and the table remains the fallback.

import { formatCurrency, formatDate, humanizeEnum } from "@/components/borrower/format";
import { AvmMap } from "./AvmMap";
import { formatPct } from "./check-bodies";
import { MetricRow, MiniTable, SubHeading, Td } from "./ui";
import type { AvmCheckResult, SubjectMapPoint } from "./types";

const TREND_ARROWS: Record<string, string> = { rising: "↑", stable: "→", declining: "↓" };

export function AvmBody({
  result,
  subject,
}: {
  result: AvmCheckResult;
  /** Geocoded subject property (from the parent page's application data). */
  subject: SubjectMapPoint | null;
}) {
  const comparables = result.comparables ?? [];
  const mappableComparables = comparables.filter(
    (c) => typeof c.latitude === "number" && typeof c.longitude === "number",
  );

  return (
    <div>
      <MetricRow label="Estimated value">{formatCurrency(result.estimatedValue)}</MetricRow>
      <MetricRow label="Value range (low – high)">
        {result.valueLow !== undefined || result.valueHigh !== undefined
          ? `${formatCurrency(result.valueLow)} – ${formatCurrency(result.valueHigh)}`
          : "—"}
      </MetricRow>
      <MetricRow label="Confidence score">{result.confidenceScore ?? "—"}</MetricRow>
      <MetricRow label="Market trend (12-month change)">
        {result.marketTrend ? (
          <>
            {TREND_ARROWS[result.marketTrend] ?? ""} {humanizeEnum(result.marketTrend)}
            {typeof result.trendPct12mo === "number"
              ? ` ${result.trendPct12mo > 0 ? "+" : ""}${formatPct(result.trendPct12mo)}`
              : ""}
          </>
        ) : (
          "—"
        )}
      </MetricRow>
      <MetricRow label="Recomputed LTV using AVM value">{formatPct(result.recomputedLtv)}</MetricRow>

      <SubHeading>Location map</SubHeading>
      <div className="mt-1">
        {subject && mappableComparables.length > 0 ? (
          <AvmMap
            subject={subject}
            estimatedValue={result.estimatedValue}
            comparables={comparables}
          />
        ) : (
          <div
            data-testid="avm-map-fallback"
            className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-line bg-paper/70 px-4 py-10 text-center"
          >
            <span aria-hidden className="font-display text-2xl text-muted">
              ⌖
            </span>
            <p className="text-sm font-semibold text-ink-soft">Map unavailable</p>
            <p className="max-w-md text-sm text-muted">
              {subject
                ? "This valuation returned no mappable comparable sales."
                : "The subject property has no geocoded coordinates."}{" "}
              The comparables table below carries the same information.
            </p>
          </div>
        )}
      </div>

      <SubHeading>Comparable sales</SubHeading>
      {comparables.length > 0 ? (
        <MiniTable
          testId="avm-comparables-table"
          headers={[
            "Address",
            "Sale price",
            "Sale date",
            "Distance (mi)",
            "Beds / baths",
            "Sq ft",
            "$ / sq ft",
          ]}
          caption="Comparable sales"
        >
          {comparables.map((comp, i) => (
            <tr key={`${comp.addressText}-${i}`}>
              <Td>{comp.addressText}</Td>
              <Td right>{formatCurrency(comp.salePrice)}</Td>
              <Td>{formatDate(comp.saleDate)}</Td>
              <Td right>{comp.distanceMiles !== undefined ? comp.distanceMiles.toFixed(2) : "—"}</Td>
              <Td right>
                {comp.beds ?? "—"} / {comp.baths ?? "—"}
              </Td>
              <Td right>{comp.squareFeet?.toLocaleString("en-US") ?? "—"}</Td>
              <Td right>{formatCurrency(comp.pricePerSqFt)}</Td>
            </tr>
          ))}
        </MiniTable>
      ) : (
        <p data-testid="avm-comparables-table" className="text-sm text-muted">
          No comparable sales were returned (partial valuation response).
        </p>
      )}
    </div>
  );
}
