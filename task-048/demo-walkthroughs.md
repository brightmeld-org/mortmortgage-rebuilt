# Demo Walkthroughs (12+)

Executable end-to-end demo walkthroughs for MortMortgage. Each narrative runs from a fresh seed (`npx prisma db seed` with `DEMO_MODE=true`) and is versioned with the seed data.

**Staging caveat (INV-016):** The >90-day approved-staleness-copy source application is staged as `declined_by_borrower` (outcome approved) due to the one-active rule. Decline-from-seed demo requires an application driven to approval live. Withdraw-from-seed works directly.

---

## Setup

```bash
# Ensure demo mode is ON
export DEMO_MODE=true

# Fresh seed
npx prisma db seed

# Start app (dev or docker)
npm run dev  # Terminal 1
npm run worker  # Terminal 2

# Navigate to http://localhost:3083
```

---

## Walkthrough 1: Public Pre-Qualification Calculator → Handoff → New Borrower Registration + MFA

**Estimated duration:** 10 minutes  
**What you'll verify:** Public tools, pre-fill handoff, registration, MFA enrollment

**Steps:**

1. Navigate to http://localhost:3083/
2. Click "Pre-Qualify" (or top nav → Pre-Qualify).
3. Enter:
   - Home price: $400,000
   - Down payment: $80,000 (20%)
   - Annual income: $120,000
   - Monthly debt: $800
   - Loan type: Conventional
   - Loan term: 30 years
4. Observe live outputs (max loan, rate, PITI, max purchase price, qualify indicator).
5. Click "Start an Application with these Numbers".
6. Redirected to /sign-in.
7. Click "Create Account" (or "Don't have an account?").
8. Enter new credentials:
   - Email: testborr@example.com
   - Password: SecurePass123! (12+ chars, 3+ character classes)
   - Accept terms.
9. Click "Create Account".
10. Check Outbound Messages page (http://localhost:3083/supervisor/outbound) → email verification link.
    - In demo mode, click "Verify now" link on the message.
11. Redirected to /sign-in. Sign in with testborr@example.com + password.
12. MFA enrollment screen: scan QR code with authenticator app (or enter manual key).
13. Enter 6-digit code; click "Verify".
14. Save recovery codes (10 codes shown).
15. Redirected to Dashboard.
16. **Success state:** Borrower logged in, dashboard visible, pre-filled Draft application created (Steps 3, 5, 7 pre-filled with calculator values).

---

## Walkthrough 2: Borrower Completes URLA Wizard + Co-Borrower + Upload + Sign + Submit

**Estimated duration:** 20 minutes  
**What you'll verify:** Full wizard, co-borrower, document upload, signature, submission

**Prerequisite:** Logged in as Borrower (use demo login: click "Demo Borrower" on /sign-in)

**Steps:**

1. Dashboard: click "Start New Application" (or edit existing).
2. Fill Step 1 (Identity):
   - First name: John
   - Last name: Smith
   - SSN: 123-45-6789 (masked input)
   - DOB: 1990-05-15
   - Citizenship: US
   - Marital status: Married
   - Dependents: 2
   - Phone: (555) 123-4567
   - Email: john@example.com
3. Click "Add Co-Borrower" toggle (co-borrower tab appears).
4. Fill co-borrower Step 1 data (name, SSN, DOB, etc.).
5. Advance to Step 2 (Address):
   - Current address: 123 Main St, San Francisco, CA 94102
   - Previous address (if >24 months): 456 Oak Ave, Seattle, WA 98101
6. Step 3 (Employment):
   - Current employer: Acme Corp
   - Start date: 2020-01-15
   - Base monthly income: $5,000
7. Step 4 (Assets):
   - Savings account: $100,000 (Bank of America, checking)
8. Step 5 (Liabilities):
   - Car loan: $25,000 unpaid, $500/month
   - Credit card: $5,000 unpaid, $100/month
   - **DTI badge updates live**
9. Step 6 (Subject Property):
   - Address: 789 Elm St, San Francisco, CA 94105
   - Address autocomplete triggers (OSM).
   - Property type: Single Family
   - Occupancy: Primary Residence
   - Value: $500,000
10. Step 7 (Loan):
    - Purpose: Purchase
    - Type: Conventional
    - Term: 30 years
    - Amount: $400,000
    - Down payment: $100,000
    - **LTV badge updates live**
11. Step 8 (Declarations):
    - Answer all 15 yes/no questions (A–M). Select "Yes" for a few; "No" for others.
12. Step 9 (Demographics):
    - Ethnicity: Not Hispanic or Latino
    - Race: White
    - Sex: Male
13. Step 10 (Documents):
    - Checklist shown (Paystubs, tax returns, ID, proof of funds, etc.).
    - Upload 2 documents: drag-drop or click "Upload Documents".
      - File 1: "paystub.pdf" (or any PDF/JPEG)
      - File 2: "form1040.pdf"
    - Documents appear with status "Pending" (OCR job queues).
    - **Wait 5–10 seconds** for OCR to complete (if `WORKER_POLL_INTERVAL_MS=20000`, jobs may take longer in background).
14. Sign both borrowers:
    - Scroll to Signature section.
    - Primary borrower: choose Drawn or Typed, sign (canvas or name field).
    - Co-borrower: same.
    - Check "I acknowledge" attestation box for both.
15. Click "Submit Application".
    - Modal confirms: borrower names, loan details, submission message.
    - Click "Confirm & Submit".
16. **Success state:** Application transitions to "Application Received", Version 1 created, Borrower notified. Dashboard shows application in submitted state.

---

## Walkthrough 3: Borrower Responds to Revision Request + Resubmit

**Estimated duration:** 10 minutes  
**What you'll verify:** Revision workflow, resubmission, version creation

**Prerequisite:** Application in "Revision Requested" state (staged in demo seed)

**Steps:**

1. Log in as Borrower (use demo account or the one from Walkthrough 1).
2. Dashboard: click application in "Revision Requested" state.
3. Revision banner displays with formal note: "Please update employment and clarify asset sources."
4. Click to open application (should be in Steps 1–10 edit mode).
5. Navigate to Step 3 (Employment).
6. Update employment: change employer to "Tech Innovations Inc.", salary to $6,000/month.
7. Navigate to Step 4 (Assets).
8. Add clarification: edit asset source to "Inheritance from father".
9. Re-sign both borrowers (prior signature is invalid after edits).
10. Click "Resubmit Application".
    - Modal confirms: "This is resubmission version 2."
    - Click "Confirm & Resubmit".
11. **Success state:** New version (Version 2) created, application transitions to "Completeness Validated", Caseworker notified of resubmission.

---

## Walkthrough 4: Borrower Withdraws Application

**Estimated duration:** 3 minutes  
**What you'll verify:** Withdrawal, terminal state

**Prerequisite:** Any application in a borrower-withdrawable state (Draft, Submitted, Revision Requested, etc.)

**Steps:**

1. Log in as Borrower.
2. Dashboard: click application.
3. Click "Withdraw" button (top right or state panel).
4. Modal: enter optional reason (e.g., "Decided to wait").
5. Click "Confirm Withdrawal".
6. **Success state:** Application state = "Withdrawn" (terminal, read-only). Assigned Caseworker notified.

---

## Walkthrough 5: Caseworker Claims Application → Corrections → Checks → Preliminary Decision

**Estimated duration:** 15 minutes  
**What you'll verify:** Queue, claim, corrections, underwriting checks, decision workflow

**Prerequisite:** Logged in as Caseworker (click "Demo Caseworker" on /sign-in)

**Steps:**

1. Navigate to /caseworker/queue.
2. Click "Unassigned" tab.
3. Find application in "Application Received" state (staged in seed).
4. Click "Claim" button (or click row, then claim).
5. **Claimed:** Application moves to "My Queue".
6. Click application to open detail.
7. **Corrections:**
   - Navigate to Step 1 (Identity) tab.
   - Click pencil icon on "Dependents Count" field.
   - Edit: change 2 → 3.
   - Click Save. Correction audited.
8. **Advance to Completeness Validated:**
   - Scroll to Workflow Action panel.
   - Select "Validate Completeness" (click button or dropdown).
   - Optional: add internal note ("Documents check out").
   - Confirm. Application transitions to "Completeness Validated".
9. **Advance to Supporting Documents Received:**
   - Navigate to Documents tab.
   - Review each document status (should be "Pending" or "Accepted").
   - For each: click "Accept" or "Waive".
   - Once all accepted/waived, select "Confirm Documents Received" from workflow panel.
   - Confirm. Application → "Supporting Documents Received".
10. **Run Underwriting Checks:**
    - Scroll to Underwriting Checks panel.
    - Click "Run Credit Check". Status: queued → processing → completed (after 5–10 sec).
    - View results: three bureau scores, tradelines, inquiries, risk tier.
    - Click "Run AVM Check". View: property value, comparables, trend, confidence.
    - Click "Run Income Check". View: verified income vs stated, variance %.
    - Click "Run Pricing Check". View: rate scenarios (par, buy-down, lender credit), APR, costs.
    - Click "Run AUS Check". View: recommendation (Approve/Refer/Refer with Caution) + conditions.
11. **Record Preliminary Decision:**
    - Once all checks complete, click "Record Preliminary Decision" (or select from workflow).
    - Recommendation: "Approve"
    - Formal note: "All checks passed. Strong credit (760), 78% LTV, 35% DTI."
    - Conditions: blank (for Approve with no escalation).
    - Click "Record".
    - **Check escalation:** If LTV >80%, DTI >43%, or loan type FHA/VA/USDA → application transitions to "Escalated Review" (awaits Level-2 Supervisor). Otherwise → "Preliminary Decision" (awaits Supervisor L1 review).
12. **Success state:** Preliminary decision recorded, application ready for Supervisor approval.

---

## Walkthrough 6: OCR Review + Apply Suggestion

**Estimated duration:** 8 minutes  
**What you'll verify:** OCR extraction, suggestions, correction workflow

**Prerequisite:** Application with uploaded documents (from Walkthrough 2 or seed with OCR jobs completed)

**Steps:**

1. Log in as Caseworker (or Supervisor).
2. Open application detail → Documents tab.
3. Click a document (e.g., "paystub.pdf").
4. Preview shows image in browser.
5. Click "OCR Panel".
6. Extracted fields displayed:
   - Employer Name: "Acme Corp" (confidence 92)
   - Base Monthly Income: "5000" (confidence 88)
   - Entered values shown alongside for comparison.
7. Confidence colors: green (≥80%), yellow (60–80%), red (<60%).
8. Click "Apply" on a suggestion (e.g., employer name).
9. Value merged into application, audit log records: "Correction from OCR: employerName → Acme Corp (source: document-123)".
10. **Success state:** OCR-extracted value now in application data, audit trail shows source.

---

## Walkthrough 7: Supervisor Assignment Operations + Priority/Suspend

**Estimated duration:** 10 minutes  
**What you'll verify:** Manual assign, bulk assign, auto-assign, priority override, suspend/resume

**Prerequisite:** Logged in as Supervisor (click "Demo Supervisor" on /sign-in)

**Steps:**

1. Navigate to /supervisor (All Applications).
2. **Manual Assignment:**
   - Find unassigned application (state = "Application Received").
   - Click "Assign" or "Assignment" button.
   - Select caseworker from dropdown.
   - Enter optional reason.
   - Click "Assign". Application now assigned, caseworker notified.
3. **Bulk Assignment:**
   - Filter: state = "Application Received" (filter controls at top).
   - Select 3–5 applications (checkboxes).
   - Click "Bulk Assign".
   - Select target caseworker + strategy (workload-balancing or productivity-weighted).
   - Click "Assign". Report shown: "Assigned 5 applications to Caseworker A."
4. **Auto-Assign:**
   - Click "Auto-Assign" button.
   - Select strategy.
   - System assigns unassigned applications to available caseworkers.
   - Report: "Assigned 12 applications to 4 caseworkers."
5. **Priority Override:**
   - Click an assigned application.
   - Click Priority dropdown (Normal by default).
   - Select "Urgent".
   - Assigned caseworker notified; application appears at top of queue.
6. **Suspend/Resume:**
   - Click "Suspend" (or action panel).
   - Enter reason: "Awaiting appraisal update."
   - Click "Suspend". Application state = "Suspended", SLA paused, action panel shows "Resume" button.
   - Click "Resume". Application returns to prior state ("Application Received" or similar), SLA resumes.
7. **Success state:** Assignment operations complete, priority/SLA controls working.

---

## Walkthrough 8: Level-1 Approval → Escalation → Different-Supervisor Level-2 → Borrower Notified

**Estimated duration:** 12 minutes  
**What you'll verify:** Two-level approval workflow, different-approver rule, notification

**Prerequisite:** Application in "Preliminary Decision" state with escalation criteria met (e.g., LTV >80%, DTI >43%, or FHA loan)

**Steps:**

1. Log in as Supervisor A (demo account or created).
2. /supervisor: find application in "Preliminary Decision" with escalation flag.
3. Click application detail.
4. Scroll to Approval section.
5. Click "Level-1 Approve" button.
6. Enter formal note: "Recommend approval. Strong credit, stable employment."
7. Click "Record Approval".
8. **Escalation triggered:** Application transitions to "Escalated Review", awaits Level-2 Supervisor (≠ Level-1).
9. Log out. Sign in as Supervisor B (different Supervisor).
10. /supervisor: find application in "Escalated Review" (filter by pendingApprovalLevel = 2 or "needsMyLevel2 = true").
11. Click application detail.
12. Scroll to Approval section.
13. Click "Level-2 Approve".
14. Enter formal note: "Concur with Level-1 assessment. Approved."
15. Click "Record Approval".
16. **Application transitions:** "Approved" → "Borrower Notified" (system-level transition).
17. Check Outbound Messages page (/supervisor/outbound):
    - Approval notification email/SMS queued.
    - Status: "Sent" or "Delivered" (depends on email backend; demo uses simulated delivery).
18. Log in as Borrower. Dashboard shows application state = "Approved" (or "Borrower Notified").
19. **Success state:** Escalation workflow complete, two different Supervisors recorded approvals, Borrower notified.

---

## Walkthrough 9: Denial with HMDA Reasons + Borrower Decline

**Estimated duration:** 10 minutes  
**What you'll verify:** Denial workflow, HMDA reason codes, decline option

**Prerequisite:** Application in "Preliminary Decision" state

**Steps:**

1. Log in as Supervisor.
2. /supervisor: find application in "Preliminary Decision".
3. Click application detail.
4. Scroll to Approval section.
5. Click "Level-1 Deny" button.
6. Select denial reasons (HMDA codes):
   - Check "Debt-to-income ratio" (reason 2).
   - Check "Employment history" (reason 3).
   - Check "Income level" (reason 6).
7. For "Other" if selected, enter free-text reason: "Unstable gig-work income history."
8. Enter formal note: "Unable to verify sufficient income for requested loan amount. DTI exceeds acceptable threshold."
9. Click "Record Denial".
10. **Application transitions:** "Denied" → "Borrower Notified" (system).
11. Check Outbound Messages: denial notification queued (includes reasons + formal note).
12. Log in as Borrower. Dashboard shows application state = "Denied".
13. Application detail shows: denial reasons (human-readable labels), formal note (visible to Borrower), no "Approve" or "Conditional" options (terminal state).
14. **Success state:** Denial recorded with HMDA reasons, Borrower notified with reasons + note.

---

## Walkthrough 10: Analytics + Audit Log + Config Change

**Estimated duration:** 10 minutes  
**What you'll verify:** Analytics dashboard, audit log, configuration updates

**Prerequisite:** Logged in as Supervisor, seed data includes multiple applications in various states

**Steps:**

1. /supervisor/analytics:
   - View summary cards: total applications, by state, by outcome, by loan type.
   - View charts: volume trend (12-month), status distribution, workload by caseworker.
   - View tables: LTV risk histogram, DTI risk, compliance (HMDA reportable count, denial rate).
   - Change date range (default: last 12 months) → select custom range.
2. Click "Export CSV" on any element → CSV downloads.
3. /supervisor/audit-log:
   - View audit entries: user, action, timestamp, changes (before/after).
   - Filter: action type (state transition, correction, approval, etc.).
   - Filter: application search (number, borrower name).
   - Filter: user search (staff email/name).
   - Filter: date range.
   - Click "Export CSV" → full audit log downloaded (streamed, max 100k rows).
4. /supervisor/settings (or "Settings"):
   - View current thresholds:
     - Escalation LTV threshold: 80%
     - Escalation DTI threshold: 43%
     - Session idle timeout: 30 minutes
     - Password expiration: 180 days
     - HMDA LEI: (blank or seeded value)
   - Edit a threshold: change "Escalation LTV" to 75%.
   - Click "Save Configuration".
   - Confirmation: "Configuration updated successfully."
   - Audit log: new entry "Configuration changed: escalationLtvThreshold 80% → 75%"
5. **Success state:** Analytics visible, audit trail complete and exportable, config changes audited.

---

## Walkthrough 11: Compliance Exports (MISMO/URLA PDF/LAR/Warehouse)

**Estimated duration:** 12 minutes  
**What you'll verify:** Export formats, HMDA LAR, URLA PDF, MISMO JSON/XML

**Prerequisite:** Logged in as Supervisor, application with approved outcome

**Steps:**

1. Open approved application detail.
2. **URLA PDF Export:**
   - Click "Export → URLA PDF".
   - PDF downloads (application form, filled, with signatures, formatted dates "Mon D, YYYY", SSN masked).
   - Open in PDF viewer: verify all steps present, signatures embedded, date/currency formatting.
3. **MISMO JSON (Masked SSN - default):**
   - Click "Export → MISMO JSON".
   - JSON file downloads.
   - Open in text editor: verify structure (MESSAGE → DEAL_SETS → DEAL_SET → DEALS → DEAL → PARTIES, LOANS, COLLATERALS, ASSETS, LIABILITIES).
   - Verify SSN field: `***-**-1234` (masked).
4. **MISMO JSON (Full SSN - Audited):**
   - Click "Export → MISMO JSON (Full SSN)".
   - Prompted for reason: "compliance-audit".
   - JSON downloads with full SSN: `123-45-6789`.
   - Audit log records: "Full-SSN MISMO export by Supervisor B, reason: compliance-audit, timestamp: ..."
5. **URLA Page (Export → URLA PDF):**
   - PDF structure verified in step 2.
6. **HMDA LAR Export:**
   - Navigate to /supervisor/exports (or click "Export → HMDA LAR").
   - Select year: 2025.
   - Click "Export".
   - Pipe-delimited text file downloads.
   - First line: transmittal sheet (Record ID 1, 15 fields).
   - Subsequent lines: application records (Record ID 2, 110 fields each).
   - Verify fields: LEI, ULI, action-taken code (1 for approved, 3 for denied, 4 for withdrawn), HMDA reasons if denied.
7. **Warehouse Extract:**
   - Navigate to /supervisor/exports → Warehouse.
   - Select mode: "full" or "incremental" (incremental requires since-date).
   - Click "Export".
   - ZIP file downloads containing CSVs: dim_borrower, dim_property, fact_application, fact_underwriting, fact_decisions, etc.
   - Extract ZIP: verify CSVs are well-formed, no SSN/DOB in dim_borrower.
8. **Success state:** All export formats download correctly, masking/auditing rules enforced, compliance data ready for filing/warehouse.

---

## Walkthrough 12: Demo Data Re-seed / Remove

**Estimated duration:** 5 minutes  
**What you'll verify:** Demo data seeding, removal, idempotence

**Prerequisite:** Logged in as Supervisor, DEMO_MODE=true

**Steps:**

1. /supervisor/demo-data (or Settings → Demo Data):
   - Button: "Seed Demo Data" (visible only in demo mode).
2. Click "Seed Demo Data".
   - Modal: "This will create ≥50 applications with various statuses. Continue?"
   - Click "Confirm Seed".
   - Page shows "Seeding…" + progress indicator.
   - After 10–30 seconds: report displays record counts (applications, documents, checks, approvals, etc.).
3. Navigate to /supervisor/applications:
   - Verify ≥50 applications are present in various states (Draft, Submitted, Approved, Denied, Withdrawn, etc.).
   - Verify applications have completed checks (credit, AVM, pricing, AUS), approvals, decisions.
4. Return to /supervisor/demo-data.
5. Click "Remove Demo Data".
   - Modal: "This will delete all seed-flagged records. Continue?"
   - Click "Confirm Remove".
   - "Removing…" status shown.
   - After a few seconds: "Removed: X applications, Y documents, Z checks, etc."
6. Navigate to /supervisor/applications:
   - Verify all seed-flagged applications are gone (non-seed applications, if any, remain).
   - Verify database state: only base seed (three demo accounts, SystemConfig) remains.
7. Click "Seed Demo Data" again (idempotence check).
   - Re-seed succeeds, counts match first seed (or are new Seed-Run IDs).
8. **Success state:** Demo data seeded and removed correctly, idempotent re-seed works.

---

## Walkthrough 13+: Additional Scenarios

The above 12 walkthroughs cover primary journeys. Additional scenarios for completeness:

- **Walkthrough 13:** Caseworker profile update + password change + MFA re-enrollment
- **Walkthrough 14:** Staff invitation + onboarding (Supervisor invites new Caseworker, new user signs up with invite token)
- **Walkthrough 15:** Notification preferences + SMS verification (Borrower sets SMS channel, receives verification code)
- **Walkthrough 16:** Conditional approval + condition clearing (Supervisor approves with conditions, Caseworker clears, application transitions to Approved)
- **Walkthrough 17:** Loan comparison tool → pre-fill (Public tool with 3 scenarios, comparison, select scenario, pre-fill handoff)

---

## Validation Checklist

After running walkthroughs, verify:

- [ ] No console errors or 500 HTTP responses
- [ ] All state transitions match spec (§4.5)
- [ ] Audit log entries recorded for every action
- [ ] Notifications sent and queued (check Outbound Messages page)
- [ ] DTI/LTV calculated correctly (cross-check manually)
- [ ] Exports well-formed (PDF opens, JSON/XML parse, CSV readable)
- [ ] Demo data seed/remove idempotent
- [ ] Different-approver rule enforced (L2 ≠ L1)
- [ ] SSN masked in default exports, full in audited exports
- [ ] HMDA reason codes correct in LAR export

---

## Notes

- **Timing:** OCR jobs may take 10–20 seconds depending on WORKER_POLL_INTERVAL_MS. Be patient.
- **Demo accounts:** Email verification bypassed (click "Verify now" on Outbound Messages page).
- **Simulations:** All credit/AVM/pricing/AUS results are deterministic (same input → same output).
- **Stale data:** AVM >30 days old counts as stale; LTV reverts to stated value (ASM-006).
- **INV-016 note:** Approved applications >90 days old staged as declined_by_borrower; live approval needed for fresh decline scenarios.

---

## Support

For walkthrough issues or questions, check application logs (browser console, server stdout) and refer to this guide's linked sections (README.md, user-guide.md, deployment.md).
