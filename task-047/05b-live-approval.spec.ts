/**
 * FLOW-008 (live file) — the Level-1 decision on the application this suite drove from
 * registration through preliminary decision, and the system dispatch that follows.
 *
 * Separated from the seeded approval journeys so a break anywhere in the live chain does
 * not skip the seeded escalation, different-approver and denial coverage.
 */
import { expect, test, type Page } from "@playwright/test";
import { gotoAs, gotoUntilReady, requireState, storagePath } from "./support/journey";

test.use({ storageState: storagePath("supervisor") });

const liveId = () => requireState("liveApplicationId");

async function openDetail(page: Page, applicationId: string): Promise<void> {
  await gotoAs(page, "supervisor", `/staff/applications/${applicationId}`);
  await gotoUntilReady(page, `/staff/applications/${applicationId}`, "staff-application-detail");
  await page.getByTestId("detail-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
  await expect(page.getByTestId("approval-panel")).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(3000);
}

async function recordApproval(page: Page, notes: string): Promise<void> {
  await page.getByTestId("approval-approve-btn").click();
  await page.getByTestId("approval-notes").waitFor({ timeout: 120_000 });
  await page.getByTestId("approval-notes").fill(notes);
  await expect(page.getByTestId("approval-submit-btn")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("approval-submit-btn").click();
  await page.getByTestId("approval-submit-btn").waitFor({ state: "detached", timeout: 300_000 }).catch(() => {});
}

test("Level-1 approval on a non-escalating file completes to Approved and Borrower Notified", async ({
  page,
}) => {
  test.setTimeout(900_000);
  await openDetail(page, liveId());

  // The panel states the recommendation, the qualification summary, the escalation
  // evaluation and any open flags before a decision is possible.
  await expect(page.getByTestId("approval-level")).toContainText("Level 1");
  await expect(page.getByTestId("approval-recommendation")).toBeVisible();
  await expect(page.getByTestId("approval-qualification")).toBeVisible();
  await expect(page.getByTestId("approval-escalation")).toContainText("Escalation required: No");
  await expect(page.getByTestId("approval-open-flags")).toBeVisible();

  await recordApproval(page, "Concur with the caseworker recommendation. Approved at Level 1.");

  // T19 then the system dispatch T27: Approved, then Borrower Notified.
  await expect(page.getByTestId("detail-state-badge")).toHaveText(/Approved|Borrower Notified/, {
    timeout: 300_000,
  });
  await expect
    .poll(
      async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByTestId("detail-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
        return page.getByTestId("detail-state-badge").innerText();
      },
      { timeout: 600_000, intervals: [20_000] },
    )
    .toMatch(/Borrower Notified/);
});
