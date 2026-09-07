// Claude-Vision adapter for the DocumentOcrProvider seam (CH-025 Layer B —
// INT-023, INV-051, OCR_PROVIDER_KIND=claude). Hand-completed behind the
// ratified interface. No SDK dependency — server-side fetch against the
// Anthropic Messages API with the key OCR_PROVIDER_API_KEY (fail-fast
// validated at module load by ocr/index.ts).
//
// CONTENT PLUMBING: the ratified interface derives the SIMULATION's output
// from entered data and carries no document bytes, so this adapter reads the
// stored version through the ADDITIVE OPTIONAL request field `loadContent`
// (populated by document-ocr.ts; absent → retryable failure, simulation
// ignores it — default behavior unchanged).
//
// PII DISCIPLINE (NFR-003 / SEC-2; FIND-007/008 lesson): extracted values are
// persisted to the UNENCRYPTED OcrExtraction.fields column and serialized to
// staff. The prompt instructs last-4-only SSN and display-form DOB, and a
// deterministic post-pass masks any full SSN and re-formats ISO DOBs anyway —
// the model is never trusted with the masking obligation.

import type {
  DocumentOcrProvider,
  OcrExtractionRequest,
  OcrOutcome,
} from "@/lib/services/ocr/provider";
import type { OcrExtractedField } from "@/lib/pure/simulations/ocr";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
const TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const SUPPORTED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const PDF_MEDIA = "application/pdf";

/** Per-documentType fieldPath vocabulary — mirrors the simulation's emission
 *  (src/lib/pure/simulations/ocr.ts) so the variance/suggestion machinery and
 *  the staff panel see the same rows regardless of provider. */
const FIELD_PATHS: Record<string, string[]> = {
  w2: [
    "employment.employerName",
    "employment.baseMonthlyIncome",
    "w2.employerEin",
    "w2.employeeSsnLast4",
    "w2.wagesBox1",
    "w2.federalTaxWithheld",
    "w2.taxYear",
  ],
  paystub: [
    "employment.employerName",
    "employment.baseMonthlyIncome",
    "paystub.payPeriodStart",
    "paystub.payPeriodEnd",
    "paystub.payDate",
    "paystub.grossPay",
    "paystub.netPay",
    "paystub.ytdGross",
    "paystub.payFrequency",
  ],
  "bank-statement": [
    "bank.institution",
    "bank.accountLast4",
    "bank.statementPeriod",
    "account.endingBalance",
    "bank.totalDeposits",
  ],
  "tax-return-1040": [
    "taxreturn.filerName",
    "taxreturn.taxYear",
    "taxreturn.adjustedGrossIncome",
    "taxreturn.totalIncome",
  ],
  "government-id": ["borrower.name", "borrower.dateOfBirth", "id.numberLast4", "id.expirationDate"],
  "gift-letter": ["gift.donorName", "gift.amount"],
};

function failure(code: "unavailable" | "invalid-response", message: string, retryable: boolean, latencyMs: number): OcrOutcome {
  return { ok: false, failure: { code, message, retryable }, latencyMs };
}

// ---------------------------------------------------------------------------
// Deterministic PII post-pass (never trust the model with masking)
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function maskExtractedValue(fieldPath: string, value: string): string {
  // Full SSN in any punctuation → keep last 4 only.
  let v = value.replace(/\b(\d{3})[- ]?(\d{2})[- ]?(\d{4})\b/g, (_m, _a, _b, last4: string) =>
    fieldPath.toLowerCase().includes("ssn") ? `***-**-${last4}` : `***-**-${last4}`,
  );
  // ISO DOB on identity fields → "Mon D, YYYY" display form (NFR-002 boundary).
  if (fieldPath === "borrower.dateOfBirth") {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) v = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ModelField {
  fieldPath?: unknown;
  extractedValue?: unknown;
  confidence?: unknown;
}

export function parseModelFields(jsonText: string, documentType: string): OcrExtractedField[] | null {
  let parsed: unknown;
  try {
    // Tolerate a fenced or prefixed reply — take the first {...} span.
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return null;
  }
  const rows = (parsed as { fields?: unknown })?.fields;
  if (!Array.isArray(rows)) return null;
  const allowed = new Set(FIELD_PATHS[documentType] ?? []);
  const out: OcrExtractedField[] = [];
  for (const r of rows as ModelField[]) {
    if (typeof r?.fieldPath !== "string" || typeof r?.extractedValue !== "string") continue;
    if (allowed.size > 0 && !allowed.has(r.fieldPath)) continue; // vocabulary-locked
    const conf =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.min(1, Math.max(0, r.confidence))
        : 0.5;
    out.push({
      fieldPath: r.fieldPath,
      extractedValue: maskExtractedValue(r.fieldPath, r.extractedValue.slice(0, 500)),
      confidence: Math.round(conf * 100) / 100,
    });
  }
  return out;
}

function buildPrompt(documentType: string): string {
  const paths = FIELD_PATHS[documentType] ?? [];
  return [
    `You are an OCR field extractor for a mortgage application system. The attached document is of type "${documentType}".`,
    `Extract ONLY these fields (omit a field entirely when it is not present in the document):`,
    paths.map((p) => `- ${p}`).join("\n"),
    ``,
    `Rules:`,
    `- Respond with ONLY a JSON object: {"fields":[{"fieldPath":"...","extractedValue":"...","confidence":0.0-1.0}],"rawText":"..."}`,
    `- "rawText" is a short plain-text transcription summary (max 2000 chars).`,
    `- Currency values as "$12,345.67". Dates as ISO "YYYY-MM-DD", EXCEPT borrower.dateOfBirth as "Mon D, YYYY".`,
    `- NEVER output a full Social Security number — last 4 digits only, formatted "***-**-1234".`,
    `- NEVER output full account numbers — last 4 digits only.`,
    `- confidence reflects your reading certainty for that field.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** Real Claude-Vision extraction (OCR_PROVIDER=real + OCR_PROVIDER_KIND=claude). */
export async function runClaudeExtraction(request: OcrExtractionRequest): Promise<OcrOutcome> {
  const started = Date.now();
  const apiKey = process.env.OCR_PROVIDER_API_KEY;
  if (!apiKey) {
    return failure("unavailable", "OCR provider key missing at call time — check configuration.", true, Date.now() - started);
  }
  if (!request.loadContent) {
    return failure(
      "unavailable",
      "The Claude-Vision provider needs the stored document content, which this caller did not supply. Retry, or use manual entry (corrections).",
      true,
      Date.now() - started,
    );
  }

  let content: { bytes: Uint8Array; mimeType: string } | null = null;
  try {
    content = await request.loadContent();
  } catch {
    content = null;
  }
  if (!content || content.bytes.byteLength === 0) {
    return failure("unavailable", "The stored document content could not be read. Retry the extraction.", true, Date.now() - started);
  }
  if (content.bytes.byteLength > MAX_IMAGE_BYTES) {
    return failure("invalid-response", "The document is too large for the Claude-Vision provider (20 MB limit).", false, Date.now() - started);
  }
  const mime = content.mimeType === "image/jpg" ? "image/jpeg" : content.mimeType;
  const isPdf = mime === PDF_MEDIA;
  if (!isPdf && !SUPPORTED_MEDIA.has(mime)) {
    return failure(
      "invalid-response",
      `Unsupported content type "${content.mimeType}" for the Claude-Vision provider — upload a PDF, JPEG, PNG, WebP, or GIF.`,
      false,
      Date.now() - started,
    );
  }

  const base64 = Buffer.from(content.bytes).toString("base64");
  const attachment = isPdf
    ? { type: "document", source: { type: "base64", media_type: PDF_MEDIA, data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: base64 } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: process.env.OCR_CLAUDE_MODEL ?? DEFAULT_MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [attachment, { type: "text", text: buildPrompt(request.documentType) }],
          },
        ],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500 || res.status === 529;
      return failure(
        "unavailable",
        `The Claude-Vision provider returned HTTP ${res.status}. ${retryable ? "Retry the extraction." : "Check the provider configuration."}`,
        retryable,
        latencyMs,
      );
    }
    const payload = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (payload.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const fields = parseModelFields(text, request.documentType);
    if (!fields || fields.length === 0) {
      return failure("invalid-response", "The Claude-Vision provider returned no parseable fields. Retry, or use manual entry (corrections).", true, latencyMs);
    }
    let rawText = "";
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const rt = (JSON.parse(text.slice(start, end + 1)) as { rawText?: unknown }).rawText;
      if (typeof rt === "string") rawText = maskExtractedValue("rawText", rt.slice(0, 2000));
    } catch {
      /* rawText stays empty — fields are the contract */
    }
    return { ok: true, fields, rawText, latencyMs };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return failure(
      "unavailable",
      aborted
        ? "The Claude-Vision provider timed out. Retry the extraction."
        : "The Claude-Vision provider could not be reached. Retry the extraction.",
      true,
      Date.now() - started,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const claudeOcrProviderName = "claude-ocr-provider";
