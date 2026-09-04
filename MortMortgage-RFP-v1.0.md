# Request for Proposal
## Mortgage Application Management System

**Issued by:** MortMortgage, Inc.
**Document:** RFP version 1.0
**Date:** August 2026
**Classification:** Confidential — for responding vendors only

---

## 1. Executive Summary

MortMortgage, Inc. ("MortMortgage", "we", "us") is procuring the design and build of a web-based Mortgage Application Management System (the "System"). The System must allow borrowers to complete the Uniform Residential Loan Application (URLA 2020, Fannie Mae Form 1003) online, and must give our caseworkers and supervisors the tools to process, underwrite, decide, and audit those applications.

This document is the sole requirements input for design and build. It is self-contained: every functional requirement, workflow state, transition, integration, data entity, security control, and acceptance criterion the vendor needs is stated here. Where a design question could reasonably be raised, we have made the decision and stated it. The only decisions left to the vendor are implementation approach (framework, workflow-engine style, schema design) within the constraints of §7.

Summary of scope:

- Three roles — Borrower, Caseworker, Supervisor — with strict data scoping (§3).
- Borrower portal with a 10-step URLA 2020 wizard, co-borrower support, auto-save, document upload with versioning, bank-account linking, address autocomplete, signature and attestation (§4.2).
- Public pre-qualification calculator and loan comparison tool with pre-fill into a new application (§4.3).
- Caseworker workbench with priority/SLA queue, corrections with audit, notes, version history, document review (§4.4).
- A fully specified 15-state underwriting workflow with escalated two-level approval (§4.5).
- Supervisor portal with assignment, underwriting panel (tri-bureau credit, income, AVM with map, pricing, AUS), fraud flags, approvals, analytics, caseworker management, audit log, configuration, and demo seeding (§4.6).
- Document intelligence (OCR extraction, confidence, auto-fill, comparison, fraud flagging) as tracked background jobs (§4.7).
- Notifications (§4.8), exports and regulatory reporting — MISMO v3.4 JSON/XML, URLA PDF, HMDA LAR, data-warehouse extract (§4.9).
- Deterministic, key-free simulations for every external integration, with optional real providers by configuration (§6).
- Cloud deployment with managed PostgreSQL and S3-compatible object storage, security controls, automated unit/integration/end-to-end tests (§7).

The demonstration environment stores only synthetic data. The System must never store real personally identifiable information (PII) in the demonstration environment.

**Reading this document.** Every requirement states the **minimum** we will accept. Where a quantity, count, list, or distribution is given (for example "at least 50 seeded applications", "three rate scenarios", "the latest 25 events"), it is a floor unless it is explicitly labeled a limit; the vendor may exceed it and may add capabilities, pages, data, or scenarios beyond those listed, provided every stated requirement is still met. The exceptions are the data-scoping rules (§3.2), the security requirements (§7.2), the workflow transition table (§4.5.3), and any value marked as a limit or as configurable-with-default — those are fixed as written.

---

## 2. Background and Business Context

### 2.1 Who we are
MortMortgage is a residential mortgage lender headquartered in Columbus, Ohio, licensed in 14 states, founded in 2009. We originate conventional, FHA, VA, and USDA loans for purchase and refinance. We are a mid-market lender: approximately $1.4 billion in annual origination volume across roughly 4,800 applications per year, processed by 22 caseworkers under 3 supervisors.

### 2.2 Why now
Our intake today is a combination of a borrower PDF form, email, spreadsheets, and manual re-keying into downstream systems. This produces three problems we intend the System to remove:

1. Borrowers abandon applications that cannot be saved and resumed, and re-enter data we already hold.
2. Caseworkers have no single queue, no priority or SLA visibility, and no enforced hand-offs; decisions are not consistently two-person reviewed on high-risk files.
3. We cannot produce a complete audit trail or a HMDA Loan Application Register without manual assembly.

### 2.3 Volumes the System must be sized for
| Measure | Value |
|---|---|
| Applications per year | 6,000 (design for 3 years of growth: 18,000 stored) |
| Concurrent borrowers (peak) | 200 |
| Concurrent staff users (peak) | 40 |
| Documents per application (typical / max) | 6 / 25 |
| Document size (max) | 10 MB each |
| Audit entries per application (typical) | 150 |

### 2.4 Procurement structure
The vendor delivers the System, its source code, deployment configuration, test suites, and documentation described in §7. Acceptance is governed by §10. Items in §11 are out of scope for this procurement.

---

## 3. Scope of Work — Roles and Data Scoping

### 3.1 Roles
The System must implement the three roles below; a user has exactly one role. Additional roles or permission flags may be added provided these three retain the semantics and data scoping stated here.

| Role | Description |
|---|---|
| **Borrower** | A homebuyer or refinancing homeowner completing and tracking their own application(s). Self-registers (§4.1.1). |
| **Caseworker** | A loan processor who claims, reviews, corrects, documents, and advances assigned applications through the underwriting workflow. Account created by a Supervisor. |
| **Supervisor** | An operations manager with visibility across all applications and users; assigns work, records approval decisions, configures thresholds, manages caseworkers, views analytics and the audit log. Account created by a Supervisor. |

### 3.2 Data scoping rules
These rules must be enforced server-side on every API endpoint, not only in the user interface.

| Rule | Requirement |
|---|---|
| S-1 | A Borrower may read and write only applications they own (primary borrower). A co-borrower's data is part of the owning Borrower's application; co-borrowers do not have separate accounts in this version. |
| S-2 | A Caseworker may read applications that are (a) assigned to them, or (b) unassigned and in a claimable state (§4.4.1). For unassigned applications the read is limited to the queue summary fields (application number, borrower display name, loan amount, loan type, submission date, state, priority, SLA status) — no identity, contact, asset, or liability detail until claimed. |
| S-3 | A Caseworker may write (corrections, notes, document review, workflow actions, underwriting checks) only to applications on which they hold the current active assignment. Queue visibility never grants write access. |
| S-4 | A Supervisor may read and write all applications and all users. |
| S-5 | SSN is returned unmasked only to the owning Borrower and only on the wizard identity step's own-data endpoint. Every other API response and UI surface, for every role including Supervisor, shows SSN masked to the last four digits (`***-**-1234`). |
| S-6 | Workflow history, notes of type formal, and notifications exposed to Borrowers must not contain staff user identifiers or staff email addresses; staff are shown by display name and role only. |
| S-7 | Internal notes and chatter are never returned to Borrowers by any endpoint. |

### 3.3 Roles × capability matrix
✔ = permitted, — = not permitted, (o) = own data only, (a) = assigned applications only.

| Capability | Borrower | Caseworker | Supervisor |
|---|---|---|---|
| Public tools (pre-qualification, comparison) | ✔ (also anonymous) | ✔ | ✔ |
| Self-register | ✔ | — | — |
| Create/edit/submit/withdraw application | ✔ (o) | — | — |
| Copy sections from prior application | ✔ (o) | — | — |
| Add/remove co-borrower | ✔ (o) | — | — |
| Upload / replace documents | ✔ (o) | ✔ (a) | ✔ |
| Delete document (Draft only) | ✔ (o) | — | — |
| Sign and attest | ✔ (o) | — | — |
| Link bank account | ✔ (o) | — | — |
| View own workflow status, formal notes, versions | ✔ (o) | — | — |
| Decline an approved loan | ✔ (o) | — | — |
| View queue; claim unassigned | — | ✔ | ✔ |
| View full application detail | — | ✔ (a) | ✔ |
| Inline corrections | — | ✔ (a) | ✔ |
| Internal notes, chatter | — | ✔ (a) | ✔ |
| Formal notes | — | ✔ (a) | ✔ |
| Document review (accept / insufficient / waive / request) | — | ✔ (a) | ✔ |
| Run underwriting checks and AUS | — | ✔ (a) | ✔ |
| View OCR results, apply suggestions, retry OCR | — | ✔ (a) | ✔ |
| Workflow transitions (per §4.5.3 actor column) | (as stated) | ✔ (a) | ✔ |
| Record Level-1 / Level-2 approval decisions | — | — | ✔ |
| Manual, bulk, auto assignment; reassignment | — | — | ✔ |
| Set priority, suspend/resume | — | — | ✔ |
| Fraud flag resolution | — | ✔ (a) | ✔ |
| Exports (MISMO, PDF, HMDA LAR, warehouse) | — | — | ✔ |
| Analytics dashboard | — | own stats strip only | ✔ |
| Caseworker management | — | — | ✔ |
| Audit log viewer and export | — | — | ✔ |
| Threshold and system configuration | — | — | ✔ |
| Seed / remove demo data | — | — | ✔ (demo mode only) |
| Profile: name, email, password, MFA re-enrollment | ✔ | ✔ | ✔ |
| Notification preferences (email/SMS) | ✔ | — | — |

---

## 4. Functional Requirements

### 4.1 Authentication, Registration, and Session Management

#### 4.1.1 Built-in credential authentication (required default)
- The System must ship with its own credential-based authentication: email + password, with passwords hashed using a memory-hard or adaptive algorithm (Argon2id or bcrypt, cost tuned to ≥ 250 ms on the target host). Plain-text or reversibly encrypted passwords are prohibited.
- This built-in mode is the required default. No external identity provider may be required to run, deploy, test, or evaluate the System.

#### 4.1.2 Borrower self-registration
- A public sign-up page collects: first name, last name, email, password, password confirmation, and acceptance of terms.
- On registration the System sends an email-verification message containing a single-use, time-limited (24 h) verification link. In demonstration mode the message is delivered through the simulated email channel (§6.3.8) and is viewable on the Outbound Messages page; the account may also be verified with one click from that page.
- Unverified accounts may sign in but are limited to the verification-pending page until verified.
- Registration responses must not reveal whether an email address already exists (uniform response; the existing account holder receives an email instead).
- Caseworker and Supervisor accounts are created only by a Supervisor (§4.6.9). There is no self-registration path for staff roles.

#### 4.1.3 Sign-in page and one-click demo logins
- Credential sign-in form with "Forgot password" and "Create account" links.
- When demonstration mode is enabled (`DEMO_MODE=true`), the sign-in page must show one-click demo login buttons for at least one pre-provisioned demo account per role: **Borrower**, **Caseworker**, **Supervisor** (additional demo accounts per role are permitted). Each button calls a server-side endpoint that issues a session for the corresponding demo account (`isDemo=true`). Demo passwords must not be present in any client-delivered bundle. The buttons and endpoint must be absent (not merely hidden) when `DEMO_MODE` is false. The buttons must work reliably on the first click, including immediately after a sign-out.
- Sign-in error responses must be uniform ("invalid email or password") regardless of whether the account exists, is locked, or has MFA pending, so account existence is not disclosed.
- After sign-in the user is routed to the role's home page (§8). A protected page requested while unauthenticated must redirect to sign-in and return the user to the requested page after successful sign-in.

#### 4.1.4 Multi-factor authentication (enforced)
- TOTP (RFC 6238, 30-second step, 6 digits) MFA is enforced for every account. After password verification, an account without a **verified** MFA enrollment receives only a short-lived (10 min) enrollment-scoped token that grants access solely to the enrollment pages; no protected page or API may be reached until enrollment is verified.
- Enrollment flow: display secret as QR code and text; user enters a valid code; only then is the enrollment activated. A secret that has not been verified must never be treated as active, and an enrollment call must not overwrite an existing active enrollment.
- On activation the System generates at least ten single-use recovery codes, shows them once, and stores only their hashes.
- Sign-in with a recovery code consumes it and prompts the user to re-enroll.
- Re-enrollment from the profile page requires the current password plus a current TOTP code or an unused recovery code. Re-enrollment invalidates prior recovery codes and issues new ones.
- A Supervisor may reset another user's MFA (clears enrollment; the user must re-enroll at next sign-in); the reset is audited and the user is notified.
- MFA code verification is rate-limited (§4.1.9).
- Demo accounts are pre-enrolled and, in demonstration mode only, bypass the code prompt on demo login.

#### 4.1.5 Password policy
| Rule | Default | Configurable |
|---|---|---|
| Minimum length | 12 characters | yes (≥ 8) |
| Character classes | at least 3 of: upper, lower, digit, symbol | no |
| Expiration | 180 days; user prompted to change at sign-in | yes |
| History | last 5 passwords may not be reused | yes |
| Lockout | 5 consecutive failures → locked 15 minutes, automatic unlock | yes |
| Common-password check | reject the 10,000 most common passwords | no |

#### 4.1.6 Password reset and change
- "Forgot password" issues a single-use reset token valid 60 minutes, delivered by email (simulated in demo mode). Response is uniform whether or not the address exists.
- Reset tokens are stored only as a hash; lookup is by an indexed hash value (no table scans, no per-row password-hash comparisons). Raw tokens must never be written to any log.
- Password change from the profile requires the current password.
- Successful reset or change invalidates every other active session for that user.

#### 4.1.7 Session management
- Sessions are server-side records (revocable). The session identifier or token is delivered only in a cookie with `HttpOnly`, `Secure`, and `SameSite=Lax` attributes. No session material may be placed in `localStorage`, in a non-HttpOnly cookie, or set from client-side script.
- Idle timeout 30 minutes and absolute lifetime 12 hours, both configurable; a warning is shown 2 minutes before idle expiry with a "stay signed in" action.
- Sign-out is available from every authenticated page and invalidates the server-side session.
- Authorization decisions are made server-side on every request. Client code may read a session-info endpoint for display purposes but must never derive authorization from decoding a token locally.
- The System must be configurable to trust proxy-supplied client IP headers only from a configured proxy; otherwise the socket address is used.

#### 4.1.8 Pluggable identity provider abstraction
- The authentication layer must be implemented behind a provider abstraction with a documented interface (sign-in, sign-out, session lookup, user provisioning hook, MFA hand-off) so that an external identity provider (for example Clerk, Auth0, Okta, or Microsoft Entra ID) can be substituted for production without changes to application code outside the provider module.
- The proposal must describe how an external IdP would be wired in (configuration, role mapping, MFA delegation) — but the delivered System must run and be evaluated with the built-in provider alone.

#### 4.1.9 Rate limiting and abuse controls
- Rate limits apply to: sign-in, registration, email verification resend, password-reset request, password-reset submit, MFA verify, demo login, public calculators' server calls, document upload, and integration-triggering endpoints.
- Limits are keyed by account and by client IP, persisted in the database or a shared store, and therefore survive restarts and apply across multiple application instances. In-memory-only limiters are not acceptable.
- Default: 10 attempts per 15 minutes per key for authentication endpoints; 60 per minute for others. Limits are configurable.

#### 4.1.10 Role-based access control
- Every API route enforces authentication and role authorization; unauthorized requests receive 401/403 before any request body is parsed or persisted.
- Every protected page redirects users with the wrong role to their own home page.
- Request bodies are validated against strict schemas; unknown fields are rejected.

### 4.2 Borrower Portal

#### 4.2.1 Dashboard
- Lists all of the Borrower's applications with: application number, created date, submitted date, current state label, loan amount, property address (city/state), and actions.
- Summary cards: Total, Draft, In Underwriting, Approved, Denied, Withdrawn.
- Actions per application by state: **Continue** (Draft, Revision Requested), **View** (all other states), **Withdraw** (any state listed as borrower-withdrawable in §4.5.3), **Decline** (Approved, Conditional Approval, Borrower Notified with approved outcome), **Delete draft** (Draft only; audited).
- Empty state with a "Start New Application" call to action. "Start New Application" is always available.
- A notification bell (§4.8.3).

#### 4.2.2 One-active-application rule
- A Borrower may have any number of Draft and closed applications, but at most **one** application in an active underwriting state (states 2–13 in §4.5.1, i.e., any state that is neither Draft nor terminal).
- Submission of a second application while one is active is rejected server-side with an explicit message ("You already have an application in underwriting: MM-2026-000123") and the message is shown in the wizard; the submit action is also disabled in the UI with the same explanation.

#### 4.2.3 New application with section copy
- When starting a new application and at least one prior application exists, the Borrower may choose a source application and select individually which sections to copy: Identity, Address History, Employment & Income, Assets & Real Estate Owned, Liabilities, Subject Property, Loan Details, Declarations, Demographics. Documents and signatures are never copied.
- Copy is a server-side operation, audited (`sections_copied` with source application id and section list).
- **Staleness advisory:** if the source application's last-saved date for a copied section is more than **90 days** before the copy date, the copied section displays an advisory: "The [section] you copied is from an application dated [date]. Please review and update before submitting." The advisory persists until the Borrower edits or explicitly confirms the section. The 90-day threshold is configurable (§4.6.11).

#### 4.2.4 URLA 2020 application wizard — 10 steps
The wizard implements the complete URLA 2020 (Form 1003, including the Additional Borrower form for a co-borrower). Field-level requirements per step follow. "Req." marks required for submission. Every address field uses address autocomplete (§4.2.11). Every currency field accepts dollars and cents and displays with thousands separators.

**Step 1 — Borrower Identity (per borrower)**
| Field | Type | Notes |
|---|---|---|
| First, middle, last name, suffix | text | first/last req. |
| Alternate names used for credit | text list | optional |
| Social Security Number | masked input `###-##-####` | req.; displayed masked after entry; stored encrypted (§7.2) |
| Date of birth | date | req.; age ≥ 18 at application date |
| Citizenship | enum: U.S. Citizen / Permanent Resident Alien / Non-Permanent Resident Alien | req. |
| Marital status | enum: Married / Separated / Unmarried | req. |
| Dependents | count + ages | optional |
| Home phone, cell phone, work phone (+ ext.) | phone | at least one req. |
| Email | email | req.; defaults to account email |
| Type of credit | enum: Individual / Joint | req.; Joint required when co-borrower present |
| Military service | boolean; if yes: currently serving (projected expiration date) / retired or discharged / non-activated Reserve or National Guard / surviving spouse | req. |

**Step 2 — Address History (per borrower)**
| Field | Type | Notes |
|---|---|---|
| Current address (street, unit, city, state, ZIP, country) | address | req. |
| Housing status | enum: Own / Rent / No primary housing expense | req. |
| Monthly rent | currency | req. if Rent |
| Years and months at address | integers | req. |
| Previous address(es) with same fields | repeating group | req. until history covers 24 months |
| Mailing address different from current | boolean + address | optional |

**Step 3 — Employment & Income (per borrower)**
| Field | Type | Notes |
|---|---|---|
| Current employment (repeating): employer name, employer address, employer phone, position/title, start date, years in line of work, self-employed (boolean, ownership share ≥ 25%), employed by family member or party to transaction (boolean) | group | at least one current employment, or "Not employed" declared |
| Base monthly income, overtime, bonus, commission, military entitlements, other | currency each | base req. when employed |
| Self-employed monthly income (or loss) | currency | req. if self-employed |
| Previous employment (repeating) with employer name, address, position, start/end dates, previous gross monthly income | group | req. until 24 months covered |
| Income from other sources (repeating): source (enum: alimony, child support, separate maintenance, rental, retirement, Social Security, disability, interest/dividends, public assistance, trust, unemployment, VA compensation, other), monthly amount | group | optional |
| Employment type | enum: Employed / Self-employed / Retired / Not employed | req. |
| Bank account linking | action (§4.2.10) | optional; imports income evidence |

**Step 4 — Assets & Real Estate Owned (shared)**
| Field | Type | Notes |
|---|---|---|
| Bank/investment accounts (repeating): account type (enum: checking, savings, money market, CD, mutual fund, stocks, bonds, retirement, stock options, bridge loan proceeds, trust, cash value of life insurance, other), financial institution, account number (stored encrypted, displayed last 4), cash or market value | group | at least one asset req. |
| Other assets and credits (repeating): type (enum: proceeds from real estate sale, proceeds from sale of non-real-estate asset, secured borrowed funds, unsecured borrowed funds, gift of cash, gift of equity, grant, earnest money, employer assistance, lot equity, relocation funds, rent credit, sweat equity, trade equity, other), source/donor, value | group | optional |
| Real estate owned (repeating): property address, property value, status (enum: sold, pending sale, retained), intended occupancy, monthly insurance/taxes/HOA, monthly rental income, net monthly rental income, mortgage loans on property (creditor, account number last 4, monthly payment, unpaid balance, to be paid off at closing, type) | group | req. if Step 8 declaration A.1 = yes or Step 6 occupancy is not primary |
| Source: manual / bank link | system | shown per row |

**Step 5 — Liabilities (shared)**
| Field | Type | Notes |
|---|---|---|
| Liabilities (repeating): account type (enum: revolving, installment, open 30-day, lease, other), company name, account number (encrypted, last 4 shown), unpaid balance, monthly payment, months left, to be paid off at or before closing (boolean) | group | optional but recommended |
| Other liabilities and expenses (repeating): type (enum: alimony, child support, separate maintenance, job-related expenses, other), monthly payment | group | optional |
| DTI badge | computed | live; see §4.2.7 |

**Step 6 — Subject Property (shared)**
| Field | Type | Notes |
|---|---|---|
| Property address (street, unit, city, state, ZIP, county) | address | req.; geocoded (§4.2.11) |
| Number of units | 1–4 | req. |
| Property type | enum: single-family detached, townhouse/PUD, condominium, cooperative, 2-unit, 3-unit, 4-unit, manufactured home | req. |
| Occupancy | enum: primary residence, second home, investment property | req. |
| Mixed-use property | boolean | req. |
| Manufactured home | boolean | req. |
| Estimated property value / purchase price | currency | req. |
| Expected monthly rental income (2–4 units or investment) | currency | conditional |
| Title will be held in names | text | req. |
| Manner in which title will be held | enum: sole ownership, joint tenancy with right of survivorship, tenancy in common, tenancy by the entirety, life estate, trust, other | req. |
| Estate | enum: fee simple, leasehold (expiration date) | req. |
| Target closing date | date | req. for purchase |

**Step 7 — Loan Details (shared)**
| Field | Type | Notes |
|---|---|---|
| Loan purpose | enum: purchase, refinance — rate/term, refinance — cash-out, construction, construction-to-permanent | req. |
| Loan type | enum: Conventional, FHA, VA, USDA-RD | req. |
| Amortization type | enum: fixed, adjustable (initial fixed period months, adjustment period months) | req. |
| Loan term (months) | enum: 120, 180, 240, 360 | req. |
| Requested loan amount | currency | req. |
| Down payment amount; source (enum from Step 4 asset/credit types) | currency + enum | req. for purchase |
| Other new mortgage loans on the property (repeating): creditor, lien type, monthly payment, amount, credit limit | group | optional |
| Proposed monthly housing expense: first mortgage P&I (computed), subordinate liens, homeowner's insurance, supplemental insurance, property taxes, mortgage insurance, HOA dues, other | currency | insurance/taxes req. |
| Refinance: original cost, existing liens, purpose of refinance (enum: no cash-out, limited cash-out, cash-out), improvements made/to be made and cost | conditional | req. for refinance |
| LTV badge | computed | live; see §4.2.7 |

**Step 8 — Declarations (per borrower)** — all fifteen answers required (Yes/No plus conditional detail):
1. A. Will you occupy the property as your primary residence?
2. A.1. Have you had an ownership interest in another property in the last three years? If yes: property type (primary residence, second home, investment) and how title was held (by yourself, jointly with spouse, jointly with another person).
3. B. Do you have a family relationship or business affiliation with the seller of the property?
4. C. Are you borrowing any money for this real estate transaction or obtaining any money from another party that you have not disclosed? If yes: amount.
5. D.1. Have you or will you be applying for a mortgage loan on another property on or before closing that is not disclosed on this application?
6. D.2. Have you or will you be applying for any new credit on or before closing that is not disclosed on this application?
7. E. Will this property be subject to a lien that could take priority over the first mortgage lien, such as a clean-energy lien paid through property taxes?
8. F. Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?
9. G. Are there any outstanding judgments against you?
10. H. Are you currently delinquent or in default on a federal debt?
11. I. Are you a party to a lawsuit in which you potentially have any personal financial liability?
12. J. Have you conveyed title to any property in lieu of foreclosure in the past 7 years?
13. K. Within the past 7 years, have you completed a pre-foreclosure sale or short sale?
14. L. Have you had property foreclosed upon in the last 7 years?
15. M. Have you declared bankruptcy within the past 7 years? If yes: type (Chapter 7, 11, 12, 13).

**Step 9 — Demographic Information (HMDA, per borrower)** — each item optional; "I do not wish to provide this information" is offered for each:
| Field | Options |
|---|---|
| Ethnicity | Hispanic or Latino (Mexican, Puerto Rican, Cuban, Other Hispanic or Latino — free text), Not Hispanic or Latino, I do not wish to provide |
| Race (multi-select) | American Indian or Alaska Native (enrolled or principal tribe — free text); Asian (Asian Indian, Chinese, Filipino, Japanese, Korean, Vietnamese, Other Asian — free text); Black or African American; Native Hawaiian or Other Pacific Islander (Native Hawaiian, Guamanian or Chamorro, Samoan, Other Pacific Islander — free text); White; I do not wish to provide |
| Sex | Female, Male, I do not wish to provide |
| Collection method | system-set to "Email or Internet"; "collected on the basis of visual observation or surname" recorded as No |

**Step 10 — Documents, Review, and Signature (shared)**
- Document upload and checklist (§4.2.9).
- Review summary of all steps with per-step edit links and a list of outstanding validation errors and warnings.
- Signature and attestation (§4.2.8) for each borrower.
- **Submit** button, enabled only when all required fields pass validation, LTV ≤ 97%, every borrower has signed, and the one-active-application rule is satisfied. Submission creates Version 1 and transitions the application to Application Received (§4.5).
- If submission fails server-side, the API error body must be surfaced verbatim to the user in a dismissible error banner; silent failure is not acceptable.

#### 4.2.5 Co-borrower support
- A toggle "Add a co-borrower" on any Draft or Revision Requested application. Adding creates a co-borrower record with its own Step 1, 2, 3, 8, and 9 data; Steps 4–7 and 10 are shared.
- Tab-based switch between Primary and Co-borrower on per-borrower steps; the current borrower is always visibly labeled.
- Remove co-borrower requires confirmation and deletes the co-borrower's data; both add and remove are audited (`co_borrower_added`, `co_borrower_removed`) in the same transaction as the change.
- Validation, signature, and attestation cover both borrowers before submission.

#### 4.2.6 Auto-save
- Every field change is saved within 2 seconds of the last keystroke (debounced) and on every step navigation, as a background request that never blocks input.
- A visible "Saved at HH:MM:SS" / "Saving…" / "Save failed — retrying" indicator.
- No data loss on refresh, back navigation, tab close, or transient network loss: unsaved changes are retried with exponential backoff and, if the page is left, persisted from a local buffer on return.
- Each save carries the application's version stamp; a conflicting concurrent save (e.g., two tabs) is rejected with a reload prompt rather than silently overwriting.
- Section saves are permitted in Draft and Revision Requested states only; other states reject Borrower edits server-side.

#### 4.2.7 Validation, DTI, and LTV
- Required-field validation per step; a step cannot be marked complete with errors, but the Borrower may navigate freely among steps.
- Validation errors are immediately visible: an error banner at the top of the step listing each error, the page scrolls to the banner on a failed "Next", and inline messages appear beside each field. A collapsible validation panel lists all current errors and warnings across all steps.
- Progress bar with overall completion percentage and a step indicator showing complete / in progress / not started for each step.
- **DTI** = (sum of all liability monthly payments not marked paid-off-at-closing + other liabilities/expenses + proposed total monthly housing expense) ÷ (sum of **all** income sources of all borrowers: base, overtime, bonus, commission, military entitlements, other employment income, self-employment income, all "income from other sources", and net rental income). This single definition must be used everywhere DTI is computed (wizard, corrections, underwriting panel, AUS, analytics, HMDA). Warning badge when DTI > 43%.
- **LTV** = requested loan amount ÷ min(estimated property value/purchase price, AVM value when available). Warning when LTV > 80%; submission blocked when LTV > 97%. CLTV (including subordinate liens) is also displayed.
- DTI and LTV are recalculated live on any change to an input field, and server-side on every save and correction.

#### 4.2.8 Signature and attestation
- Signature capture supports two modes, selectable by the borrower: (a) drawn signature on a canvas with mouse and touch input, rendering correctly at any device pixel ratio, with Clear and Save; (b) typed full legal name rendered in a script style. Both are stored as an image (PNG data, ≤ 200 KB) plus the mode.
- The signing ceremony displays the URLA Section 6 acknowledgments and the statement "I certify that the information provided in this application is true and accurate to the best of my knowledge" with a required checkbox.
- On save the System records: signer (borrower or co-borrower), timestamp (UTC), client IP, user agent, attestation text version, and the hash of the application data snapshot signed. Signature creation is audited (`signature_captured`) in the same transaction.
- Signing is allowed only in Draft and Revision Requested; any subsequent edit to application data invalidates the signature (flagged in the UI) and requires re-signing before submission.
- **Demonstration mode:** when `DEMO_MODE=true`, an "Accept demonstration attestation" button completes the ceremony with a generated placeholder signature, recorded with `demoBypass=true`. The button is absent when demo mode is off.
- The signature image is embedded in the URLA PDF export (§4.9.3).

#### 4.2.9 Document upload, checklist, replacement, and versioning
- Accepted types: PDF, JPEG, PNG at minimum; per-file size limit (default 10 MB) and per-application document limit (default 25), both configurable (§4.6.11). The upload flow is: (1) select document type, (2) choose or drop file, (3) upload with a progress indicator, (4) success confirmation. The drop zone is keyboard accessible.
- Document types: W-2, Pay Stub, Bank Statement, Tax Return (1040), Government-Issued ID, Gift Letter, Purchase Agreement, Homeowner's Insurance Quote, Other (with description).
- **Required checklist by loan type** (a checklist item is satisfied when a document of that type is in status Accepted or Pending review, or the item is Waived):

| Item | Conventional | FHA | VA | USDA |
|---|---|---|---|---|
| Government-issued ID (each borrower) | ✔ | ✔ | ✔ | ✔ |
| Pay stubs — most recent 30 days (each employed borrower) | ✔ | ✔ | ✔ | ✔ |
| W-2 — 2 years (each employed borrower) | ✔ | ✔ | ✔ | ✔ |
| Tax returns — 2 years | self-employed only | ✔ | ✔ | ✔ |
| Bank statements — 2 months | ✔ | ✔ | ✔ | ✔ |
| Gift letter | if gift funds | if gift funds | if gift funds | if gift funds |
| Purchase agreement | purchase only | purchase only | purchase only | purchase only |
| Certificate of Eligibility (type Other, description) | — | — | ✔ | — |

- Document statuses: Pending review, Accepted, Insufficient (reason required), Waived (reason required; staff only). Status changes are audited.
- **Replacement and versioning:** a Borrower (in Draft, Revision Requested, or in response to a document request in any pre-decision state) or the assigned staff member may upload a replacement for an existing document. A replacement creates a new DocumentVersion; every prior version is retained, viewable, and downloadable by staff; the checklist and OCR operate on the current version. Deletion (Borrower, Draft only, with confirmation) removes all versions and is audited; deletion in any other state is rejected server-side.
- Display order: checklist order, then upload time.
- Every uploaded file is validated server-side by content sniffing (magic bytes) — the client-supplied MIME type and extension are not trusted — and stored under a System-generated, path-safe key (§7.2).
- Upload triggers a document-intelligence job (§4.7).

#### 4.2.10 Bank account linking (financial-data aggregator)
- In Steps 3 and 4, "Link a bank account" opens the aggregator flow (simulated by default per §6.3.5; real provider optional). The Borrower consents, selects an institution, authenticates, and selects accounts.
- Imported accounts appear in Step 4 as asset rows with source "bank link", pre-filled institution, type, last-4, and balance; recurring payroll deposits detected over the last 90 days appear in Step 3 as an "income evidence" panel showing employer name match and average monthly deposit, which the Borrower may accept to pre-fill base income.
- Manual entry remains available at all times; imported rows are editable; an "Unlink" action removes the link token and marks imported rows as manual.
- Link tokens are stored encrypted. Linking, import, and unlinking are audited.

#### 4.2.11 Address autocomplete and geocoding
- Every address field (current, previous, mailing, employer, subject property, real estate owned) offers type-ahead suggestions from the address-lookup service (simulated by default per §6.3.6). Selecting a suggestion fills street, unit, city, state, ZIP, county.
- Suggestions are keyboard navigable and screen-reader announced. Manual entry always remains possible; a service failure degrades silently to manual entry with no error dialog.
- The subject property address is geocoded on save (latitude, longitude, county, census tract) for the map (§4.6.5) and HMDA (§4.9.4).

#### 4.2.12 Borrower profile and notification preferences
- View/edit first name, last name, phone; change email (requires current password and re-verification of the new address before it becomes active); change password (§4.1.6); MFA re-enrollment and recovery-code regeneration (§4.1.4).
- Notification preferences: external channel Email, SMS, or Both (default Email); SMS requires a verified mobile number (verification code, simulated in demo mode). In-app notifications are always on.

#### 4.2.13 Withdraw and decline
- **Withdraw** is available in every state marked borrower-withdrawable in §4.5.3; it requires a confirmation dialog with optional reason and results in the terminal Withdrawn state, notifying the assigned caseworker.
- **Decline** is available when the outcome is approved (Approved, Conditional Approval, or Borrower Notified with approved outcome); it results in Declined by Borrower.

### 4.3 Public Tools (no login required)

#### 4.3.1 Pre-qualification calculator
- Inputs: gross monthly income, existing monthly debt payments, estimated credit tier (Excellent ≥ 740 / Good 700–739 / Fair 660–699 / Poor < 660), down payment amount, loan term (15/20/30 years), property tax rate (default 1.2%/yr), insurance (default $1,200/yr).
- Outputs, recalculated on every input change: maximum loan amount at 43% DTI, estimated interest rate for the tier (from the pricing simulation's base table, §6.3.4), estimated monthly PITI, maximum purchase price (loan + down payment), and a "likely to qualify / review needed" indicator.
- No data is stored for anonymous users. No SSN or other identifiers are requested.

#### 4.3.2 Loan comparison tool
- At least three scenarios side by side; inputs per scenario: loan amount, interest rate, term, down payment, loan type (Conventional/FHA/VA/USDA — FHA adds the mortgage-insurance premium assumption).
- Presets: 15-year vs 30-year; 5% vs 20% down; Conventional vs FHA.
- Outputs per scenario: monthly P&I, monthly PITI, total interest paid, LTV, total cost of loan, and lifetime mortgage insurance where applicable; the best-value scenario (lowest total cost) is highlighted.

#### 4.3.3 Pre-fill into a new application
- Both tools offer "Start an application with these numbers". The values (income, debts, down payment, term, loan amount/rate, loan type) are held in a signed, short-lived (60 min) browser-side hand-off token, never server-stored for anonymous users.
- If the visitor is not signed in they are routed to registration or sign-in; after authentication (and MFA enrollment when required) the System creates a new Draft with Step 3 income, Step 5 total debts (as a single "other" liability the Borrower must itemize), and Step 7 loan values pre-filled, and lands the Borrower on Step 1. Expired or tampered tokens are ignored and a plain new Draft is created.

#### 4.3.4 Public page requirements
- All public pages share a common header with the MortMortgage logo linking to the landing page, links to both tools, and Sign In / Create Account. A favicon is required. A custom 404 page is required.

### 4.4 Caseworker Workbench

#### 4.4.1 Queue
- Two tabs: **Unassigned** (applications with no active assignment in a claimable state: Application Received, or any pre-decision state left unassigned by deactivation/reassignment) and **My Queue** (applications with an active assignment to the signed-in caseworker that are not terminal).
- Columns: application number, borrower display name, loan amount, loan type, submitted date, current state label, priority badge, SLA badge, days in current state, last activity.
- **Priority** values: Urgent, High, Normal, Low, color-coded (red/orange/blue/gray). Default Normal. Automatic rules: purchase with target closing date within 14 days → Urgent; within 30 days → High; loan amount ≥ $1,000,000 → High. A Supervisor may override priority manually; overrides are audited.
- **SLA** per state (business days, configurable): Application Received 2; Completeness Validated 3; Supporting Documents Received 2; AUS Executed 2; Preliminary Decision 2; Escalated Review 2; Conditional Approval 10; Revision Requested (borrower clock) 10. Status: On track (green) < 75% elapsed; At risk (yellow) ≥ 75%; Overdue (red) > 100%. An overall SLA of 30 calendar days from submission to final decision is tracked and shown on the detail page.
- Default sort: Overdue first, then Urgent → Low, then At risk, then oldest submission first. Column sort and text filter by application number or borrower name are available.
- **Claim** on an unassigned row creates an active assignment to the caseworker. Claim is atomic (§7.2 SEC-3); a second claimant receives "already claimed by [name]" and the row disappears from Unassigned.
- Row click opens the application detail. Every workflow state has a human-readable label; "unknown" must never appear.

#### 4.4.2 Stats strip and completion history
- Above the queue: My queue size; Completed this month (final decisions on applications I held); Average days to decision (last 90 days); Approval rate (last 90 days); Overdue count.
- **Completion history** tab: applications I processed to a final decision or terminal state in the last 12 months with outcome, days to decision, and date; paginated.

#### 4.4.3 Application detail
- Tabs: Summary (qualification card, state, priority, SLA, assignment, version), Identity (per borrower), Addresses, Employment & Income, Assets & REO, Liabilities, Property, Loan, Declarations, Demographics, Documents, Underwriting, Notes, Versions, History.
- All data is read-only unless corrections are permitted (§4.4.4). Co-borrower data is clearly labeled. Dates display as `Mon D, YYYY` (e.g., `Nov 15, 1971`) — never raw ISO strings. Currency displays as `$1,234.56`. SSN is masked (§3.2 S-5).
- Workflow action panel showing only the transitions valid for the current state and the user's role (§4.5.3), each with an optional note and a confirmation step, and showing the API error body on failure.

#### 4.4.4 Inline corrections
- The assigned caseworker (or a Supervisor) may correct any borrower-entered field while the application is in a staff-editable state: Application Received, Completeness Validated, Supporting Documents Received, AUS Executed, Preliminary Decision. In any other state the correction endpoint rejects the request server-side (409) and the UI shows fields read-only.
- A correction is a field-level edit; it never creates an application version. Each correction is validated against the field's schema (type, enum, range) and recorded in the same database transaction as an audit entry containing field path, before value, after value, user, timestamp, and reason (required, free text ≤ 500 chars).
- The UI marks corrected fields with a distinct indicator; hover/focus shows original value, who changed it, when, and why.
- Any correction to an income, liability, housing-expense, loan-amount, property-value, or down-payment field recalculates DTI and LTV server-side using the definitions in §4.2.7. A correction made after AUS Executed marks the AUS result stale; the application cannot advance to Preliminary Decision until AUS is re-run.

#### 4.4.5 Notes
| Type | Author | Visible to | Rules |
|---|---|---|---|
| Internal | Caseworker (assigned), Supervisor | staff only | length limit enforced (default 4,000 chars, configurable); immutable once posted; audited |
| Formal | Caseworker (assigned), Supervisor | staff and Borrower | attached to a decision or revision request; length limit enforced (default 4,000 chars); immutable; audited; delivered as a Borrower notification |
| Chatter | Caseworker (assigned), Supervisor | staff only | persisted per-application message list in chronological order, length limit enforced (default 1,000 chars); messages are immutable and cannot be deleted; each message is an audit record; the list refreshes by polling (every 15 s while the tab is open) — real-time push is not required; new chatter triggers an in-app notification to the other staff participants on the application |

#### 4.4.6 Version history with diff
- A version is a full snapshot of application data created at each Borrower submission: Version 1 at first submission, Version n+1 at each resubmission after Revision Requested. Corrections do not create versions.
- The Versions tab lists versions with number, created timestamp, reason (initial submission / resubmission after revision request), and marks the current version. Selecting two versions shows a field-level diff (added / removed / changed with before and after values), grouped by URLA section.
- The Borrower sees the same version list and diff for their own application.

#### 4.4.7 Document review
- Documents tab lists checklist items with status and the current document version for each, plus unmatched documents. For each document: preview (PDF/image inline), download, version list, OCR result panel (§4.7), status actions (Accept / Mark insufficient with reason / Waive with reason), and "Request document" which creates a document request notification to the Borrower naming the type and reason.
- Delete confirmation is required for any destructive action.

#### 4.4.8 Workflow actions
Caseworkers perform the transitions attributed to "Caseworker" in §4.5.3 from the action panel, including Validate completeness, Confirm documents received, Run AUS, Record preliminary decision, Request revision, Clear conditions. Each action records a WorkflowHistory row and an audit entry in the same transaction and dispatches the notifications in §4.8.

### 4.5 Underwriting Workflow

#### 4.5.1 States
Machine names in parentheses. "Active" = counts toward the one-active-application rule. "Staff-editable" = corrections allowed. "Borrower-editable" = borrower section saves allowed.

| # | State (machine) | Description | Active | Staff-edit | Borrower-edit | Terminal |
|---|---|---|---|---|---|---|
| 1 | Draft (`draft`) | Borrower is completing the application; not yet submitted. | no | no | yes | no |
| 2 | Application Received (`application_received`) | Submitted by Borrower; awaiting claim/assignment and completeness review. | yes | yes | no | no |
| 3 | Completeness & Consistency Validated (`completeness_validated`) | Caseworker confirmed all required fields present and internally consistent. | yes | yes | no | no |
| 4 | Supporting Documents Received (`documents_received`) | Every checklist item Accepted or Waived. | yes | yes | no | no |
| 5 | AUS Executed (`aus_executed`) | Credit, income, AVM, and pricing checks complete and AUS recommendation recorded. | yes | yes | no | no |
| 6 | Preliminary Decision (`preliminary_decision`) | Caseworker recorded a recommendation (approve / approve with conditions / deny) with a formal note draft; awaiting Level-1 supervisor decision. | yes | yes | no | no |
| 7 | Escalated Review (`escalated_review`) | Level-1 approved and escalation criteria met; awaiting Level-2 decision by a different supervisor. | yes | no | no | no |
| 8 | Conditional Approval (`conditional_approval`) | Approved subject to listed conditions (e.g., updated pay stub); caseworker tracks conditions. | yes | no | no | no |
| 9 | Approved (`approved`) | Final decision approved with required approval levels obtained. | yes | no | no | no |
| 10 | Denied (`denied`) | Final decision denied; denial reasons recorded (HMDA reason codes). | yes | no | no | no |
| 11 | Borrower Notified (`borrower_notified`) | Formal decision notification dispatched to Borrower; outcome (approved/denied) retained. | no | no | no | yes, unless approved (may go to 15) |
| 12 | Revision Requested (`revision_requested`) | Returned to Borrower to correct or supplement; Borrower edits and resubmits, creating a new version. | yes | no | yes | no |
| 13 | Suspended (`suspended`) | On hold by a Supervisor with reason; SLA clock paused; remembers the state it was suspended from. | yes | no | no | no |
| 14 | Withdrawn (`withdrawn`) | Borrower withdrew before a final decision. | no | no | no | yes |
| 15 | Declined by Borrower (`declined_by_borrower`) | Borrower declined an approved loan. | no | no | no | yes |

Every state must have a human-readable label used consistently in every list, badge, activity feed, notification, and export. The workflow state is the single status field of an application; there is no separate "status" enumeration.

#### 4.5.2 Approval model
- Every final decision requires approval records. **One-level** approval (a single Supervisor Level-1 decision) suffices unless any escalation criterion is met, in which case **two-level** approval is required.
- Default escalation criteria (each configurable by a Supervisor, §4.6.11): LTV > **80%**, or DTI > **43%**, or loan type is **FHA, VA, or USDA**. Criteria are evaluated at the moment of the Level-1 decision using the current DTI/LTV (with AVM value when present) and are recorded on the ApprovalRecord.
- The Level-2 approver must be a **different** Supervisor user from the Level-1 approver; the System rejects a Level-2 decision by the same user.
- An ApprovalRecord stores level, decision (`approve` or `deny`), approver, timestamp, notes, and conditions (if any). The approval gate for transitions into Approved or Conditional Approval must verify the presence of `approve` decisions at every required level; a `deny` record never satisfies an approval requirement. A `deny` at any level transitions the application to Denied and requires denial reasons.
- Caseworkers never record approval decisions; they record the preliminary recommendation.

#### 4.5.3 Transition table
Actor abbreviations: B = Borrower (owner), C = Caseworker with active assignment, S = Supervisor, SYS = System. All transitions not listed are invalid and must be rejected server-side (409) with the current state and allowed transitions in the response.

| # | From | To | Actor | Preconditions | Effects |
|---|---|---|---|---|---|
| T1 | Draft | Application Received | B | all required fields valid; LTV ≤ 97%; all borrowers signed; no other active application | Version 1 created; notify B (submitted) and all S (new unassigned application) |
| T2 | Draft | Withdrawn | B | — | audited; draft retained read-only |
| T3 | Application Received | Completeness Validated | C, S | — | notify B (in review) |
| T4 | Application Received | Revision Requested | C, S | formal note with reason | notify B; borrower SLA clock starts |
| T5 | Application Received | Withdrawn | B | — | notify C |
| T6 | Application Received | Suspended | S | reason | SLA paused |
| T7 | Completeness Validated | Supporting Documents Received | C, S | every checklist item Accepted or Waived | — |
| T8 | Completeness Validated | Revision Requested | C, S | formal note | notify B |
| T9 | Completeness Validated | Withdrawn | B | — | notify C |
| T10 | Completeness Validated | Suspended | S | reason | SLA paused |
| T11 | Supporting Documents Received | AUS Executed | C, S | credit, income, AVM, pricing checks completed (not errored) and not stale | AUS result recorded; notify C and S (AUS result) |
| T12 | Supporting Documents Received | Revision Requested | C, S | formal note | notify B |
| T13 | Supporting Documents Received | Withdrawn | B | — | notify C |
| T14 | Supporting Documents Received | Suspended | S | reason | SLA paused |
| T15 | AUS Executed | Preliminary Decision | C, S | recommendation (approve / approve with conditions / deny) + formal note draft; AUS not stale | notify S (pending approval) |
| T16 | AUS Executed | Revision Requested | C, S | formal note | notify B |
| T17 | AUS Executed | Withdrawn | B | — | notify C |
| T18 | AUS Executed | Suspended | S | reason | SLA paused |
| T19 | Preliminary Decision | Approved | S | Level-1 `approve`; no escalation criterion met; no conditions | ApprovalRecord L1; then SYS T27 |
| T20 | Preliminary Decision | Conditional Approval | S | Level-1 `approve`; no escalation criterion met; ≥ 1 condition listed | ApprovalRecord L1; notify B and C |
| T21 | Preliminary Decision | Escalated Review | S | Level-1 `approve`; escalation criterion met | ApprovalRecord L1; notify all other S (pending Level-2) |
| T22 | Preliminary Decision | Denied | S | Level-1 `deny`; denial reasons | ApprovalRecord L1 deny; then SYS T28 |
| T23 | Preliminary Decision | Revision Requested | S | formal note | notify B |
| T24 | Preliminary Decision | Withdrawn | B | — | notify C, S |
| T25 | Preliminary Decision | Suspended | S | reason | SLA paused |
| T26 | Escalated Review | Approved | S (≠ L1 approver) | Level-2 `approve`; no conditions | ApprovalRecord L2; then SYS T27 |
| T26a | Escalated Review | Conditional Approval | S (≠ L1 approver) | Level-2 `approve`; ≥ 1 condition | ApprovalRecord L2; notify B and C |
| T26b | Escalated Review | Denied | S (≠ L1 approver) | Level-2 `deny`; denial reasons | ApprovalRecord L2 deny; then SYS T28 |
| T26c | Escalated Review | Withdrawn | B | — | notify C, S |
| T26d | Escalated Review | Suspended | S | reason | SLA paused |
| T27 | Approved | Borrower Notified | SYS | notification dispatched (per §4.8) | outcome = approved; formal note delivered |
| T28 | Denied | Borrower Notified | SYS | notification dispatched with denial reasons | outcome = denied |
| T29 | Approved | Declined by Borrower | B | — | notify C, S |
| T30 | Conditional Approval | Approved | C, S | all conditions marked cleared | then SYS T27 |
| T31 | Conditional Approval | Denied | S | conditions unmet; denial reasons; `deny` ApprovalRecord at the highest level previously required | then SYS T28 |
| T32 | Conditional Approval | Declined by Borrower | B | — | notify C, S |
| T33 | Conditional Approval | Withdrawn | B | — | notify C, S |
| T34 | Conditional Approval | Suspended | S | reason | SLA paused |
| T35 | Borrower Notified (approved outcome) | Declined by Borrower | B | outcome = approved | notify C, S |
| T36 | Revision Requested | Completeness Validated | B (resubmit) | required fields valid; re-signed; LTV ≤ 97% | new Version n+1 created; corrections indicator retained; notify C (resubmission) |
| T37 | Revision Requested | Withdrawn | B | — | notify C |
| T38 | Suspended | (state suspended from) | S | — | SLA resumed; "Resume" action |
| T39 | Suspended | Withdrawn | B | — | notify C, S |
| T40 | Suspended | Denied | S | denial reasons; `deny` ApprovalRecord | then SYS T28 |

Rules:
- Withdrawn, Declined by Borrower, and Borrower Notified (denied outcome) are terminal; no transition leaves them. Suspended cannot be entered from Draft, Revision Requested, Approved, Denied, or terminal states.
- Every transition writes one WorkflowHistory row (from, to, actor, timestamp, note) and one AuditLogEntry in the same database transaction as the state change; the transition is rejected if either write fails.
- Transitions carry the application's version stamp for optimistic concurrency; a stale request is rejected (409).
- Deactivating or reassigning a caseworker never changes the workflow state.
- Counter-offers are out of scope (§11); conditions on a Conditional Approval are free-text items with cleared/uncleared status.

#### 4.5.4 Revision request loop
- A revision request requires a formal note stating what must change. The Borrower receives a notification (channel per preference) and an in-app banner on the dashboard and wizard listing the note. The Borrower edits (all steps editable), re-signs, and resubmits (T36), creating a new version. Prior versions, corrections, documents, and underwriting results are retained; underwriting results are marked stale for re-run.
- There is no limit on the number of revision cycles; each is counted on the application and shown in analytics.

#### 4.5.5 Borrower notification of decision
- Upon Approved or Denied, the System dispatches the formal note and outcome to the Borrower via the notification service (§4.8) and then performs T27/T28. The dispatch and the transition are recorded together; if dispatch fails the application remains in Approved/Denied with a visible "notification pending — retry" indicator for staff, and a retry action.

### 4.6 Supervisor Portal

#### 4.6.1 All-applications list
- Paginated (selectable page sizes; server-enforced maximum page size, default 100, configurable) list of every application with columns as in §4.4.1 plus assigned caseworker and approval status.
- Summary cards: Total, Draft, In Underwriting, Pending Approval (Preliminary Decision + Escalated Review), Approved, Denied, Withdrawn, This Month.
- Filters (auto-apply on change; no separate "Apply" button): state (multi-select), assigned caseworker (incl. Unassigned), priority, SLA status (overdue / at risk / on track), loan type, submitted date range, pending approval level (1 / 2), needs my Level-2 (applications where I am eligible as a different approver). Text search by application number, borrower name, or property city.
- Search and filters are operational; there is no ad-hoc query builder or general-purpose analytics search.

#### 4.6.2 Assignment
- **Manual assign** from the list or detail page: choose a caseworker (active caseworkers only), optional reason.
- **Bulk assign**: select multiple applications, choose a caseworker, one confirmation.
- **Auto-assign**: assigns every selected (or all unassigned) application using **workload balancing**: each application goes to the active caseworker with the fewest active (non-terminal, non-Draft) assignments at the moment of assignment, ties broken by least-recently-assigned. A configurable option (default **off**) enables **productivity-aware weighting**: effective load = active count × (1 − w × normalized 90-day completion rate), w ∈ [0, 0.5] configurable. The algorithm must be implemented behind a strategy interface so additional factors can be added.
- **Reassign** from one caseworker to another with required reason; the previous assignment is closed (end timestamp, reason) and a new one created; both caseworkers are notified.
- All four operations are **atomic**: each application's assignment change (close previous, create new) executes in one database transaction, and the database enforces at most one active assignment per application (unique partial index or equivalent). Under concurrent claim/assign attempts exactly one succeeds; the other receives a conflict response. Bulk and auto operations report per-application success/conflict.
- Every assignment event is audited with who, what, when, and why.

#### 4.6.3 Priority and suspension
- Set priority override; suspend with reason; resume. Each is audited and notifies the assigned caseworker.

#### 4.6.4 Application detail (supervisor)
- Everything in §4.4.3–4.4.8, plus the underwriting panel (§4.6.5), fraud flags (§4.6.6), approval decision panel (§4.6.7), assignment history, export actions (§4.9), and all workflow actions attributed to S in §4.5.3.

#### 4.6.5 Underwriting panel
Available to the assigned caseworker and Supervisors. Each check runs asynchronously against the simulation or configured provider (§6), shows a loading state, records an UnderwritingResult, and is audited with a result summary in the audit detail (e.g., "credit: score 742, tier Good"). Checks are idempotent while in flight (a second click while running is ignored server-side); re-running replaces the current result and retains the prior in history. Checks are permitted only in states 3–8 and are marked stale by data corrections (§4.4.4) or a new version.

| Check | Displayed results |
|---|---|
| **Credit (tri-bureau)** | Scores from three bureaus (labeled Bureau A/B/C in simulation; real names when a provider is configured), middle score used for qualification, risk tier (Good ≥ 700 / Fair 640–699 / Poor < 640), tradelines table (creditor, type, opened date, balance, limit, utilization %, payment status), total utilization, collections and derogatories (type, amount, date), inquiries (12 months), report date. Risk badge green/yellow/red. |
| **Income verification** | Per employment: employer verified (yes/no), employment status, verified monthly income, stated monthly income, variance %, confidence (0–100). Flags variance > 10% as a discrepancy. Badge: green ≤ 5% variance, yellow ≤ 10%, red > 10% or unverified. |
| **Property valuation (AVM)** | Estimated value, value range (low/high), confidence score, market trend (rising/stable/declining, 12-month % change), comparables table (address, sale price, sale date, distance, beds/baths, square feet, price per sq ft), recomputed LTV using AVM value, and a **map** showing the geocoded subject property and comparable-sale markers with popups. Map tiles must not require an API key; if tiles are unreachable the comparables table and a placeholder are shown. Badge by LTV using AVM value: green ≤ 80%, yellow ≤ 95%, red > 95%. |
| **Loan pricing** | At least three rate scenarios (par; 1-point buy-down; lender credit), each with interest rate, APR, points/credits, monthly P&I, monthly PITI, rate adjustment factors itemized (credit score, LTV, loan type, occupancy, property type), estimated origination and closing costs. Badge by par rate vs base: green ≤ +0.25%, yellow ≤ +0.75%, red > +0.75%. |
| **AUS** | Runs after the four checks: recommendation (Approve/Eligible, Refer, Refer with Caution), reasons list, and the DTI, LTV, and middle credit score used. |

- **Qualification summary card**: middle credit score with tier, DTI (§4.2.7 definition), LTV and CLTV, estimated monthly PITI, AUS recommendation, escalation required (yes/no with criteria met), overall status (Qualified / Review / Not qualified).
- Each result section is expandable; errored checks display the error and a Retry button.

#### 4.6.6 Fraud flags
- The System creates FraudFlag records automatically when: OCR-extracted values differ materially from entered values (§4.7); verified income variance > 20%; AVM value < 85% of stated value; a duplicate SSN blind-index match exists on another borrower's application; stated employer not verified.
- Each flag has type, severity (low/medium/high), source document or check, details, status (open / resolved / dismissed), resolver, and resolution note. Open high-severity flags block T15 (Preliminary Decision) until resolved or dismissed by a Supervisor. Flags are listed on the detail page with counts on the queue rows. Flag creation and resolution are audited. Flag evaluation must tolerate missing documents or results (no errors when a source is absent).

#### 4.6.7 Approval decisions
- Approval panel visible in Preliminary Decision and Escalated Review showing the caseworker's recommendation, qualification summary, escalation evaluation, prior approval records, and open fraud flags.
- Actions: Approve (with optional conditions list → Conditional Approval), Deny (denial reasons from the HMDA reason list: DTI, employment history, credit history, collateral, insufficient cash, unverifiable information, credit application incomplete, mortgage insurance denied, other with text), each with notes. The panel enforces the different-approver rule and shows why the current user is ineligible when applicable.

#### 4.6.8 Analytics dashboard
All figures are computed by database aggregation queries; no endpoint may load the full application set into application memory. A date-range filter (default last 12 months) applies to all charts; each table and chart offers "Download CSV" of its aggregated data.

| Element | Content |
|---|---|
| Summary metrics | total applications, applications this month, approval rate (approved ÷ (approved + denied)), average loan amount, average days to decision, applications overdue |
| Volume chart | applications submitted over time, weekly/monthly toggle |
| Status breakdown | donut by workflow state label |
| Loan type breakdown | bar by loan type |
| Property type breakdown | bar by property type |
| Workload distribution | bar per caseworker of active assignments with capacity coloring: green ≤ 8, yellow 9–12, red ≥ 13 (thresholds configurable) |
| LTV risk analysis | stacked bar of approved vs denied counts by LTV band: ≤ 60%, 60–80%, 80–90%, 90–97% |
| DTI risk analysis | stacked bar of approved vs denied counts by DTI band: ≤ 36%, 36–43%, 43–50%, > 50% |
| Performance trend | multi-line chart, last 6 months, completed applications per caseworker per month |
| Caseworker compliance table | per caseworker: active, overdue, at risk, pending approvals awaiting their action, average days in state, corrections made, revision requests issued, completed (period), approval rate |
| Pending approvals | list of applications in Preliminary Decision / Escalated Review with days waiting and eligible approver note |
| Recent activity feed | at least the latest 25 events (submissions, transitions with from/to labels, assignments, approvals) using workflow state labels; never "unknown" |

#### 4.6.9 Caseworker management
- List all Caseworker and Supervisor accounts with role, status (active/inactive), MFA status, active assignments, completed this month, last sign-in.
- Add account (first name, last name, email, role); the System sends an invitation with a set-password link (simulated in demo mode) and the user enrolls MFA at first sign-in.
- Deactivate (blocks sign-in, revokes sessions, and closes active assignments — those applications return to Unassigned with a notification to all Supervisors); reactivate; reset MFA. Accounts are never hard-deleted (audit integrity).
- All actions audited.

#### 4.6.10 Audit log viewer and export
- Paginated (25 per page) chronological viewer of AuditLogEntry records with filters that auto-apply: action type (dropdown of all action types), application (search-as-you-type by application number or borrower name), user (search-as-you-type by name or email), date range. ID inputs, where offered, show placeholder text with the expected format.
- Each row: timestamp, user (name, role), action type, application number, summary, and expandable details including before/after values for corrections and result summaries for underwriting checks.
- Export CSV of the current filter as a streamed download (no full-table load into memory), with a configurable row cap per export (default 100,000) and a message when the cap is hit. Exports are themselves audited.
- The audit log is append-only: no update or delete endpoint exists for any role, and entries are written only by server-side code paths in the same transaction as the action they record. There is no public HTTP endpoint that accepts audit entries.
- Retention: entries are retained indefinitely in this version; archival is out of scope (§11).

#### 4.6.11 Threshold and system configuration
A configuration page (Supervisor) backed by SystemConfig; every change is audited with before/after values.

| Setting | Default |
|---|---|
| Escalation LTV threshold | 80% |
| Escalation DTI threshold | 43% |
| Loan types requiring two-level approval | FHA, VA, USDA |
| LTV submission block / warning | 97% / 80% |
| DTI warning | 43% |
| SLA business days per state | per §4.4.1 |
| Overall decision SLA (calendar days) | 30 |
| Workload capacity thresholds (yellow/red) | 9 / 13 |
| Productivity-aware auto-assign (on/off, weight) | off / 0.25 |
| Stale-copy threshold (days) | 90 |
| Session idle / absolute timeout | 30 min / 12 h |
| Password expiry days, history depth, lockout attempts, lockout minutes | 180 / 5 / 5 / 15 |
| Rate-limit defaults | per §4.1.9 |
| Document size limit, max documents per application | 10 MB / 25 |
| Note / chatter length limits | 4,000 / 1,000 chars |
| Maximum page size; audit export row cap | 100 / 100,000 |
| OCR automatic retry limit | 5 |
| HMDA reporting: Legal Entity Identifier (LEI), agency code | blank (must be set before LAR export) |

#### 4.6.12 Demo data seeding
- A Supervisor-only "Seed Demo Data" action, available only when `DEMO_MODE=true` (endpoint absent otherwise), creates **at least 50** synthetic applications with synthetic borrower accounts, documents (fixture files), signatures, bank links, workflow history, assignments, corrections, notes and chatter, versions, underwriting results, fraud flags, approval records and conditions, notifications, outbound messages, and audit entries — every entity in §9 must be represented. The seed also creates a staff roster of at least 6 seeded caseworkers (at least 1 inactive) and at least 2 seeded supervisors in addition to the demo accounts.
- Minimum distribution (each figure is a floor; the vendor may seed more): states — 8 Draft, 6 Application Received, 5 Completeness Validated, 5 Supporting Documents Received, 4 AUS Executed, 4 Preliminary Decision, 3 Escalated Review, 2 Conditional Approval, 5 Borrower Notified (approved), 3 Borrower Notified (denied), 2 Revision Requested, 1 Suspended, 1 Withdrawn, 1 Declined by Borrower; loan types — 26 Conventional, 12 FHA, 8 VA, 4 USDA; 15 with co-borrowers; 10 with military service; 12 with previous addresses and employers; 8 with gift funds; all 15 declarations answered with a realistic mix; demographics with a realistic mix including "do not wish to provide". Submission and decision dates must be spread across at least the last 6 months so that every chart in §4.6.8 renders with non-trivial data, and priorities and SLA statuses must cover every value.
- **Demo persona staging (required).** The seed must attach data to the demo accounts so that each role's demonstration starts from a prepared position:
  - *Demo Borrower* owns at least: one Draft part-way through the wizard (with a co-borrower and uploaded documents); one application in Revision Requested with a formal note and an unread notification; one Borrower Notified (approved) dated more than 90 days ago (a copy source that triggers the staleness advisory); one Withdrawn.
  - *Demo Caseworker* holds at least 8 active assignments spanning every priority and SLA status, including: one AUS Executed with a stale-AUS correction, one with an open high-severity fraud flag, one Conditional Approval with one of two conditions cleared, one with chatter from a seeded supervisor, and at least 3 unread notifications; a completion history spanning at least 12 months; and at least 5 Unassigned applications available to claim.
  - *Demo Supervisor* sees at least: 2 applications in Preliminary Decision awaiting Level-1; 2 in Escalated Review where Level-1 was recorded by a seeded supervisor (so the Demo Supervisor is an eligible Level-2 approver); 1 in Escalated Review where Level-1 was recorded by the Demo Supervisor (to demonstrate the different-approver rule); pending document requests; an overdue application; and workload spread unevenly across caseworkers so the capacity chart shows all three colors.
- **Staged walk-throughs.** The demonstration narratives required by §6.4 (at least 10) must each start from seeded state and be executable end-to-end immediately after a fresh seed; the seed and the narratives are delivered and versioned together.
- Seeded records carry an `isSeed` flag; seeded borrower and staff accounts receive random, undisclosed passwords and cannot be used to sign in (only demo accounts, `isDemo=true`, can). Re-running the seed first removes the prior seed set. A "Remove Demo Data" action deletes all seeded records (including their audit entries, which are seed-flagged) and nothing else. Seeding and removal are audited.
- All seed data is synthetic: SSNs use the 900–999 area range reserved from issuance, names and addresses are generated, and no real person's data is used.

### 4.7 Document Intelligence (OCR extraction)

- On every document upload (and on Retry), the System enqueues a **tracked background job** (DocumentJob) with status queued → processing → completed / failed, attempt count, timestamps, provider, and error. Fire-and-forget processing is prohibited: the job record must exist before the response returns, a worker or scheduler must pick it up, and a job still "processing" beyond 10 minutes must be marked failed and retryable. Status is visible to the Borrower (badge on the document) and staff (document panel), refreshed by polling.
- Extraction targets by type: W-2 — employer name, employer EIN (masked), employee SSN last 4, wages (box 1), federal tax withheld, tax year; Pay Stub — employer, pay period start/end, pay date, gross pay, net pay, YTD gross, pay frequency; Bank Statement — institution, account last 4, statement period, ending balance, total deposits; Tax Return — filer name, tax year, AGI, total income; Government ID — name, DOB, ID number last 4, expiration; Gift Letter — donor name, amount, relationship.
- Each extracted field has a confidence 0–100 with color coding: green ≥ 85, yellow 60–84, red < 60. Provider attribution is shown ("via configured AI provider" / "via built-in simulated extraction").
- **Comparison view**: extracted value alongside the borrower-entered value for mapped fields (employer name, base monthly income derived from pay frequency, account balance, name, DOB), with variance highlighted.
- **Apply suggestion**: accepting an extracted value persists it to the application **server-side** as a correction (§4.4.4) — audited with before/after and source document — and the UI reflects the persisted value on reload. Suggestions cannot be applied when corrections are not permitted for the current state.
- **Fraud flagging**: a material difference (income variance > 20%, balance variance > 25%, name or DOB mismatch, employer mismatch) creates a FraudFlag (§4.6.6).
- **Retry** re-enqueues the job (automatic retries with exponential backoff up to a configurable attempt limit, default 5; manual retry always allowed).
- **Zero-key operation**: with no AI provider configured, the built-in deterministic simulated extractor (§6.3.7) runs. A real OCR/AI provider is optional, enabled by configuration. Manual entry by staff (corrections) is always available regardless of extraction.

### 4.8 Notifications

#### 4.8.1 Service
- One notification service is the sole path for all notifications; every trigger (including workflow transitions, assignment, decisions) must route through it. It creates a Notification record (in-app) and, for Borrowers, dispatches through the external channel per preference via the email/SMS provider abstraction (§6.3.8). Delivery failures are recorded on the Notification (status, error) and surfaced for retry; they are never silently swallowed.

#### 4.8.2 Triggers
| Recipient | Event |
|---|---|
| Borrower | registration verification; password reset; submitted; in review (T3); revision requested; document requested; conditional approval with conditions; decision (approved/denied) with formal note; withdrawal confirmation; decline confirmation; signature invalidated by edit; bank link imported |
| Caseworker | new assignment (claim confirmation, manual, bulk, auto); reassignment (both old and new); resubmission after revision; borrower withdrawal/decline; document uploaded/replaced by borrower; underwriting check or AUS result recorded; fraud flag created; chatter message; suspension/resume; condition cleared |
| Supervisor | new unassigned application; pending Level-1 approval; pending Level-2 approval (all supervisors other than L1 approver); caseworker deactivation returning applications to Unassigned; notification delivery failure; OCR job failure after max retries |

#### 4.8.3 In-app presentation
- A notification bell in the header for every role with an unread count badge; clicking opens a dropdown of at least the latest 10 with read/unread state, relative timestamps, links to the related application, and "Mark all read"; a full notifications page lists all with pagination.

#### 4.8.4 Demonstration delivery
- In demonstration mode (no email/SMS provider configured) external messages are recorded to an **Outbound Messages** page (Supervisor) showing channel, recipient, subject, body, and timestamp, and to the structured log. Nothing is sent externally.

### 4.9 Exports and Compliance Reporting
All exports are Supervisor-only, audited (`export_mismo_json`, `export_mismo_xml`, `export_urla_pdf`, `export_hmda_lar`, `export_warehouse`), and available for any non-Draft application (per-application exports) or globally (LAR, warehouse).

#### 4.9.1 MISMO v3.4 JSON
A JSON document conforming to the MISMO v3.4 Reference Model logical structure: `MESSAGE > DEAL_SETS > DEAL_SET > DEALS > DEAL` with `PARTIES` (one PARTY per borrower with INDIVIDUAL name, contact points, ROLES > ROLE > BORROWER including residences, employers, declarations, government monitoring), `LOANS > LOAN` (TERMS_OF_LOAN, LOAN_DETAIL, AMORTIZATION, QUALIFICATION), `COLLATERALS > COLLATERAL > SUBJECT_PROPERTY` (ADDRESS, PROPERTY_DETAIL, PROPERTY_VALUATIONS), `ASSETS`, `LIABILITIES`, and `RELATIONSHIPS` linking parties to assets/liabilities. SSN is exported masked unless the export is explicitly requested as "full" by a Supervisor with a reason (audited). The vendor must deliver a field-mapping document (URLA field → MISMO container/element) as part of documentation.

#### 4.9.2 MISMO v3.4 XML
The equivalent XML document in the MISMO v3.4 namespace (`http://www.mismo.org/residential/2009/schemas`) with the same containers, validated well-formed, and the same masking rules.

#### 4.9.3 URLA PDF
A filled URLA 2020 layout (Form 1003 sections 1–9 including the Additional Borrower form for co-borrowers) as a downloadable PDF: SSN masked to last four; dates and currency in U.S. format independent of server locale; signature image(s) and attestation metadata (name, timestamp, IP) embedded in Section 6; application number in the header and generation timestamp in the footer; a structurally valid PDF file.

#### 4.9.4 HMDA Loan Application Register (LAR)
- A pipe-delimited file conforming to the current FFIEC HMDA file specification (one header record for the institution, one LAR record per application with a reportable action) for a Supervisor-selected calendar year.
- Fields include, at minimum: LEI, ULI (generated from LEI + application number with check digit), application date, loan type, loan purpose, preapproval, construction method, occupancy type, loan amount, action taken and date (originated/approved not accepted → Approved but not accepted; denied; withdrawn; file closed for incompleteness; application approved not accepted for Declined by Borrower), property address, state, county, census tract (from geocoding), applicant and co-applicant ethnicity/race/sex with "not provided" codes, applicant age at application date (computed from DOB and application date, not the current date), income (annualized, thousands), purchaser type, rate spread, HOEPA status, lien status, credit score and model, denial reasons (up to 4), total loan costs, origination charges, discount points, lender credits, interest rate, prepayment penalty term, DTI, CLTV, loan term, introductory rate period, non-amortizing features, property value, manufactured home fields, total units, submission of application, initially payable to institution, AUS type and result, reverse mortgage, open-end line of credit, business or commercial purpose. Values not collected are populated with the specification's "not applicable" or "exempt" codes; the mapping is documented.
- Records are generated by streaming query; the full set is never held in memory.

#### 4.9.5 Data-warehouse extract
- A ZIP containing one CSV per table of a documented star schema: fact tables `fact_application` (one row per application with keys and measures: loan amount, DTI, LTV, days in each state, outcome), `fact_workflow_event`, `fact_underwriting_check`, `fact_assignment`, `fact_document`; dimension tables `dim_date`, `dim_caseworker`, `dim_loan_type`, `dim_property_type`, `dim_workflow_state`, `dim_borrower` (masked: no SSN, DOB replaced by age band). Includes a `schema.json` describing each column. Supports full and incremental (changed since a timestamp) extracts. Streamed; audited.

---

## 5. Data Standards Compliance

### 5.1 URLA 2020 (Fannie Mae / Freddie Mac Form 1003, effective 2021)
The data model must capture every field of Form 1003 sections 1–9 as enumerated in §4.2.4, including the Additional Borrower form, the Unmarried Addendum where applicable, military service, and the full declaration set. Enumerations must use the URLA/MISMO value sets (e.g., `CitizenshipResidencyType`, `PropertyUsageType`, `MortgageType`).

### 5.2 MISMO v3.4
Exports (§4.9.1–4.9.2) must follow the MISMO v3.4 Reference Model container hierarchy and element names. The vendor delivers the mapping document. The System must validate exports against the delivered mapping in automated tests.

### 5.3 HMDA (Regulation C)
Demographic collection per §4.2.4 Step 9 with "do not wish to provide" options; LAR generation per §4.9.4; denial reasons per the HMDA reason codes; applicant age computed at application date. Collection method recorded as electronic; no visual-observation collection.

---

## 6. Integrations and Simulation Requirements

### 6.1 Principles
- Every integration is implemented behind a provider interface with two implementations: a **built-in deterministic simulation** (default) and an **optional real provider** enabled by configuration. The System must install, run, pass all tests, and be fully demonstrable with **zero external API keys**.
- Simulations are pure functions of their documented inputs (plus configured fault/latency settings): the same input always yields the same output. No random number generation without a documented seed derived from input.
- Missing configuration for an enabled real provider must fail fast at startup with a clear message — never silently default to empty credentials.

### 6.2 Integration table
| # | Integration | Purpose | Default | Optional real provider (examples) | Fallback if unavailable |
|---|---|---|---|---|---|
| 1 | Credit bureau (tri-bureau) | scores, tradelines, derogatories | simulation | any tri-merge credit reporting API | error state with Retry |
| 2 | Income/employment verification | verified income, employment status | simulation | any VOI/VOE API | error state with Retry |
| 3 | Automated Valuation Model | value, comparables, trend, geocoded comps | simulation | any AVM API | error state with Retry |
| 4 | Pricing engine | rates, APR, points, fees | simulation | any product/pricing engine API | error state with Retry |
| 5 | Financial-data aggregator | bank linking, asset/income import | simulation | Plaid, MX, Finicity | manual entry |
| 6 | Address lookup / geocoding | autocomplete, geocode, census tract | simulation | Google Places, Mapbox, Smarty | manual entry |
| 7 | Document OCR / AI extraction | field extraction, confidence | simulation | any vision/LLM or OCR service | manual entry by staff |
| 8 | Email / SMS delivery | borrower notifications, verification, reset | simulation (Outbound Messages page) | SendGrid/SES; Twilio | in-app only + retry |
| 9 | Automated Underwriting System | recommendation | simulation (rule-based) | none in this version | — |
| 10 | Map tiles | underwriting map | keyless public tile source or bundled static tiles | any tile provider | comparables table + placeholder |
| 11 | Object storage | document files | local disk (development) | S3-compatible (required for cloud, §7.1) | — |

### 6.3 Simulation rules
Each simulation must implement: a documented input→output mapping; configurable base latency and jitter (defaults below); and fault scenarios selectable by input trigger (deterministic) and by configuration (`SIM_FAULT_<INTEGRATION>=none|slow|timeout|unavailable|partial|invalid`). Timeout handling: the client shows a timeout message with Retry after 30 s. The mapping document is a delivery item.

#### 6.3.1 Credit bureau
- Input: primary borrower SSN (via blind index), DOB, name. Scenario by **last digit of SSN**: 0–3 → Good (base score 740 + digit×10, range 740–770); 4–6 → Fair (660 + (digit−4)×12); 7–8 → Poor (585 + (digit−7)×25); 9 → service unavailable (503) on first attempt, Good on retry.
- Three bureau scores: base, base−7, base+5. Tradelines: count 4 + (digit mod 5); utilization increasing with worse tier (Good 12–28%, Fair 35–55%, Poor 60–95%); collections: 0 for Good, 1 for Fair, 2–3 for Poor with amounts; inquiries 1–4.
- Co-borrower evaluated separately; qualification uses the lower of the borrowers' middle scores.
- Latency 1,200 ms ± 600. Partial scenario: only two bureau scores returned, third marked "unavailable".

#### 6.3.2 Income verification
- Input: employer name, stated base monthly income, start date. Factor by **(sum of character codes of employer name) mod 10**: 0–6 → 1.00 (verified matches); 7 → 0.95; 8 → 0.88 (discrepancy); 9 → 0.70 (material, fraud flag). Employer names containing "UNVERIFIED" → employer not found. Employment status: "Active" unless start date within 30 days → "Probationary". Confidence 95 / 85 / 70 / 50 by factor tier.
- Latency 900 ms ± 400.

#### 6.3.3 AVM
- Input: subject address (geocoded), stated value, property type. Factor by **last digit of ZIP**: 0–5 → 1.00 + (digit−2)×0.01; 6–8 → 0.90 (low appraisal); 9 → partial response (value returned, no comparables, confidence 40).
- Comparables: at least 4 synthetic sales within 0.6 miles (the first four: sale prices = AVM value × {0.94, 0.98, 1.03, 1.07}), sale dates within 180 days, coordinates offset deterministically from the subject geocode. Trend: rising if ZIP digit even, stable if 5/7/9, declining if 1/3.
- Latency 1,500 ms ± 500.

#### 6.3.4 Pricing engine
- Base rate table (configurable): Conventional 30-yr 6.50%, 20-yr 6.25%, 15-yr 5.85%; FHA 30-yr 6.15%; VA 30-yr 6.05%; USDA 30-yr 6.10%; ARM initial 5.95%.
- Adjustments (additive, percentage points): credit ≥ 740: 0.00; 700–739: +0.25; 660–699: +0.625; < 660: +1.25. LTV ≤ 60: −0.125; ≤ 80: 0; ≤ 90: +0.25; ≤ 97: +0.50. Investment +0.75; second home +0.375; 2–4 units +0.25; condo +0.125; manufactured +0.50; cash-out +0.375.
- Scenarios: par; buy-down (−0.25% for 1.0 point); lender credit (+0.25% for 1.0% credit). APR = rate + finance charges spread over term (origination 1%, fixed fees $2,850). FHA adds MIP 0.55%/yr; USDA 0.35%/yr; VA funding fee 2.15% financed. Closing cost estimate = fixed fees + origination + prepaid taxes/insurance.
- Latency 700 ms ± 300. Fault trigger: loan amount exactly $999,999 → invalid-response scenario.

#### 6.3.5 Financial-data aggregator
- Simulated link dialog: at least 6 fictional institutions; any username; password `fail` → authentication failure; password `slow` → 8 s latency; otherwise success. Accounts derived from hash(username): 2–4 accounts (checking, savings, optional money market/brokerage) with balances $1,800–$85,000; 90-day transactions with bi-weekly payroll deposits equal to (stated base income × 12 / 26) × 0.78 (net) from an employer name equal to the Step 3 employer when username contains "match", else a different employer.
- Latency 2,000 ms ± 800 on exchange.

#### 6.3.6 Address lookup / geocoding
- A bundled synthetic dataset of ≥ 2,000 U.S. addresses across ≥ 20 states with coordinates, county, and synthetic census tract; prefix and fuzzy match returning at least 5 suggestions when available; any free-typed address geocodes deterministically from a hash of its normalized text to coordinates inside the ZIP's state. Query containing "!!" → service unavailable (client degrades to manual silently).
- Latency 150 ms ± 100.

#### 6.3.7 Document OCR / AI extraction
- Deterministic extraction based on document type and a fixture table keyed by tokens in the file name and the file's content hash: files matching seeded fixture names return their fixture values with confidence 90–98; other files return values derived from the application's own entered data (so comparison matches) with confidence 75–92; file names containing `blurry` → all confidences 30–55; `mismatch` → income/balance 30% different from entered (fraud flag); `fail` → job fails after 2 automatic retries; `slow` → 45 s processing.
- Latency (processing time) 4 s ± 2.

#### 6.3.8 Email / SMS
- Simulated delivery records the message on the Outbound Messages page and structured log. Recipient address ending `@bounce.example` → delivery failure recorded (retryable). Latency 100 ms.

#### 6.3.9 AUS
- Rule-based: Approve/Eligible when middle score ≥ 660, DTI ≤ 45%, LTV ≤ 97%, no open high fraud flags, no derogatories in 24 months; Refer with Caution when score < 620 or DTI > 50% or a foreclosure/bankruptcy declaration within 7 years; Refer otherwise. Reasons are itemized. Latency 2,500 ms ± 500.

### 6.4 Scenario coverage
The delivered simulations and seed data must together exercise: all four loan types; all credit tiers; all property and occupancy types; LTV bands on both sides of 80% and 97%; DTI bands on both sides of 43%; each fault scenario for each integration; a partial credit response; a low AVM that raises LTV above the escalation threshold; an income discrepancy that creates a fraud flag; and an OCR mismatch that creates a fraud flag. A narrative of at least 10 predictable demo walk-throughs must be included in documentation.

---

## 7. Non-Functional Requirements

### 7.1 Hosting and deployment
- Deployable to a mainstream cloud web platform (container or Node-compatible host) with a **managed PostgreSQL** database and **S3-compatible object storage** for documents, such that uploads, OCR jobs, notifications, and all exports function in the hosted environment. The vendor deploys a demonstration instance as part of delivery.
- Docker configuration (`Dockerfile` and `docker-compose.yml` for local database, storage emulator, and the app); the application container must run as a non-root user.
- `GET /api/health` returns 200 with JSON `{status, version, database: ok|fail, storage: ok|fail, time}` without authentication and without loading configuration files per request; returns 503 when a dependency check fails.
- All configuration by environment variables with a documented `.env.example` covering every variable, its purpose, default, and whether it is required; secrets never in source control.
- One command each for: install, database migrate + seed base data (demo accounts, config defaults), start, test, and end-to-end test. When `DEMO_MODE=true`, the migrate + seed command also runs the full demo seed of §4.6.12, so a fresh environment is demonstration-ready without any UI action.
- Storage provider abstraction: local disk for development, S3-compatible for cloud; the storage key for every file is generated by the server (UUID-based), never derived from the user-supplied file name, and is validated to remain within the configured bucket/prefix.
- Background jobs (OCR, notification retry) run inside the deployed environment via a worker process or a durable scheduler; the deployment document states how jobs run on the chosen platform.
- Demo mode (`DEMO_MODE`), demo seeding, and demonstration bypasses are disabled by default and must be explicitly enabled; production deployment documentation states they must remain off.

### 7.2 Security and data protection
Each item is individually testable and paired with an acceptance criterion in §10.

| ID | Requirement |
|---|---|
| SEC-1 | SSN, date of birth, and all account numbers (assets, liabilities, REO mortgages, bank-link tokens) are encrypted at rest at the field level with AES-256-GCM (or equivalent authenticated encryption), key supplied by environment/KMS, key identifier stored with ciphertext to permit rotation. SSN additionally has an HMAC blind index for duplicate detection and simulation seeding, and a separately stored last-four value for display. |
| SEC-2 | SSN is masked to the last four digits in **every** API response and UI surface for every role other than the owning Borrower (§3.2 S-5). A single masking implementation is used everywhere. Date of birth is displayed in human-readable form (`Nov 15, 1971`), never as a raw ISO string. |
| SEC-3 | Session tokens are delivered only as `HttpOnly`, `Secure`, `SameSite` cookies (§4.1.7). CSRF protection on every state-changing request uses a token bound server-side to the session (synchronizer token or HMAC of the session identifier) — a bare double-submit cookie is not acceptable. |
| SEC-4 | Claim, manual assign, bulk assign, auto-assign, and reassign are atomic and serialized per application (§4.6.2): concurrent attempts yield exactly one active assignment, enforced by a database constraint. |
| SEC-5 | The approval gate distinguishes `approve` from `deny`; a recorded denial can never satisfy any approval requirement; the different-approver rule is enforced server-side (§4.5.2). |
| SEC-6 | Corrections (including OCR "apply suggestion") are accepted only in staff-editable states and only from the assigned caseworker or a Supervisor; the guard is server-side (§4.4.4). |
| SEC-7 | DTI includes all income sources (§4.2.7) everywhere it is computed; a single shared implementation is used; a correction to any income or liability field triggers recalculation of DTI and LTV. |
| SEC-8 | Every state-changing action is audited — including signature capture, co-borrower add/remove, section copy, document status changes, bank link/unlink, configuration changes, exports, MFA resets, and all notes and chatter — and the audit write occurs in the same database transaction as the change; failure of the audit write fails the action. |
| SEC-9 | The audit log has no public write endpoint and no update/delete endpoint; entries are created only by server-side code. |
| SEC-10 | Password-reset (and email-verification, invitation) tokens are stored hashed, never logged, and looked up by indexed hash (§4.1.6). |
| SEC-11 | Rate limiting persists across restarts and instances via the database or a shared store (§4.1.9). |
| SEC-12 | Uploaded files are validated by server-side content sniffing (not client MIME or extension), limited to 10 MB, stored under server-generated path-safe keys through the storage abstraction; downloads are served with `Content-Disposition: attachment` and the sniffed content type; file deletion and database deletion are performed so that no orphaned record references a missing file (delete record in transaction, then object; reconcile on failure). |
| SEC-13 | OCR/document processing runs as a tracked background job with visible status and retry (§4.7); never fire-and-forget. |
| SEC-14 | Analytics, compliance metrics, LAR, audit export, and warehouse extract aggregate or stream in the database; no endpoint loads all applications into memory; all list endpoints are paginated with a server-enforced maximum page size. |
| SEC-15 | Demo seeding, demo logins, demonstration attestation, and MFA bypass are gated by `DEMO_MODE` and disabled by default; no credentials exist in client-delivered bundles; the only demo affordance in the client is the quick-login buttons, which call a server endpoint. |
| SEC-16 | OCR "apply suggestion" persists the accepted value server-side to the application and records it as a correction (§4.7). |
| SEC-17 | HTTP security headers on every response: Content-Security-Policy (no `unsafe-inline` scripts; nonce or hash), Strict-Transport-Security, X-Content-Type-Options `nosniff`, `frame-ancestors 'none'`, Referrer-Policy `strict-origin-when-cross-origin`, Permissions-Policy restricting camera/microphone/geolocation. |
| SEC-18 | OWASP Top 10 controls: parameterized queries only; output encoding; strict request schemas rejecting unknown fields; user-supplied content (including signature images and note text) sanitized before rendering; no server-side request forgery paths; dependency vulnerability scan with no known critical/high findings at delivery. |
| SEC-19 | Authorization and scoping are enforced by a single shared middleware/guard applied to every route; authentication occurs before request bodies are parsed. |
| SEC-20 | Logout, password change/reset, deactivation, and MFA reset revoke sessions server-side (§4.1.6–4.1.7). |
| SEC-21 | Underwriting checks and AUS require an active assignment (or Supervisor) and a permitted state; duplicate in-flight runs are rejected; new-application creation is idempotent per request token to prevent double creation. |
| SEC-22 | Staff identifiers are not exposed to Borrowers (§3.2 S-6); caseworker queue rows for unassigned applications expose only summary fields (§3.2 S-2). |

### 7.3 Performance
- Page load (largest contentful paint) ≤ 3 s on a 10 Mbps connection for every page with seeded data (50 applications, 300+ audit entries); list pages ≤ 1.5 s server response at 18,000 applications.
- Auto-save and integration calls are non-blocking with visible progress; API p95 ≤ 500 ms for CRUD endpoints, excluding simulated latency.
- Analytics endpoints ≤ 2 s at 18,000 applications.

### 7.4 Usability and accessibility
- Responsive layout for desktop (≥ 1280 px), tablet, and mobile (≥ 360 px) browsers; latest two versions of Chrome, Edge, Firefox, Safari.
- WCAG 2.1 AA: semantic markup, ARIA labels, full keyboard operability (including drop zones, autocomplete lists, signature typed mode, dropdown menus), visible focus, color contrast ≥ 4.5:1, status conveyed by text as well as color.
- Clear inline error messages; API error bodies surfaced to the user; progress indicators on every operation > 1 s; confirmation dialogs on destructive actions; consistent identifier display (full application number everywhere); consistent date and currency formatting; a shared navigation header per role; a favicon; a 404 page.

### 7.5 Reliability
- Graceful degradation when optional integrations are unavailable (manual entry paths remain available; no unhandled errors).
- No data loss on network interruption during form entry (§4.2.6).
- Optimistic concurrency on application saves, transitions, and submissions.
- Database migrations are versioned and repeatable; a fresh environment reaches a working state with the one-command migrate + seed.

### 7.6 Observability
- Structured JSON logs (timestamp, level, request id, user id, role, route, status, duration) to stdout; no PII, tokens, secrets, or file contents in logs; errors logged with stack traces; a request id echoed in error responses.
- `/api/health` per §7.1. Background job metrics (queued, processing, failed counts) exposed on a Supervisor system-status panel.

### 7.7 Testing
- **Unit and integration tests** (run against a real PostgreSQL in CI) for all business rules: every workflow transition in §4.5.3 including every invalid transition; approval gates including mixed approve/deny histories and the different-approver rule; escalation criteria at boundary values; DTI and LTV with every income source and with corrections; the one-active-application rule; RBAC and data scoping for every route and role (positive and negative); SSN masking on every endpoint; audit coverage (every state-changing endpoint produces an audit entry in-transaction, verified by a test that enumerates routes); concurrency tests for claim/assign; rate-limit persistence; file sniffing; OCR job lifecycle; every simulation's deterministic mapping and fault scenarios; MISMO/LAR mapping against the delivered mapping document.
- **End-to-end browser tests** covering each role's primary journey: Borrower — register, verify, enroll MFA, complete all 10 steps with co-borrower, upload and replace a document, link a bank account, sign, submit, receive revision request, resubmit, withdraw/decline; Caseworker — sign in via demo login, claim, correct a field, add notes and chatter, review documents and OCR, run checks and AUS, record preliminary decision, request revision; Supervisor — assign/bulk/auto/reassign, Level-1 and Level-2 approval by different supervisors, denial, analytics, caseworker management, audit log filter and export, configuration change, seed and remove demo data, all exports. Public — calculator, comparison, pre-fill flow.
- Tests run in CI on every change with a coverage report; the delivered test suite passes in a clean environment with zero external keys.

---

## 8. Pages and Navigation Inventory

| Page | Route (indicative) | Role | Purpose |
|---|---|---|---|
| Landing | `/` | Public | Overview, links to tools, Sign In, Create Account |
| Pre-Qualification Calculator | `/pre-qualify` | Public | Affordability estimate; pre-fill hand-off |
| Loan Comparison | `/compare` | Public | 3+ scenarios; presets; pre-fill hand-off |
| Sign In | `/sign-in` | Public | Credentials; demo quick logins (demo mode) |
| Create Account | `/sign-up` | Public | Borrower registration |
| Verify Email | `/verify-email` | Public | Token landing; resend |
| Forgot / Reset Password | `/forgot-password`, `/reset-password` | Public | Reset flow |
| MFA Enrollment | `/mfa/enroll` | Any (enrollment token) | QR, verify, recovery codes |
| MFA Challenge | `/mfa/verify` | Any | TOTP or recovery code |
| Not Found | `*` | Public | 404 |
| Borrower Dashboard | `/dashboard` | Borrower | Application list, cards, actions |
| New Application | `/applications/new` | Borrower | Source selection and section copy |
| Application Wizard | `/applications/:id` (steps 1–10) | Borrower | URLA entry, documents, signature, submit |
| Application View | `/applications/:id/view` | Borrower | Read-only, status, formal notes, versions, withdraw/decline |
| Borrower Profile | `/profile` | All | Name, email, password, MFA, (Borrower) notification preferences |
| Notifications | `/notifications` | All | Full list |
| Caseworker Queue | `/caseworker/queue` | Caseworker | Unassigned / My Queue, stats strip |
| Completion History | `/caseworker/history` | Caseworker | Completed applications |
| Application Detail (staff) | `/staff/applications/:id` | Caseworker (assigned), Supervisor | Tabs per §4.4.3; underwriting panel; approvals (Supervisor) |
| Supervisor Home — All Applications | `/supervisor` | Supervisor | List, filters, cards, assignment actions |
| Analytics | `/supervisor/analytics` | Supervisor | Charts, compliance table, activity feed |
| Caseworker Management | `/supervisor/caseworkers` | Supervisor | Accounts, workload, add/deactivate/reset MFA |
| Audit Log | `/supervisor/audit-log` | Supervisor | Viewer, filters, CSV export |
| Configuration | `/supervisor/settings` | Supervisor | Thresholds, SLAs, policies, HMDA identifiers |
| Outbound Messages | `/supervisor/outbound` | Supervisor | Simulated email/SMS log |
| System Status | `/supervisor/system` | Supervisor | Job metrics, integration mode (simulated/real), demo mode indicator |
| Demo Data | `/supervisor/demo-data` | Supervisor (demo mode) | Seed / remove |
| Exports | (actions on detail and `/supervisor/exports`) | Supervisor | MISMO, PDF, LAR, warehouse |

Navigation: each role has a persistent header with role-appropriate links, the notification bell, and a user menu (profile, sign out). Borrowers see Dashboard, New Application, Profile. Caseworkers see Queue, History, Profile. Supervisors see All Applications, Analytics, Caseworkers, Audit Log, Settings, Profile.

---

## 9. Data Model Overview

Identifiers are UUIDs; applications also carry a human-readable `applicationNumber` (`MM-YYYY-NNNNNN`). All entities carry `createdAt`/`updatedAt`. Encrypted fields are marked (enc).

| Entity | Key fields | Relationships |
|---|---|---|
| **User** | id, email (unique), passwordHash, role (BORROWER/CASEWORKER/SUPERVISOR), firstName, lastName, phone, emailVerifiedAt, status (active/inactive), passwordChangedAt, failedLoginCount, lockedUntil, notificationChannel (EMAIL/SMS/BOTH), smsVerifiedAt, isDemo, isSeed, lastSignInAt | 1–n Application (borrower), Session, MfaEnrollment, PasswordHistory, Notification, AuditLogEntry (actor) |
| **Session** | id, userId, tokenHash, createdAt, lastSeenAt, expiresAt, revokedAt, ip, userAgent | n–1 User |
| **MfaEnrollment** | id, userId, secret (enc), status (pending/active/reset), verifiedAt, recoveryCodeHashes[] (with usedAt), lastUsedStep | n–1 User |
| **PasswordResetToken** | id, userId, tokenHash (indexed, unique), purpose (reset/verify-email/invite), expiresAt, usedAt | n–1 User |
| **PasswordHistory** | id, userId, passwordHash, createdAt | n–1 User |
| **RateLimitBucket** | key, windowStart, count | — |
| **Application** | id, applicationNumber, borrowerUserId, workflowState, previousStateForSuspend, priority, priorityOverride, currentVersionNumber, versionStamp (concurrency), submittedAt, decidedAt, outcome (approved/denied/null), stateEnteredAt, slaPausedAt, revisionCycles, escalationRequired, escalationCriteriaMet[], dti, ltv, cltv, aussStale, isSeed, copiedFromApplicationId | n–1 User; 1–n Borrower, ApplicationVersion, Document, Signature, UnderwritingResult, FraudFlag, CaseworkerAssignment, ApprovalRecord, WorkflowHistory, ApplicationNote, AuditLogEntry, Condition |
| **Borrower** (primary & co-borrower) | id, applicationId, ordinal (1/2), names, alternateNames, ssn (enc), ssnLast4, ssnBlindIndex, dateOfBirth (enc), citizenship, maritalStatus, dependents, phones, email, creditType, militaryService{}, currentAddress{}, previousAddresses[], mailingAddress{}, housingStatus, monthlyRent, employments[] (current & previous), otherIncome[], declarations{A..M}, demographics{ethnicity[], race[], sex, method} | n–1 Application |
| **ApplicationData** (shared sections) | applicationId, assets[] (accountNumber enc), otherCredits[], realEstateOwned[] (mortgage accountNumber enc), liabilities[], otherLiabilities[], subjectProperty{address, geocode{lat,lng,county,censusTract}, …}, loan{…}, proposedHousingExpense{…} | 1–1 Application |
| **ApplicationVersion** | id, applicationId, versionNumber, snapshot (JSON, encrypted fields masked/encrypted), reason (initial_submission/resubmission), createdAt, createdByUserId | n–1 Application |
| **Document** | id, applicationId, documentType, description, checklistItemKey, status (pending/accepted/insufficient/waived), statusReason, currentVersionId, uploadedByUserId, isSeed | n–1 Application; 1–n DocumentVersion |
| **DocumentVersion** | id, documentId, versionNumber, storageKey, originalFileName, sniffedContentType, sizeBytes, sha256, uploadedByUserId, createdAt | n–1 Document; 1–n DocumentJob, OcrExtraction |
| **DocumentJob** | id, documentVersionId, status (queued/processing/completed/failed), attempt, maxAttempts, provider, startedAt, finishedAt, error | n–1 DocumentVersion |
| **OcrExtraction** | id, documentVersionId, provider, fields[] {path, value, confidence}, rawText, createdAt | n–1 DocumentVersion |
| **DocumentRequest** | id, applicationId, documentType, reason, requestedByUserId, fulfilledByDocumentId, createdAt | n–1 Application |
| **Signature** | id, applicationId, borrowerId, mode (drawn/typed/demo), imageData, attestationText, attestationVersion, signedAt, ip, userAgent, dataHash, invalidatedAt | n–1 Application |
| **BankLink** | id, applicationId, borrowerId, provider, institution, accessToken (enc), linkedAt, unlinkedAt, importedAccountIds[] | n–1 Application |
| **UnderwritingResult** | id, applicationId, checkType (credit/income/avm/pricing/aus), status (running/completed/error), provider, requestedByUserId, requestedAt, completedAt, result (JSON), summary, riskBadge, isStale, supersededById | n–1 Application |
| **FraudFlag** | id, applicationId, type, severity, sourceDocumentVersionId, sourceResultId, details, status (open/resolved/dismissed), resolvedByUserId, resolutionNote, resolvedAt | n–1 Application |
| **CaseworkerAssignment** | id, applicationId, caseworkerUserId, assignedByUserId, method (claim/manual/bulk/auto/reassign), reason, assignedAt, endedAt, endReason; DB constraint: at most one row per application with endedAt null | n–1 Application, User |
| **ApprovalRecord** | id, applicationId, level (1/2), decision (approve/deny), approverUserId, notes, conditions[], denialReasons[], criteriaEvaluated (JSON), dtiAtDecision, ltvAtDecision, createdAt | n–1 Application |
| **Condition** | id, applicationId, approvalRecordId, text, status (open/cleared), clearedByUserId, clearedAt | n–1 Application |
| **WorkflowHistory** | id, applicationId, fromState, toState, actorUserId (nullable for SYSTEM), actorRole, note, versionNumber, createdAt | n–1 Application |
| **ApplicationNote** | id, applicationId, authorUserId, type (internal/formal/chatter), content, relatedTransitionId, createdAt (immutable) | n–1 Application |
| **AuditLogEntry** | id, timestamp, actorUserId, actorRole, actionType, applicationId, entityType, entityId, summary, before (JSON), after (JSON), reason, ip, requestId, isSeed | n–1 User, Application |
| **Notification** | id, recipientUserId, type, title, body, applicationId, channel (in_app/email/sms), deliveryStatus (pending/sent/failed), deliveryError, readAt, createdAt | n–1 User |
| **OutboundMessage** | id, channel, recipient, subject, body, notificationId, status, createdAt | n–1 Notification |
| **SystemConfig** | key, value (JSON), updatedByUserId, updatedAt | — |
| **SeedRun** | id, createdByUserId, createdAt, recordCounts (JSON), removedAt | — |

Relationships summary: User 1–n Application; Application 1–2 Borrower, 1–1 ApplicationData, 1–n each of Version, Document (1–n DocumentVersion 1–n Job/Extraction), Signature, UnderwritingResult, FraudFlag, Assignment (≤ 1 active), ApprovalRecord (≤ 1 per level per version), Condition, WorkflowHistory, Note, AuditLogEntry, DocumentRequest, BankLink; Notification n–1 User with optional Application.

---

## 10. Acceptance Criteria

Each criterion is pass/fail and will be verified on the vendor-deployed demonstration instance with `DEMO_MODE=true` and no external API keys, and by review of the automated test suite.

**Authentication and sessions**
- AC-01 A visitor can register, receive the verification message on the Outbound Messages page, verify, be forced through TOTP enrollment (receiving 10 recovery codes), and reach the dashboard; before enrollment is verified every protected API returns 401/403.
- AC-02 The sign-in page shows Borrower / Caseworker / Supervisor quick-login buttons that work on first click; with `DEMO_MODE=false` the buttons and their endpoint are absent, and no password string appears in any client bundle.
- AC-03 Signing in with a recovery code consumes it; calling the enrollment endpoint while an active enrollment exists does not change the active secret.
- AC-04 After 5 failed sign-ins the account is locked for 15 minutes; responses for wrong password, locked account, and unknown email are byte-identical apart from timing.
- AC-05 (SEC-3) The session cookie carries `HttpOnly`, `Secure`, `SameSite`; a state-changing request with a valid session but missing/mismatched CSRF token is rejected; a forged cookie+header pair not bound to the session is rejected.
- AC-06 (SEC-10) The reset-token table stores only hashes with a unique index; a request for a reset produces no log line containing the token; the lookup query uses the index (explain plan).
- AC-07 (SEC-11) After 10 failed sign-ins, restarting the application server does not reset the limit; a second instance sharing the database enforces the same limit.
- AC-08 (SEC-20) Password change invalidates other sessions; deactivation revokes sessions immediately.
- AC-09 The proposal describes wiring an external IdP through the provider interface; the delivered System runs entirely on the built-in provider.

**Borrower portal**
- AC-10 A Borrower completes all 10 steps with a co-borrower; every field listed in §4.2.4 is present and saved; refresh at any point loses no data; the saved-at indicator updates.
- AC-11 With one application in Application Received, submitting a second returns 409 with the stated message, shown in the wizard.
- AC-12 Copying sections from an application saved 91 days earlier shows the staleness advisory; from one saved 30 days earlier it does not; the copy is audited.
- AC-13 (SEC-7) DTI shown in the wizard, after a caseworker correction, in the underwriting panel, and in the LAR are identical for the same data and include overtime, bonus, commission, rental, and other income.
- AC-14 LTV 97.5% blocks submission with a visible error; 85% shows a warning and allows submission.
- AC-15 Both drawn and typed signatures can be captured; attestation metadata is stored; editing a field after signing invalidates the signature; the demonstration attestation button exists only in demo mode; signature capture creates an audit entry (SEC-8).
- AC-16 Uploading a `.exe` renamed `.pdf` is rejected by content sniffing (SEC-12); a 10.1 MB file is rejected; an 8 MB PDF succeeds and appears with a job status badge that progresses to completed.
- AC-17 Replacing a W-2 creates version 2, retains version 1 viewable by staff, and the checklist references version 2; deleting a document outside Draft is rejected server-side.
- AC-18 The simulated bank link imports 2–4 accounts as asset rows and an income-evidence panel; unlink converts the rows to manual.
- AC-19 Typing "123 Ma" in any address field shows suggestions; selecting one fills all address parts; with the `!!` fault trigger the field silently accepts manual entry.
- AC-20 Withdraw works from every borrower-withdrawable state and Decline from every approved-outcome state; both notify staff.
- AC-21 Changing the account email requires the current password and the old address remains active until the new one is verified.

**Public tools**
- AC-22 The calculator and comparison tool work without sign-in, recalculate on input change, highlight best value, and "Start an application" pre-fills Steps 3, 5, and 7 after registration/sign-in; a tampered hand-off token yields a plain draft.

**Caseworker workbench**
- AC-23 The queue sorts overdue and urgent items first; all 15 states display human-readable labels; the stats strip shows the five figures in §4.4.2.
- AC-24 (SEC-4) Two caseworkers clicking Claim on the same application within the same second results in exactly one active assignment and one conflict response; the same holds for concurrent supervisor bulk assign and reassign.
- AC-25 (SEC-6) A correction succeeds in Completeness Validated by the assigned caseworker, is rejected (403) for a non-assigned caseworker, and is rejected (409) in Approved; the corrected field shows the indicator with original value, editor, time, and reason.
- AC-26 (SEC-8) Every correction, note, chatter message, document status change, and assignment produces an audit entry in the same transaction — a forced failure of the audit insert rolls back the change.
- AC-27 Internal notes and chatter are never returned to the Borrower on any endpoint (SEC-22); formal notes are; chatter messages cannot be edited or deleted by any role.
- AC-28 A resubmission after Revision Requested creates Version 2; the diff view shows changed fields; a caseworker correction does not create a version.
- AC-29 (SEC-2) On every staff endpoint and screen SSN appears as `***-**-NNNN` and DOB as `Mon D, YYYY`; the owning Borrower's identity step is the only place the full SSN is returned.

**Workflow and approvals**
- AC-30 Every transition in §4.5.3 is executable by the stated actor with its preconditions and produces WorkflowHistory and audit rows; every transition not in the table returns 409 listing the allowed transitions.
- AC-31 (SEC-5) With a Level-1 `deny` record present, the transition to Approved is rejected; with a Level-1 `approve` for an LTV 85% application the System routes to Escalated Review; the same supervisor attempting Level-2 is rejected; a different supervisor's approve completes to Approved and then Borrower Notified.
- AC-32 Changing the escalation LTV threshold to 90% causes an LTV 85% Conventional application to require one-level approval only; the change is audited with before/after.
- AC-33 Suspend from AUS Executed then Resume returns to AUS Executed with the SLA clock excluding the suspended interval.
- AC-34 A correction to income after AUS Executed marks AUS stale and blocks T15 until AUS is re-run.

**Supervisor portal**
- AC-35 Manual, bulk, and auto-assign produce assignments; auto-assign gives the next application to the caseworker with the fewest active assignments; enabling productivity weighting changes the outcome per the documented formula; every assignment is audited with reason.
- AC-36 All four checks and AUS run against simulations with the documented deterministic outcomes for SSN last digit 2, 5, 8, and 9 (retry), ZIP last digit 7 and 9, and employer factor 9; results show risk badges; audit details include result summaries.
- AC-37 The AVM map renders the subject and 4 comparable markers without any API key.
- AC-38 A fraud flag is created for employer factor 9 and for an OCR `mismatch` file; a high-severity open flag blocks Preliminary Decision until resolved.
- AC-39 (SEC-14) Analytics with 18,000 seeded-scale applications responds in ≤ 2 s and the queries are aggregations (verified by query log); the recent activity feed shows state labels, never "unknown".
- AC-40 The compliance table, workload chart, LTV/DTI risk charts, and 6-month trend render with seeded data and export CSV.
- AC-41 Adding a caseworker sends an invitation (Outbound Messages), and deactivating one returns their active applications to Unassigned with a Supervisor notification.
- AC-42 (SEC-9) No HTTP route accepts audit entries; attempts to POST/PUT/DELETE audit records return 404/405 for every role; the audit viewer filters auto-apply and CSV export streams with the filter applied.
- AC-43 (SEC-15) Seeding is available only in demo mode, creates at least 50 applications meeting every minimum in the §4.6.12 distribution, stages every demo-persona position listed there (verified by signing in as each demo account), seeded accounts cannot sign in, and Remove Demo Data deletes only seed-flagged records; each §6.4 walk-through narrative executes end-to-end from a fresh seed.

**Document intelligence**
- AC-44 (SEC-13) Every upload creates a DocumentJob visible with status; killing the worker mid-job leaves the job retryable rather than stuck; a `fail` file ends in failed after automatic retries with a manual Retry available.
- AC-45 (SEC-16) Applying an OCR suggestion persists the value (visible after reload and in the audit log as a correction with source document); it is rejected when corrections are not permitted.
- AC-46 The comparison view shows extracted vs entered values with confidence colors and provider attribution; `blurry` files show red confidence.

**Notifications**
- AC-47 Each trigger in §4.8.2 produces an in-app notification; Borrower external messages appear on the Outbound Messages page in the preferred channel; a `@bounce.example` address shows a failed delivery with retry; approval/denial notifications use the shared service (verified by test).

**Exports and compliance**
- AC-48 MISMO JSON and XML exports for a co-borrower application contain PARTIES, LOANS, COLLATERALS, ASSETS, LIABILITIES per the delivered mapping; XML is well-formed in the MISMO namespace; SSN is masked.
- AC-49 The URLA PDF opens in a standard viewer, contains all sections, masked SSN, U.S.-formatted dates and currency, and the embedded signature image.
- AC-50 The HMDA LAR for the seeded year parses under the FFIEC file format with one record per reportable application, correct action-taken codes for approved/denied/withdrawn/declined, applicant age computed at application date, and "not provided" demographic codes where applicable.
- AC-51 The warehouse extract ZIP contains every table in §4.9.5 with `schema.json`; `dim_borrower` contains no SSN or DOB.

**Deployment, security, and quality**
- AC-52 The System is deployed by the vendor to a cloud host with managed PostgreSQL and S3-compatible storage; upload, OCR, notification, and every export function there.
- AC-53 `docker compose up` followed by the single migrate+seed command yields a working local instance; `.env.example` documents every variable; `GET /api/health` returns dependency status.
- AC-54 (SEC-1) Database inspection shows SSN, DOB, and account numbers as ciphertext with a key id; rotating the key and re-encrypting is documented and tested.
- AC-55 (SEC-17, SEC-18) Security headers are present on every response; a dependency scan shows no critical/high findings; a request with an unknown JSON field is rejected.
- AC-56 (SEC-19, SEC-21) A scripted scan of all routes confirms each is guarded; a Borrower calling any staff route receives 403 before body validation; duplicate in-flight check runs and duplicate new-application requests are rejected.
- AC-57 (SEC-12 storage) A storage key containing `../` cannot be produced by any API; deleting a document leaves no orphaned record.
- AC-58 Unit/integration suite covers every item in §7.7 and passes in CI; the end-to-end suite executes every role journey in §7.7 and passes against the deployed demo instance with zero external keys.
- AC-59 Every list endpoint is paginated with an enforced maximum; a request for `limit=1000` returns at most the maximum without error.
- AC-60 Keyboard-only navigation completes registration, the full wizard, a document upload, and a claim; automated accessibility checks report no WCAG 2.1 AA violations on every page in §8.

---

## 11. Out of Scope

The following are **not required** by this procurement and will not be evaluated under §10. The vendor may include any of them as additions, provided the required scope is delivered in full and unaffected; where not included, the System must be designed so they can be added later without redesign of the provider abstractions in §6.

- Live third-party credit bureau, AVM, income-verification, pricing, or AUS integrations with production credentials (interfaces and optional wiring are in scope; contracts and credentials are not).
- Production financial-data aggregator, address, OCR/AI, email, or SMS provider contracts.
- Third-party electronic signature services (e.g., DocuSign); the built-in signature and attestation is the in-scope mechanism.
- Native mobile applications (iOS/Android); the responsive web application is in scope.
- Multi-language / internationalization; U.S. English only.
- Real-time collaboration or simultaneous co-editing of an application; real-time push for chatter (polling is sufficient).
- The analytics data warehouse itself and analytic queries against it; the extract in §4.9.5 is in scope.
- Counter-offer negotiation workflows; loan closing, funding, servicing; disclosure generation (Loan Estimate / Closing Disclosure).
- Separate co-borrower login accounts.
- Audit log archival and retention tiering.
- Identity verification (KYC) services beyond document upload.

---

## 12. Glossary

| Term | Definition |
|---|---|
| **Active application** | An application in any workflow state other than Draft or a terminal state; at most one per Borrower. |
| **APR** | Annual Percentage Rate — the annual cost of credit including finance charges. |
| **AUS** | Automated Underwriting System — rule-based evaluation producing Approve/Eligible, Refer, or Refer with Caution. |
| **AVM** | Automated Valuation Model — algorithmic property value estimate with comparable sales. |
| **Blind index** | A keyed hash (HMAC) of a sensitive value stored to allow equality lookup without decryption. |
| **Chatter** | Persisted, immutable per-application message list among staff. |
| **CLTV** | Combined Loan-to-Value — all liens on the property divided by value. |
| **Correction** | A field-level, audited staff edit of borrower-entered data; never creates a version. |
| **CSRF** | Cross-Site Request Forgery — forged state-changing requests from a victim's browser. |
| **Demo mode** | `DEMO_MODE=true`: enables quick logins, demonstration attestation, seeding, simulated delivery pages. |
| **DTI** | Debt-to-Income ratio per the single definition in §4.2.7. |
| **Escalation** | Requirement for two-level approval when LTV, DTI, or loan-type criteria are met. |
| **FHA / VA / USDA** | Government-insured or guaranteed loan programs (Federal Housing Administration, Department of Veterans Affairs, U.S. Department of Agriculture Rural Development). |
| **Formal note** | A staff note attached to a decision or revision request and visible to the Borrower. |
| **HMDA** | Home Mortgage Disclosure Act (Regulation C) — demographic collection and LAR reporting. |
| **LAR** | Loan Application Register — the HMDA annual file of application dispositions. |
| **LEI / ULI** | Legal Entity Identifier of the institution; Universal Loan Identifier derived from it. |
| **LTV** | Loan-to-Value — loan amount divided by the lesser of value/price and AVM value. |
| **MFA / TOTP** | Multi-factor authentication using time-based one-time passwords (RFC 6238). |
| **MISMO** | Mortgage Industry Standards Maintenance Organization; v3.4 Reference Model used for exports. |
| **OCR** | Optical character recognition / document extraction. |
| **PII** | Personally identifiable information (SSN, DOB, account numbers, contact details). |
| **PITI** | Principal, interest, taxes, insurance — the monthly housing payment. |
| **Priority** | Urgent / High / Normal / Low ranking of an application in queues. |
| **REO** | Real Estate Owned — properties the borrower currently owns. |
| **SLA** | Service-level target for time in a workflow state; on track / at risk / overdue. |
| **Simulation** | Built-in deterministic implementation of an external integration requiring no API key. |
| **Tradeline** | A credit account on a credit report. |
| **URLA** | Uniform Residential Loan Application, 2020 revision (Fannie Mae Form 1003 / Freddie Mac Form 65). |
| **Version** | Full snapshot of application data created at each Borrower submission or resubmission. |
| **Workflow state** | The single status of an application, one of the 15 states in §4.5.1. |

---

*End of Request for Proposal — MortMortgage, Inc., RFP v1.0*
