# MortMortgage User Guide

This guide covers every primary user journey in the system: registration, application completion, underwriting, approval, and compliance workflows. Terminology follows the **Glossary** in requirements.md §12.

---

## Table of Contents

1. [Borrower Journeys](#borrower-journeys)
2. [Caseworker Journeys](#caseworker-journeys)
3. [Supervisor Journeys](#supervisor-journeys)
4. [Public Tool Journeys](#public-tool-journeys)
5. [Glossary Reference](#glossary-reference)

---

## Borrower Journeys

### Journey 1: Registration & MFA Setup

**Starting state:** No account

**Steps:**

1. Navigate to the Sign Up page.
2. Enter email, password (min 12 chars, ≥3 of 4 character classes), confirm password, and accept terms.
3. Click Create Account.
4. A verification email is sent; open it and click the verification link (demo mode: link appears on the Outbound Messages page; click "Verify now").
5. You are redirected to the Sign In page. Sign in with your email and password.
6. MFA enrollment screen appears: scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, etc.) or enter the manual key.
7. Enter a 6-digit code from the app and click Verify.
8. 10 single-use recovery codes are shown. Save them in a secure location (if lost, you cannot sign in without a Supervisor reset).
9. MFA enrollment complete. You are redirected to your Dashboard.

**Outcome:** Borrower account created, verified, and MFA-enrolled. Ready to apply.

---

### Journey 2: Creating & Copying an Application

**Starting state:** Signed in (Borrower), Dashboard visible

**Steps:**

1. Click "Start New Application" or the New Application button.
2. Enter **Loan Purpose** (purchase or refinance), **Loan Type** (conventional, FHA, VA, USDA), **Requested Loan Amount**, and optionally **Down Payment**.
3. Optionally select "Copy sections from a prior application" and pick a previous application. A staleness advisory appears if the copied section is >90 days old.
4. Click Create Application.
5. You are taken to Step 1 (Borrower Identity) of the URLA wizard in Draft mode.

**Outcome:** New application created in Draft state. You can now complete the 10-step wizard or return later (auto-save preserves progress).

**Staleness Advisory:** If you copy sections >90 days old, a banner persists until you edit or confirm the data.

---

### Journey 3: Completing the URLA Wizard

**Starting state:** Application in Draft, at Step 1

**Wizard Steps:**

| Step | Section | Content |
|------|---------|---------|
| 1 | Borrower Identity | Name, SSN, DOB, citizenship, marital status, dependents, phones, email, military service, credit type |
| 2 | Address History | Current address, previous addresses (24-month coverage), housing status, rent, mailing address |
| 3 | Employment & Income | Current/previous employment (24-month), self-employment, other income, bank linking (optional) |
| 4 | Assets & REO | Bank/investment accounts, other assets/credits, real estate owned with mortgages |
| 5 | Liabilities | Loans, lines of credit, other debts; DTI badge live-updates |
| 6 | Subject Property | Address, type, occupancy, units, value, closing date, rental income |
| 7 | Loan Details | Purpose, type, term, amount, down payment, proposed housing expense; LTV badge live-updates |
| 8 | Declarations | 15 yes/no questions (A–M) with conditional detail fields |
| 9 | Demographics (HMDA) | Ethnicity, race, sex, all optional with "do not wish to provide" option |
| 10 | Documents & Review | Upload required documents (checklist), review summary, sign & attest, submit |

**Navigation:**

- Click a step number to jump to it (no skipping required).
- Address fields have autocomplete (OSM-compatible).
- Currency fields accept `$1,234.56` format; saved as `1234.56`.
- Auto-save occurs every 2 seconds + on step navigation.
- A "Saved" indicator confirms persistence; "Save failed — retrying" shows transient network issues.

**DTI & LTV Display:**

- **DTI (Debt-to-Income):** Numerator = housing expense + other debts; denominator = gross monthly income. Live-updated. Warning at >43%.
- **LTV (Loan-to-Value):** Loan amount ÷ min(stated value, AVM). Warning >80%, blocks submission >97%.
- **CLTV (Combined LTV):** All liens ÷ value. Displayed alongside LTV.

**Validation:**

- Step-level required fields are marked with `*`. Free navigation allowed even with errors.
- Before submission, a cross-step validation panel shows all errors.
- Submission is blocked if any required field is missing, LTV >97%, or no signatures.

**Outcome after completing all steps:** Application is in Draft. Proceed to Journey 4 (Sign & Submit).

---

### Journey 4: Co-Borrower (Optional)

**Starting state:** Application in Draft, any step

**Steps:**

1. On any step, click "Add Co-Borrower" toggle.
2. A co-borrower tab appears alongside the primary borrower.
3. Enter co-borrower data in Steps 1 (Identity), 2 (Address), 3 (Employment), 8 (Declarations), and 9 (Demographics).
4. Steps 4–7 (Assets/Liabilities/Property/Loan) are shared; no separate co-borrower entry.
5. Both borrowers must sign before submission.
6. To remove, click "Remove Co-Borrower" and confirm. All co-borrower data is deleted.

**Outcome:** Co-borrower data integrated; submission validates signatures from both.

---

### Journey 5: Document Upload & Management

**Starting state:** Application in Draft, Step 10 (Documents) visible

**Steps:**

1. Review the checklist of required documents by loan type (e.g., paystubs, tax returns, employment verification).
2. Click "Upload Documents" or drag-drop into the zone.
3. Select documents (PDF/JPEG/PNG, max 10 MB each, max 25 per application).
4. Files appear with status Pending; a background OCR job starts automatically.
5. View OCR results: click the document → OCR panel shows extracted fields, confidence scores, and entered-vs-extracted comparison.
6. To accept an OCR suggestion: click the suggestion → value is applied to the application and audited.
7. Once uploaded, Caseworker/Supervisor can mark documents Accepted, Insufficient (with reason), or Waived (with reason).
8. To replace: upload a new version. Prior versions are retained and downloadable by staff.
9. To delete (Borrower, Draft only): click Delete and confirm. All versions are removed.

**Checklist statuses:**
- Pending: awaiting action
- Accepted: satisfies the checklist item
- Insufficient: rejected, reason recorded
- Waived: requirement waived, reason recorded

**Outcome:** All required documents uploaded and accepted. Checklist ready for submission.

---

### Journey 6: Bank Account Linking

**Starting state:** Application in Draft, Step 3 (Employment & Income)

**Steps:**

1. In Step 3, click "Link Bank Account" (optional; manual entry always available).
2. Select your financial institution from a list (simulated — demo uses a synthetic list).
3. Provide your online banking credentials (simulated; demo does not connect to real banks).
4. Select accounts to import (checking, savings, etc.).
5. Imported transactions appear in Step 4 (Assets) with source "bank link".
6. The system analyzes 90 days of payroll deposits and surfaces an income-evidence panel in Step 3.
7. Review and accept the auto-detected income.
8. To unlink: click Unlink. Tokens are deleted; imported rows remain editable as manual entries.

**Outcome:** Bank data imported; income verified or flagged for review.

---

### Journey 7: Signature & Attestation

**Starting state:** Application in Draft, Step 10, validation passed, all required docs uploaded

**Steps:**

1. On Step 10, scroll to the Signature section.
2. Choose Drawn (canvas) or Typed (script-style) signature.
3. Drawn: use mouse/touch to draw; Typed: enter name in script font.
4. Read the URLA §6 acknowledgment text and check "I acknowledge and agree".
5. Click "Sign & Attest" (or in demo mode, "Accept demonstration attestation").
6. Signature image is saved (≤200 KB PNG); signer/timestamp/IP/user agent/attestation version all recorded.
7. Any subsequent edit to application data invalidates the signature (requires re-sign).

**Demo mode:**
- In demo mode, a "Accept demonstration attestation" button bypasses drawing and instantly records signature.
- This is absent in production (`DEMO_MODE=false`).

**Outcome:** Signature recorded. Application ready to submit.

---

### Journey 8: Submit Application

**Starting state:** Application in Draft, all steps completed, validated, all signed, one-active-application rule confirmed

**Steps:**

1. On Step 10, click "Submit Application".
2. A modal confirms: borrower name, loan details, loan amount, submission acknowledgment.
3. Click "Confirm & Submit".
4. Server validates (again): all required fields, LTV ≤97%, signatures present, no other active application.
5. If successful: Application transitions to "Application Received" state, Version 1 is created, borrower and all Supervisors are notified.
6. If errors: the exact error message is shown in a dismissible banner; you can edit and retry.

**One-Active-Application Rule:** At most one non-Draft, non-terminal application per Borrower. Second submission rejected with a named-application message.

**Outcome:** Application submitted. Workflow state is "Application Received". Caseworker can now claim and process.

---

### Journey 9: Revision Response & Resubmission

**Starting state:** Application in Revision Requested state, borrower receives revision notification

**Steps:**

1. Borrower notified via preferred channel (email/SMS/in-app) that revisions are requested.
2. Log in to Dashboard; application shows "Revision Requested" with a revision banner.
3. Click to open the application.
4. A formal note (staff feedback) is displayed at the top.
5. Review corrections marked by staff (fields show hover/focus provenance).
6. Edit all steps as needed.
7. Navigate to Step 10 (Documents & Review).
8. Re-sign (prior signature is invalid after any edit).
9. Click "Resubmit Application".
10. Server validates and creates Version n+1 (e.g., Version 2). Revision cycle counter increments.
11. Caseworker is notified that revision is submitted.

**Outcome:** New version created. Underwriting resumes.

---

### Journey 10: Withdraw Application

**Starting state:** Application in any borrower-withdrawable state

**Steps:**

1. Click the Withdraw button (available from Dashboard or application detail).
2. Optional: enter a withdrawal reason.
3. Click "Confirm Withdrawal".
4. Application transitions to Withdrawn (terminal). Assigned Caseworker is notified.
5. Application is read-only; no further edits permitted.

**Outcome:** Application withdrawn and terminal.

---

### Journey 11: Decline Approved Application

**Starting state:** Application outcome=approved (Approved, Conditional Approval, or Borrower Notified-approved)

**Steps:**

1. Borrower receives approval notification via preferred channel.
2. Log in to Dashboard; application shows an approval state.
3. Click the Decline button.
4. Optional: enter a reason.
5. Click "Confirm Decline".
6. Application transitions to Declined by Borrower (terminal).
7. Caseworker and Supervisor are notified.

**Outcome:** Application declined. Caseworker and supervisors see the decision.

---

### Journey 12: Profile Management

**Starting state:** Signed in (any role)

**Steps:**

1. Click Profile (or user menu).
2. Edit name or phone.
3. To change email: enter current password, new email, and confirm. Verification email sent. Click the link to activate.
4. To change password: enter current password, new password (same complexity rules as registration), confirm.
5. To re-enroll MFA: enter current password and current TOTP/recovery code. New QR code and recovery codes generated.
6. To regenerate recovery codes: enter current password and current TOTP/recovery code. 10 new codes issued.
7. Notification preferences (Email/SMS/Both): select channel, verify mobile if SMS.

**Outcome:** Profile updated. Changes take effect immediately (password change revokes all other sessions).

---

### Journey 13: Notification Preferences

**Starting state:** Signed in (Borrower)

**Steps:**

1. Profile → Notification Preferences.
2. Select Email, SMS, or Both (default: Email).
3. If SMS: verify your mobile number. Click "Send Code", check SMS, enter code.
4. Preferences saved. Notifications delivered via selected channel.

**Note:** In-app notifications always on (no opt-out).

**Outcome:** Notifications routed to preferred channel.

---

## Caseworker Journeys

### Journey 1: Demo Login & Dashboard

**Starting state:** Application home page (demo mode only)

**Steps:**

1. On /sign-in, click "Demo Caseworker" button.
2. One-click login with demo credentials (no password required).
3. Redirect to Caseworker Dashboard (/caseworker/queue).
4. Dashboard shows:
   - My Queue tab (applications assigned to me)
   - Unassigned tab (claimable applications)
   - Completion History (12-month overview, last 25 completions)
   - Stats strip (queue size, completions this month, avg days to decision, approval rate, overdue count)

**Outcome:** Caseworker logged in and viewing queue.

---

### Journey 2: Claim Unassigned Application

**Starting state:** Caseworker Dashboard, Unassigned tab visible

**Steps:**

1. Click Unassigned tab.
2. See paginated list of applications in claimable states (Submitted, Revision Requested, etc.).
3. Columns: Application number, borrower name, loan amount, loan type, submission date, state, priority, SLA status.
4. Click a row or "Claim" button.
5. Atomic claim: if another caseworker claims it simultaneously, you see "Already claimed" and the row vanishes.
6. If successful: application assigned to you; you see it in My Queue.
7. Click to open application detail.

**Outcome:** Application claimed. You are the assigned Caseworker.

---

### Journey 3: Application Detail & Corrections

**Starting state:** Caseworker viewing claimed application detail

**Tabs & Actions:**

| Tab | Content |
|-----|---------|
| **Overview** | Borrower names, loan details, property, current state, SLA status, assigned caseworker, priority, workflow action panel |
| **Identity** | Borrower info (SSN masked, DOB masked, contact) |
| **Address** | Current and previous addresses (24-month) |
| **Employment** | Employment records and income |
| **Assets** | Bank accounts, other assets, REO |
| **Liabilities** | Loans, credit accounts, other debts; DTI display |
| **Property** | Subject property, address, value, AVM results (if run) |
| **Loan** | Loan details, purpose, type, term, amount, refinance details |
| **Declarations** | All 15 yes/no answers per borrower |
| **Demographics** | HMDA race/ethnicity/sex per borrower |
| **Documents** | Upload/status/version history/OCR panel |
| **Versions** | Full snapshots at submission/resubmission; two-version diff |
| **Corrections** | Field-level edits by staff; audit trail |
| **Notes** | Internal (staff-only) and formal (visible to Borrower) |
| **Workflow History** | All state transitions and decision records |

**Inline Corrections:**

1. In permitted states (Completeness Validated, Supporting Documents Received, AUS Executed, Preliminary Decision), click the pencil icon on a field.
2. Edit the value (no version created).
3. Optionally mark corrected fields with hover tooltip showing who/when/reason.
4. Save. Correction is audited with before/after values.
5. If the correction impacts DTI/LTV/income/liability/property value/loan amount, DTI/LTV are recalculated server-side and AUS marked stale.

**Outcome:** Application data corrected. Audit trail updated.

---

### Journey 4: Document Review & OCR

**Starting state:** Caseworker viewing Documents tab

**Steps:**

1. See checklist with status (Pending/Accepted/Insufficient/Waived) and current document version.
2. Click a document to preview (PDF/image in browser).
3. Click "OCR Panel" to view extracted fields:
   - **Extracted Value:** OCR-recognized text
   - **Entered Value:** Borrower's manual entry (if any)
   - **Confidence:** Color-coded (red <60%, yellow 60–80%, green ≥80%)
   - **Variance %:** Difference between extracted and entered (if applicable)
4. Apply suggestions: click "Apply" on an extracted field. Value is merged into the application and audited.
5. Update status: click Accept/Insufficient/Waive and optionally add reason.
6. For Insufficient documents, caseworker can click "Request Document" → borrower notified with required document type + reason.
7. Upload new version: borrower uploads; new DocumentJob queued.

**Outcome:** Document reviewed, OCR processed, checklist status updated.

---

### Journey 5: Underwriting Checks (Credit, Income, AVM, Pricing, AUS)

**Starting state:** Caseworker in Supporting Documents Received state (or later)

**Steps:**

1. Click "Underwriting Checks" or scroll to the checks panel.
2. Each check shows a "Run" button if not yet completed:
   - **Credit:** tri-bureau credit report (deterministic simulation)
   - **Income:** income verification (payroll/tax analysis)
   - **AVM:** automated valuation model (property value estimate)
   - **Pricing:** rate quote (buy-down, lender credit scenarios)
   - **AUS:** automated underwriting system recommendation (Approve/Refer/Refer with Caution)
3. Click "Run [Check]".
4. Status shows queued → processing → completed or failed.
5. View results:
   - **Credit:** three bureau scores, tradelines, inquiries, collections, risk tier
   - **Income:** verified vs stated, flags if mismatch
   - **AVM:** property value, comparables, trend, confidence
   - **Pricing:** rate by scenario (par, buy-down, lender credit), APR, costs, term
   - **AUS:** recommendation with condition notes
6. If a check fails: retry is available.
7. If LTV >80%, DTI >43%, or loan type FHA/VA/USDA: escalation flag set (two-level approval required).

**Outcome:** All underwriting checks completed. Application ready for preliminary decision.

---

### Journey 6: Preliminary Decision & Escalation

**Starting state:** Application in AUS Executed state, all checks completed and not stale

**Steps:**

1. Caseworker (or Supervisor on behalf of caseworker) navigates to the Preliminary Decision section.
2. Enters:
   - **Recommendation:** Approve or Deny
   - **Formal Note:** Reasoning (visible to Supervisor and Borrower if approved)
   - **Conditions (if Approve):** free-text conditions to be cleared before final approval
3. Click "Record Preliminary Decision".
4. Application transitions to:
   - **Preliminary Decision** (no escalation criteria met) → awaiting Supervisor review
   - **Escalated Review** (escalation criteria met) → awaiting Level-2 Supervisor review
5. All Supervisors notified.

**Escalation Criteria** (configurable defaults):
- LTV >80%
- DTI >43%
- Loan Type FHA/VA/USDA

**Outcome:** Preliminary decision recorded. Workflow advances; awaiting supervisor approval.

---

### Journey 7: Notes & Chatter

**Starting state:** Caseworker viewing application detail, Notes tab

**Types of Notes:**

- **Internal:** Staff-only, visible only to Caseworker and Supervisor, not to Borrower
- **Formal:** Attached to a decision (approval/denial/revision) and visible to Borrower
- **Chatter:** Persistent, chronological conversation among staff on the application; 15-second polling refresh; visible only to staff

**Steps:**

1. Click "Add Internal Note" → enter text → save. Audited.
2. Click "Add Formal Note" (when recording a decision) → text recorded with the decision.
3. Chatter: type a message in the chatter pane → posted instantly; other staff see it refresh every 15 seconds.

**Outcome:** Communication recorded and audited.

---

### Journey 8: Transition States

**Starting state:** Caseworker in application detail, Overview tab

**Workflow Actions:**

Depending on the current state, the action panel shows valid transitions:

| From State | Valid Caseworker Transitions |
|------------|------------------------------|
| Completeness Validated | Run AUS, Request revision, Withdraw (if Borrower), Suspend |
| Supporting Documents Received | Run AUS, Request revision, Withdraw, Suspend |
| AUS Executed | Record preliminary decision, Request revision, Withdraw, Suspend |
| Preliminary Decision | (Caseworker cannot approve; only Supervisors record final decisions) |

**Steps:**

1. Select action from the workflow panel (e.g., "Request Revision").
2. Optionally enter a formal note.
3. Confirm.
4. State transitions. Borrower and stakeholders notified.

**Outcome:** Workflow advanced; audit trail updated.

---

## Supervisor Journeys

### Journey 1: Demo Login & Dashboard

**Starting state:** Application home page (demo mode only)

**Steps:**

1. On /sign-in, click "Demo Supervisor" button.
2. One-click login.
3. Redirect to Supervisor Dashboard (/supervisor).
4. Dashboard shows all applications with auto-applying filters:
   - State, Caseworker, Priority, SLA status, Loan type, Date range, Pending approval level, Needs my L2

**Outcome:** Supervisor logged in with full application visibility.

---

### Journey 2: Application Management & Assignment

**Starting state:** Supervisor Dashboard, applications list visible

**Manual Assignment:**

1. Click an unassigned application (or click "Assign" on an assigned one to reassign).
2. Select a caseworker from the dropdown.
3. Click "Assign".
4. Assignment created; caseworker notified.

**Bulk Assignment:**

1. Filter applications (e.g., state=Submitted, caseworker=Unassigned).
2. Select multiple rows (checkbox).
3. Click "Bulk Assign".
4. Select target caseworker and strategy (even workload, productivity-weighted, or manual).
5. Click "Assign".
6. Per-application success/conflict reported.

**Auto-Assign:**

1. Click "Auto-Assign".
2. Select strategy (workload-balancing or productivity-weighted).
3. System automatically assigns unassigned applications to available caseworkers.
4. Report shown with assignment counts.

**Reassignment:**

1. On an assigned application, click "Reassign".
2. Select new caseworker.
3. Enter reason.
4. Prior caseworker and new caseworker notified.

**Outcome:** Applications assigned or reassigned. Workload distributed.

---

### Journey 3: Priority & SLA Override

**Starting state:** Supervisor viewing an application

**Steps:**

1. Click Priority dropdown (Normal, Low, High, Urgent).
2. Select new priority.
3. Optionally override SLA (Supervisor action, audited).
4. Click Suspend to pause SLA clock; Resume to restart.
5. All actions audited; assigned caseworker notified of changes.

**Outcome:** Application priority and SLA status updated.

---

### Journey 4: Level-1 & Level-2 Approval

**Starting state:** Application in Preliminary Decision state (L1) or Escalated Review state (L2)

**Level-1 Approval (Supervisor):**

1. Click "Approve" or "Deny".
2. If Approve:
   - Enter formal note (optional).
   - If escalation criteria met: application moves to Escalated Review (awaits different Supervisor's L2).
   - If no escalation: application transitions to Approved → Borrower Notified.
3. If Deny:
   - Select denial reasons (checkboxes + free-text "other" field).
   - Enter formal note.
   - Application transitions to Denied → Borrower Notified.

**Level-2 Approval (Different Supervisor, escalated files only):**

1. Application in Escalated Review awaits L2 Supervisor (must be ≠ L1 Supervisor).
2. L2 Supervisor clicks "Approve" or "Deny" (same workflow as L1).
3. If Approve: application moves to Approved → Borrower Notified.
4. If Deny: transitions to Denied → Borrower Notified.

**Different-Approver Rule:** Level-2 must be a different Supervisor than Level-1. System rejects if same.

**Outcome:** Decision recorded. Application transitions to final state; Borrower notified.

---

### Journey 5: Denial with HMDA Reasons

**Starting state:** Supervisor recording Level-1 or Level-2 denial

**Steps:**

1. Click "Deny".
2. Select denial reasons (HMDA reasons from a fixed list):
   - Credit history
   - Debt-to-income ratio
   - Employment history
   - Insufficient collateral / Property value
   - Insufficient funds for down payment
   - Income level
   - Loan amount requested
   - Property type
   - Credit application pending
   - Other
3. For "Other," enter free-text reason.
4. Enter formal note (required).
5. Click "Record Denial".
6. Application transitions to Denied → Borrower Notified.
7. Denial notification includes decision + formal note + reasons (customer-facing).

**Outcome:** Denial recorded with HMDA reasons. LAR export includes reason codes.

---

### Journey 6: Conditional Approval & Condition Clearing

**Starting state:** Supervisor recording Level-1 approval with conditions

**Steps:**

1. Click "Approve" but indicate conditions exist.
2. Enter condition details: "Appraisal must support value of $350,000" or "Homeowner's insurance quote required by [date]".
3. Click "Record Conditional Approval".
4. Application transitions to Conditional Approval.
5. Borrower notified of conditions + formal note.
6. Caseworker or Supervisor can clear conditions:
   - Navigate to Conditional Approval → Conditions tab.
   - Review condition; click "Clear".
   - Application moves to Approved → Borrower Notified.

**Outcome:** Conditions tracked; application progresses when conditions met.

---

### Journey 7: Caseworker & Staff Management

**Starting state:** Supervisor, Admin → Staff page

**Steps:**

1. View all caseworkers and supervisors (active/inactive).
2. To invite a new staff member:
   - Click "Invite Staff".
   - Enter name, email, role (Caseworker or Supervisor).
   - Click "Send Invitation".
   - Invitation email sent with accept-link (contains one-time token).
   - New staff member sets password + MFA on acceptance.
3. To deactivate: click "Deactivate". Their active assignments return to Unassigned; they cannot sign in.
4. To reactivate: click "Reactivate".
5. To reset MFA: click "Reset MFA" (they must re-enroll on next sign-in).

**Outcome:** Staff roster managed. Invitations sent.

---

### Journey 8: Configuration & Thresholds

**Starting state:** Supervisor, Admin → Configuration page

**Settings:**

| Setting | Default | Purpose |
|---------|---------|---------|
| Escalation LTV Threshold | 80% | Applications above trigger L2 approval |
| Escalation DTI Threshold | 43% | Applications above trigger L2 approval |
| Escalation Loan Types | FHA, VA, USDA | Loan types triggering escalation |
| Password Min Length | 12 | Enforce password length (≥8) |
| Password Expiration Days | 180 | Force password change interval (configurable) |
| MFA Lockout Failures | 5 | Lockout after N failed MFA attempts |
| MFA Lockout Minutes | 15 | Duration of MFA lockout |
| Session Idle Timeout Mins | 30 | Idle session timeout |
| Session Absolute Timeout Hrs | 12 | Max session lifetime |
| SLA Days by State | (configurable) | Service level targets by workflow state |
| HMDA LEI | (blank) | Legal Entity Identifier for HMDA reporting |
| HMDA Agency Code | (blank) | Federal agency code (409 if not set) |

**Steps:**

1. Edit threshold or setting.
2. Click "Save Configuration".
3. Change is audited; message displayed on success.

**Outcome:** System configuration updated.

---

### Journey 9: Analytics & Reporting

**Starting state:** Supervisor, Analytics page

**Elements:**

| Element | Data |
|---------|------|
| **Summary** | Total applications, by state, by outcome, by loan type |
| **Volume Trend** | Applications received per month (12-month rolling) |
| **Status Distribution** | Pie chart by workflow state |
| **Loan Type Distribution** | Pie chart by loan type |
| **Property Type Distribution** | Pie chart by property type |
| **Workload by Caseworker** | Applications per caseworker, SLA compliance |
| **LTV Risk** | Histogram of LTV distribution, high-risk count |
| **DTI Risk** | Histogram of DTI distribution, high-risk count |
| **Performance Trend** | Approval rate, avg days to decision, overdue %, over 12 months |
| **Compliance** | HMDA reportable count, denials vs approvals, demographic collection % |
| **Pending Approvals** | Applications awaiting my L1/L2 signature |
| **Activity** | Caseworker activity (applications claimed, corrections, approvals) |

**Steps:**

1. Select date range (default: last 12 months; max span: 3 years).
2. View charts and tables.
3. Click "Export CSV" for any element to download tabular data.

**Outcome:** Insights into application volume, underwriting performance, compliance.

---

### Journey 10: Audit Log & Compliance

**Starting state:** Supervisor, Audit Log page

**Filtering:**

- Action type (application state change, correction, note, approval, etc.)
- Application search (number, borrower name)
- User search (staff name/email)
- Date range (custom)

**Steps:**

1. Enter filters.
2. View paginated audit entries: user, action, timestamp, changes (before/after), request ID.
3. Click "Export CSV" to download full audit log (streamed, max 100,000 rows).
4. For compliance, verify:
   - All corrections are attributed to staff member + timestamp.
   - All approval decisions include formal notes.
   - All denials include HMDA reasons.

**Outcome:** Full audit trail available for compliance review.

---

### Journey 11: Outbound Messages & Notifications

**Starting state:** Supervisor, Outbound Messages page

**Content:**

- Email and SMS messages sent to borrowers (verification links, password resets, decision notifications, revision requests).
- Status: Sent, Delivered, Failed, Pending Retry.
- Failed messages show delivery error; retry available.

**Steps:**

1. Review messages and delivery statuses.
2. For failed messages: click "Retry" to re-attempt delivery.
3. If 3 automatic retries exhausted, message flagged for manual retry; supervisor alert visible on dashboard.

**Outcome:** Notification status visible; manual retry capability for troubleshooting.

---

### Journey 12: Exports & Compliance Reporting

**Starting state:** Supervisor, Exports page (under Admin)

**Export Types:**

| Export | Format | Content | Use |
|--------|--------|---------|-----|
| **MISMO JSON** | JSON | URLA data in MISMO v3.4 logical structure (masked SSN by default, full-SSN audited export available) | Transfer to downstream systems |
| **MISMO XML** | XML | MISMO v3.4 in XML namespace | Legacy system integration |
| **URLA PDF** | PDF | Completed URLA form with signatures, borrower attestation, date/currency formatting per SEC-2 | Borrower record, document retention |
| **HMDA LAR** | Pipe-delimited text | Loan Application Register per FFIEC 2018+ spec; one record per reportable application | Annual HMDA submission to regulators |
| **Data Warehouse** | ZIP (CSV tables) | Extract of all entities (dim_borrower, dim_property, fact_application, etc.) | Analytics data warehouse ingestion |

**Steps:**

1. Select export type.
2. Enter required parameters:
   - For MISMO JSON/XML: application ID, optionally full-SSN export (audit reason required).
   - For HMDA LAR: select year (e.g., 2025).
   - For warehouse: select mode (full or incremental) and optional since-date.
3. Click "Export".
4. File downloads (streamed, never full-set memory load).
5. For full-SSN MISMO exports: audit entry recorded with reason.

**Outcome:** Compliance data exported for downstream systems or regulatory filing.

---

### Journey 13: Demo Data Seeding & Removal

**Starting state:** Supervisor, Admin → Demo Data (DEMO_MODE=true only)

**Seeding (POST /api/admin/demo-data/seed):**

1. Click "Seed Demo Data".
2. Confirmation: "This will create ≥50 applications with various statuses and personas."
3. Click "Confirm Seed".
4. Application is in-flight; Demo Data page shows "Seeding…" + progress.
5. Seed completes: report shows record counts per entity (applications, documents, checks, approvals, etc.).
6. Staged data includes:
   - Applications in every workflow state (Draft through Denied/Withdrawn)
   - Applications with completed underwriting checks (credit, AVM, etc.)
   - Applications with approval decisions (some approved, some denied, some escalated)
   - Borrower versions (revised applications)
   - Documents with OCR extractions
   - Fraud flags, corrections, notes
   - Staff caseworkers and supervisors (demo-account level only)

**Removal (DELETE /api/admin/demo-data):**

1. Click "Remove Demo Data".
2. Confirmation: "This will delete all seed-flagged records (isSeed=true)."
3. Click "Confirm Remove".
4. Deletion in-flight; status shown.
5. Completion report: records deleted per entity.
6. HMDA LEI/agency-code reset to blank (if they held seeded values).
7. Audit entries for seed/remove operations are NOT deleted (retained for compliance history).

**Outcome:** Demo dataset available for testing; removable for production transition.

---

## Public Tool Journeys

### Journey 1: Pre-Qualification Calculator

**Starting state:** Landing page, Public → Pre-Qualify

**Steps:**

1. Enter inputs:
   - Home price (or refinance property value)
   - Down payment (or LTV target)
   - Annual income
   - Monthly debt obligations
   - Loan type (Conventional, FHA, VA, USDA)
   - Loan term (30, 20, 15 years)
2. Live outputs update as you type:
   - Maximum loan amount at 43% DTI
   - Estimated interest rate (from pricing simulation)
   - Estimated monthly PITI
   - Maximum purchase price
   - Qualification indicator (yes/no)
3. No data stored; anonymous use.
4. Click "Start an Application with these numbers" → hand-off token created, redirects to Sign In.

**Outcome:** Loan feasibility assessed. User can start a pre-filled application.

---

### Journey 2: Loan Comparison Tool

**Starting state:** Landing page, Public → Compare Loans

**Steps:**

1. Create ≥3 loan scenarios by name (e.g., "Conventional 30y", "FHA 30y", "ARM 7/1").
2. Enter per-scenario: home price, down payment, annual income, monthly debt, loan type, term, rate-buy scenario (par, buy-down, lender-credit).
3. Outputs (per scenario): max loan, max purchase price, monthly PITI, total closing costs, APR, best-value flag.
4. System highlights one scenario as "Best Value" (lowest total cost or shortest payoff).
5. Click "Start an Application with Scenario X" → hand-off token for that scenario's values.
6. Redirect to Sign In → pre-filled Draft application on success.

**Outcome:** Loan scenarios compared; user can start application pre-filled with chosen scenario.

---

### Journey 3: Pre-Fill Handoff

**Starting state:** Public tool (pre-qual or comparison), user clicks "Start an Application"

**Token Lifecycle:**

1. Tool generates a signed, short-lived (60-min) hand-off token containing: loan details, property details, borrower income (from calc), selected scenario.
2. Token embedded in URL redirect to Sign In (e.g., `/sign-up?handoff=<token>`).
3. User signs up or signs in (with optional MFA if required).
4. On successful auth, redirect to `/applications/new?handoff=<token>`.
5. Application creation reads token; if valid and not expired:
   - New Draft application created.
   - Steps 3 (Employment & Income), 5 (Liabilities), 7 (Loan Details) pre-filled with token values.
   - Lands on Step 1 (Identity) for borrower to complete.
   - Token consumed (invalid for reuse).
6. If token expired or tampered: ignored; plain new Draft created (no pre-fill).

**Outcome:** Borrower's application workflow starts with pre-filled data from public calculator.

---

## Glossary Reference

Key terminology from requirements.md §12 — used consistently throughout the system:

| Term | Definition |
|------|-----------|
| **Active application** | An application in any workflow state other than Draft or a terminal state; at most one per Borrower. |
| **APR** | Annual Percentage Rate — the annual cost of credit including finance charges. |
| **AUS** | Automated Underwriting System — rule-based evaluation producing Approve/Eligible, Refer, or Refer with Caution. |
| **AVM** | Automated Valuation Model — algorithmic property value estimate with comparable sales. |
| **Chatter** | Persisted, immutable per-application message list among staff. |
| **CLTV** | Combined Loan-to-Value — all liens on the property divided by value. |
| **Correction** | A field-level, audited staff edit of borrower-entered data; never creates a version. |
| **Demo mode** | `DEMO_MODE=true`: enables quick logins, demonstration attestation, seeding, simulated delivery pages. |
| **DTI** | Debt-to-Income ratio per the single definition in §4.2.7. |
| **Escalation** | Requirement for two-level approval when LTV, DTI, or loan-type criteria are met. |
| **FHA / VA / USDA** | Government-insured or guaranteed loan programs. |
| **Formal note** | A staff note attached to a decision or revision request and visible to the Borrower. |
| **HMDA** | Home Mortgage Disclosure Act (Regulation C) — demographic collection and LAR reporting. |
| **LAR** | Loan Application Register — the HMDA annual file of application dispositions. |
| **LTV** | Loan-to-Value — loan amount divided by the lesser of value/price and AVM value. |
| **MISMO** | Mortgage Industry Standards Maintenance Organization; v3.4 Reference Model used for exports. |
| **OCR** | Optical character recognition / document extraction. |
| **Priority** | Urgent / High / Normal / Low ranking of an application in queues. |
| **REO** | Real Estate Owned — properties the borrower currently owns. |
| **SLA** | Service-level target for time in a workflow state; on track / at risk / overdue. |
| **URLA** | Uniform Residential Loan Application, 2020 revision (Fannie Mae Form 1003 / Freddie Mac Form 65). |
| **Version** | Full snapshot of application data created at each Borrower submission or resubmission. |
| **Workflow state** | The single status of an application, one of the 15 states in §4.5.1. |

---

## Support & Troubleshooting

**Common Issues:**

- **MFA not working:** Ensure your authenticator app's time is synchronized; verify the 6-digit code is current (codes expire every 30 seconds). If locked, contact a Supervisor for MFA reset.
- **Session timeout:** 30-minute idle timeout by default. A 2-minute warning appears; click "Stay Signed In" to refresh, or sign back in.
- **Document upload fails:** Ensure file is PDF/JPEG/PNG, ≤10 MB. Max 25 documents per application. Try again or contact support.
- **OCR confidence low:** Re-upload document (high contrast, clear focus). Accept or manually correct values as needed.

**Contact Support:**

For issues not resolved by this guide, contact your loan officer (Borrower) or supervisor (staff).
