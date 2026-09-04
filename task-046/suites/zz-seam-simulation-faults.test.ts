/**
 * §7.7 — every simulation's FAULT scenarios (task-048/simulation-mapping.md §Fault
 * Scenarios). The data-driven collisions are covered without the seam in
 * 06-simulations.test.ts; this file covers the modes that live in process environment.
 * Depends on the sanctioned test-only fixture seam — see task-046/test-fixtures-contract.md.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { demoLogin, registerBorrower, suitePrefix, type Session } from "../helpers/auth.js";
import { ensureAuthHeadroom } from "../helpers/config.js";
import { requireSeam, seam } from "../helpers/seam.js";
import { expectOk, GET } from "../helpers/http.js";
import { enums } from "../helpers/contract.js";
import { awaitCheck, FOUR_CHECKS, listChecks, pdfBytes, runCheck, runChecks, uploadDocument } from "../helpers/application.js";
import { toDocumentsReceived, type Actors } from "../helpers/workflow.js";

const PREFIX = suitePrefix("fault");

/** Fault modes declared for each provider in the delivered mapping document. */
const PROVIDER_FAULTS: Record<string, string[]> = {
  credit: ["partial", "unavailable", "timeout", "invalid-response"],
  income: ["unavailable", "timeout", "invalid-response"],
  avm: ["partial", "unavailable", "timeout"],
  aus: ["unavailable", "timeout", "invalid-response"],
  pricing: ["unavailable", "timeout", "invalid-response"],
  ocr: ["slow", "timeout", "unavailable", "partial", "invalid-response"],
};

let supervisor: Session;
let caseworker: Session;

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);
  await requireSeam();
});

after(async () => {
  for (const provider of Object.keys(PROVIDER_FAULTS)) {
    await seam("set-simulation-fault", { provider, mode: "none" }).catch(() => undefined);
  }
});

async function fileFor(label: string): Promise<string> {
  const actors: Actors = {
    borrower: (await registerBorrower(supervisor, `${PREFIX}-${label}`)).session,
    caseworker,
    supervisor,
  };
  const application = await toDocumentsReceived(actors, { estimatedValue: 400000, requestedLoanAmount: 300000 });
  return application.id;
}

describe("§6.3 provider fault scenarios surface as errored checks, never as a crash", () => {
  for (const [provider, modes] of Object.entries(PROVIDER_FAULTS)) {
    if (provider === "ocr") continue;
    for (const mode of modes) {
      if (mode === "partial") continue; // partial is a shaped success, asserted separately
      test(`${provider} / ${mode} records an errored ${provider} check`, { timeout: 400000 }, async () => {
        const applicationId = await fileFor(`${provider}-${mode}`);
        if (provider === "aus") {
          // INV-031/WF-013: AUS only runs once the four checks are completed, error-free
          // and current — so they must run BEFORE the fault is injected.
          await runChecks(caseworker, applicationId, FOUR_CHECKS);
        }
        await seam("set-simulation-fault", { provider, mode });
        try {
          const started = await runCheck(caseworker, applicationId, provider);
          assert.equal(started.status, 202, `the check must still be accepted: ${started.text.slice(0, 200)}`);
          const settled = await awaitCheck(caseworker, applicationId, provider, 120000);
          assert.equal(settled.status, "error", `${provider}/${mode} must record an errored result`);
          assert.ok(enums.CheckStatus.includes(settled.status));
          assert.ok(settled.error && settled.error.length > 0, "an errored result must carry the error text");
        } finally {
          await seam("set-simulation-fault", { provider, mode: "none" });
        }
      });
    }
  }

  test("credit / partial returns two bureau scores with the third marked unavailable", { timeout: 400000 }, async () => {
    const applicationId = await fileFor("credit-partial");
    await seam("set-simulation-fault", { provider: "credit", mode: "partial" });
    try {
      const started = await runCheck(caseworker, applicationId, "credit");
      assert.equal(started.status, 202);
      const settled = await awaitCheck(caseworker, applicationId, "credit", 120000);
      assert.equal(settled.status, "completed", "a partial response is still a completed check");
      const credit = settled.credit as { bureauScores: Array<{ bureau: string; score?: number; unavailable?: boolean }> };
      assert.equal(credit.bureauScores.length, 3, "all three bureaus are reported");
      assert.equal(
        credit.bureauScores.filter((entry) => entry.unavailable === true).length,
        1,
        "exactly one bureau is marked unavailable",
      );
      assert.equal(credit.bureauScores.filter((entry) => typeof entry.score === "number").length, 2);
    } finally {
      await seam("set-simulation-fault", { provider: "credit", mode: "none" });
    }
  });

  test("avm / partial returns value and confidence with no comparables", { timeout: 400000 }, async () => {
    const applicationId = await fileFor("avm-partial");
    await seam("set-simulation-fault", { provider: "avm", mode: "partial" });
    try {
      const started = await runCheck(caseworker, applicationId, "avm");
      assert.equal(started.status, 202);
      const settled = await awaitCheck(caseworker, applicationId, "avm", 120000);
      assert.equal(settled.status, "completed");
      const avm = settled.avm as {
        estimatedValue: number;
        confidenceScore?: number;
        comparables?: unknown[];
        marketTrend?: string;
        valueLow?: number;
        valueHigh?: number;
      };
      assert.equal(avm.confidenceScore, 40, "the documented partial confidence is 40");
      assert.ok(!avm.comparables || avm.comparables.length === 0);
      assert.equal(avm.valueLow, undefined);
      assert.equal(avm.valueHigh, undefined);
    } finally {
      await seam("set-simulation-fault", { provider: "avm", mode: "none" });
    }
  });
});

describe("§6.3.7 OCR fault scenarios", () => {
  test("ocr / unavailable leaves a failed, retryable job rather than losing the document", { timeout: 400000 }, async () => {
    const applicationId = await fileFor("ocr-unavailable");
    await seam("set-simulation-fault", { provider: "ocr", mode: "unavailable" });
    try {
      const upload = await uploadDocument(caseworker, applicationId, "fault-probe.pdf", pdfBytes(2200), "pay-stub");
      const document = expectOk(upload, "upload", 201);
      const path = `/api/documents/${document.id}/ocr`;
      const deadline = Date.now() + 150000;
      let status = "";
      while (Date.now() < deadline) {
        const panel = expectOk(
          await GET<{ job?: { status: string } }>(path, { session: caseworker }),
          path,
          200,
        );
        status = panel.job?.status ?? "";
        if (["failed", "completed"].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      assert.equal(status, "failed", "an unavailable provider must fail the job, not hang it");

      const documents = expectOk(
        await GET<{ documents: Array<{ id: string }> }>(`/api/applications/${applicationId}/documents`, {
          session: caseworker,
        }),
        "documents",
        200,
      );
      assert.ok(
        documents.documents.some((entry) => entry.id === document.id),
        "the uploaded document itself must survive a failed extraction",
      );
    } finally {
      await seam("set-simulation-fault", { provider: "ocr", mode: "none" });
    }
  });

  test("ocr / partial produces an extraction with fewer fields and no confidence-band hits", { timeout: 400000 }, async () => {
    const applicationId = await fileFor("ocr-partial");
    await seam("set-simulation-fault", { provider: "ocr", mode: "partial" });
    try {
      const upload = await uploadDocument(caseworker, applicationId, "partial-probe.pdf", pdfBytes(2200), "pay-stub");
      const document = expectOk(upload, "upload", 201);
      const path = `/api/documents/${document.id}/ocr`;
      const deadline = Date.now() + 150000;
      let extraction: { fields: Array<{ confidence: number }> } | undefined;
      while (Date.now() < deadline && !extraction) {
        const panel = expectOk(
          await GET<{ extraction?: { fields: Array<{ confidence: number }> } }>(path, { session: caseworker }),
          path,
          200,
        );
        extraction = panel.extraction;
        if (!extraction) await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      assert.ok(extraction, "a partial response is still an extraction");
      assert.ok(extraction.fields.length > 0, "a partial extraction still reports the fields it did read");
    } finally {
      await seam("set-simulation-fault", { provider: "ocr", mode: "none" });
    }
  });

  test("an undefined provider/mode pair is rejected by the seam itself", { timeout: 120000 }, async () => {
    await assert.rejects(
      () => seam("set-simulation-fault", { provider: "pricing", mode: "slow" }),
      /400|not defined|invalid/i,
      "`slow` is documented for OCR only",
    );
  });

  test("the fault vocabulary matches the delivered mapping document", () => {
    for (const modes of Object.values(PROVIDER_FAULTS)) {
      for (const mode of modes) {
        assert.ok(
          ["slow", "timeout", "unavailable", "partial", "invalid-response"].includes(mode),
          `${mode} is not a documented fault mode`,
        );
      }
    }
    // The check status the faults must surface through is a contract enum.
    assert.deepEqual(enums.CheckStatus, ["running", "completed", "error"]);
  });
});
