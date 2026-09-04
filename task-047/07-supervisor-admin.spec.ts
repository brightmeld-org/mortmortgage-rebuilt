/**
 * FLOW-010 and FLOW-011 — analytics, compliance exports, audit log, configuration and
 * caseworker management.
 *
 * §7.7 supervisor items: analytics, caseworker management, audit log filter and export,
 * configuration change, all exports.
 */
import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import { awaitHydrated, gotoAs, gotoUntilReady, runTag, storagePath } from "./support/journey";

test.describe.configure({ mode: "serial" });
test.use({ storageState: storagePath("supervisor") });

/**
 * Trigger a download and wait for the browser to actually start one.
 *
 * The trigger is a client-side handler. The app server compiles a route's client
 * chunk on demand, so a freshly opened page can paint its markup seconds before
 * React attaches handlers — a click that lands in that window is swallowed with
 * no request, no busy state and no error, and a single long `waitForEvent` then
 * burns its whole budget waiting for an effect that was never started. Re-issue
 * the trigger until a download begins. A swallowed click started nothing, so
 * re-issuing cannot produce a duplicate export; a refusal the server DID answer
 * surfaces its verbatim message instead of another wait.
 */
async function download(page: Page, trigger: () => Promise<void>): Promise<Download> {
  const attempts = 6;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = page.waitForEvent("download", { timeout: 60_000 });
    await trigger();
    try {
      return await started;
    } catch (error) {
      lastError = error;
      const refusal = await page
        .locator('[data-testid$="-error"][role="alert"]')
        .filter({ hasText: /\S/ })
        .first()
        .innerText()
        .catch(() => "");
      if (refusal.trim()) {
        throw new Error(`the export was refused: ${refusal.trim().replace(/\s+/g, " ").slice(0, 300)}`);
      }
      await page.waitForTimeout(2_000);
    }
  }
  throw lastError;
}

/**
 * What the downloaded body must actually BE.
 *
 * The previous helper asserted only that `suggestedFilename()` matched an
 * extension and that `await file.path()` was truthy — and `path()` is truthy for
 * a 0-BYTE file. Despite its name it asserted neither emptiness nor content, and
 * it was the SOLE assertion behind MISMO JSON, MISMO XML, the URLA PDF, the HMDA
 * LAR, the warehouse ZIP and both analytics CSVs. An export route returning a
 * correct filename and an empty body — or a truncated stream, or a valid-looking
 * PDF with no content — passed all seven, leaving FLOW-010, AC-40, AC-48, AC-49,
 * AC-50 and AC-51 unverified.
 */
type DownloadKind = "pdf" | "zip" | "mismo-xml" | "mismo-json" | "csv" | "hmda-lar";

/** Byte floors: a real body, not a stub or a truncated stream. */
const MIN_BYTES: Record<DownloadKind, number> = {
  pdf: 1000,
  zip: 1000,
  "mismo-xml": 1000,
  "mismo-json": 1000,
  // A single-chart analytics CSV is legitimately small, so its floor is
  // STRUCTURAL (header row + at least one data row), asserted below.
  csv: 32,
  "hmda-lar": 1000,
};

async function expectNonEmptyDownload(
  file: Download,
  extension: RegExp,
  kind: DownloadKind,
): Promise<void> {
  expect(file.suggestedFilename(), "the download carries a sensible filename").toMatch(extension);
  const path = await file.path();
  expect(path, "the download completed to disk").toBeTruthy();

  const bytes = await readFile(path as string);
  expect(
    bytes.byteLength,
    `the ${kind} download is ${bytes.byteLength} bytes — an empty or truncated body, not a real export`,
  ).toBeGreaterThan(MIN_BYTES[kind]);

  const head = bytes.subarray(0, 8);
  const text = bytes.toString("utf8");

  switch (kind) {
    case "pdf":
      expect(
        head.toString("latin1").startsWith("%PDF-"),
        `expected the %PDF- signature, got ${JSON.stringify(head.toString("latin1"))}`,
      ).toBe(true);
      expect(bytes.subarray(-2048).toString("latin1"), "a complete PDF ends with the %%EOF marker").toContain("%%EOF");
      break;
    case "zip":
      // Local file header signature PK\x03\x04 — a real, non-empty archive.
      expect(
        head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04,
        `expected the PK\\x03\\x04 ZIP signature, got ${JSON.stringify([...head])}`,
      ).toBe(true);
      break;
    case "mismo-xml": {
      expect(text.trimStart().startsWith("<?xml"), "the MISMO XML export must start with an XML declaration").toBe(true);
      expect(text, "the MISMO root element must be present").toContain("MESSAGE");
      const opens = (text.match(/<[A-Za-z][^\s/>]*(?:\s[^>]*)?>/g) ?? []).length;
      const closes = (text.match(/<\/[A-Za-z][^\s>]*>/g) ?? []).length;
      const selfClosing = (text.match(/<[A-Za-z][^>]*\/>/g) ?? []).length;
      expect(opens - selfClosing, "every opened element must be closed — a truncated stream fails this").toBe(closes);
      break;
    }
    case "mismo-json": {
      const document = JSON.parse(text) as Record<string, unknown>;
      expect(document, "the MISMO JSON export must parse and carry the MESSAGE spine").toHaveProperty("MESSAGE");
      break;
    }
    case "csv": {
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
      expect(lines.length, "a CSV export must carry a header row and at least one data row").toBeGreaterThan(1);
      expect(lines[0], "the first line must be a comma-separated header row").toContain(",");
      break;
    }
    case "hmda-lar": {
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
      expect(lines[0]?.startsWith("1|"), "LAR line 1 must be the transmittal sheet (record identifier 1)").toBe(true);
      expect(lines[0]?.split("|").length, "the transmittal sheet carries 15 fields").toBe(15);
      const records = lines.slice(1).filter((line) => line.startsWith("2|"));
      expect(records.length, "the LAR must carry at least one record line (record identifier 2)").toBeGreaterThan(0);
      for (const record of records) {
        expect(record.split("|").length, "every LAR record carries 110 fields").toBe(110);
      }
      break;
    }
  }
}

test("the analytics dashboard renders every element and exports CSV", async ({ page }) => {
  test.setTimeout(900_000);
  await gotoAs(page, "supervisor", "/supervisor/analytics");
  await gotoUntilReady(page, "/supervisor/analytics", "analytics-summary-total");

  for (const card of ["total", "this-month", "approval-rate", "avg-loan", "avg-days", "overdue"]) {
    await expect(page.getByTestId(`analytics-summary-${card}`)).toBeVisible({ timeout: 300_000 });
  }
  for (const chart of [
    "volume",
    "status",
    "loan-type",
    "property-type",
    "workload",
    "ltv-risk",
    "dti-risk",
    "performance-trend",
  ]) {
    await expect(page.getByTestId(`analytics-chart-${chart}`)).toBeVisible({ timeout: 300_000 });
  }
  await expect(page.getByTestId("analytics-compliance-table")).toBeVisible();
  await expect(page.locator('[data-testid^="analytics-pending-row-"]').first()).toBeVisible();

  // The recent-activity feed uses state labels, never "unknown" (AC-39).
  const feed = page.locator('[data-testid^="analytics-feed-item-"]');
  await expect(feed.first()).toBeVisible();
  await expect(page.locator('[data-testid^="analytics-feed-item-"]', { hasText: /unknown/i })).toHaveCount(0);

  // The date-range filter applies to every element.
  await page.getByTestId("analytics-date-from").fill("2026-01-01");
  await page.getByTestId("analytics-date-to").fill("2026-12-31");
  await expect(page.getByTestId("analytics-summary-total")).toBeVisible({ timeout: 300_000 });

  const chartCsv = await download(page, () => page.getByTestId("analytics-csv-volume").click());
  await expectNonEmptyDownload(chartCsv, /\.csv$/i, "csv");

  const complianceCsv = await download(page, () => page.getByTestId("analytics-csv-compliance").click());
  await expectNonEmptyDownload(complianceCsv, /\.csv$/i, "csv");
});

test("the audit log filters in place and streams a filtered CSV export", async ({ page }) => {
  test.setTimeout(900_000);
  await gotoAs(page, "supervisor", "/supervisor/audit-log");
  await gotoUntilReady(page, "/supervisor/audit-log", "audit-filter-actionType");

  const rows = page.locator('[data-testid^="audit-row-"]');
  // The viewer pages a very large table; reload rather than assert against a list whose
  // first query never came back.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await rows.first().waitFor({ timeout: 120_000 });
      break;
    } catch {
      await gotoUntilReady(page, "/supervisor/audit-log", "audit-filter-actionType");
    }
  }
  await expect(rows.first(), "the audit viewer returns rows").toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(3000);
  const unfiltered = await rows.count();
  expect(unfiltered, "the viewer pages seeded audit entries").toBeGreaterThan(0);

  // Expanding a row reveals the before/after payload.
  const firstRowId = String(await rows.first().getAttribute("data-testid")).replace("audit-row-", "");
  await page.getByTestId(`audit-expand-${firstRowId}`).click();
  await expect(page.getByTestId(`audit-row-${firstRowId}`)).toBeVisible();

  // Filters auto-apply — there is no Apply button to press (AC-42).
  const options = await page.getByTestId("audit-filter-actionType").locator("option").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value.length > 0),
  );
  expect(options.length, "the action-type filter is populated from the audit vocabulary").toBeGreaterThan(0);
  await page.getByTestId("audit-filter-actionType").selectOption(options[0]);
  await expect(rows.first()).toBeVisible({ timeout: 300_000 });

  const csv = await download(page, () => page.getByTestId("audit-export-btn").click());
  await expectNonEmptyDownload(csv, /\.csv$/i, "csv");
});

test("a configuration change is saved and reflected back on the settings page", async ({ page }) => {
  test.setTimeout(900_000);
  await gotoAs(page, "supervisor", "/supervisor/settings");
  await gotoUntilReady(page, "/supervisor/settings", "config-escalation-ltvThresholdPercent");

  await page.waitForTimeout(4000);
  const field = page.getByTestId("config-escalation-ltvThresholdPercent");
  const original = await field.inputValue();
  const changed = original.trim() === "90" ? "85" : "90";

  // Reissue the edit until the panel confirms the SERVER accepted it.
  //
  // Reading the input back proves nothing: `fill()` sets that value itself, so the
  // old `toHaveValue(value)` check passed even when the Save click was swallowed by
  // a not-yet-hydrated page and no PUT ever reached the server — the reload two lines
  // below was then the first thing to notice. The panel's own "Saved." affordance
  // (`config-saved-{key}`, rendered only on a 2xx from PUT /api/admin/config) is the
  // server's answer, so that is the success condition.
  const saveSetting = async (value: string): Promise<void> => {
    const savedBadge = page.getByTestId("config-saved-escalation-ltvThresholdPercent");
    const errorBanner = page.getByTestId("config-error-escalation-ltvThresholdPercent");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await awaitHydrated(page, "config-escalation-ltvThresholdPercent");
      await field.fill(value);
      await page.getByTestId("config-save-escalation-ltvThresholdPercent").click();
      const confirmed = await savedBadge
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (confirmed) return;
      if (await errorBanner.isVisible().catch(() => false)) {
        throw new Error(`the escalation threshold was refused: ${await errorBanner.innerText()}`);
      }
      await page.waitForTimeout(3000);
    }
    throw new Error(`the settings panel never confirmed a save of the escalation threshold as ${value}`);
  };

  await saveSetting(changed);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("config-escalation-ltvThresholdPercent")).toHaveValue(changed, {
    timeout: 300_000,
  });

  // The change is audited with before/after (AC-32).
  await gotoUntilReady(page, "/supervisor/audit-log", "audit-filter-actionType");
  await expect(
    page.locator('[data-testid^="audit-row-"]', { hasText: /Config Change/i }).first(),
  ).toBeVisible({ timeout: 300_000 });

  // Restore the original threshold so the rest of the dataset behaves as seeded.
  await gotoUntilReady(page, "/supervisor/settings", "config-escalation-ltvThresholdPercent");
  await page.waitForTimeout(4000);
  await saveSetting(original);
});

test("adding a caseworker sends an invitation that appears on Outbound Messages", async ({ page }) => {
  test.setTimeout(900_000);
  await gotoAs(page, "supervisor", "/supervisor/caseworkers");
  await gotoUntilReady(page, "/supervisor/caseworkers", "staff-add-btn");
  await expect(page.locator('[data-testid^="staff-row-"]').first()).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(4000);

  const email = `${runTag()}-newcw@e2e.example`;
  await page.getByTestId("staff-add-btn").click();
  await expect(page.getByTestId("staff-invite-email")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("staff-invite-firstName").fill("Journey");
  await page.getByTestId("staff-invite-lastName").fill("Caseworker");
  await page.getByTestId("staff-invite-email").fill(email);
  const roleSelect = page.getByTestId("staff-invite-role");
  await roleSelect.selectOption("CASEWORKER").catch(() => roleSelect.selectOption({ label: "Caseworker" }));
  await page.getByTestId("staff-invite-submit").click();

  await expect(page.locator('[data-testid^="staff-row-"]', { hasText: email })).toBeVisible({
    timeout: 300_000,
  });

  await gotoAs(page, "supervisor", "/supervisor/outbound");
  await expect(
    page.locator('[data-testid^="outbound-row-"]', { hasText: email }).first(),
    "the invitation is delivered to the simulated outbound log",
  ).toBeVisible({ timeout: 300_000 });
});

test("deactivating and reactivating a caseworker is guarded and reversible", async ({ page }) => {
  test.setTimeout(900_000);
  await gotoAs(page, "supervisor", "/supervisor/caseworkers");
  await gotoUntilReady(page, "/supervisor/caseworkers", "staff-add-btn");
  await expect(page.locator('[data-testid^="staff-row-"]').first()).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(4000);

  const dialog = page.getByRole("dialog");
  await expect(dialog, "no dialog is left open from an earlier step").toHaveCount(0, { timeout: 60_000 });

  // The roster carries accounts that are already deactivated, and those rows offer
  // Reactivate instead of Deactivate. Selecting on the control rather than on the status
  // text is what guarantees this journey starts from an account that is actually active.
  const candidate = page
    .locator('[data-testid^="staff-row-"]')
    .filter({ has: page.locator('[data-testid^="staff-deactivate-"]') })
    .filter({ hasText: /Caseworker/ })
    .filter({ hasNotText: /Demo / })
    .first();
  await expect(candidate, "an active non-demo caseworker is available to deactivate").toBeVisible({
    timeout: 300_000,
  });
  const staffId = String(await candidate.getAttribute("data-testid")).replace("staff-row-", "");
  const row = page.getByTestId(`staff-row-${staffId}`);
  const confirmDeactivate = page.getByTestId(`staff-deactivate-confirm-${staffId}`);
  const cancelDeactivate = page.getByTestId(`staff-deactivate-confirm-${staffId}-cancel`);

  // "Guarded": deactivation revokes sessions and closes assignments, so it is confirmed
  // before it happens. Dismissing the confirmation has to leave the account alone.
  await page.getByTestId(`staff-deactivate-${staffId}`).click();
  await expect(confirmDeactivate, "deactivation asks for confirmation first").toBeVisible({
    timeout: 120_000,
  });
  await expect(dialog.first(), "the confirmation states what deactivation does").toContainText(
    /revokes all of their sessions/i,
  );
  await cancelDeactivate.click();
  await expect(dialog, "dismissing the confirmation closes it").toHaveCount(0, { timeout: 120_000 });
  await expect(row, "a dismissed confirmation leaves the account active").toContainText(/Active/);

  // …and confirming it carries the deactivation through.
  await page.getByTestId(`staff-deactivate-${staffId}`).click();
  await expect(confirmDeactivate).toBeEnabled({ timeout: 120_000 });
  await confirmDeactivate.click();
  await expect(dialog, "the confirmation closes once the deactivation is recorded").toHaveCount(0, {
    timeout: 180_000,
  });
  await expect(row, "the account is deactivated").toContainText(/Inactive/, { timeout: 180_000 });
  await expect(page.getByTestId(`staff-reactivate-${staffId}`)).toBeVisible({ timeout: 180_000 });

  // "Reversible": the account is kept, never deleted, and reactivation restores it.
  await page.getByTestId(`staff-reactivate-${staffId}`).click();
  const confirmReactivate = page.getByTestId(`staff-reactivate-confirm-${staffId}`);
  if (await confirmReactivate.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await confirmReactivate.click();
    await expect(dialog).toHaveCount(0, { timeout: 180_000 });
  }
  await expect(row, "the account is reactivated").toContainText(/Active/, { timeout: 180_000 });
  await expect(page.getByTestId(`staff-deactivate-${staffId}`)).toBeVisible({ timeout: 180_000 });

  // Resetting another user's MFA is a supervisor action (REQ-013 / REQ-063). The row
  // reports the account's MFA status, which must no longer read as enrolled. The demo
  // personas are excluded — clearing their enrolment would break demo quick login for the
  // rest of the suite.
  const enrolled = page
    .locator('[data-testid^="staff-row-"]', { hasText: /Enrolled/ })
    .filter({ hasNotText: "Demo " })
    .first();
  await expect(enrolled, "an enrolled staff account is available to reset").toBeVisible({ timeout: 300_000 });
  const mfaStaffId = String(await enrolled.getAttribute("data-testid")).replace("staff-row-", "");

  // Pin the row by id — the filtered locator above would slide to a different row once
  // this one stops matching.
  const mfaRow = page.getByTestId(`staff-row-${mfaStaffId}`);
  const confirmReset = page.getByTestId(`staff-reset-mfa-confirm-${mfaStaffId}`);

  await expect(dialog, "the deactivation confirmation is closed before the next action").toHaveCount(0, {
    timeout: 120_000,
  });

  // Stripping someone's second factor revokes their sessions, so this is confirmed too.
  await page.getByTestId(`staff-reset-mfa-${mfaStaffId}`).click();
  await expect(confirmReset, "resetting another user's MFA asks for confirmation first").toBeVisible({
    timeout: 120_000,
  });
  await expect(dialog.first(), "the confirmation states what the reset does").toContainText(
    /re-enroll multi-factor authentication/i,
  );
  await confirmReset.click();
  await expect(dialog, "the confirmation closes once the reset is recorded").toHaveCount(0, {
    timeout: 180_000,
  });

  await expect(mfaRow, "the reset clears the enrolled MFA status").not.toContainText(/\bEnrolled\b/, {
    timeout: 180_000,
  });
  await expect(mfaRow, "the account is put back on the enrollment path").toContainText(
    /Enrollment required/i,
    { timeout: 180_000 },
  );
});

test("per-application exports download MISMO JSON, MISMO XML and the URLA PDF", async ({ page }) => {
  test.setTimeout(900_000);
  await gotoAs(page, "supervisor", "/supervisor");
  await gotoUntilReady(page, "/supervisor", "supervisor-applications");

  const row = page.locator('[data-testid^="sup-row-"]').first();
  await expect(row).toBeVisible({ timeout: 300_000 });
  const applicationId = String(await row.getAttribute("data-testid")).replace("sup-row-", "");

  await gotoUntilReady(page, `/staff/applications/${applicationId}`, "staff-application-detail");
  await page.getByTestId("detail-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
  await expect(page.getByTestId("export-actions")).toBeVisible({ timeout: 300_000 });

  await expectNonEmptyDownload(
    await download(page, () => page.getByTestId("export-mismo-json-btn").click()),
    /\.json$/i,
    "mismo-json",
  );
  await expectNonEmptyDownload(
    await download(page, () => page.getByTestId("export-mismo-xml-btn").click()),
    /\.xml$/i,
    "mismo-xml",
  );
  await expectNonEmptyDownload(
    await download(page, () => page.getByTestId("export-urla-pdf-btn").click()),
    /\.pdf$/i,
    "pdf",
  );
});

test("global exports download the HMDA LAR and the warehouse extract", async ({ page }) => {
  test.setTimeout(900_000);
  await gotoAs(page, "supervisor", "/supervisor/exports");
  await gotoUntilReady(page, "/supervisor/exports", "exports-lar-download");

  await page.getByTestId("exports-lar-year").selectOption({ index: 0 });
  await expectNonEmptyDownload(
    await download(page, () => page.getByTestId("exports-lar-download").click()),
    /\.(txt|dat|psv|csv)$/i,
    "hmda-lar",
  );

  const warehouseMode = page.getByTestId("exports-warehouse-mode");
  await warehouseMode.selectOption("full").catch(() => warehouseMode.selectOption({ index: 0 }));
  await expectNonEmptyDownload(
    await download(page, () => page.getByTestId("exports-warehouse-download").click()),
    /\.zip$/i,
    "zip",
  );
});
