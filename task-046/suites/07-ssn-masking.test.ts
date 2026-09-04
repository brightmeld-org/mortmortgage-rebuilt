/**
 * §7.7 — SSN masking on EVERY endpoint.
 *
 * The endpoint list is enumerated from contracts.json; the set that can carry borrower
 * data is computed by walking the model graph from each endpoint's declared response
 * model, so the enumeration follows the contract rather than a hand-written list.
 *
 * The only contracted unmasked egress paths (§B, S-5, urla-mismo-mapping.md) are:
 *   - GET /api/applications/:id/borrowers/:ordinal/identity  (the owning borrower)
 *   - GET /api/applications/:id/exports/mismo-json|mismo-xml with ?full=true&reason=…
 *     (Supervisor, audited)
 * Everything else must show ***-**-NNNN and never the full number.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { GET, api, expectOk } from "../helpers/http.js";
import { endpointKey, endpoints, fillPath, type ContractEndpoint } from "../helpers/contract.js";
import {
  claim,
  getApplication,
  listDocuments,
  pdfBytes,
  transitionOk,
  uploadDocument,
  buildSubmittableDraft,
  type Application,
} from "../helpers/application.js";

const PREFIX = suitePrefix("ssn");

/** A distinctive full SSN in the demo 900-999 area so a leak is unmistakable. */
const FULL_SSN = "923-45-6781";
const MASKED_SSN = "***-**-6781";
const SSN_DIGITS = "923456781";

const UNMASKED_EGRESS = new Set([
  "GET /api/applications/:id/borrowers/:ordinal/identity",
]);

interface ModelDef {
  fields: Record<string, { type: string; required: boolean }>;
}

const models = JSON.parse(readFileSync(join(process.cwd(), "contracts.json"), "utf8")).models as Record<
  string,
  ModelDef
>;

/** True when the model graph rooted at `name` can reach borrower identity data. */
function carriesBorrowerData(name: string | null): boolean {
  if (!name) return false;
  const seen = new Set<string>();
  const stack = [name.replace(/\[\]$/, "")];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === "BorrowerRecord" || current === "BorrowerIdentitySection") return true;
    const model = models[current];
    if (!model) continue;
    for (const field of Object.values(model.fields)) {
      stack.push(field.type.replace(/\[\]$/, ""));
    }
  }
  return false;
}

let supervisor: Session;
let caseworker: Session;
let borrower: Session;
let application: Application;
let documentId = "";
let documentVersionId = "";

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  borrower = (await registerBorrower(supervisor, `${PREFIX}-b1`)).session;

  const draft = await buildSubmittableDraft(borrower, { ssn: FULL_SSN, firstName: "Masked", lastName: "Borrower" });
  application = await transitionOk(borrower, draft.id, {
    toState: "application_received",
    versionStamp: draft.versionStamp,
  });
  await claim(caseworker, application.id);

  const upload = await uploadDocument(caseworker, application.id, "masking-fixture.pdf", pdfBytes(2400), "pay-stub");
  const document = expectOk(upload, "document upload", 201);
  documentId = document.id;
  documentVersionId = document.currentVersionId;
});

function pathFor(entry: ContractEndpoint): string | null {
  const isDocumentRoute = entry.path.startsWith("/api/documents/");
  try {
    return fillPath(entry.path, {
      id: isDocumentRoute ? documentId : application.id,
      ordinal: "1",
      versionId: documentVersionId,
      section: "identity",
      checkType: "credit",
      element: "summary",
      linkId: "00000000-0000-4000-8000-000000000000",
    });
  } catch {
    return null;
  }
}

describe("§7.7 SSN never leaves the system unmasked", () => {
  test("the owning borrower's identity endpoint is the one contracted unmasked read (S-5)", async () => {
    const path = `/api/applications/${application.id}/borrowers/1/identity`;
    const body = expectOk(
      await GET<{ ordinal: number; identity: { ssn?: string } }>(path, { session: borrower }),
      path,
      200,
    );
    assert.equal(body.identity.ssn, FULL_SSN, "the owner must see their own full SSN here");
  });

  test("the application detail carries the masked form and last four only", async () => {
    const detail = await getApplication(borrower, application.id);
    const record = detail.borrowers.find((entry) => entry.ordinal === 1);
    assert.ok(record);
    assert.equal(record.ssnMasked, MASKED_SSN);
    assert.equal(record.ssnLast4, "6781");
    assert.ok(!JSON.stringify(detail).includes(FULL_SSN), "the full SSN must not appear anywhere in the detail payload");
  });

  test("staff never see the full SSN on the same application", async () => {
    const detail = await getApplication(caseworker, application.id);
    assert.ok(!JSON.stringify(detail).includes(FULL_SSN));
    const supervisorView = await getApplication(supervisor, application.id);
    assert.ok(!JSON.stringify(supervisorView).includes(FULL_SSN));
  });

  test("staff are refused the borrower-own identity endpoint entirely (§B role gate: borrower)", async () => {
    const path = `/api/applications/${application.id}/borrowers/1/identity`;
    for (const staff of [caseworker, supervisor]) {
      const result = await GET(path, { session: staff });
      assert.equal(result.status, 403, `${result.status} ${result.text.slice(0, 200)}`);
    }
  });

  test("every contracted GET endpoint that can carry borrower data is enumerated", () => {
    const carriers = endpoints
      .filter((entry) => entry.method === "GET" && carriesBorrowerData(entry.responseBody))
      .map(endpointKey);
    assert.ok(carriers.length > 0, "the model walk must find at least the application detail endpoint");
    assert.ok(
      carriers.includes("GET /api/applications/:id"),
      `the walk must classify the application detail as a borrower-data carrier: ${carriers.join(", ")}`,
    );
    for (const key of UNMASKED_EGRESS) {
      assert.ok(
        endpoints.some((entry) => endpointKey(entry) === key),
        `${key} must exist in the contract endpoint table`,
      );
    }
  });

  test("no reachable endpoint leaks the full SSN for any role", { timeout: 600000 }, async () => {
    const leaks: string[] = [];
    const probed: string[] = [];
    const sessions: Array<[string, Session]> = [
      ["borrower", borrower],
      ["caseworker", caseworker],
      ["supervisor", supervisor],
    ];

    for (const entry of endpoints) {
      if (entry.method !== "GET") continue;
      const key = endpointKey(entry);
      if (UNMASKED_EGRESS.has(key)) continue;
      const path = pathFor(entry);
      if (!path) continue;
      for (const [role, session] of sessions) {
        const result = await api(entry.method, path, { session });
        if (result.status !== 200) continue;
        probed.push(`${key} (${role})`);
        const text = result.text;
        if (text.includes(FULL_SSN) || text.includes(SSN_DIGITS)) {
          leaks.push(`${key} as ${role}: response contains the full SSN`);
        }
      }
    }
    assert.ok(probed.length >= 15, `expected a broad probe, only reached ${probed.length} endpoint/role pairs`);
    assert.deepEqual(leaks, [], leaks.join("\n"));
  });

  test("the default MISMO export masks the SSN; the audited full export is opt-in (§B, ASM-010)", { timeout: 120000 }, async () => {
    const masked = await api("GET", `/api/applications/${application.id}/exports/mismo-json`, {
      session: supervisor,
    });
    assert.equal(masked.status, 200, masked.text.slice(0, 300));
    assert.ok(masked.text.includes(MASKED_SSN), "the default export must carry the masked SSN");
    assert.ok(!masked.text.includes(FULL_SSN), "the default export must not carry the full SSN");

    const query = "?full=true&reason=compliance-audit";
    const full = await api("GET", `/api/applications/${application.id}/exports/mismo-json${query}`, {
      session: supervisor,
    });
    assert.equal(full.status, 200, full.text.slice(0, 300));
    assert.ok(full.text.includes(FULL_SSN), "the audited full export must carry the unmasked SSN");
  });

  test("the full-SSN export requires the audited reason parameter", { timeout: 60000 }, async () => {
    const result = await api("GET", `/api/applications/${application.id}/exports/mismo-json?full=true`, {
      session: supervisor,
    });
    if (result.status === 200) {
      assert.ok(
        !result.text.includes(FULL_SSN),
        "without a reason the export must fall back to masking rather than leaking the full SSN",
      );
    } else {
      assert.equal(result.status, 400, result.text.slice(0, 300));
    }
  });

  test("borrower-facing list surfaces never carry SSN material at all", { timeout: 60000 }, async () => {
    const list = await api("GET", "/api/applications?pageSize=100", { session: borrower });
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes(SSN_DIGITS));
    assert.ok(!list.text.includes(MASKED_SSN), "BorrowerApplicationRow has no SSN field in the contract");

    const queue = await api("GET", "/api/queue/mine?pageSize=100", { session: caseworker });
    assert.equal(queue.status, 200);
    assert.ok(!queue.text.includes(SSN_DIGITS));
    assert.ok(!queue.text.includes(MASKED_SSN), "QueueRow is the S-2 summary field set and carries no SSN");
  });

  test("the audit log and its export never carry a full SSN", { timeout: 120000 }, async () => {
    const page = await api("GET", "/api/admin/audit-log?page=1&pageSize=100", { session: supervisor });
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes(SSN_DIGITS) && !page.text.includes(FULL_SSN));

    const csv = await api("GET", "/api/admin/audit-log/export", { session: supervisor });
    assert.equal(csv.status, 200, csv.text.slice(0, 200));
    assert.ok(!csv.text.includes(SSN_DIGITS) && !csv.text.includes(FULL_SSN));
  });

  test("document downloads and the warehouse export never carry a full SSN", { timeout: 120000 }, async () => {
    const documents = await listDocuments(caseworker, application.id);
    assert.ok(documents.length > 0);
    const download = await api("GET", `/api/documents/${documents[0].id}/download`, { session: caseworker });
    assert.equal(download.status, 200, download.text.slice(0, 200));
    assert.ok(!download.text.includes(FULL_SSN));

    const warehouse = await api("GET", "/api/admin/exports/warehouse?mode=full", { session: supervisor });
    assert.equal(warehouse.status, 200, warehouse.text.slice(0, 200));
    assert.ok(!warehouse.text.includes(FULL_SSN) && !warehouse.text.includes(SSN_DIGITS));
  });
});
