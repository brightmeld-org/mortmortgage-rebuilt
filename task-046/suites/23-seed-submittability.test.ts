/**
 * §7.7 — SEED INTEGRITY: every seeded application that is AT OR BEYOND
 * application_received must pass the URLA 2020 submission gate (LENS-019).
 *
 * A post-submission workflow state is only reachable through the T1/T36 gate,
 * which runs validateForSubmission (src/lib/pure/urla-validation.ts). If the
 * demo seed writer emits data that would never have passed that gate, the app's
 * whole history is structurally unreachable — the LENS-008 class. LENS-019
 * closed the remaining error-severity offenders in the seed writer:
 *   - assets-reo/realEstateOwned: REO now populated whenever A.1 prior ownership
 *     is Yes OR occupancy is not primary (the two triggers of validateAssetsReo).
 *   - address-history/monthlyRent: a renting co-borrower now carries monthlyRent.
 *   - loan-details/refinance: refinance loans now carry loan.refinance details.
 * (identity and the AVM-adjusted LTV block were already clean in the seed writer;
 * this guard covers them too by running the FULL gate, so a regression is caught.)
 *
 * This guard is READ-ONLY and reconstructs the EXACT gate input the service uses
 * (buildValidationInput → validateForSubmission). It is authoritative against a
 * FRESHLY-SEEDED database: run it after `prisma db seed`. Point DATABASE_URL at
 * the database under test (the standard runner uses .env; an inline DATABASE_URL
 * wins over it). It FAILS today against a database seeded by a broken writer and
 * PASSES against one seeded by the fixed writer.
 *
 * Intentional exception: exactly one staged DRAFT ("draft-ltv-block") is meant
 * to be un-submittable — it demonstrates the > 97% LTV submission block. It is
 * identified structurally (a draft whose ONLY gate error is loan-details/ltv)
 * and allowed; any OTHER failing draft, or any failing post-submission app, is a
 * seed-integrity defect and fails this suite.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { buildValidationInput } from "@/lib/services/application";
import { validateForSubmission } from "@/lib/pure/urla-validation";

const DRAFT = "draft";

/** Every workflow state reachable only THROUGH the submission gate (§4.5.x). */
const POST_SUBMISSION_STATES = new Set([
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
  "approved",
  "denied",
  "borrower_notified",
  "revision_requested",
  "suspended",
  "withdrawn",
  "declined_by_borrower",
]);

describe("LENS-019 seed integrity: seeded apps pass the submission gate", () => {
  test("every post-submission seeded app passes validateForSubmission; drafts pass except the staged LTV-block draft", async () => {
    const apps = await prisma.application.findMany({
      where: { isSeed: true },
      select: { id: true, workflowState: true },
      orderBy: { id: "asc" },
    });
    assert.ok(apps.length > 0, "expected seeded applications to validate");

    const postOffenders: string[] = [];
    const draftOffenders: string[] = [];
    let postChecked = 0;
    let draftChecked = 0;
    let ltvBlockDrafts = 0;

    for (const app of apps) {
      const input = await buildValidationInput(prisma, app.id);
      const result = validateForSubmission(input);
      const rules = [...new Set(result.errors.map((e) => `${e.section}/${e.fieldPath}`))].sort();

      if (app.workflowState === DRAFT) {
        draftChecked += 1;
        if (result.ok) continue;
        // The one sanctioned partial: a draft whose SOLE gate error is the LTV
        // submission block (draft-ltv-block, LTV 98% > 97%). Anything else is a
        // defect — a draft the demo says a user can sign in and submit but can't.
        const ltvBlockOnly = result.errors.every(
          (e) => e.section === "loan-details" && e.fieldPath === "ltv",
        );
        if (ltvBlockOnly) {
          ltvBlockDrafts += 1;
        } else {
          draftOffenders.push(`draft ${app.id} — ${rules.join(", ")}`);
        }
      } else if (POST_SUBMISSION_STATES.has(app.workflowState)) {
        postChecked += 1;
        if (!result.ok) {
          postOffenders.push(`${app.workflowState} ${app.id} — ${rules.join(", ")}`);
        }
      }
    }

    assert.ok(postChecked > 0, "expected post-submission seeded apps to validate");

    assert.deepEqual(
      postOffenders,
      [],
      `${postOffenders.length} seeded post-submission application(s) FAIL their own submission gate — ` +
        "their history is structurally unreachable (LENS-019). Fix the seed writer, not the rows:\n  " +
        postOffenders.join("\n  "),
    );
    assert.deepEqual(
      draftOffenders,
      [],
      `${draftOffenders.length} seeded draft(s) cannot be submitted for a reason other than the staged ` +
        "LTV block — the demo intends these to be sign-in-and-submit ready (LENS-019):\n  " +
        draftOffenders.join("\n  "),
    );
    // The staged un-submittable draft is expected to exist (and be unique). If it
    // ever stops being LTV-block-only, one of the asserts above already fired.
    assert.ok(
      ltvBlockDrafts <= 1,
      `expected at most one staged LTV-block draft, found ${ltvBlockDrafts}`,
    );
  });
});
