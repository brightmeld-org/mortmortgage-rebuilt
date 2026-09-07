/**
 * CH-025 Layer B — real-provider smoke driver (operator tool, not a suite).
 *
 * Drives the app's OWN contracted endpoints on :3083 against a server booted
 * with real providers enabled (keys in the gitignored .env.local). All
 * external calls happen server-side; this script talks to localhost only and
 * never reads or prints key material.
 *
 * Usage:  npx tsx --env-file=.env scripts/smoke-real-providers.ts [address|bank|ocr|all]
 * Result: PASS/FAIL per integration on stdout; exit 1 on any FAIL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { demoLogin, type DemoRole } from "../task-046/helpers/auth";
import { BASE_URL, GET, POST } from "../task-046/helpers/http";

const which = (process.argv[2] ?? "all").toLowerCase();
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function findEditableApplication(session: Awaited<ReturnType<typeof demoLogin>>): Promise<string> {
  const list = await GET<{ rows: Array<{ id: string; workflowState: string }> }>(
    "/api/applications",
    { session },
  );
  if (list.status !== 200) throw new Error(`GET /api/applications ${list.status}`);
  const editable = list.body.rows.find(
    (r) => r.workflowState === "draft" || r.workflowState === "revision_requested",
  );
  if (!editable) throw new Error("borrower has no editable application");
  return editable.id;
}

async function smokeAddress(): Promise<void> {
  const session = await demoLogin("borrower" as DemoRole);
  const r = await GET<{ suggestions: Array<{ formatted: string; state: string; zip: string }> }>(
    `/api/address/suggest?q=${encodeURIComponent("1600 Amphitheatre Parkway Mountain View")}`,
    { session },
  );
  if (r.status !== 200) return record("address", false, `HTTP ${r.status}`);
  const rows = r.body.suggestions ?? [];
  const hit = rows.find((s) => /amphitheatre/i.test(s.formatted));
  record(
    "address",
    rows.length > 0 && Boolean(hit),
    rows.length === 0
      ? "0 suggestions (silent degrade — provider fault or keyless)"
      : `${rows.length} suggestion(s); top: "${rows[0]!.formatted}"${hit ? "" : " (no Amphitheatre match)"}`,
  );
}

async function smokeBank(): Promise<void> {
  const session = await demoLogin("borrower" as DemoRole);
  const appId = await findEditableApplication(session);
  const token = await POST<{ linkToken: string; expiration: string }>(
    `/api/applications/${appId}/bank-links/link-token`,
    { session, body: {} },
  );
  if (token.status !== 200 || !token.body.linkToken) {
    return record("bank/link-token", false, `HTTP ${token.status} — ${JSON.stringify(token.body).slice(0, 160)}`);
  }
  record("bank/link-token", true, `link token issued (expires ${token.body.expiration})`);
  console.log(
    "  → full widget flow (Plaid Link → exchange → import → unlink) is browser-driven; see the operator smoke record.",
  );
}

async function smokeOcr(): Promise<void> {
  const borrower = await demoLogin("borrower" as DemoRole);
  const appId = await findEditableApplication(borrower);

  const pdfPath = process.env.SMOKE_PDF ?? path.join(process.cwd(), "scripts", "smoke-paystub.pdf");
  const bytes = readFileSync(pdfPath);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "smoke-paystub.pdf", { type: "application/pdf" }));
  form.set("documentType", "paystub");
  const upload = await POST<{ id?: string; documents?: Array<{ id: string }> }>(
    `/api/applications/${appId}/documents`,
    { session: borrower, form },
  );
  if (upload.status !== 200 && upload.status !== 201) {
    return record("ocr/upload", false, `HTTP ${upload.status} — ${JSON.stringify(upload.body).slice(0, 200)}`);
  }
  const documentId =
    (upload.body as { id?: string }).id ??
    (upload.body as { document?: { id?: string } }).document?.id;
  if (!documentId) return record("ocr/upload", false, "no document id in response");
  record("ocr/upload", true, `document ${documentId} uploaded`);

  const staff = await demoLogin("caseworker" as DemoRole);
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    const ocr = await GET<{
      jobStatus?: string;
      provider?: string;
      extraction?: { provider?: string; fields?: Array<{ fieldPath: string; extractedValue: string }> } | null;
    }>(`/api/documents/${documentId}/ocr`, { session: staff });
    last = JSON.stringify(ocr.body).slice(0, 300);
    const status = ocr.body.jobStatus ?? "";
    if (status === "completed" && ocr.body.extraction) {
      const fields = ocr.body.extraction.fields ?? [];
      const gross = fields.find((f) => f.fieldPath === "paystub.grossPay");
      return record(
        "ocr/extraction",
        fields.length > 0,
        `provider=${ocr.body.extraction.provider ?? ocr.body.provider} fields=${fields.length}` +
          (gross ? ` grossPay="${gross.extractedValue}"` : " (no grossPay row)"),
      );
    }
    if (status === "failed") return record("ocr/extraction", false, `job failed — ${last}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  record("ocr/extraction", false, `timeout waiting for completion — last: ${last}`);
}

(async () => {
  console.log(`smoke target: ${BASE_URL}`);
  try {
    if (which === "all" || which === "address") await smokeAddress();
    if (which === "all" || which === "bank") await smokeBank();
    if (which === "all" || which === "ocr") await smokeOcr();
  } catch (err) {
    record("driver", false, err instanceof Error ? err.message : String(err));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
