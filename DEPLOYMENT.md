# MortMortgage — Deployment Runbook (task-045)

Deployment-configuration statement for the MortMortgage system (§7.1, NFR-026,
NFR-027, ASM-007). The full deliverable documentation set (user guide, mapping
documents, walk-throughs) is task-048; this document covers how to run the
system.

## 1. One-command operations

| Operation | Command | Notes |
|---|---|---|
| Install | `npm ci` | Node >= 22 < 25 |
| Migrate + seed | `npm run db:setup` | `prisma migrate deploy` (versioned, repeatable — NFR-026) then `prisma db seed`. Base seed always (demo accounts, config defaults); when `DEMO_MODE=true` it also runs the full §4.6.12 demonstration dataset, so a fresh environment is demonstration-ready with no UI action. |
| Start (web) | `npm run start` | Production server on :3083 (`npm run build` first) |
| Start (worker) | `npm run worker` | Background-job worker (see §4) |
| Unit/integration tests | `npm run test` | Suite delivered with task-046 (increment 12); the runner is wired now and reports no matching test files until then |
| End-to-end tests | `npm run test:e2e` | Suite delivered with task-047 (increment 12); same note |

All configuration is by environment variables — `.env.example` documents every
variable with purpose, default, and required-ness. Secrets are never committed:
`.env` is gitignored and excluded from the Docker build context.

## 2. Local full stack (docker compose)

```
docker compose up -d --build
docker compose exec worker npm run db:setup
```

Services: PostgreSQL (host port **5433**), MinIO S3-compatible storage
emulator (**9000** API / **9001** console), a one-shot `storage-init` bucket
bootstrap, the web app (**http://localhost:3085**), and the worker. The app
container runs the Next.js standalone build as a **non-root** user; health is
`GET /api/health` (200 only when database AND storage checks pass, 503
otherwise — no authentication, no per-request config loading).

The compose file defaults `DEMO_MODE=true` because it is the local
demonstration bring-up (AC-53). Everything else demo-related follows that one
flag.

Teardown: `docker compose down -v` (removes the database and object-store
volumes).

## 3. Cloud target (ASM-007: containers + managed PostgreSQL + S3)

The delivery cloud target is a container platform on AWS:

- **Web app** — the `runner` image target (ECS/Fargate or any container
  service), one or more instances behind a load balancer. Set `TRUST_PROXY=true`
  behind the load balancer. Health-check path: `/api/health`.
- **Database** — RDS PostgreSQL. `DATABASE_URL` points at it; run
  `npm run db:setup` once per release (migrations are versioned and
  repeatable; a fresh database reaches working state from zero).
- **Object storage** — S3 with `STORAGE_PROVIDER=s3` and the `S3_*` variables
  (IAM-scoped credentials). The storage abstraction keeps the app portable:
  local disk in development, any S3-compatible endpoint in the cloud; keys are
  server-generated UUIDs validated on every operation. Missing S3 configuration
  fails fast at startup naming the missing variables — the system never runs on
  silently-empty credentials.
- **Background jobs** — the `worker` image target runs as its own long-lived
  container service (one instance is sufficient; running two is safe — every
  claim is a guarded database update, so concurrent workers and the web app's
  own lazy execution can never double-run a job). It drives OCR document jobs,
  notification delivery retries, decision-notification dispatch recovery, and
  stuck-row reconciliation on a `WORKER_POLL_INTERVAL_MS` loop, and re-runs all
  reconcilers at boot. It stops cleanly on SIGTERM (finish in-flight work,
  disconnect, exit 0), so rolling deploys are safe.
- **Rate limiting / sessions / CSRF** are database-backed — no sticky sessions
  or shared cache required for multi-instance web deployments.

## 4. Observability (NFR-027)

- **Logs**: both containers emit single-line structured JSON to stdout —
  `{timestamp, level, requestId, userId, role, route, method, status, duration}`
  per API request, stack traces on errors, request id echoed in every error
  response body. No PII, tokens, secrets, or file contents are logged; ship
  stdout to your log aggregator as-is.
- **Health**: `GET /api/health` → `{status, version, database, storage, time}`.
- **System status**: `/supervisor/system` (Supervisor role) — live background
  job metrics and integration modes. Metric buckets: *queued* = queued OCR
  jobs + pending notification deliveries + pending decision dispatches;
  *processing* = executing OCR jobs; *failed* = failed OCR jobs + failed
  notification deliveries.

## 5. Security posture notes

- **Demo mode is OFF by default and MUST remain off in production**
  (`DEMO_MODE=false`): demo quick logins, demonstration attestation, demo
  seeding, and the Demo Data page are absent when off.
- **Key rotation**: field-encryption keys live in the `FIELD_ENCRYPTION_KEYS`
  ring; rotate with `scripts/rotate-keys.ts` (procedure in
  `src/lib/crypto/KEY-ROTATION.md`) — old keys stay in the ring until
  re-encryption completes.
- The app container runs as a non-root user; response headers carry the full
  §7.2 SEC-17 set (CSP without `unsafe-eval`/inline scripts in production,
  HSTS, nosniff, frame-ancestors 'none', referrer and permissions policies).
