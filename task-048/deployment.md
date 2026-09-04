# Deployment Guide

This document covers deploying MortMortgage to AWS cloud infrastructure, configuring the background worker, and managing encryption key rotation.

---

## Table of Contents

1. [Cloud Architecture (ASM-007)](#cloud-architecture-asm-007)
2. [Container Build & Registry](#container-build--registry)
3. [Environment Configuration](#environment-configuration)
4. [Running the System](#running-the-system)
5. [Background Worker](#background-worker)
6. [Health & Observability](#health--observability)
7. [Encryption Key Rotation](#encryption-key-rotation)
8. [Demo Mode in Production](#demo-mode-in-production)

---

## Cloud Architecture (ASM-007)

**Target:** AWS container platform (ECS/Fargate or equivalent) + managed RDS PostgreSQL + S3 object storage.

```
┌─────────────────────────────────────────────────────┐
│  Application Load Balancer (ALB)                    │
└─────────┬───────────────────────────────────────────┘
          │
    ┌─────┴──────────────────────────┐
    │                                │
┌───▼──────┐                  ┌──────▼──────┐
│ Web App  │                  │ Web App      │
│ Container 1                 │ Container 2  │
│ :3083    │                  │ :3083        │
└───┬──────┘                  └──────┬──────┘
    │                                │
    └────────────────┬───────────────┘
                     │
        ┌────────────┴──────────────┐
        │                           │
    ┌───▼────────────┐      ┌──────▼──────┐
    │ RDS PostgreSQL │      │ S3 Storage  │
    │ (Multi-AZ)     │      │ (Versioned) │
    └────────────────┘      └─────────────┘
        │
        │
    ┌───▼────────────────────┐
    │ Worker Container       │
    │ (Long-lived service)   │
    │ :3083 (no traffic)     │
    └────────────────────────┘
```

**Components:**

| Component | Purpose | Configuration |
|-----------|---------|----------------|
| **ALB** | Distributes traffic across web app instances | Health check: GET /api/health (200 OK) |
| **Web App Container (runner)** | Next.js application server | ECS/Fargate; min 2 instances for HA |
| **Worker Container** | Background job processor | Single instance sufficient; running 2+ is safe (DB-guarded claims) |
| **RDS PostgreSQL** | Managed database | Multi-AZ for HA; automated backups |
| **S3 Storage** | Document storage, exports | Versioning enabled; server-side encryption |

**Security Posture:**

- Web app container runs as non-root user
- Database credentials in AWS Secrets Manager, injected at runtime
- S3 access via IAM role (no long-lived keys in env)
- All traffic encrypted (TLS 1.3 recommended)
- Network isolation: private subnets for database/storage

---

## Container Build & Registry

**Multi-stage Dockerfile** (provided in root):

```dockerfile
# Stage 1: builder
# Stage 2: worker (for background job container)
# Stage 3: runner (for web app container)
```

**Build:**

```bash
docker build -t mortmortgage:latest -t mortmortgage:$(git rev-parse --short HEAD) .
docker push <ecr-registry>/mortmortgage:latest
```

**Image targets:**

| Target | Command | Purpose |
|--------|---------|---------|
| `runner` | `npm run start` (Next.js standalone) | Web application server |
| `worker` | `npm run worker` | Background job processor |

**Registry:** AWS ECR (recommended) or Docker Hub.

---

## Environment Configuration

**Secrets (AWS Secrets Manager):**

```json
{
  "DATABASE_URL": "postgresql://user:password@rds-endpoint:5432/mortmortgage",
  "FIELD_ENCRYPTION_KEYS": "{\"k1\":\"<base64-32-byte-key>\"}",
  "FIELD_ENCRYPTION_ACTIVE_KEY_ID": "k1",
  "SSN_BLIND_INDEX_KEY": "<base64-32-byte-key>",
  "CSRF_SECRET": "<base64-32-byte-key>"
}
```

**Non-secret env vars (ECS task definition or parameter store):**

```env
DEMO_MODE=false
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_REGION=us-east-1
S3_BUCKET=mortmortgage-documents-prod
S3_ACCESS_KEY_ID=<iam-role-based-credential>
S3_SECRET_ACCESS_KEY=<iam-role-based-credential>
S3_FORCE_PATH_STYLE=false
APP_BASE_URL=https://mortmortgage.example.com
TRUST_PROXY=true
TRUST_PROXY_HOP_COUNT=1
WORKER_POLL_INTERVAL_MS=20000
```

`TRUST_PROXY_HOP_COUNT` is the number of trusted proxies you actually operate —
`1` for a single ALB (the default), `2` for CloudFront + ALB. It selects the real
client IP that many positions from the RIGHT of `x-forwarded-for`; the leftmost
entry is caller-controlled and must never be trusted (INV-042). It is ignored
when `TRUST_PROXY=false`.

**Optional secrets.** `SESSION_SECRET` and `HANDOFF_TOKEN_SECRET` are not
required. CSRF falls back to `SESSION_SECRET` when `CSRF_SECRET` is unset, and
public-tool hand-off tokens fall back to `CSRF_SECRET` then `SESSION_SECRET`. Add
them to Secrets Manager only to put those subsystems on separate key material.

**Complete reference.** The two lists above are the *production* set. The
exhaustive reference is `.env.example` in the repository root — every variable
the code reads, with purpose, default and required-ness. Beyond the production
set it documents three families that exist for demonstration and testing and
that a production deployment leaves unset:

| Family | Purpose |
|--------|---------|
| `CHECK_PROVIDER_*`, `OCR_PROVIDER*` | Select `real` integration providers and supply their base URL / API key. Default is `simulation` — zero external keys (§6.1). |
| `SIM_FAULT_*`, `SIM_LATENCY_*` | Inject fault scenarios and tune simulated-integration timing (§6.3). Each defaults to a value baked into the code. |
| `BANK_AGGREGATOR_PROVIDER`, `GEOCODING_PROVIDER`, `MESSAGING_PROVIDER` | Reporting-only labels for the Supervisor system page. These three integrations have no real-provider seam in this version, so setting them changes no behaviour. |

`E2E_BASE_URL` points the Playwright suite at an already-running instance
(`npm run test:e2e`); it is never set on a deployed service.

**Best Practices:**

- Never commit `.env` or secrets to Git
- Rotate secrets every 90 days
- Use AWS Secrets Manager for centralized management
- IAM roles for S3 access (no embedded keys)
- Database credentials in RDS password manager

---

## Running the System

### One-Command Database Setup

```bash
# Run once per release/environment
npm run db:setup

# Internals:
#   1. prisma migrate deploy (versioned migrations; idempotent)
#   2. prisma db seed (ensureBaseSeed + demo dataset if DEMO_MODE=true)
```

### ECS Task Definition (Web App)

```json
{
  "family": "mortmortgage-app",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "<ecr>/mortmortgage:latest",
      "portMappings": [
        {
          "containerPort": 3083,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "DEMO_MODE",
          "value": "false"
        },
        {
          "name": "STORAGE_PROVIDER",
          "value": "s3"
        },
        {
          "name": "TRUST_PROXY",
          "value": "true"
        }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:...:secret:mortmortgage/database-url"
        },
        {
          "name": "FIELD_ENCRYPTION_KEYS",
          "valueFrom": "arn:aws:secretsmanager:...:secret:mortmortgage/encryption-keys"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/mortmortgage-app",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3083/api/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ],
  "executionRoleArn": "arn:aws:iam::...:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::...:role/ecsTaskRole"
}
```

### ECS Service

```json
{
  "serviceName": "mortmortgage-app",
  "cluster": "mortmortgage-cluster",
  "taskDefinition": "mortmortgage-app",
  "desiredCount": 2,
  "launchType": "FARGATE",
  "networkConfiguration": {
    "awsvpcConfiguration": {
      "subnets": ["subnet-private-1", "subnet-private-2"],
      "securityGroups": ["sg-app-private"],
      "assignPublicIp": "DISABLED"
    }
  },
  "loadBalancers": [
    {
      "targetGroupArn": "arn:aws:elasticloadbalancing:...:targetgroup/mortmortgage/...",
      "containerName": "app",
      "containerPort": 3083
    }
  ],
  "deploymentConfiguration": {
    "maximumPercent": 200,
    "minimumHealthyPercent": 100
  }
}
```

### Worker Task Definition

```json
{
  "family": "mortmortgage-worker",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "worker",
      "image": "<ecr>/mortmortgage:latest",
      "command": ["npm", "run", "worker"],
      "environment": [
        {
          "name": "DEMO_MODE",
          "value": "false"
        },
        {
          "name": "WORKER_POLL_INTERVAL_MS",
          "value": "20000"
        }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:...:secret:mortmortgage/database-url"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/mortmortgage-worker",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "executionRoleArn": "arn:aws:iam::...:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::...:role/ecsTaskRole"
}
```

### ALB Target Group

```json
{
  "Name": "mortmortgage-tg",
  "Protocol": "HTTP",
  "Port": 3083,
  "HealthCheckProtocol": "HTTP",
  "HealthCheckPath": "/api/health",
  "HealthCheckIntervalSeconds": 30,
  "HealthCheckTimeoutSeconds": 5,
  "HealthyThresholdCount": 2,
  "UnhealthyThresholdCount": 3,
  "Matcher": {
    "HttpCode": "200"
  },
  "TargetType": "ip"
}
```

---

## Background Worker

**Purpose:**

The worker is a long-lived container that continuously polls for and executes background jobs:

1. **Document OCR extraction** — processes DocumentJob rows (queued → processing → completed/failed)
2. **Notification delivery** — retries failed outbound messages (3× with exponential backoff)
3. **Decision-notification dispatch recovery** — re-attempts approval/denial notifications if dispatch initially failed
4. **Reconciliation** — marks stuck OCR jobs (processing >10 minutes) as failed and retryable

**Execution Model:**

```
while(true):
  tx = BEGIN
    LOCK advisor-lock (global singleton — only one worker runs at a time per-phase)
    load queued/failed jobs with FOR UPDATE SKIP LOCKED
    process each job
    if job succeeds: mark completed
    if job fails: increment retry count; if <= maxRetries, mark failed-retryable else mark failed
  COMMIT
  sleep(WORKER_POLL_INTERVAL_MS)
```

**Boot Reconcilers:**

On startup, the worker:
1. Re-runs all reconcilers (marked stuck jobs, pending decision notifications, failed outbound messages)
2. Then enters the polling loop

**Multiple Workers:**

Safe to run 2+ worker instances concurrently. Database-guarded job claims ensure no double-execution. Concurrent workers and the web app's own lazy execution can never duplicate work.

**Graceful Shutdown:**

On SIGTERM, the worker:
1. Stops accepting new claims
2. Finishes in-flight work
3. Disconnects cleanly
4. Exits with code 0

Rolling deploys are safe; no data loss.

---

## Health & Observability

### Health Check Endpoint

```bash
GET /api/health
# Response (200 OK):
# {
#   "status": "ok",
#   "version": "1.0.0",
#   "database": "ok",
#   "storage": "ok",
#   "time": "2025-01-15T14:30:00.000Z"
# }

# Response (503 Service Unavailable):
# {
#   "status": "error",
#   "database": "fail",
#   "storage": "ok",
#   "time": "2025-01-15T14:30:00.000Z"
# }
```

Returns 200 only when both database AND storage checks pass. ALB and Kubernetes use this for liveness/readiness probes.

### Structured Logging

Both web app and worker emit single-line JSON logs to stdout:

```json
{
  "timestamp": "2025-01-15T14:30:00.000Z",
  "level": "info",
  "requestId": "req-abc123",
  "userId": "user-xyz789",
  "role": "supervisor",
  "route": "POST /api/applications/:id/transition",
  "method": "POST",
  "status": 200,
  "duration": 124,
  "message": "Application transitioned to preliminary_decision"
}
```

**No PII, secrets, or file contents logged.** Request IDs are echoed in error responses for correlation.

**Ship stdout to CloudWatch / Datadog / ELK stack as-is.**

### System Status (Supervisor UI)

```bash
GET /api/admin/system-status
```

Returns:
- Background job metrics: queued, processing, failed
- Integration modes: credit provider, income provider, AVM provider, pricing provider, OCR provider (simulation vs real)
- Last reconciliation timestamp

**Used by Supervisor → System Status page to monitor job queue health.**

### Metrics & Alarms

Recommended CloudWatch alarms:

- **High error rate:** `ErrorRate > 5%` for 5 minutes
- **Database connection failures:** `DBConnectionErrors > 10` per minute
- **S3 access failures:** `S3Errors > 10` per minute
- **Worker lag:** `QueuedJobs > 100` (OCR jobs not processing)
- **Long-running tasks:** `ApplicationProcessingTime > 3600` seconds

---

## Encryption Key Rotation

**Summary:** Field-encryption keys live in the `FIELD_ENCRYPTION_KEYS` environment variable. Rotation is zero-downtime via a two-phase operation.

### Why Rotate

- Key compromise
- Regulatory/compliance requirement
- Scheduled key lifecycle policy (e.g., annually)

### Phase 1: Add New Key to Ring

1. Generate a new 32-byte key (base64):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

2. Update `FIELD_ENCRYPTION_KEYS` (keep old key, add new):
   ```env
   FIELD_ENCRYPTION_KEYS={"k1":"<old-base64-key>","k2":"<new-base64-key>"}
   ```

3. Keep `FIELD_ENCRYPTION_ACTIVE_KEY_ID=k1` (still old).

4. Deploy/restart all instances (web app + worker).

**Effect:** Old key still active; new key now in ring. No behavior change yet.

### Phase 2: Flip Active Key

1. Update `FIELD_ENCRYPTION_ACTIVE_KEY_ID=k2`.

2. Deploy/restart.

**Effect:** All NEW/UPDATED encrypted fields use k2. Existing rows still decrypt via k1. System runs in mixed state — safe for days/weeks.

### Phase 3: Re-Encrypt Existing Data

```bash
npx tsx scripts/rotate-keys.ts
```

This script:
- Re-encrypts all PII columns (`Borrower.ssn*`, `Borrower.dateOfBirth*`, etc.)
- Re-encrypts JSON-embedded account numbers in ApplicationData documents
- Batch transactional processing (idempotent; safe to re-run on crash)
- Only touches rows whose keyId is not the active key

**Duration:** ~5 minutes per 100k records. Run during off-hours if possible, but safe anytime.

**Monitoring:**

```bash
# Watch progress in logs
docker logs -f mortmortgage-worker | grep "rotate-keys"

# After completion, verify:
npx tsx scripts/rotate-keys.ts
# Should report 0 re-encrypted rows (all done)
```

### Phase 4: Retire Old Key

1. Remove old key from `FIELD_ENCRYPTION_KEYS`:
   ```env
   FIELD_ENCRYPTION_KEYS={"k2":"<new-base64-key>"}
   ```

2. Deploy/restart.

**Effect:** Old key no longer in ring. Any remaining ciphertext referencing old keyId becomes undecryptable. Should be zero after Phase 3.

**Only do this after Phase 3 reports zero stale rows.**

### Escrow & Backup Recovery

Keep retired key material in secure offline storage (HSM, vault, encrypted backup). If you ever need to restore a database backup from before Phase 3, you will need the old key to be in the ring to decrypt rows from that backup.

### SSN Blind Index Rotation

**Separate from encryption key rotation:** The `SSN_BLIND_INDEX_KEY` is an HMAC key used for duplicate-detection lookups. Rotating it requires re-deriving every blind index from decrypted SSNs.

```bash
# This is NOT automated yet. Manual procedure:
# 1. Generate new SSN_BLIND_INDEX_KEY
# 2. Run a one-time script to re-hash all SSN values with new key
# 3. Update SSN_BLIND_INDEX_KEY env var
# 4. Deploy

# CAVEAT: Duplicate detection is broken during the transition.
# Schedule this during low-volume periods.
```

---

## Demo Mode in Production

**CRITICAL:** `DEMO_MODE` must be **OFF** in production.

```env
DEMO_MODE=false
```

**When OFF:** The following are absent/disabled:

- `/api/auth/demo-login` endpoint (404 if called)
- `/api/admin/demo-data/seed` endpoint (404)
- `/api/admin/demo-data` endpoint (404)
- Demo login buttons on Sign In page
- Demo Data admin page

**When ON (development/testing only):**

- One-click demo logins with preset credentials
- Seeding ≥50 applications with staged personas
- Demonstration attestation mode (bypass signature drawing)
- System status indicators for simulation vs real providers

**Verification:**

Before deploying to production, verify:
```bash
# In production environment, must return 404:
curl https://mortmortgage.example.com/api/auth/demo-login
# Expected: 404 Not Found

# If 200/OK: DEMO_MODE is ON — DO NOT DEPLOY
```

---

## Common Deployment Tasks

### Deploy a New Release

```bash
# 1. Build and push new image
docker build -t mortmortgage:$(git rev-parse --short HEAD) .
docker push <ecr>/mortmortgage:$(git rev-parse --short HEAD)

# 2. Update ECS task definition with new image tag
aws ecs update-service \
  --cluster mortmortgage-cluster \
  --service mortmortgage-app \
  --force-new-deployment

# 3. Monitor rollout
aws ecs describe-services \
  --cluster mortmortgage-cluster \
  --services mortmortgage-app
```

### Scale Up/Down

```bash
# Increase to 5 instances
aws ecs update-service \
  --cluster mortmortgage-cluster \
  --service mortmortgage-app \
  --desired-count 5
```

### Database Migration (with Downtime Minimization)

```bash
# 1. Deploy new app code (old schema-compatible)
# 2. Run migrations during low-traffic window
npm run db:setup

# 3. Restart all instances to pick up schema changes
aws ecs update-service --cluster ... --force-new-deployment

# 4. Monitor error rates
```

### Rollback

```bash
# Revert to previous task definition
aws ecs update-service \
  --cluster mortmortgage-cluster \
  --service mortmortgage-app \
  --task-definition mortmortgage-app:123  # Previous revision
  --force-new-deployment
```

---

## Support

For deployment issues or questions, contact your DevOps/infrastructure team or the development team via internal channels.
