"use client";

// UrlaWizard (task-016) — per-borrower signature & attestation panel (§4.2.8,
// REQ-037, VR-073..077). Two selectable modes: drawn canvas (mouse + touch,
// DPR-correct rendering, Clear/Save) and typed full legal name rendered in a
// script style. The ceremony shows the URLA Section 6 acknowledgments and the
// exact certification statement with a required checkbox. In demo mode an
// "Accept demonstration attestation" button completes the ceremony (demoBypass).

import { useEffect, useRef, useState } from "react";
import { postSignature } from "./api";
import type { BorrowerRecord, SignatureInfo } from "./types";
import { formatSignedAt } from "./format";

const ATTESTATION_TEXT =
  "I certify that the information provided in this application is true and accurate to the best of my knowledge";

export function SignaturePanel({
  applicationId,
  borrower,
  label,
  signature,
  csrfToken,
  demoMode,
  disabled,
  attestationAccepted,
  onSigned,
  onError,
}: {
  applicationId: string;
  borrower: BorrowerRecord;
  label: string;
  /** Latest signature for this borrower (may be invalidated), or null. */
  signature: SignatureInfo | null;
  csrfToken: string;
  demoMode: boolean;
  disabled: boolean;
  /** Shared ceremony checkbox state (attestation-checkbox in Step 10). */
  attestationAccepted: boolean;
  onSigned: (sig: SignatureInfo) => void;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [typedName, setTypedName] = useState("");
  const [hasInk, setHasInk] = useState(false);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);

  const signedValid = signature !== null && !signature.invalidatedAt;
  const invalidated = signature !== null && !!signature.invalidatedAt;

  // DPR-correct canvas sizing (§4.2.8: renders correctly at any device pixel ratio).
  useEffect(() => {
    if (mode !== "drawn" || signedValid) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1d2733";
    }
  }, [mode, signedValid]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || saving) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };

  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setHasInk(true);
  };

  const endDraw = () => {
    drawingRef.current = false;
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    setHasInk(false);
  };

  const save = async (bodyMode: "drawn" | "typed" | "demo") => {
    setSaving(true);
    const body: Parameters<typeof postSignature>[2] = {
      borrowerId: borrower.id,
      mode: bodyMode,
      attestationAccepted,
    };
    if (bodyMode === "drawn") {
      const canvas = canvasRef.current;
      if (!canvas) {
        setSaving(false);
        return;
      }
      body.imageData = canvas.toDataURL("image/png"); // PNG data URL ≤ 200 KB (VR-075)
    } else if (bodyMode === "typed") {
      body.typedName = typedName.trim();
    }
    const r = await postSignature(applicationId, csrfToken, body);
    setSaving(false);
    if (r.ok) {
      onSigned(r.data);
      clearCanvas();
    } else {
      onError(r.error.message);
    }
  };

  const modeBtn = (m: "drawn" | "typed", text: string, testId: string) => (
    <button
      type="button"
      data-testid={testId}
      onClick={() => setMode(m)}
      disabled={disabled || saving}
      aria-pressed={mode === m}
      className={`rounded-md px-4 py-1.5 text-sm font-semibold transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] disabled:cursor-not-allowed disabled:opacity-50 ${
        mode === m ? "bg-navy text-white" : "border border-line bg-card text-ink-soft hover:border-navy/50"
      }`}
    >
      {text}
    </button>
  );

  const borrowerName = [borrower.firstName, borrower.lastName].filter(Boolean).join(" ") || "Borrower";

  return (
    <div data-testid={`signature-panel-${borrower.ordinal}`} className="rounded-lg border border-line bg-paper/50 p-4">
      <p className="mb-3 text-sm font-semibold text-ink">
        {borrowerName} <span className="font-normal text-muted">({label})</span>
      </p>

      {signedValid ? (
        <div className="space-y-2">
          <div className="flex h-28 items-center justify-center rounded-md border border-success/40 bg-success-soft">
            <p className="font-display text-lg italic text-success">Signed</p>
          </div>
          <p data-testid={`signature-status-${borrower.ordinal}`} className="text-xs text-success">
            ✓ Signed {formatSignedAt(signature.signedAt)}
            {signature.demoBypass ? " (demonstration attestation)" : ""}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {invalidated ? (
            <p
              data-testid={`signature-invalidated-${borrower.ordinal}`}
              role="alert"
              className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn"
            >
              Signature invalidated — the application changed after signing. Please re-sign.
            </p>
          ) : null}
          <div className="flex gap-2">
            {modeBtn("drawn", "Draw", "signature-mode-drawn")}
            {modeBtn("typed", "Type name", "signature-mode-typed")}
          </div>

          {mode === "drawn" ? (
            <div className="space-y-2">
              <canvas
                ref={canvasRef}
                data-testid="signature-canvas"
                onPointerDown={startDraw}
                onPointerMove={moveDraw}
                onPointerUp={endDraw}
                onPointerLeave={endDraw}
                aria-label={`Draw signature for ${borrowerName}`}
                className="h-32 w-full touch-none rounded-md border border-line bg-card"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="signature-clear-btn"
                  onClick={clearCanvas}
                  disabled={disabled || saving}
                  className="rounded-md border border-line bg-card px-4 py-1.5 text-sm font-semibold text-ink-soft transition-colors duration-200 hover:border-navy/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear
                </button>
                <button
                  type="button"
                  data-testid="signature-save-btn"
                  onClick={() => void save("drawn")}
                  disabled={disabled || saving || !hasInk || !attestationAccepted}
                  className="rounded-md bg-navy px-4 py-1.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save signature"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                data-testid="signature-typed-input"
                type="text"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder="Type your full legal name"
                disabled={disabled || saving}
                aria-label={`Typed signature for ${borrowerName}`}
                className="w-full rounded-md border border-line bg-card px-3 py-2 text-ink outline-none transition-colors duration-200 focus:border-navy focus:ring-2 focus:ring-navy/20"
              />
              {typedName.trim() !== "" ? (
                <div className="flex h-20 items-center justify-center rounded-md border border-line bg-card">
                  <p className="font-display text-2xl italic text-ink">{typedName}</p>
                </div>
              ) : null}
              <button
                type="button"
                data-testid="signature-save-btn"
                onClick={() => void save("typed")}
                disabled={disabled || saving || typedName.trim() === "" || !attestationAccepted}
                className="rounded-md bg-navy px-4 py-1.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save signature"}
              </button>
            </div>
          )}

          {demoMode ? (
            <button
              type="button"
              data-testid="demo-attestation-btn"
              onClick={() => void save("demo")}
              disabled={disabled || saving || !attestationAccepted}
              className="inline-flex items-center gap-2 rounded-md border border-copper/50 bg-copper-soft px-4 py-1.5 text-sm font-semibold text-copper transition-colors duration-200 hover:border-copper disabled:cursor-not-allowed disabled:opacity-50"
            >
              Accept demonstration attestation
              <span className="rounded-full bg-copper px-2 py-0.5 text-[10px] font-bold uppercase text-white">demo</span>
            </button>
          ) : null}
          {!attestationAccepted ? (
            <p className="text-xs text-muted">Check the certification statement below to enable signing.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export { ATTESTATION_TEXT };
