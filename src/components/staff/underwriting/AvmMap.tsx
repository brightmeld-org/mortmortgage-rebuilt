"use client";

// Keyless AVM map (task-026, ASM-008 / AC-37 / INT-011).
//
// DOCUMENTED INTERPRETATION: instead of adding a map dependency (no new
// packages), this renders a small static "slippy map": OSM tile x/y indices
// are computed from the geocoded subject latitude/longitude via the standard
// Web-Mercator tile math, a grid of
//   https://tile.openstreetmap.org/{z}/{x}/{y}.png
// <img> tiles is laid out around the subject, and the subject + comparable
// markers are absolutely positioned over it with click-toggled popups.
// The tile endpoint is keyless — no API key appears in any request URL
// (AC-37); attribution is shown per the OSM policy. If ANY tile fails to load
// (offline / tiles unreachable) the whole map swaps to the placeholder
// (`avm-map-fallback`) — the comparables table rendered by AvmSection below
// the map remains the data fallback per §4.6.5.
//
// Zoom is fixed per render: the largest zoom in [12..16] that fits the
// subject AND every comparable inside the viewport (with a margin).
//
// Selector contract: everything here extends the `avm-map` namespace —
// avm-map, avm-map-tile-*, avm-map-marker-subject, avm-map-marker-comp-{i},
// avm-map-popup, avm-map-fallback, avm-map-attribution.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatCurrency, formatDate } from "@/components/borrower/format";
import type { ComparableSale, SubjectMapPoint } from "./types";

const TILE_SIZE = 256;
const TILE_HOST = "https://tile.openstreetmap.org";
const MAP_HEIGHT = 320;
const FIT_MARGIN_PX = 28;

// ---------------------------------------------------------------------------
// Web-Mercator tile math (OSM slippy-map convention)
// ---------------------------------------------------------------------------

/** Fractional tile coordinates for a lat/lng at a zoom level. */
function tileCoords(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const latRad = (latitude * Math.PI) / 180;
  const x = ((longitude + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

interface MapPoint {
  key: string;
  kind: "subject" | "comp";
  compIndex?: number;
  latitude: number;
  longitude: number;
  title: string;
  lines: string[];
}

/** Largest zoom in [12..16] that fits every point inside the viewport. */
function fitZoom(points: MapPoint[], center: SubjectMapPoint, width: number): number {
  for (let zoom = 16; zoom > 12; zoom -= 1) {
    const c = tileCoords(center.latitude, center.longitude, zoom);
    const fits = points.every((p) => {
      const t = tileCoords(p.latitude, p.longitude, zoom);
      const dx = Math.abs(t.x - c.x) * TILE_SIZE;
      const dy = Math.abs(t.y - c.y) * TILE_SIZE;
      return dx <= width / 2 - FIT_MARGIN_PX && dy <= MAP_HEIGHT / 2 - FIT_MARGIN_PX;
    });
    if (fits) return zoom;
  }
  return 12;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AvmMapProps {
  subject: SubjectMapPoint;
  /** AVM estimated value — shown in the subject marker's popup. */
  estimatedValue: number;
  comparables: ComparableSale[];
}

export function AvmMap({ subject, estimatedValue, comparables }: AvmMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [openPopup, setOpenPopup] = useState<string | null>(null);

  useEffect(() => {
    function measure() {
      const w = containerRef.current?.clientWidth;
      if (w && w > 0) setWidth(w);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const onTileError = useCallback(() => setTilesFailed(true), []);

  if (tilesFailed) {
    return (
      <div
        data-testid="avm-map-fallback"
        role="img"
        aria-label="Map unavailable — comparable sales are listed in the table below"
        className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-line bg-paper/70 px-4 text-center"
        style={{ height: MAP_HEIGHT }}
      >
        <span aria-hidden className="font-display text-2xl text-muted">
          ⌖
        </span>
        <p className="text-sm font-semibold text-ink-soft">Map tiles are unreachable</p>
        <p className="max-w-md text-sm text-muted">
          The map could not be loaded. The comparable sales below carry the same information.
        </p>
      </div>
    );
  }

  const points: MapPoint[] = [
    {
      key: "subject",
      kind: "subject",
      latitude: subject.latitude,
      longitude: subject.longitude,
      title: subject.label ?? "Subject property",
      lines: [`AVM estimated value ${formatCurrency(estimatedValue)}`],
    },
    ...comparables.flatMap<MapPoint>((comp, i) =>
      typeof comp.latitude === "number" && typeof comp.longitude === "number"
        ? [
            {
              key: `comp-${i}`,
              kind: "comp",
              compIndex: i,
              latitude: comp.latitude,
              longitude: comp.longitude,
              title: comp.addressText,
              lines: [
                `Sold ${formatCurrency(comp.salePrice)}`,
                `Sale date ${formatDate(comp.saleDate)}`,
                ...(typeof comp.distanceMiles === "number"
                  ? [`${comp.distanceMiles.toFixed(2)} mi from subject`]
                  : []),
              ],
            },
          ]
        : [],
    ),
  ];

  const zoom = fitZoom(points, subject, width);
  const center = tileCoords(subject.latitude, subject.longitude, zoom);
  const centerPx = { x: center.x * TILE_SIZE, y: center.y * TILE_SIZE };
  const originPx = { x: centerPx.x - width / 2, y: centerPx.y - MAP_HEIGHT / 2 };

  const tileCount = 2 ** zoom;
  const firstCol = Math.floor(originPx.x / TILE_SIZE);
  const lastCol = Math.floor((originPx.x + width) / TILE_SIZE);
  const firstRow = Math.floor(originPx.y / TILE_SIZE);
  const lastRow = Math.floor((originPx.y + MAP_HEIGHT) / TILE_SIZE);

  const tiles: { key: string; url: string; left: number; top: number }[] = [];
  for (let col = firstCol; col <= lastCol; col += 1) {
    for (let row = firstRow; row <= lastRow; row += 1) {
      if (row < 0 || row >= tileCount) continue;
      const wrappedCol = ((col % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: `${zoom}/${col}/${row}`,
        url: `${TILE_HOST}/${zoom}/${wrappedCol}/${row}.png`,
        left: col * TILE_SIZE - originPx.x,
        top: row * TILE_SIZE - originPx.y,
      });
    }
  }

  return (
    <div
      ref={containerRef}
      data-testid="avm-map"
      data-zoom={zoom}
      className="relative w-full select-none overflow-hidden rounded-md border border-line bg-gray-soft"
      style={{ height: MAP_HEIGHT }}
    >
      {tiles.map((tile) => (
        // eslint-disable-next-line @next/next/no-img-element -- plain OSM tile
        <img
          key={tile.key}
          src={tile.url}
          alt=""
          width={TILE_SIZE}
          height={TILE_SIZE}
          draggable={false}
          onError={onTileError}
          className="absolute max-w-none"
          style={{ left: tile.left, top: tile.top }}
        />
      ))}

      {points.map((point) => {
        const t = tileCoords(point.latitude, point.longitude, zoom);
        const left = t.x * TILE_SIZE - originPx.x;
        const top = t.y * TILE_SIZE - originPx.y;
        const isSubject = point.kind === "subject";
        const testId = isSubject ? "avm-map-marker-subject" : `avm-map-marker-comp-${point.compIndex}`;
        const open = openPopup === point.key;
        return (
          <div key={point.key} className="absolute" style={{ left, top }}>
            <button
              type="button"
              data-testid={testId}
              aria-label={`${isSubject ? "Subject property" : "Comparable sale"}: ${point.title}`}
              aria-expanded={open}
              onClick={() => setOpenPopup(open ? null : point.key)}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/50 ${
                isSubject ? "h-5 w-5 bg-copper" : "h-3.5 w-3.5 bg-navy"
              }`}
            />
            {open ? (
              <div
                data-testid="avm-map-popup"
                role="dialog"
                aria-label={point.title}
                className="absolute bottom-4 left-0 z-10 w-56 -translate-x-1/2 rounded-md border border-line bg-card p-2.5 text-left shadow-lg"
              >
                <p className="text-sm font-semibold text-ink">{point.title}</p>
                {point.lines.map((line) => (
                  <p key={line} className="mt-0.5 text-xs text-ink-soft">
                    {line}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      <p
        data-testid="avm-map-attribution"
        className="absolute bottom-0 right-0 rounded-tl-md bg-card/85 px-1.5 py-0.5 text-[10px] text-ink-soft"
      >
        Map data ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          OpenStreetMap
        </a>{" "}
        contributors · keyless tiles
      </p>
    </div>
  );
}
