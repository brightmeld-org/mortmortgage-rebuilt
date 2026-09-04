# MortMortgage — System Documentation

MortMortgage is a web-based Mortgage Application Management System enabling borrowers to complete the Uniform Residential Loan Application (URLA 2020) online, and caseworkers and supervisors to process, underwrite, and approve applications.

**Technology:** Next.js 15, Prisma, PostgreSQL, TypeScript, TailwindCSS. Deployed on AWS containers + managed database + S3 object storage.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Installation & Setup](#installation--setup)
4. [Running Locally](#running-locally)
5. [Data Model Overview](#data-model-overview)
6. [API Surface Overview](#api-surface-overview)
7. [Documentation Index](#documentation-index)

---

## Quick Start

```bash
# Install dependencies
npm ci

# Set up database and demo data (one-command)
npm run db:setup

# Start development server (http://localhost:3083)
npm run dev

# In another terminal, start the background worker
npm run worker

# Run tests
npm run test
npm run test:e2e
```

**Docker Compose (full stack with PostgreSQL + S3 emulator):**
```bash
docker compose up -d --build
docker compose exec worker npm run db:setup
# App available at http://localhost:3085
```

---

## Prerequisites

- **Node.js:** >= 22 < 25
- **Docker & Docker Compose** (if running with containers)
- **PostgreSQL 16** (local dev with `docker compose`, or external instance via `DATABASE_URL`)
- **S3-compatible storage** (MinIO for local dev, AWS S3 for cloud)

---

## Installation & Setup

### 1. Clone & Install

```bash
git clone <repo>
cd mortmortgage
npm ci
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and fill in required values:

```bash
cp .env.example .env
# Edit .env with:
# - DATABASE_URL (PostgreSQL connection string)
# - FIELD_ENCRYPTION_KEYS (32-byte base64 key for PII encryption)
# - FIELD_ENCRYPTION_ACTIVE_KEY_ID (key ID to use for new encryptions)
# - SSN_BLIND_INDEX_KEY (32-byte base64 for SSN blind index)
# - CSRF_SECRET (32-byte base64 for CSRF token HMAC)
# - DEMO_MODE (true for demo, false for production)
```

Generate cryptographic keys:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3. Database Setup

```bash
# Run migrations and seed demo data (if DEMO_MODE=true)
npm run db:setup

# Or separately:
npx prisma migrate deploy
npx prisma db seed
```

---

## Running Locally

### Development Mode

**Terminal 1 — Web server:**
```bash
npm run dev
# http://localhost:3083
```

**Terminal 2 — Background worker:**
```bash
npm run worker
```

The worker processes:
- Document OCR extraction jobs
- Notification delivery (with retries)
- Decision-notification dispatch recovery
- Stuck-job reconciliation

### Docker Compose

```bash
docker compose up -d --build
docker compose exec worker npm run db:setup
# http://localhost:3085
```

Services:
- **App:** http://localhost:3085 (mapped from container 3083)
- **PostgreSQL:** localhost:5433 (mapped from container 5432)
- **MinIO S3 emulator:** http://localhost:9000 (API), http://localhost:9001 (console)

Teardown:
```bash
docker compose down -v  # -v removes volumes (database & storage)
```

### Health Check

```bash
curl http://localhost:3083/api/health
# { "status": "ok", "version": "...", "database": "ok", "storage": "ok", "time": "..." }
```

---

## Data Model Overview

**29 entities** across 7 domains:

| Domain | Entities |
|--------|----------|
| **Identity & Auth** | User, Session, MfaEnrollment, PasswordReset, RateLimitBucket |
| **Application Core** | Application, ApplicationData, ApplicationVersion, BorrowerRecord, WorkflowHistory |
| **Documents** | Document, DocumentVersion, DocumentJob, OcrExtraction, DocumentRequest |
| **Underwriting** | UnderwritingResult, CreditCheckResult, IncomeCheckResult, AvmCheckResult, PricingCheckResult, AusCheckResult |
| **Workflow & Decisions** | ApprovalRecord, Condition |
| **Audit & Notes** | AuditLogEntry, ApplicationNote, FraudFlag |
| **System** | SystemConfig, SeedRun, Notification, BankLink, OutboundMessage |

**Key field constraints:**
- SSN encrypted at-rest (AES-256-GCM), masked everywhere except identity endpoint
- Account numbers encrypted at-rest, only last 4 digits exported
- Optimistic concurrency via `Application.versionStamp` (409 on conflict)
- Timestamps always ISO 8601 UTC
- Monetary values in dollars with cents (e.g., `1234.56`)

See **contracts.md §A** for complete data shapes and constraints.

---

## API Surface Overview

**Base URL:** `/api`

### Authentication Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/auth/register` | Self-register (Borrower) |
| `POST` | `/auth/sign-in` | Sign in with email + password |
| `POST` | `/auth/sign-out` | Sign out (revoke session) |
| `POST` | `/auth/demo-login` | Quick demo login (DEMO_MODE only) |
| `POST` | `/auth/mfa/enroll` | Start TOTP enrollment |
| `POST` | `/auth/mfa/verify` | Verify TOTP or recovery code |
| `GET` | `/auth/session` | Current session info |

### Application & Borrower Endpoints

| Method | Path | Purpose | Role |
|--------|------|---------|------|
| `GET` | `/applications` | List borrower's applications | Borrower |
| `POST` | `/applications` | Create new application (Draft) | Borrower |
| `GET` | `/applications/:id` | View application detail | Borrower, Caseworker, Supervisor |
| `PUT` | `/applications/:id/sections/:section` | Save a wizard section | Borrower |
| `POST` | `/applications/:id/signatures` | Submit borrower signature/attestation | Borrower |
| `POST` | `/applications/:id/transition` | Advance workflow state | Borrower, Caseworker, Supervisor |

### Document Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/applications/:id/documents` | Upload document |
| `GET` | `/documents/:id/download` | Download current version |
| `PATCH` | `/documents/:id/status` | Accept/Waive/Insufficient (staff) |
| `GET` | `/documents/:id/ocr` | View OCR extraction + suggestions |
| `POST` | `/documents/:id/ocr/apply-suggestion` | Apply OCR suggestion (staff) |

### Queue & Assignment (Caseworker/Supervisor)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/queue/unassigned` | View claimable applications |
| `GET` | `/queue/mine` | View claimed applications |
| `POST` | `/applications/:id/claim` | Claim unassigned application |
| `POST` | `/applications/:id/assignment` | Manually assign (Supervisor) |
| `POST` | `/supervisor/assignments/bulk` | Bulk assign (Supervisor) |

### Underwriting Checks (Staff)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/applications/:id/checks/:checkType` | Run credit/income/AVM/pricing/AUS check |
| `GET` | `/applications/:id/checks` | List completed checks |
| `GET` | `/applications/:id/qualification` | View LTV/DTI/qualifying score summary |
| `GET` | `/applications/:id/fraud-flags` | List fraud flags + resolutions |

### Approval & Decision (Supervisor)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/applications/:id/approval-decision` | Record approval/denial decision with escalation |
| `GET` | `/applications/:id/approvals` | View approval history |

### Exports & Compliance (Supervisor)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/applications/:id/exports/mismo-json` | Export MISMO JSON (can be masked or full-SSN) |
| `GET` | `/applications/:id/exports/mismo-xml` | Export MISMO XML |
| `GET` | `/applications/:id/exports/urla-pdf` | Export URLA PDF |
| `GET` | `/admin/exports/hmda-lar` | Export HMDA LAR pipe-delimited file |
| `GET` | `/admin/exports/warehouse` | Export data-warehouse ZIP |

### Public Tools (Anonymous)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/public/prequalify` | Pre-qualification calculator (live results) |
| `POST` | `/public/compare` | Loan comparison tool |
| `POST` | `/public/handoff-token` | Generate hand-off token for pre-fill |

### Admin & Configuration (Supervisor)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/staff` | List caseworkers/supervisors |
| `POST` | `/admin/staff` | Invite new staff member |
| `GET` | `/admin/config` | View system configuration |
| `PUT` | `/admin/config` | Update thresholds, notifications, HMDA IDs |
| `GET` | `/admin/audit-log` | View audit trail (filterable, paginated) |
| `GET` | `/admin/audit-log/export` | Export audit as CSV |
| `POST` | `/admin/demo-data/seed` | Seed ≥50 demo applications (DEMO_MODE) |
| `DELETE` | `/admin/demo-data` | Remove all seed-flagged records (DEMO_MODE) |

### Example curl requests

**Health check:**
```bash
curl http://localhost:3083/api/health
```

**Sign in (password auth):**
```bash
curl -X POST http://localhost:3083/api/auth/sign-in \
  -H "Content-Type: application/json" \
  -d '{
    "email": "borrower@example.com",
    "password": "SecurePass123!"
  }'
```

**Demo login (DEMO_MODE only):**
```bash
curl -X POST http://localhost:3083/api/auth/demo-login \
  -H "Content-Type: application/json" \
  -d '{"role": "borrower"}'
```

**Create application (Borrower, with session cookie):**
```bash
curl -X POST http://localhost:3083/api/applications \
  -H "Content-Type: application/json" \
  -b "mm_session=<session_id>" \
  -d '{
    "loanPurpose": "purchase",
    "loanType": "conventional",
    "requestedLoanAmount": 350000,
    "copyFromApplicationId": null
  }'
```

**Save application section:**
```bash
curl -X PUT http://localhost:3083/api/applications/:id/sections/step-1 \
  -H "Content-Type: application/json" \
  -b "mm_session=<session_id>" \
  -d '{
    "versionStamp": 42,
    "data": {
      "firstName": "Jane",
      "lastName": "Doe",
      "ssn": "123-45-6789",
      ...
    }
  }'
```

**Upload document:**
```bash
curl -X POST http://localhost:3083/api/applications/:id/documents \
  -H "Authorization: Bearer <token>" \
  -F "file=@pay-stub.pdf" \
  -F "documentType=paystub" \
  -b "mm_session=<session_id>"
```

**Run credit check:**
```bash
curl -X POST http://localhost:3083/api/applications/:id/checks/credit \
  -H "Content-Type: application/json" \
  -b "mm_session=<session_id>" \
  -d '{}'
```

**Record approval decision (Supervisor):**
```bash
curl -X POST http://localhost:3083/api/applications/:id/approval-decision \
  -H "Content-Type: application/json" \
  -b "mm_session=<session_id>" \
  -d '{
    "versionStamp": 42,
    "level1": {
      "decision": "approve",
      "formalNoteText": "All docs received and verified."
    }
  }'
```

**Export MISMO JSON (masked SSN):**
```bash
curl -X GET http://localhost:3083/api/applications/:id/exports/mismo-json \
  -b "mm_session=<session_id>" \
  --output application.json
```

**Export MISMO JSON (full SSN, audited):**
```bash
curl -X GET "http://localhost:3083/api/applications/:id/exports/mismo-json?full=true&reason=compliance-audit" \
  -b "mm_session=<session_id>" \
  --output application.json
```

**Export HMDA LAR (by year):**
```bash
curl -X GET "http://localhost:3083/api/admin/exports/hmda-lar?year=2025" \
  -b "mm_session=<session_id>" \
  --output lar_2025.txt
```

**Transition to next state:**
```bash
curl -X POST http://localhost:3083/api/applications/:id/transition \
  -H "Content-Type: application/json" \
  -b "mm_session=<session_id>" \
  -d '{
    "versionStamp": 42,
    "toState": "completeness_validated",
    "formalNoteText": "Documents confirmed."
  }'
```

---

## Documentation Index

| Document | Purpose |
|----------|---------|
| **[user-guide.md](./user-guide.md)** | Step-by-step workflows for Borrower, Caseworker, Supervisor, and Public users — how to complete each primary journey. |
| **[deployment.md](./deployment.md)** | AWS architecture, Docker container setup, background worker execution, environment configuration, encryption key rotation. |
| **[idp-wiring.md](./idp-wiring.md)** | How to wire an external identity provider (OIDC/SAML) through the pluggable provider interface. |
| **[urla-mismo-mapping.md](./urla-mismo-mapping.md)** | Complete URLA 2020 field-to-MISMO v3.4 mapping table (167 entries) for export conformance. |
| **[hmda-code-mapping.md](./hmda-code-mapping.md)** | HMDA LAR field specs, code tables, not-applicable justifications, transmittal sheet structure. |
| **[simulation-mapping.md](./simulation-mapping.md)** | Deterministic simulation mappings for credit, AVM, income, AUS, pricing, OCR — fault triggers, scenario keys, value ranges. |
| **[demo-walkthroughs.md](./demo-walkthroughs.md)** | 12+ executable end-to-end demo scenarios from fresh seed: pre-qualification, borrower registration, application completion, underwriting, approval, denial, exports, compliance. |

---

## Next Steps

- **Development:** See [deployment.md](./deployment.md) for running the full stack locally.
- **Admin onboarding:** See [user-guide.md](./user-guide.md) → **Supervisor** section for staff management and system configuration.
- **Integration:** See [idp-wiring.md](./idp-wiring.md) to wire production identity providers.
- **Testing:** Run demo walkthroughs in [demo-walkthroughs.md](./demo-walkthroughs.md) to validate end-to-end workflows.

---

## Key Features

- **10-step URLA 2020 wizard** with auto-save and address autocomplete
- **Co-borrower support** with independent data capture
- **Document upload** with versioning, OCR extraction, and AI suggestions
- **Bank account linking** (simulated) for income verification
- **15-state underwriting workflow** with escalated two-level approval
- **Tri-bureau credit scoring**, AVM, income verification, AUS, and pricing simulations
- **Fraud detection** with OCR mismatch, document confidence, and manual flags
- **HMDA compliance** with annual LAR reporting and demographic collection
- **MISMO v3.4 exports** (JSON/XML) for downstream systems
- **Role-based access** (Borrower, Caseworker, Supervisor) with strict data scoping
- **Audit trail** of every workflow action, correction, and decision
- **Demo mode** with one-click logins, 50+ seeded applications, and simulation data
- **Responsive design** supporting 360px–1280px+ screens

---

## Support & Contact

For issues, questions, or feedback on this documentation, contact the development team via your internal channels.
