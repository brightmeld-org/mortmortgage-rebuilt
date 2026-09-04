# Test-Only Fixture Seam — `POST /api/test/fixtures`

**Owner:** task-046 (§7.7 unit and integration test suite)
**Consumers:** `task-046/suites/zz-seam-*.test.ts` only.

A small number of §7.7 business rules describe states that are **unreachable through the
public API by construction** — they depend on the passage of real time (SLA business-day
maths at week and DST boundaries, the OCR ten-minute stuck rule, the ninety-day copy
staleness advisory, token expiry boundaries) or on the process environment (simulation
fault injection). This document specifies the single test-only endpoint that makes those
states reachable, expressed in domain terms.

Every other suite in `task-046/suites/` is green **without** this endpoint. Only files
named `zz-seam-*.test.ts` depend on it.

---

## Gate requirements (mandatory)

The route MUST be absent — **HTTP 404, not 403 and not "hidden"** — unless BOTH hold:

1. `process.env.NODE_ENV !== "production"`, and
2. `process.env.DEMO_MODE === "true"`.

When both hold the route is reachable **without authentication and without a CSRF token**
(it is a test seam, not a product surface; it must never be reachable in a production
build, which is what makes the missing auth acceptable). It must not appear in navigation
or in any product surface.

It **is** recorded in `contracts.json` as a single entry marked TEST-ONLY and demo-gated,
mirroring how `POST /api/auth/demo-login` is declared: the profile's *Independent Test
Suite Fixture Rules* require a test-only fixture endpoint to be documented there. Because
it is a contract entry, the enumeration-driven suites must carry it in their exclusion
maps (`03-rbac-and-scoping`, `04-audit-route-coverage`) rather than probing it as a
product route.

The same gating rule already governs `POST /api/auth/demo-login`,
`POST /api/admin/demo-data/seed` and `DELETE /api/admin/demo-data` (§B
"Demo-mode-gated endpoints"), so this follows an established pattern in the build.

---

## Request

```
POST /api/test/fixtures
Content-Type: application/json

{ "op": "<operation name>", ...operation fields }
```

## Response

`200 OK` with `{ "ok": true, ...operation result fields }`.

On an unknown `op`, an unknown target id, or a request the operation cannot satisfy,
respond with the project's standard `ErrorResponse` shape (`{ code, message, details? }`)
and status `400` (bad request) or `404` (unknown target). Never 500.

---

## Operations

All timestamps moved by these operations are moved **backwards** only; nothing here
creates data that the public API could not create, it only ages data that already exists.

### 1. `backdate-workflow-state`

Ages the current workflow state of an application so SLA elapsed-time maths can be
observed at a chosen boundary.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"backdate-workflow-state"` | yes | — |
| `applicationId` | string (uuid) | yes | The application to age. |
| `hours` | number | yes | Move `stateEnteredAt` (and the SLA clock origin for the current state) this many hours into the past. |

Response: `{ ok: true, stateEnteredAt: "<new ISO timestamp>" }`

Semantics (as implemented): the operation performs a **uniform backward translation** of
`stateEnteredAt`, `slaPausedAt` and every `WorkflowHistory` row on the application by the
same interval. Shifting the whole timeline rather than a single field is what preserves
suspend/resume pairing and the INV-012 accumulation of already-excluded suspended
intervals — an application that had banked suspended time still has it after aging. The
workflow state, assignment and versions are untouched.

Used by: `zz-seam-sla-boundaries.test.ts`
Covers: §7.7 SLA business-day computation at week boundaries and across DST transitions;
INV-012 (elapsed time never decreases and excludes suspended intervals); INV-037 "SLA
business days at week and DST boundaries and multi-cycle suspend/resume".

---

### 2. `backdate-suspension`

Ages a suspension so a multi-cycle suspend/resume can be measured without waiting.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"backdate-suspension"` | yes | — |
| `applicationId` | string (uuid) | yes | An application currently in `suspended`. |
| `hours` | number | yes | Move the moment the suspension began this many hours into the past. |

Response: `{ ok: true, slaPausedAt: "<new ISO timestamp>" }`

Rejects with 400 when the application is not currently `suspended`.

Used by: `zz-seam-sla-boundaries.test.ts`
Covers: §7.7 multi-cycle suspend/resume; XBR-023; INV-012.

---

### 3. `age-document-job`

Ages a document-intelligence job so the ten-minute stuck rule can be observed.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"age-document-job"` | yes | — |
| `documentId` | string (uuid) | yes | The document whose current-version job is aged. |
| `minutes` | number | yes | Move the job's `startedAt` this many minutes into the past. |
| `forceProcessing` | boolean | no | When true, leave/put the job in the `processing` status so the reconciler's stuck rule applies. Default `false`. |
| `reconcile` | boolean | no | When true, the aging mutation and ONE stuck-job reconciler scan (the same predicate/action op 4 runs — the production reconciler core, not a copy) execute atomically in a single database transaction. Default `false`. |

Response: `{ ok: true, jobId: "<uuid>", status: "<DocumentJobStatus>", startedAt: "<ISO>" }`

With `reconcile: true` the response additionally carries the op-4 count and
`status` reflects the post-reconcile state:
`{ ok: true, jobId: "<uuid>", status: "<DocumentJobStatus>", startedAt: "<ISO>", markedFailed: <number> }`

Why `reconcile` exists: aging a job into a claimable `processing` state and
then calling op 4 as a SEPARATE request leaves a window in which the live
scheduler claims the aged row as a new attempt and overwrites the backdated
`startedAt` — the subsequent op 4 then reports `markedFailed: 0`. With
`reconcile: true` the aged row and its stuck-failure commit together, so no
other transaction can ever observe the aged row in a claimable state. The
§4.8.2 terminal supervisor fan-out still runs post-commit, exactly as op 4
does it.

Used by: `zz-seam-ocr-stuck.test.ts`
Covers: §7.7 OCR job lifecycle including the stuck rule (ASYNC-004: a job in
`processing` beyond ten minutes is marked `failed` and becomes retryable).

---

### 4. `run-stuck-job-reconciler`

Runs the scheduled stuck-job scan once, synchronously, instead of waiting for its
five-minute cron tick.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"run-stuck-job-reconciler"` | yes | — |

Response: `{ ok: true, markedFailed: <number> }`

Used by: `zz-seam-ocr-stuck.test.ts`
Covers: ASYNC-004 crash-recovery/reconciler behaviour.

---

### 5. `age-application`

Ages an application's creation timestamp so the copy-staleness advisory
(`application.staleCopyThresholdDays`, default 90) can be observed on a section copy.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"age-application"` | yes | — |
| `applicationId` | string (uuid) | yes | The application to age. |
| `days` | number | yes | Move `createdAt` and the per-section "last saved" timestamps this many days into the past. |

Response: `{ ok: true, createdAt: "<ISO>" }`

Used by: `zz-seam-stale-copy.test.ts`
Covers: §7.7/REQ-022 copied sections older than the configured threshold carry a
persistent staleness advisory (XBR-020).

---

### 6. `age-token`

Ages an outstanding single-use token so its expiry boundary can be tested exactly
(verification 24 h, password reset 60 min, invitation per §4.6.11).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"age-token"` | yes | — |
| `kind` | `"email-verification" \| "password-reset" \| "invitation" \| "email-change"` | yes | Which token family to age. |
| `email` | string | yes | The address the token was issued to. |
| `minutes` | number | yes | Move the token's issue time this many minutes into the past. |

Response: `{ ok: true, expiresAt: "<ISO>" }`

Rejects with 404 when no outstanding token of that kind exists for the address.

Used by: `zz-seam-token-expiry.test.ts`
Covers: §7.7/INV-037 "token expiry boundaries (exactly 24 h / 60 min)"; INV-010
(a consumed or expired token never authenticates again).

---

### 7. `age-session`

Ages a session so the idle and absolute timeout boundaries can be tested
(`session.idleTimeoutMinutes` 30, `session.absoluteTimeoutHours` 12).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"age-session"` | yes | — |
| `email` | string | yes | The account whose most recently created active session is aged. |
| `idleMinutes` | number | no | Move last-activity this many minutes into the past. |
| `absoluteHours` | number | no | Move session creation this many hours into the past. |

Response: `{ ok: true, idleExpiresAt: "<ISO>", absoluteExpiresAt: "<ISO>" }`

Used by: `zz-seam-token-expiry.test.ts`
Covers: NFR-004 session idle/absolute expiry boundaries.

---

### 8. `set-simulation-fault`

Sets the effective fault mode for one simulated provider for the remainder of the
process, mirroring the `SIM_FAULT_*` environment variables documented in
`task-048/simulation-mapping.md`. Environment variables cannot be changed against a
running server, so this is the only way to exercise the non-data-driven fault scenarios.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"set-simulation-fault"` | yes | — |
| `provider` | `"credit" \| "income" \| "avm" \| "aus" \| "pricing" \| "ocr"` | yes | Which simulation to affect. |
| `mode` | `"none" \| "slow" \| "timeout" \| "unavailable" \| "partial" \| "invalid-response"` | yes | The documented fault mode; `"none"` restores normal behaviour. |

Response: `{ ok: true, provider: "<provider>", mode: "<mode>" }`

Rejects with 400 for a provider/mode pair the delivered mapping document does not define
for that provider (e.g. `slow` is defined for OCR, not for pricing).

Used by: `zz-seam-simulation-faults.test.ts`
Covers: §7.7 "every simulation's … fault scenarios" for the modes that are not reachable
through data (the data-driven collisions — SSN digit 9, ZIP digit 9, `$999,999`, and the
OCR filename triggers — are already covered without the seam in `06-simulations.test.ts`).

---

### 9. `fail-next-audit-write`

Arms a one-shot failure of the next audit-log insert so the transactional coupling can be
observed: the action that would have been audited must roll back entirely.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `op` | `"fail-next-audit-write"` | yes | — |
| `armed` | boolean | yes | `true` arms the one-shot failure; `false` disarms it. |

Response: `{ ok: true, armed: <boolean> }`

Semantics: while armed, the next attempt to write an `AuditLogEntry` throws inside the
enclosing transaction. The arming is consumed by that one attempt.

Used by: `zz-seam-audit-rollback.test.ts`
Covers: §7.7 audit coverage "in-transaction"; XBR-013 ("the transition is rejected if
either write fails"); AC-26 / INV-037 "audit-write failure rolling back the action".

---

## Summary — seam-dependent test files

| File | Ops used |
|---|---|
| `task-046/suites/zz-seam-sla-boundaries.test.ts` | `backdate-workflow-state`, `backdate-suspension` |
| `task-046/suites/zz-seam-ocr-stuck.test.ts` | `age-document-job`, `run-stuck-job-reconciler` |
| `task-046/suites/zz-seam-stale-copy.test.ts` | `age-application` |
| `task-046/suites/zz-seam-token-expiry.test.ts` | `age-token`, `age-session` |
| `task-046/suites/zz-seam-simulation-faults.test.ts` | `set-simulation-fault` |
| `task-046/suites/zz-seam-audit-rollback.test.ts` | `fail-next-audit-write` |

Each of these files calls `seamAvailable()` in `before()`; if the endpoint answers 404 the
file fails with a message naming this document, so a missing seam is loud rather than a
silent skip.
