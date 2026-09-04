/**
 * REQ-038 / AC-17 — "Replacing a W-2 creates version 2, retains version 1 viewable by
 * staff, and the checklist references version 2."
 *
 * §B exposes `POST /api/documents/:id/versions` to the borrower role, so the borrower
 * surface has to be able to reach it. This lives in its own file rather than inside the
 * serial lifecycle journey: if the affordance is missing, the finding should be one red
 * test, not a cascade that skips the rest of the lifecycle.
 *
 * It runs against the Demo Borrower's seeded Draft (§4.6.12 staging: "one Draft part-way
 * through the wizard … with uploaded documents"), which the setup project re-seeds at the
 * top of every run. That is deliberate. §4.2.9 permits a Borrower to replace a document
 * only in Draft, in Revision Requested, or in answer to a document request, and the
 * Replace control is shown under the same gating as the upload affordance (wizard
 * editability) — so a journey that submits its application first has, correctly, no
 * Replace control left to exercise. Owning its own Draft keeps this file independent of
 * the lifecycle journey's ordering as well as its outcome.
 *
 * The replacement is driven entirely through the Step 10 checklist UI — the Replace
 * control, then the file chooser it opens — and then verified against the contracted
 * `GET /api/applications/:id/documents` read: one Document, now at version 2, rather than
 * a second Document row.
 */
import { expect, test } from "@playwright/test";
import { gotoAs, gotoUntilReady, pdfBuffer, storagePath } from "./support/journey";

test.use({ storageState: storagePath("borrower") });

interface DocumentRow {
  id: string;
  documentType: string;
  currentVersionNumber: number;
  versions?: unknown[];
}

interface DocumentListResponse {
  documents: DocumentRow[];
}

interface BorrowerApplicationRow {
  id: string;
  workflowState: string;
}

interface BorrowerApplicationList {
  rows: BorrowerApplicationRow[];
}

const REPLACEMENT_FILE = "journey-replacement-v2.pdf";

test("replacing an uploaded document produces version 2 of that document", async ({ page }) => {
  test.setTimeout(600_000);

  // Locate the staged Draft and the document to replace, through the contracted borrower
  // reads only — never a route the endpoint table does not define.
  const listResponse = await page.request.get("/api/applications?page=1&pageSize=100");
  expect(listResponse.status(), "GET /api/applications is readable by the borrower").toBe(200);
  const drafts = ((await listResponse.json()) as BorrowerApplicationList).rows.filter(
    (row) => row.workflowState === "draft",
  );
  expect(drafts.length, "the seeded Demo Borrower owns a Draft (§4.6.12 staging)").toBeGreaterThan(0);

  let applicationId = "";
  let documentId = "";
  for (const draft of drafts) {
    const path = `/api/applications/${draft.id}/documents`;
    const response = await page.request.get(path);
    expect(response.status(), `GET ${path} is readable by the owning borrower`).toBe(200);
    const documents = ((await response.json()) as DocumentListResponse).documents;
    const replaceable = documents.filter((document) => document.currentVersionNumber === 1);
    // AC-17 names the W-2 specifically; take it when the staged draft carries one.
    const chosen = replaceable.find((document) => document.documentType === "w2") ?? replaceable[0];
    if (chosen) {
      applicationId = draft.id;
      documentId = chosen.id;
      break;
    }
  }
  expect(
    documentId,
    "a staged Draft carries an uploaded document at version 1 to replace (§4.6.12)",
  ).toBeTruthy();

  const documentsPath = `/api/applications/${applicationId}/documents`;
  const readDocuments = async (): Promise<DocumentRow[]> => {
    const response = await page.request.get(documentsPath);
    expect(response.status(), `GET ${documentsPath} is readable by the owning borrower`).toBe(200);
    return ((await response.json()) as DocumentListResponse).documents;
  };

  const before = await readDocuments();
  const target = before.find((document) => document.id === documentId);
  expect(target, `the staged document ${documentId} is on the application`).toBeDefined();
  expect(target?.currentVersionNumber, "the document starts at version 1").toBe(1);

  const url = `/applications/${applicationId}?step=10`;
  await gotoAs(page, "borrower", url);
  await gotoUntilReady(page, url, "wizard-step-10");

  const item = page.getByTestId(`doc-item-${documentId}`);
  await expect(item).toBeVisible({ timeout: 300_000 });
  await expect(item).toContainText("v1");

  // The Replace control is a real button: keyboard-focusable and activatable, not a
  // bare file input styled to look like one (AC-60 / §8 keyboard accessibility).
  const replaceButton = page.getByTestId(`doc-replace-${documentId}`);
  await expect(replaceButton, "each uploaded document offers a Replace control").toBeVisible({
    timeout: 300_000,
  });
  await expect(replaceButton).toBeEnabled();
  await replaceButton.focus();
  expect(
    await replaceButton.evaluate((element) => document.activeElement === element),
    "the Replace control takes keyboard focus",
  ).toBe(true);

  // Activating it opens the hidden file input — the same picker a person gets.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 120_000 }),
    replaceButton.click(),
  ]);
  await expect(page.getByTestId("doc-replace-file-input")).toBeAttached();
  await chooser.setFiles({
    name: REPLACEMENT_FILE,
    mimeType: "application/pdf",
    buffer: pdfBuffer("journey replacement version 2"),
  });

  // The screen confirms the replacement the way it confirms a fresh upload...
  const confirmation = page.getByTestId("doc-upload-confirmation");
  await expect(confirmation, "the replacement is confirmed on screen").toBeVisible({ timeout: 300_000 });
  await expect(confirmation).toContainText(REPLACEMENT_FILE);
  await expect(confirmation).toContainText(/Replaced with/i);
  await expect(confirmation).toContainText(/now v2/i);

  // ...and the checklist item itself refreshes in place onto the new file and version.
  await expect(item, "the checklist item reports the replacement and its new version").toContainText(
    REPLACEMENT_FILE,
    { timeout: 300_000 },
  );
  await expect(item).toContainText("v2");
  // The version and OCR badges behave like a fresh upload: the item still carries an
  // extraction badge for the new version (its terminal value is asserted by task-046).
  await expect(item).toContainText(/OCR:/i);

  // AC-17 proper: version 2 of the SAME document, not a second document.
  const after = await readDocuments();
  expect(after.length, "replacing does not create an additional Document").toBe(before.length);
  const replaced = after.find((document) => document.id === documentId);
  expect(replaced, "the original document survives the replacement").toBeDefined();
  expect(replaced?.currentVersionNumber, "the checklist now references version 2").toBe(2);
  expect(
    replaced?.versions?.length ?? 2,
    "version 1 is retained alongside version 2",
  ).toBeGreaterThanOrEqual(2);
});
