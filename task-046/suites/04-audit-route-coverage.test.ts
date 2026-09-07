/**
 * §7.7 — audit coverage proven by route enumeration.
 *
 * Every mutating (POST/PUT/PATCH/DELETE) endpoint in contracts.json is either
 * exercised here with a minimal valid call — after which a NEW audit entry must be
 * visible through the contracted supervisor read path — or listed in EXCLUSIONS with
 * a contract-derived justification. The final test fails loudly if any mutating
 * endpoint is in neither set, so an endpoint can never be silently skipped.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  demoLogin,
  extractToken,
  inviteStaff,
  outboundMessagesFor,
  registerBorrower,
  resetTokenFor,
  suitePrefix,
  totpCode,
  freshTotpCode,
  STRONG_PASSWORD,
  type Session,
} from "../helpers/auth.js";
import { ensureAuthHeadroom, readSetting, writeSetting } from "../helpers/config.js";
import { auditEntries } from "../helpers/audit.js";
import { DEL, GET, PATCH, POST, PUT, api, expectOk, type ApiResult, type Session as HttpSession } from "../helpers/http.js";
import { endpointKey, mutatingEndpoints } from "../helpers/contract.js";
import {
  buildSubmittableDraft,
  createDraft,
  getApplication,
  listDocuments,
  makeSsn,
  pdfBytes,
  runCheck,
  awaitCheck,
  saveSection,
  transitionOk,
  uploadDocument,
  type Application,
} from "../helpers/application.js";
import { claim } from "../helpers/application.js";
import { approvalDecision, toPreliminaryDecision } from "../helpers/workflow.js";

const PREFIX = suitePrefix("audit");

/**
 * Mutating endpoints not exercised here, each with the contract reason. These are NOT
 * silent skips: the coverage test asserts this map plus the exercised set is exactly
 * the contract's mutating-endpoint list.
 */
const EXCLUSIONS: Record<string, string> = {
  "POST /api/public/prequalify":
    "REQ-043 pure calculation — returns a computed affordability result and persists no state, so there is no state change to audit.",
  "POST /api/public/compare":
    "REQ-044 pure calculation — scenario comparison persists no state.",
  "POST /api/public/handoff-token":
    "REQ-045 issues a signed stateless hand-off token; no server-side row is created (an expired or tampered token is simply ignored at POST /api/applications).",
  "POST /api/admin/demo-data/seed":
    "REQ-066/ASYNC-006 re-seed removes the prior seed set first; running it would destroy the §4.6.12 demo dataset every other suite and the delivered demo depend on.",
  "DELETE /api/admin/demo-data":
    "REQ-066/WALK-004 deletes every isSeed row including seeded audit entries; destructive to the shared demo dataset.",
  "POST /api/notifications/:id/retry":
    "REQ-068/INT-009 requires a Notification whose external delivery already failed; the simulated provider only fails under SIM_FAULT_* process env, which no contracted endpoint can set at runtime.",
  "POST /api/applications/:id/decision-notification/retry":
    "WF-049 requires decisionNotificationPending, i.e. a failed decision dispatch; reachable only through the same SIM_FAULT_* process env.",

  // The RFP enumerates the audited action set explicitly — transitions, corrections,
  // assignments, underwriting checks, fraud flags, staff management, configuration,
  // exports, seed/remove, signature capture, document status/delete, section copy,
  // co-borrower add/remove, notes, MFA reset and draft delete. Session establishment and
  // notification-read are operational state, not part of that contracted audit domain.
  // (Sign-OUT is audited because SEC-20 makes session revocation a contracted event —
  // the asymmetry is intentional, not a gap.) Each of these six is still exercised in
  // this file's fixture chain; only the audit-row expectation is out of scope.
  "POST /api/test/fixtures":
    "The TEST-ONLY fixture seam (task-046/test-fixtures-contract.md) — demo-gated, absent in production, and not a product surface, so it is outside the audited action set by construction.",

  "POST /api/auth/sign-in":
    "Session establishment is not in the RFP's enumerated audited action set; SEC-20 contracts session REVOCATION (sign-out), not creation.",
  "POST /api/auth/mfa/verify":
    "Completing the MFA challenge is part of session establishment, which the RFP's audited action set does not include.",
  "POST /api/auth/demo-login":
    "NFR-016 demo session establishment — same ruling as sign-in; not in the RFP's enumerated audited action set.",
  "POST /api/auth/resend-verification":
    "Re-issuing a verification token is account-onboarding operational state; REQ-011 does not place it in the audited action set (the registration itself is audited).",
  "POST /api/notifications/:id/read":
    "REQ-070 read-state is per-user operational state on the recipient's own notification, not an application-domain event in the RFP's audited action set.",
  "POST /api/notifications/read-all":
    "REQ-070 bulk read-state — same ruling as the single-notification read.",

  // CH-025 (INV-054): the two token-flow endpoints are mode-gated. Under the
  // keyless simulation this suite runs in, both return the contracted 503
  // not-available and persist nothing — no state change to audit. On a
  // real-mode Layer-B success the exchange persists a BankLink through the
  // same audited path as the credentials flow (`bank-link` action); link-token
  // issuance mutates nothing in any mode (token issuance only, like
  // handoff-token above). Suite 27 exercises both endpoints' 503/validation/
  // role-gate behavior directly.
  "POST /api/applications/:id/bank-links/link-token":
    "CH-025/INV-054 token issuance persists no state in any mode; 503 not-available under the simulation this suite runs in.",
  "POST /api/applications/:id/bank-links/exchange":
    "CH-025/INV-054 503 not-available (no mutation) under simulation; the real-mode success path audits `bank-link` via the shared credentials-flow persistence path, unreachable keyless by design.",
};

interface Outcome {
  addedTypes: string[];
  error?: string;
}

const results = new Map<string, Outcome>();
const exercisedKeys: string[] = [];

let supervisor: Session;
let caseworker: Session;

async function settle(ms = 700): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs a fixture-chain step for an endpoint that is in EXCLUSIONS. The call still
 * runs (later steps depend on it) but no audit expectation is recorded against it.
 */
async function perform(run: () => Promise<void>): Promise<void> {
  await run();
}

/** Runs one endpoint exercise and records the audit rows it produced. */
async function record(key: string, run: () => Promise<void>): Promise<void> {
  exercisedKeys.push(key);
  try {
    await settle();
    const before = new Set((await auditEntries(supervisor, 100)).map((row) => row.id));
    await run();
    await settle(500);
    const after = await auditEntries(supervisor, 100);
    const added = after.filter((row) => !before.has(row.id));
    results.set(key, { addedTypes: added.map((row) => row.actionType) });
  } catch (error) {
    results.set(key, { addedTypes: [], error: (error as Error).message });
  }
}

function assertOk(result: ApiResult<unknown>, what: string, ...accepted: number[]): void {
  const allowed = accepted.length > 0 ? accepted : [200, 201, 202, 204];
  assert.ok(allowed.includes(result.status), `${what}: got ${result.status} ${result.text.slice(0, 300)}`);
}

before(async () => {
  supervisor = await demoLogin("supervisor");
  caseworker = await demoLogin("caseworker");
  await ensureAuthHeadroom(supervisor);

  // ---------------------------------------------------------------- auth surface
  const authEmail = `${PREFIX}-auth@t46.example`;
  let authCookie = "";
  let totpSecret = "";
  let lastTotp = "";
  let currentPassword = STRONG_PASSWORD;
  const rotatedPassword = "Tst-Fixture-Rotated-8823";

  const cookieOf = (result: ApiResult<unknown>): string => {
    for (const entry of result.headers.getSetCookie?.() ?? []) {
      const match = /(mm_session=[^;]*)/.exec(entry);
      if (match) return match[1];
    }
    return "";
  };
  const bare = (): HttpSession => ({ cookie: authCookie, csrfToken: "", userId: "", email: authEmail, role: "BORROWER" });
  const live = async (): Promise<HttpSession> => {
    const info = await GET<{ csrfToken: string; userId: string }>("/api/auth/session", { session: bare() });
    const body = expectOk(info, "GET /api/auth/session", 200);
    return { cookie: authCookie, csrfToken: body.csrfToken, userId: body.userId, email: authEmail, role: "BORROWER" };
  };

  await record("POST /api/auth/register", async () => {
    const result = await POST("/api/auth/register", {
      body: {
        firstName: "Audit",
        lastName: "Fixture",
        email: authEmail,
        password: currentPassword,
        passwordConfirmation: currentPassword,
        acceptTerms: true,
      },
    });
    assertOk(result, "register", 200);
  });

  await record("POST /api/auth/verify-email", async () => {
    const token = extractToken(await outboundMessagesFor(supervisor, authEmail));
    assertOk(await POST("/api/auth/verify-email", { body: { token } }), "verify-email", 200);
  });

  await perform(async () => {
    const result = await POST("/api/auth/sign-in", { body: { email: authEmail, password: currentPassword } });
    assertOk(result, "sign-in", 200);
    authCookie = cookieOf(result);
  });

  await record("POST /api/auth/mfa/enroll", async () => {
    const result = await POST<{ secret: string }>("/api/auth/mfa/enroll", { session: bare() });
    assertOk(result, "mfa/enroll", 200);
    totpSecret = (result.body as { secret: string }).secret;
  });

  await record("POST /api/auth/mfa/enroll/verify", async () => {
    lastTotp = await freshTotpCode(totpSecret, lastTotp);
    const result = await POST("/api/auth/mfa/enroll/verify", { session: bare(), body: { code: lastTotp } });
    assertOk(result, "mfa/enroll/verify", 200);
  });

  await perform(async () => {
    assertOk(await POST("/api/auth/resend-verification", { session: await live() }), "resend-verification", 200);
  });

  await record("PUT /api/profile", async () => {
    const result = await PUT("/api/profile", {
      session: await live(),
      body: { firstName: "Audited", lastName: "Fixture", phone: "614-555-0180" },
    });
    assertOk(result, "PUT /api/profile", 200);
  });

  await record("PUT /api/profile/notification-preferences", async () => {
    const result = await PUT("/api/profile/notification-preferences", {
      session: await live(),
      body: { channel: "email" },
    });
    assertOk(result, "notification-preferences", 200);
  });

  await record("POST /api/profile/sms-verification", async () => {
    assertOk(await POST("/api/profile/sms-verification", { session: await live() }), "sms-verification", 200);
  });

  await record("POST /api/profile/sms-verification/confirm", async () => {
    const messages = await outboundMessagesFor(supervisor, "614-555-0180");
    const code = /\b(\d{4,8})\b/.exec(messages.map((m) => m.body).join(" "))?.[1];
    assert.ok(code, "no SMS verification code in outbound messages");
    const result = await POST("/api/profile/sms-verification/confirm", { session: await live(), body: { code } });
    assertOk(result, "sms-verification/confirm", 200);
  });

  const changedEmail = `${PREFIX}-auth2@t46.example`;
  await record("POST /api/profile/change-email", async () => {
    const result = await POST("/api/profile/change-email", {
      session: await live(),
      body: { newEmail: changedEmail, currentPassword },
    });
    assertOk(result, "change-email", 200);
  });

  await record("POST /api/profile/verify-new-email", async () => {
    const token = extractToken(await outboundMessagesFor(supervisor, changedEmail));
    assertOk(await POST("/api/profile/verify-new-email", { body: { token } }), "verify-new-email", 200);
  });

  // CH-017 cancel path: request a FURTHER change (the account's address is now
  // changedEmail) and then abandon it. Requesting first is what makes this a real
  // exercise — the endpoint's job is clearing a set pendingEmail, and asserting the
  // returned UserProfile proves the contracted "refreshed profile, no follow-up GET".
  const abandonedEmail = `${PREFIX}-auth3@t46.example`;
  await perform(async () => {
    const result = await POST("/api/profile/change-email", {
      session: await live(),
      body: { newEmail: abandonedEmail, currentPassword },
    });
    assertOk(result, "change-email (to be cancelled)", 200);
  });

  await record("DELETE /api/profile/change-email", async () => {
    const result = await DEL<{ pendingEmail?: string; email?: string }>("/api/profile/change-email", {
      session: await live(),
    });
    assertOk(result, "cancel change-email", 200);
    assert.equal(
      result.body.pendingEmail,
      undefined,
      "the cancelled change must clear UserProfile.pendingEmail",
    );
    assert.equal(result.body.email, changedEmail, "cancelling must not touch the active address");
  });

  await record("POST /api/auth/change-password", async () => {
    const result = await POST("/api/auth/change-password", {
      session: await live(),
      body: { currentPassword, newPassword: rotatedPassword },
    });
    assertOk(result, "change-password", 200);
    currentPassword = rotatedPassword;
  });

  await record("POST /api/auth/recovery-codes/regenerate", async () => {
    lastTotp = await freshTotpCode(totpSecret, lastTotp);
    const result = await POST("/api/auth/recovery-codes/regenerate", {
      session: await live(),
      body: { currentPassword, code: lastTotp },
    });
    assertOk(result, "recovery-codes/regenerate", 200);
  });

  await record("POST /api/auth/mfa/reenroll", async () => {
    lastTotp = await freshTotpCode(totpSecret, lastTotp);
    const authenticated = await live();
    const result = await POST<{ secret: string }>("/api/auth/mfa/reenroll", {
      session: authenticated,
      body: { currentPassword, code: lastTotp },
    });
    assertOk(result, "mfa/reenroll", 200);
    const next = (result.body as { secret: string }).secret;
    lastTotp = await freshTotpCode(next, lastTotp);
    // Re-enrollment leaves the session mid-enrollment; keep the CSRF token that was
    // valid before the call rather than re-reading a session that may now be pending.
    assertOk(
      await POST("/api/auth/mfa/enroll/verify", { session: authenticated, body: { code: lastTotp } }),
      "re-enrol verify",
      200,
    );
    totpSecret = next;
  });

  await record("POST /api/auth/sign-out", async () => {
    assertOk(await POST("/api/auth/sign-out", { session: await live() }), "sign-out", 204, 200);
  });

  await perform(async () => {
    const signIn = await POST<{ status: string }>("/api/auth/sign-in", {
      body: { email: changedEmail, password: currentPassword },
    });
    assertOk(signIn, "sign-in for mfa", 200);
    assert.equal((signIn.body as { status: string }).status, "mfa-required");
    authCookie = cookieOf(signIn);
    lastTotp = await freshTotpCode(totpSecret, lastTotp);
    const result = await POST("/api/auth/mfa/verify", { session: bare(), body: { code: lastTotp } });
    assertOk(result, "mfa/verify", 200);
    if (cookieOf(result)) authCookie = cookieOf(result);
  });

  // A dedicated account keeps the reset token unambiguous — the primary fixture's
  // mailbox already holds verification and email-change links.
  const resetEmail = `${PREFIX}-reset@t46.example`;
  assertOk(
    await POST("/api/auth/register", {
      body: {
        firstName: "Reset",
        lastName: "Fixture",
        email: resetEmail,
        password: STRONG_PASSWORD,
        passwordConfirmation: STRONG_PASSWORD,
        acceptTerms: true,
      },
    }),
    "register reset fixture",
    200,
  );
  // Verify first: a reset link is only issued for a verified account, and consuming the
  // verification token here keeps the later reset token unambiguous in the mailbox.
  assertOk(
    await POST("/api/auth/verify-email", {
      body: { token: extractToken(await outboundMessagesFor(supervisor, resetEmail)) },
    }),
    "verify reset fixture",
    200,
  );

  await record("POST /api/auth/forgot-password", async () => {
    assertOk(await POST("/api/auth/forgot-password", { body: { email: resetEmail } }), "forgot-password", 200);
  });

  await record("POST /api/auth/reset-password", async () => {
    // INV-041: reset tokens are redacted out of GET /api/admin/outbound-messages
    // UNCONDITIONALLY — the HTTP harvest WAS the takeover chain the contract
    // closed. The stored row is never rewritten, so read the raw token from the
    // database rather than weakening the redaction.
    const token = await resetTokenFor(resetEmail);
    const result = await POST("/api/auth/reset-password", {
      body: { token, newPassword: "Tst-Fixture-Reset-5591" },
    });
    assertOk(result, "reset-password", 200);
  });

  await perform(async () => {
    assertOk(await POST("/api/auth/demo-login", { body: { role: "borrower" } }), "demo-login", 200);
  });

  // --------------------------------------------------------------- staff admin
  const staffEmail = `${PREFIX}-staff@t46.example`;
  let staffId = "";
  await record("POST /api/admin/staff", async () => {
    const result = await POST<{ id: string }>("/api/admin/staff", {
      session: supervisor,
      body: { firstName: "Audit", lastName: "Caseworker", email: staffEmail, role: "CASEWORKER" },
    });
    assertOk(result, "invite staff", 201);
    staffId = (result.body as { id: string }).id;
  });

  await record("POST /api/auth/accept-invitation", async () => {
    const token = extractToken(await outboundMessagesFor(supervisor, staffEmail));
    assertOk(
      await POST("/api/auth/accept-invitation", { body: { token, password: STRONG_PASSWORD } }),
      "accept-invitation",
      200,
    );
  });

  // reset-mfa needs a target with an active enrollment (INV-003 forbids self-reset).
  const enrolledStaff = await inviteStaff(supervisor, `${PREFIX}-cw-mfa`, "CASEWORKER");
  await record("POST /api/admin/staff/:id/reset-mfa", async () => {
    const path = `/api/admin/staff/${enrolledStaff.account.id}/reset-mfa`;
    assertOk(await POST(path, { session: supervisor }), path, 200);
  });

  await record("POST /api/admin/staff/:id/deactivate", async () => {
    const path = `/api/admin/staff/${staffId}/deactivate`;
    assertOk(await POST(path, { session: supervisor }), path, 200);
  });

  await record("POST /api/admin/staff/:id/reactivate", async () => {
    const path = `/api/admin/staff/${staffId}/reactivate`;
    assertOk(await POST(path, { session: supervisor }), path, 200);
  });

  await record("PUT /api/admin/config", async () => {
    const original = await readSetting(supervisor, "workload.capacityYellow");
    await writeSetting(supervisor, "workload.capacityYellow", "8");
    await writeSetting(supervisor, "workload.capacityYellow", original);
  });

  // ------------------------------------------------------- borrower application
  const borrower = (await registerBorrower(supervisor, `${PREFIX}-b1`)).session;
  let draft: Application;

  await record("POST /api/applications", async () => {
    const result = await POST<Application>("/api/applications", {
      session: borrower,
      body: { requestToken: randomUUID() },
    });
    assertOk(result, "create application", 201);
    draft = result.body as Application;
  });

  await record("PUT /api/applications/:id/sections/:section", async () => {
    const result = await saveSection(
      borrower,
      draft.id,
      "identity",
      { identity: { firstName: "Audit", lastName: "Borrower", ssn: makeSsn(2), dateOfBirth: "1984-02-02" } },
      draft.versionStamp,
      1,
    );
    assertOk(result, "section save", 200);
  });

  await record("POST /api/applications/:id/co-borrower", async () => {
    const path = `/api/applications/${draft.id}/co-borrower`;
    assertOk(await POST(path, { session: borrower }), path, 201);
  });

  await record("DELETE /api/applications/:id/co-borrower", async () => {
    const path = `/api/applications/${draft.id}/co-borrower`;
    assertOk(await DEL(path, { session: borrower }), path, 200);
  });

  await record("POST /api/applications/:id/signatures", async () => {
    const current = await getApplication(borrower, draft.id);
    const path = `/api/applications/${draft.id}/signatures`;
    const result = await POST(path, {
      session: borrower,
      body: { borrowerId: current.borrowers[0].id, mode: "demo", attestationAccepted: true },
    });
    assertOk(result, path, 201);
  });

  let borrowerDocumentId = "";
  await record("POST /api/applications/:id/documents", async () => {
    const result = await uploadDocument(borrower, draft.id, "audit-upload.pdf", pdfBytes(2500), "bank-statement");
    assertOk(result, "document upload", 201);
    borrowerDocumentId = (result.body as { id: string }).id;
  });

  await record("POST /api/documents/:id/versions", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pdfBytes(2600))]), "audit-upload-v2.pdf");
    form.append("documentType", "bank-statement");
    const path = `/api/documents/${borrowerDocumentId}/versions`;
    assertOk(await POST(path, { session: borrower, form }), path, 201);
  });

  await record("DELETE /api/documents/:id", async () => {
    const path = `/api/documents/${borrowerDocumentId}`;
    assertOk(await DEL(path, { session: borrower }), path, 204);
  });

  let linkId = "";
  let linkedAccountIds: string[] = [];
  await record("POST /api/applications/:id/bank-links", async () => {
    const institutions = await GET<{ rows: Array<{ id: string; name: string }> }>("/api/bank-link/institutions", {
      session: borrower,
    });
    const first = expectOk(institutions, "institutions", 200).rows[0];
    assert.ok(first, "the simulated aggregator must publish at least one institution");
    const path = `/api/applications/${draft.id}/bank-links`;
    const result = await POST<{ linkId: string; accounts: Array<{ externalAccountId: string }> }>(path, {
      session: borrower,
      body: { institutionId: first.id, username: "fixture-user", password: "fixture-passphrase" },
    });
    assertOk(result, path, 200);
    const body = result.body as { linkId: string; accounts: Array<{ externalAccountId: string }> };
    linkId = body.linkId;
    linkedAccountIds = body.accounts.map((account) => account.externalAccountId);
  });

  await record("POST /api/applications/:id/bank-links/:linkId/import", async () => {
    assert.ok(linkedAccountIds.length > 0, "the link session must expose at least one account");
    const path = `/api/applications/${draft.id}/bank-links/${linkId}/import`;
    const result = await POST(path, { session: borrower, body: { accountIds: linkedAccountIds.slice(0, 1) } });
    assertOk(result, path, 200);
  });

  await record("DELETE /api/applications/:id/bank-links/:linkId", async () => {
    const path = `/api/applications/${draft.id}/bank-links/${linkId}`;
    assertOk(await DEL(path, { session: borrower }), path, 200);
  });

  await record("DELETE /api/applications/:id", async () => {
    const path = `/api/applications/${draft.id}`;
    assertOk(await DEL(path, { session: borrower }), path, 204);
  });

  // ---------------------------------------------------- submitted-file workflow
  const workflowBorrower = (await registerBorrower(supervisor, `${PREFIX}-b2`)).session;
  const submittable = await buildSubmittableDraft(workflowBorrower);
  let submitted: Application;

  await record("POST /api/applications/:id/transition", async () => {
    submitted = await transitionOk(workflowBorrower, submittable.id, {
      toState: "application_received",
      versionStamp: submittable.versionStamp,
    });
  });

  await record("POST /api/applications/:id/claim", async () => {
    assertOk(await claim(caseworker, submitted.id), "claim", 201);
  });

  await record("POST /api/applications/:id/notes", async () => {
    const path = `/api/applications/${submitted.id}/notes`;
    const result = await POST(path, {
      session: caseworker,
      body: { type: "internal", content: "Audit-coverage note." },
    });
    assertOk(result, path, 201);
  });

  await record("POST /api/applications/:id/corrections", async () => {
    const path = `/api/applications/${submitted.id}/corrections`;
    // INV-039: a correction is an Application write and carries the current
    // versionStamp like every other one.
    const current = await getApplication(caseworker, submitted.id);
    const result = await POST(path, {
      session: caseworker,
      body: {
        versionStamp: current.versionStamp,
        fieldPath: "employments[0].baseMonthlyIncome",
        borrowerOrdinal: 1,
        newValue: "9100",
        reason: "Corrected from the verification of employment.",
      },
    });
    assertOk(result, path, 201);
  });

  await record("POST /api/applications/:id/document-requests", async () => {
    const path = `/api/applications/${submitted.id}/document-requests`;
    const result = await POST(path, {
      session: caseworker,
      body: { documentType: "pay-stub", reason: "Most recent 30 days required." },
    });
    assertOk(result, path, 201);
  });

  let staffDocumentId = "";
  await record("PATCH /api/documents/:id/status", async () => {
    const upload = await uploadDocument(caseworker, submitted.id, "audit-staff.pdf", pdfBytes(2400), "pay-stub");
    assertOk(upload, "staff upload", 201);
    staffDocumentId = (upload.body as { id: string }).id;
    const path = `/api/documents/${staffDocumentId}/status`;
    assertOk(await PATCH(path, { session: caseworker, body: { status: "accepted" } }), path, 200);
  });

  await record("POST /api/documents/:id/ocr/apply-suggestion", async () => {
    const deadline = Date.now() + 60000;
    let extraction: { id: string; fields: Array<{ fieldPath: string; mapped?: boolean }> } | undefined;
    while (Date.now() < deadline && !extraction) {
      const panel = await GET<{ extraction?: { id: string; fields: Array<{ fieldPath: string; mapped?: boolean }> } }>(
        `/api/documents/${staffDocumentId}/ocr`,
        { session: caseworker },
      );
      extraction = expectOk(panel, "ocr panel", 200).extraction;
      if (!extraction) await settle(2000);
    }
    assert.ok(extraction, "the OCR job must produce an extraction (ASYNC-001)");
    const field = extraction.fields.find((entry) => entry.mapped) ?? extraction.fields[0];
    assert.ok(field, "the extraction must carry at least one field");
    // VR-130 / INV-039: apply-suggestion is a correction-bearing write and
    // carries the caller's version stamp, read from the surface's own GET.
    const appPath = `/api/applications/${submitted.id}`;
    const current = expectOk(await GET<{ versionStamp: number }>(appPath, { session: caseworker }), appPath, 200);
    const path = `/api/documents/${staffDocumentId}/ocr/apply-suggestion`;
    const result = await POST(path, {
      session: caseworker,
      body: {
        versionStamp: current.versionStamp,
        extractionId: extraction.id,
        fieldPath: field.fieldPath,
        reason: "Applied from the document.",
      },
    });
    assertOk(result, path, 200);
  });

  await record("POST /api/documents/:id/ocr/retry", async () => {
    const path = `/api/documents/${staffDocumentId}/ocr/retry`;
    assertOk(await POST(path, { session: caseworker }), path, 202);
  });

  await record("POST /api/fraud-flags/:id/resolve", async () => {
    // §6.3.7: a filename containing "mismatch" drives the OCR simulation to a >20%
    // income/balance variance, which XBR-017 turns into a FraudFlag on this file.
    const upload = await uploadDocument(
      caseworker,
      submitted.id,
      "mismatch-paystub.pdf",
      pdfBytes(2600),
      "pay-stub",
    );
    assertOk(upload, "mismatch upload", 201);

    const flagsPath = `/api/applications/${submitted.id}/fraud-flags`;
    const deadline = Date.now() + 90000;
    let open: { id: string; status: string } | undefined;
    while (Date.now() < deadline && !open) {
      const flags = await GET<{ rows: Array<{ id: string; status: string }> }>(flagsPath, { session: caseworker });
      open = expectOk(flags, flagsPath, 200).rows.find((row) => row.status === "open");
      if (!open) await settle(2500);
    }
    assert.ok(open, "the mismatch document must raise an open fraud flag (XBR-017)");
    const path = `/api/fraud-flags/${open.id}/resolve`;
    const result = await POST(path, {
      session: supervisor,
      body: { status: "dismissed", resolutionNote: "Reviewed during audit-coverage fixture setup." },
    });
    assertOk(result, path, 200);
  });

  await record("PATCH /api/applications/:id/priority", async () => {
    const path = `/api/applications/${submitted.id}/priority`;
    const result = await PATCH(path, {
      session: supervisor,
      body: { priority: "high", reason: "Audit-coverage priority change." },
    });
    assertOk(result, path, 200);
  });

  const reassignTarget = await inviteStaff(supervisor, `${PREFIX}-cw2`, "CASEWORKER");
  await record("POST /api/applications/:id/reassignment", async () => {
    const path = `/api/applications/${submitted.id}/reassignment`;
    const result = await POST(path, {
      session: supervisor,
      body: { caseworkerUserId: reassignTarget.session.userId, reason: "Audit-coverage reassignment." },
    });
    assertOk(result, path, 201);
  });

  // A second submitted file supplies the direct-assignment and bulk/auto surfaces.
  const assignBorrower = (await registerBorrower(supervisor, `${PREFIX}-b3`)).session;
  const assignDraft = await buildSubmittableDraft(assignBorrower);
  const assignApplication = await transitionOk(assignBorrower, assignDraft.id, {
    toState: "application_received",
    versionStamp: assignDraft.versionStamp,
  });

  await record("POST /api/applications/:id/assignment", async () => {
    const path = `/api/applications/${assignApplication.id}/assignment`;
    const result = await POST(path, {
      session: supervisor,
      body: { caseworkerUserId: reassignTarget.session.userId, reason: "Audit-coverage assignment." },
    });
    assertOk(result, path, 201);
  });

  const bulkBorrower = (await registerBorrower(supervisor, `${PREFIX}-b4`)).session;
  const bulkDraft = await buildSubmittableDraft(bulkBorrower);
  const bulkApplication = await transitionOk(bulkBorrower, bulkDraft.id, {
    toState: "application_received",
    versionStamp: bulkDraft.versionStamp,
  });

  await record("POST /api/supervisor/assignments/bulk", async () => {
    const result = await POST("/api/supervisor/assignments/bulk", {
      session: supervisor,
      body: {
        applicationIds: [bulkApplication.id],
        caseworkerUserId: reassignTarget.session.userId,
        reason: "Audit-coverage bulk assignment.",
      },
    });
    assertOk(result, "bulk assignment", 200);
  });

  const autoBorrower = (await registerBorrower(supervisor, `${PREFIX}-b5`)).session;
  const autoDraft = await buildSubmittableDraft(autoBorrower);
  const autoApplication = await transitionOk(autoBorrower, autoDraft.id, {
    toState: "application_received",
    versionStamp: autoDraft.versionStamp,
  });

  await record("POST /api/supervisor/assignments/auto", async () => {
    const result = await POST("/api/supervisor/assignments/auto", {
      session: supervisor,
      body: { applicationIds: [autoApplication.id] },
    });
    assertOk(result, "auto assignment", 200);
  });

  // ------------------------------------------------------------- fraud + decisions
  const decisionBorrower = (await registerBorrower(supervisor, `${PREFIX}-b6`)).session;
  const decisionApplication = await toPreliminaryDecision(
    { borrower: decisionBorrower, caseworker, supervisor },
    { estimatedValue: 400000, requestedLoanAmount: 300000 },
  );

  await record("POST /api/applications/:id/checks/:checkType", async () => {
    // INV-031: a check may only start in states 3–8 with an active assignment.
    // ASYNC-005 audits with the result summary when the worker records the result,
    // so the exercise waits for the check to settle before the audit snapshot closes.
    assertOk(await runCheck(caseworker, decisionApplication.id, "credit"), "credit check", 202);
    await awaitCheck(caseworker, decisionApplication.id, "credit");
  });

  await record("POST /api/applications/:id/approval-decision", async () => {
    const result = await approvalDecision(supervisor, decisionApplication.id, {
      decision: "approve",
      notes: "Audit-coverage approval.",
      conditions: ["Provide proof of homeowners insurance."],
    });
    assertOk(result, "approval-decision", 200);
  });

  await record("POST /api/conditions/:id/clear", async () => {
    const approvalsPath = `/api/applications/${decisionApplication.id}/approvals`;
    const records = await GET<{ rows: Array<{ conditions?: Array<{ id: string; status: string }> }> }>(approvalsPath, {
      session: supervisor,
    });
    const condition = expectOk(records, approvalsPath, 200)
      .rows.flatMap((row) => row.conditions ?? [])
      .find((entry) => entry.status === "open");
    assert.ok(condition, "the conditional approval must carry an open condition");
    const path = `/api/conditions/${condition.id}/clear`;
    assertOk(await POST(path, { session: supervisor }), path, 200);
  });

  // --------------------------------------------------------------- notifications
  await perform(async () => {
    const list = await GET<{ rows: Array<{ id: string; readAt?: string }> }>("/api/notifications?pageSize=100", {
      session: supervisor,
    });
    const unread = expectOk(list, "notifications", 200).rows.find((row) => !row.readAt);
    assert.ok(unread, "the supervisor must have at least one unread notification");
    const path = `/api/notifications/${unread.id}/read`;
    assertOk(await POST(path, { session: supervisor }), path, 200);
  });

  await perform(async () => {
    assertOk(await POST("/api/notifications/read-all", { session: supervisor }), "read-all", 200);
  });
});

describe("§7.7 every state-changing endpoint writes an audit entry", () => {
  test("the enumeration accounts for every mutating endpoint in the contract", () => {
    const contracted = mutatingEndpoints.map(endpointKey).sort();
    const accounted = [...new Set([...exercisedKeys, ...Object.keys(EXCLUSIONS)])].sort();
    const missing = contracted.filter((key) => !accounted.includes(key));
    const stray = accounted.filter((key) => !contracted.includes(key));
    assert.deepEqual(missing, [], `mutating endpoints neither exercised nor excluded: ${missing.join(", ")}`);
    assert.deepEqual(stray, [], `enumerated keys that are not contract endpoints: ${stray.join(", ")}`);
    for (const [key, justification] of Object.entries(EXCLUSIONS)) {
      assert.ok(justification.length > 40, `exclusion ${key} needs a contract-derived justification`);
    }
  });

  test("no exercised endpoint failed during setup", () => {
    const errors = [...results.entries()]
      .filter(([, outcome]) => outcome.error)
      .map(([key, outcome]) => `${key}: ${outcome.error}`);
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  for (const key of [...new Set(Object.keys(EXCLUSIONS))]) {
    test(`excluded: ${key}`, () => {
      assert.ok(EXCLUSIONS[key], "an exclusion must carry its justification");
    });
  }
});

describe("§7.7 audit entry produced per exercised endpoint", () => {
  // One assertion per endpoint so a gap names the exact route.
  test("every exercised endpoint produced at least one new audit entry", { timeout: 60000 }, () => {
    const gaps: string[] = [];
    for (const key of exercisedKeys) {
      const outcome = results.get(key);
      if (!outcome) {
        gaps.push(`${key}: never executed`);
        continue;
      }
      if (outcome.error) {
        gaps.push(`${key}: setup error — ${outcome.error}`);
        continue;
      }
      if (outcome.addedTypes.length === 0) {
        gaps.push(`${key}: no audit entry appeared in the supervisor audit log`);
      }
    }
    assert.deepEqual(gaps, [], `\n${gaps.join("\n")}`);
  });

  test("audit rows carry the contracted AuditLogEntryInfo fields", { timeout: 60000 }, async () => {
    const rows = await auditEntries(supervisor, 25);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.timestamp, "string");
      assert.equal(typeof row.actionType, "string");
      assert.equal(typeof row.summary, "string");
      assert.ok(!Number.isNaN(Date.parse(row.timestamp)), `unparseable timestamp ${row.timestamp}`);
    }
  });

  test("no route accepts audit writes for any role (INV-009)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = await api(method, "/api/admin/audit-log", { session: supervisor });
      assert.ok(
        [404, 405].includes(result.status),
        `${method} /api/admin/audit-log must not exist as a write route; got ${result.status}`,
      );
    }
  });
});
