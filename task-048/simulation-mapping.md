# Simulation Input→Output Mapping (§6.3)

All external integrations ship as deterministic, key-free simulations. This document specifies the input→output mappings for **all nine §6.3 simulations** — credit (§6.3.1), income (§6.3.2), AVM (§6.3.3), pricing (§6.3.4), financial-data aggregator (§6.3.5), address lookup / geocoding (§6.3.6), document OCR (§6.3.7), email / SMS (§6.3.8) and AUS (§6.3.9) — including all fault triggers (INV-037: legitimate data can collide with triggers).

---

## Overview

**Pure functions:** Every simulation produces identical outputs for identical inputs (no clock, no randomness, no I/O). Every "random-looking" value is FNV-1a hash of documented seed material (source module: `src/lib/pure/simulations/shared.ts`).

**Fault scenarios:** `SIM_FAULT_*` env vars (none, slow, timeout, unavailable, partial, invalid) trigger injected failures for testing.

**Two ways a fault is selected** (§6.3 preamble): by **input trigger** (a value in the data — deterministic, always active, no configuration) and by **configuration** (`SIM_FAULT_<INTEGRATION>`). Six of the nine integrations (credit, income, AVM, pricing, OCR, AUS) also accept a runtime fault override through the sanctioned test-only fixture seam (`POST /api/test/fixtures`, op `set-simulation-fault` — `src/lib/services/sim-fault-override.ts`). The aggregator (§6.3.5) and address lookup (§6.3.6) read their `SIM_FAULT_*` variable straight from the process environment, so changing them requires a server restart; email / SMS (§6.3.8) has no configuration fault at all — its only fault is the recipient-address input trigger.

**Caveat:** Legitimate data (e.g., SSN ending in 9, ZIP 99999, $999,999 loan amount, filename "fail") can collide with fault triggers — this is expected behavior for a deterministic simulation.

---

## Credit Simulation (§6.3.1)

**Source:** `src/lib/pure/simulations/credit.ts`

### Scenario Key

**SSN last digit** determines credit tier + base score:

| Digit | Tier | Base Score | Scenario |
|-------|------|-----------|----------|
| 0–3 | Good | 740 + digit×10 | 740 / 750 / 760 / 770 |
| 4–6 | Fair | 660 + (digit−4)×12 | 660 / 672 / 684 |
| 7–8 | Poor | 585 + (digit−7)×25 | 585 / 610 |
| 9 | Good (retry) | 770 | 503 on attempt 1; Good (770) on retry |

### Bureau Scores

Three bureau scores (Bureau A/B/C):
- A: base score
- B: base − 7
- C: base + 5

**Example:** SSN ending in 2 → base 760 → scores 760, 753, 765

### Risk Tier Display

Derived from middle score (Bureau B):

| Score Range | Tier |
|-------------|------|
| ≥700 | Good |
| 640–699 | Fair |
| <640 | Poor |

### Tradelines

**Count:** 4 + (SSN last digit mod 5)
- Digit 0 → 4 tradelines
- Digit 4 → 8 tradelines
- Digit 8 → 7 tradelines
- Digit 9 → 4 tradelines

**Utilization (% of limit):**

| Tier | Range | Seed Position |
|------|-------|---------------|
| Good | 12–28% | Seeded from name/DOB hash |
| Fair | 35–55% | Seeded |
| Poor | 60–95% | Seeded |

**Collections:** 0 / 1 / 2–3 (by tier); amounts seeded

**Inquiries:** 1–4 (seeded)

### Fault Scenarios

| SIM_FAULT_CREDIT | Behavior |
|------------------|----------|
| none (default) | Normal deterministic output |
| partial | Only two bureau scores returned; third marked "unavailable" |
| unavailable | HTTP 503 returned (retryable) |
| timeout | HTTP 504 (timeout) after 45 seconds |
| invalid-response | Malformed JSON response |

### Example

```bash
SSN: 000-00-1234  (last digit 4 → Fair tier, base 672)
Attempt: 1
Output:
  - Bureau A: 672
  - Bureau B: 665 (middle, for qualifying score)
  - Bureau C: 677
  - Tradelines: 8
  - Collections: 1
  - Inquiries: 3
```

---

## AVM Simulation (§6.3.3)

**Source:** `src/lib/pure/simulations/avm.ts`

### Scenario Key

**ZIP code last digit** determines value factor + trend:

| Digit | Factor | Trend | Notes |
|-------|--------|-------|-------|
| 0 | 0.98 | rising (even → +3.0%) | — |
| 1 | 0.99 | declining (1/3 → −3.0%) | — |
| 2 | 1.00 | rising | — |
| 3 | 1.01 | declining | — |
| 4 | 1.02 | rising | — |
| 5 | 1.03 | stable (5/7/9 → 0%) | — |
| 6–8 | 0.90 | varies (6→rising, 7→stable, 8→declining) | Low appraisal |
| 9 | 1.00 | stable | Partial: no comparables, confidence 40 |

### Property Value

```
AVM Value = Stated Value × Factor
```

**Example:** Stated $300,000, ZIP 94XXX (factor 0.90) → AVM $270,000

### Comparables (Non-Partial)

**Count:** 4 synthetic sales

**Multipliers:** [0.94, 0.98, 1.03, 1.07] applied to AVM value
- Sale 1: $270,000 × 0.94 = $253,800
- Sale 2: $270,000 × 0.98 = $264,600
- Sale 3: $270,000 × 1.03 = $278,100
- Sale 4: $270,000 × 1.07 = $288,900

**Distance:** 0.6 miles max; addresses seeded from property type + ZIP

**Sale dates:** Within 180 days of reference date

### Trend

| Digit | Trend | Percent Change |
|-------|-------|-----------------|
| Even (0,2,4,6,8) | Rising | +3.0% per year |
| 1, 3 | Declining | −3.0% per year |
| 5, 7, 9 | Stable | 0% per year |

### Confidence & Range

**Confidence:**
- Full response (factors 0.90–1.03): 80–90%
- Partial response (factor 1.00, digit 9): 40%

**Value Low/High:** ±5% of AVM value (omitted on partial)

### Partial Response (Digit 9 or SIM_FAULT_AVM=partial)

```json
{
  "value": 300000.00,
  "confidence": 40,
  "comparables": null,
  "trend": null,
  "valueHigh": null,
  "valueLow": null
}
```

### Fault Scenarios

| SIM_FAULT_AVM | Behavior |
|---------------|----------|
| none (default) | Full response with comparables |
| partial | Digit-9 shape (value + confidence, no comparables) |
| unavailable | HTTP 503 (retryable) |
| timeout | HTTP 504 (timeout) after 45 seconds |

### Example

```bash
Subject: $350,000, ZIP 94103 (digit 3 → declining)
Factor: 1.01 → AVM = $353,500
Comparables: 4 sales [333,290 / 346,430 / 364,055 / 378,245]
Trend: Declining (−3.0% per year)
Confidence: 80%
ValueLow: $335,825
ValueHigh: $371,175
```

---

## Address Lookup / Geocoding Simulation (§6.3.6)

**Source:** `src/lib/services/geocoding.ts` (both surfaces), `src/lib/data/addresses.ts` + `addresses.json` (the bundled dataset), `src/lib/pure/address-match.ts` (normalization, FNV-1a, ranking)

Two surfaces, deliberately different in character:

| Surface | Endpoint | Latency | Faults |
|---------|----------|---------|--------|
| `suggestAddresses(q)` — type-ahead | `GET /api/address/suggest?q=` | 150 ms ± 100 | yes (silent degrade) |
| `geocodeAddress(address)` — coordinates | none (called by the subject-property save hook, AVM §6.3.3 and HMDA export) | none | none — always returns a point |

### Bundled Dataset

`addresses.json` is **generated** with a fixed seed (`node scripts/generate-address-dataset.mjs`, byte-identical output) — do not hand-edit.

| Property | Value | §6.3.6 requirement |
|----------|-------|--------------------|
| Rows | 2,016 | ≥ 2,000 |
| States | 24 | ≥ 20 |
| Per row | street, optional unit, city, state, 5-digit ZIP, county, lat, lng, censusTract | coordinates + county + census tract |

Census tract format is the dataset's synthetic `SSCCC.TTTT.BB` (e.g. `06037.9012.03`).

### Scenario Key (suggest)

**The query string itself.** Evaluated in this order:

| Query condition | Result |
|-----------------|--------|
| contains `!!` anywhere | **service unavailable** → `200` with **empty** suggestions (§4.2.11 silent degrade to manual entry — never an error) |
| normalized length < 2 | `200` with empty suggestions (documented clamp — contracts §B declares no validation-error status for this endpoint) |
| otherwise | prefix + fuzzy ranked match over the dataset, **max 10** suggestions (§6.3.6 asks for ≥ 5 when available) |

### Output (suggest)

`AddressSuggestion`: `formatted`, `street`, `unit?`, `city`, `state`, `zip`, `county?`.

### Scenario Key (geocode)

Deterministic and total — the same address always yields the same `GeoPoint`, and there is always a point:

1. **Exact dataset match** on normalized `street` + 5-digit `zip` → that row's exact `lat`/`lng`/`county`/`censusTract`.
2. **Otherwise** the FNV-1a hash of the normalized address text is mapped into the bounding box of the address's **state** (the `state` field wins over the ZIP; an unrecognized state falls back to a CONUS-wide box).
   - County = the nearest dataset county in that state, or a synthesized `"<State> County NN"` when the state has no dataset rows.
   - Census tract = synthesized from the same hash in `SSCCC.TTTT.BB` format.

### Output (geocode)

`GeoPoint`: `latitude`, `longitude`, `county?`, `censusTract?` — always inside the state's bounding box.

### Fault Scenarios

| SIM_FAULT_ADDRESS | Behavior |
|-------------------|----------|
| none (default; unknown values degrade to none) | Normal ranked suggestions |
| slow | Extra `SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS` (default 2,000 ms) on top of the normal latency |
| timeout | Empty suggestions (silent degrade). **Documented simplification:** the §6.3 30-second client timeout is truncated to the normal latency here so evidence runs and the UX stay responsive |
| unavailable | Empty suggestions (silent degrade) |

**Input trigger (always active, no configuration):** `!!` anywhere in `q` → service unavailable → empty suggestions.

`geocodeAddress` has **no** fault handling by design: AVM, the save hook and the HMDA export all require coordinates, so it must never fail.

### Latency

150 ms ± 100 on suggest only, deterministic from the query hash (never `Math.random`).

```bash
SIM_LATENCY_ADDRESS_BASE_MS         # default 150
SIM_LATENCY_ADDRESS_JITTER_MS       # default 100
SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS   # default 2000 (SIM_FAULT_ADDRESS=slow)
```

### Example

```bash
GET /api/address/suggest?q=120 Ma      -> up to 10 ranked dataset suggestions
GET /api/address/suggest?q=120 Ma!!    -> 200 { "suggestions": [] }   (silent degrade)
GET /api/address/suggest?q=1           -> 200 { "suggestions": [] }   (clamp, < 2 chars)

geocodeAddress({ street: "<a dataset street>", zip: "<its ZIP>", ... })
  -> that row's exact lat/lng/county/censusTract
geocodeAddress({ street: "999 Nowhere Rd", city: "Bend", state: "OR", zip: "97701" })
  -> deterministic point inside the OR bounding box, nearest OR dataset county,
     synthesized census tract — identical on every call
```

---

## Income Simulation (§6.3.2)

**Source:** `src/lib/pure/simulations/income.ts`

### Scenario Key

**Primary borrower's first employment record** determines income variance:

- Base employment monthly income (from application)
- Variance: −25% to +25% (seeded from name/DOB)

### Output

```json
{
  "monthlyIncomeVerified": 5000.00,
  "monthlyIncomeStated": 4800.00,
  "variance": 4.17,  // +4.17% (verified higher)
  "riskFlag": false   // Variance < 20% threshold
}
```

### Fault Scenarios

| SIM_FAULT_INCOME | Behavior |
|------------------|----------|
| none (default) | Verified income within ±25% of stated |
| unavailable | HTTP 503 (retryable) |
| timeout | HTTP 504 (timeout) |
| invalid-response | Malformed JSON |

### Risk Flag

- **True if:** Variance >20% (high mismatch)
- **False if:** Variance ≤20% (acceptable)

---

## Financial-Data Aggregator Simulation (§6.3.5)

**Source:** `src/lib/services/bank-aggregator.ts` (institutions, latency, fault triggers, credential exchange), `src/lib/pure/bank-simulation.ts` (all derivations — pure), `src/lib/services/bank-link.ts` (persistence + audit)

**Endpoints:** `GET /api/bank-link/institutions` · `POST /api/applications/:id/bank-links` · `POST /api/applications/:id/bank-links/:linkId/import` · `DELETE /api/applications/:id/bank-links/:linkId`

### Institutions

Eight fictional institutions (§6.3.5 requires ≥ 6), fixed UUID-format ids that are **stable across calls, restarts and deployments** so clients may cache them. No real bank is referenced.

| # | Name |
|---|------|
| 1 | First Meridian Bank |
| 2 | Cascade Union Bank |
| 3 | Harborline Credit Union |
| 4 | Silver Birch Savings |
| 5 | Granite Peak National Bank |
| 6 | Bluewater Federal Credit Union |
| 7 | Prairie Rose Bank & Trust |
| 8 | Copperfield Community Bank |

### Scenario Key

**Two independent keys:** the **password** selects the fault, the **username** derives all data.

| Password (exact match, case-sensitive) | Outcome |
|----------------------------------------|---------|
| `fail` | Institution **authentication failure** → `401` with code `auth_failed`. Nothing is persisted: no `BankLink` row, no encrypted access token, no `bank-link` audit entry |
| `slow` | Success, **+8 s** on the exchange latency |
| anything else | Success at the normal latency |

`Fail`, `failure`, `slow ` and similar near-misses are **not** triggers — the comparison is exact equality, so an ordinary password can never accidentally fire one.

### Accounts (derived from `hash(username)`)

- **Count:** `2 + (FNV-1a("bank|{username}") mod 3)` ∈ {2, 3, 4} (§6.3.5 "2–4 accounts").
- **Types, in order:** `checking`, `savings`, `money-market`, `stocks`. §6.3.5's "brokerage" is mapped onto the contracted `AssetAccountType` value `stocks` — `contracts.json` defines no "brokerage" literal, and nothing is invented.
- **Balance:** `$1,800.00 – $85,000.00`, seeded from `FNV-1a("acct|{username}|{i}")`.
- **Account number:** deterministic 10-digit from `FNV-1a("acctnum|{username}|{i}")`. Only `last4` ever reaches the wire or an audit row; the full number is sealed into the task-011 AES-256-GCM envelope at import.
- **`externalAccountId`:** `ext-{seed hex}-{n}` — stable per username.

### Income Evidence (90-day payroll stream)

Computed from **live** inputs — the primary borrower's current Step-3 employments, never constants:

```
biWeeklyNet          = round2(statedBaseMonthlyIncome × 12 / 26 × 0.78)
averageMonthlyDeposit = round2(biWeeklyNet × 26 / 12)      // ≡ stated × 0.78
```

- Deposits every 14 days across the 90-day window; the payday phase is `FNV-1a("payday|{username}") mod 14`, so different users have different paydays.
- **Employer:** the Step-3 employer when the username contains `match` (case-insensitive) → `employerMatch: true`; otherwise `Cascadia Freight Systems` (or `Bluepine Staffing Group` when the borrower's real employer *is* Cascadia Freight Systems).
- No positive stated base income → no income evidence (the optional `BankLinkSession.incomeEvidence` is simply omitted).

### Output

```json
{
  "linkId": "…",
  "accounts": [
    { "externalAccountId": "ext-4b19d0c2-1", "accountType": "checking",
      "institution": "First Meridian Bank", "last4": "8317", "balance": 12480.55 },
    { "externalAccountId": "ext-4b19d0c2-2", "accountType": "savings",
      "institution": "First Meridian Bank", "last4": "2094", "balance": 46310.02 }
  ],
  "incomeEvidence": [
    { "employerName": "Cascadia Freight Systems", "employerMatch": false,
      "averageMonthlyDeposit": 4680.00 }
  ]
}
```

Import appends `source: "bank-link"` asset rows to Step 4, invalidates signatures (XBR-003), recalculates DTI/LTV/CLTV, bumps `versionStamp` and audits `bank-import` — all in one transaction, and idempotent per `accountId`.

### Fault Scenarios

| SIM_FAULT_BANKLINK | Behavior |
|--------------------|----------|
| none (default; unknown values degrade to none) | Password triggers only |
| slow | The +8 s slow-extra applies to **every** exchange regardless of password |

The env value is normalized (`trim().toLowerCase()`), so `SLOW` and `" slow "` are accepted; unknown modes (`timeout`, `unavailable`, `partial`, `invalid`) are **not implemented** for this integration and fall back to `none`. This variable is read straight from `process.env` at call time — it is **not** settable through the test-fixture seam, unlike the six check simulations.

**Credential posture:** the username and password are never persisted, logged or audited. Only a SHA-256 hash of the username is kept, inside the encrypted session payload.

### Latency

2,000 ms ± 800 on exchange, deterministic from `FNV-1a("latency|banklink|{username}")` — the same username always produces the same latency. Applied by the route with a non-blocking `sleep()` **before any transaction is opened**, and applied to the failure path too (a real provider round-trips before rejecting credentials).

```bash
SIM_LATENCY_BANKLINK_BASE_MS         # default 2000
SIM_LATENCY_BANKLINK_JITTER_MS       # default 800   → band 1,200–2,800 ms
SIM_LATENCY_BANKLINK_SLOW_EXTRA_MS   # default 8000  → the `slow` trigger
```

### Example

```bash
POST /api/applications/:id/bank-links
  { institutionId: "<First Meridian Bank>", username: "jsmith", password: "hunter2" }
  -> 200 BankLinkSession after ~1,200–2,800 ms

POST /api/applications/:id/bank-links
  { institutionId: "<First Meridian Bank>", username: "jsmith", password: "slow" }
  -> 200 after exactly 8,000 ms more than the same username's normal latency

POST /api/applications/:id/bank-links
  { institutionId: "<First Meridian Bank>", username: "jsmith", password: "fail" }
  -> 401 { "code": "auth_failed", ... } — no BankLink row, no token, no audit entry

username "matchtest" + Step-3 employer "Northwind Traders"
  -> incomeEvidence.employerName = "Northwind Traders", employerMatch = true
```

---

## AUS Simulation (§6.3.9)

**Source:** `src/lib/pure/simulations/aus.ts`

### Scenario Key

**RFP §6.3.9 rules:**

| Condition | Recommendation | Reasons Itemized |
|-----------|---|---|
| Middle score ≥ 660 AND DTI ≤ 45% AND LTV ≤ 97% AND no open high fraud flags AND no derogatories in 24 months | **approve-eligible** | All conditions met |
| Score < 620 OR DTI > 50% OR foreclosure/bankruptcy declaration within 7 years | **refer-with-caution** | Trigger(s) present; specific reasons noted |
| All other cases | **refer** | One or more Approve/Eligible conditions failed |

**Evaluation order:** Refer-with-Caution triggers are checked first. When a file meets all Approve/Eligible conditions but also carries a Refer-with-Caution trigger (only possible via a foreclosure/bankruptcy declaration older than 24 months but within 7 years), the risk-conservative Refer-with-Caution result is returned.

### Output

```json
{
  "recommendation": "approve-eligible",
  "reasons": ["Credit score 750 meets minimum 660", "DTI 42% within 45% limit", "LTV 78% within 97% limit", "No open high-severity fraud flags", "No derogatories in the last 24 months"],
  "middleScoreUsed": 750,
  "dtiUsed": 42,
  "ltvUsed": 78
}
```

### Conditions

When recommendation is refer or refer-with-caution, reasons are itemized failure/trigger reasons rather than sample conditions.

### Latency

2,500 ms ± 500 (deterministic jitter from input hash).

### Fault Scenarios

| SIM_FAULT_AUS | Behavior |
|---------------|----------|
| none (default) | Deterministic result |
| unavailable | HTTP 503 (retryable) |
| timeout | HTTP 504 (timeout) |
| invalid-response | Malformed JSON |

---

## Pricing Simulation (§6.3.4)

**Source:** `src/lib/pure/simulations/pricing.ts`

### Base Rate Table

| Loan Type | 30-year | 20-year | 15-year | ARM Initial |
|-----------|---------|---------|---------|-------------|
| Conventional | 6.50% | 6.25% | 5.85% | — |
| FHA | 6.15% | — | — | — |
| VA | 6.05% | — | — | — |
| USDA | 6.10% | — | — | — |
| (Any) | — | — | — | 5.95% |

**Fallback:** Missing (type, term) pair → use Conventional rate for term; missing term → Conventional 30-year.

### Rate Adjustments (Additive, % points)

| Factor | Adjustment |
|--------|------------|
| **Credit Score:** | |
| ≥740 | +0.00 |
| 700–739 | +0.25 |
| 660–699 | +0.625 |
| <660 | +1.25 |
| **LTV:** | |
| ≤60% | −0.125 |
| 60–80% | 0.00 |
| 80–90% | +0.25 |
| 90–97% | +0.50 |
| **Occupancy:** | |
| Primary residence | 0.00 |
| Second home | +0.375 |
| Investment property | +0.75 |
| **Property:** | |
| 2–4 units | +0.25 |
| Condo | +0.125 |
| Manufactured | +0.50 |
| **Refi:** | |
| Cash-out | +0.375 |

**Example:**
- Base (Conventional 30): 6.50%
- Credit 680: +0.625
- LTV 85%: +0.25
- Investment: +0.75
- **Total: 8.125%**

### Scenarios

**Buy-down:** −0.25% for 1.0 discount point (% of loan)
**Lender credit:** +0.25% for 1.0% credit (% of loan)

**Sign convention:** Positive = discount points paid; negative = lender credit

### APR Calculation

```
APR = Rate + Finance Charges ÷ Loan Amount × 100 ÷ Term Years

Finance Charges:
  - Origination: 1% of loan
  - Fixed fees: $2,850
  - Prepaid taxes/insurance: 3 months of P+I
```

### Loan-Program Adjustments

- **FHA:** Mortgage insurance 0.55%/year (monthly MI in PITI)
- **VA:** Funding fee 2.15% (financed, added to amortized principal)
- **USDA:** Mortgage insurance 0.35%/year (monthly MI in PITI)

### Fault Triggers

**$999,999 exactly:** Invalid-response scenario (this triggers fault for testing; legitimate loans can use this amount).

### Output

```json
{
  "scenarios": [
    {
      "name": "par",
      "rate": 6.50,
      "apr": 6.75,
      "points": 0.0,
      "credits": 0.0,
      "closingCost": 4200,
      "originationCost": 3500,
      "pointsOrCredits": 0.0
    },
    {
      "name": "buy-down",
      "rate": 6.25,
      "apr": 6.52,
      "points": 3500,
      "credits": 0.0,
      "pointsOrCredits": 1.0
    }
  ]
}
```

### Fault Scenarios

| SIM_FAULT_PRICING | Behavior |
|-------------------|----------|
| none (default) | Normal pricing |
| unavailable | HTTP 503 (retryable) |
| timeout | HTTP 504 (timeout) |
| invalid-response | Malformed JSON |

---

## OCR Simulation (§6.3.7)

**Source:** `src/lib/pure/simulations/ocr.ts`

### File-Name Fault Triggers

**Case-insensitive substring match:**

| Filename Contains | Behavior | Retryable? |
|-------------------|----------|-----------|
| "fail" | Extraction fails | Attempts 1–2: yes; attempt ≥3: no (non-retryable) |
| "slow" | 45 second latency | Yes |
| "blurry" | All confidence 30–55 (red) | Yes |
| "mismatch" | Income/balance +30% (variance >20%) | Yes |

### Fixture Table

When filename contains fixture token AND document type matches, return fixture values (confidence 90–98):

- "paystub-2024Q1.pdf" → fixture paystub values
- "form1040-2023.pdf" → fixture tax return values
- (See seed data `src/lib/services/demo-seed/` for fixture tokens)

### Default Behavior

Values derived from **application's own entered data** (so comparison view matches) with confidence 75–92. Where entered data absent, deterministic synthetic filler used (field NOT mapped to avoid comparing annual vs monthly).

### Latency

4 seconds ± 2 seconds deterministic jitter (from content hash), except `slow` (45 seconds).

### Confidence & Mapped Fields

**Mapped fields:** Only terminal-segment tokens (e.g., "employment.employerName", "account.endingBalance") where entered counterpart exists and is comparable.

**Unmapped fields:** Annual wages, aggregate totals (no entered counterpart) → no mapped entry, no variance.

### Fault Scenarios

| SIM_FAULT_OCR | Behavior |
|---------------|----------|
| none (default) | Fixture or entered-data-derived extraction |
| slow | 45 second latency for any file |
| timeout | HTTP 504 after 45 sec (not retriable) |
| unavailable | HTTP 503 (retriable) |
| partial | Partial fields only (no confidence-band hits) |
| invalid-response | Malformed JSON |

### Example

```bash
Filename: "paystub.pdf"
SHA256: abc123...
Extracted Fields:
  - fieldPath: "employment.employerName"
  - extractedValue: "Acme Corp"
  - enteredValue: "Acme Corp"
  - confidence: 92
  - variancePct: 0
  - mapped: true

  - fieldPath: "employment.baseMonthlyIncome"
  - extractedValue: "5000"
  - enteredValue: "4800"
  - confidence: 88
  - variancePct: 4.17
  - mapped: true

Latency: 4050 ms
```

---

## Email / SMS Simulation (§6.3.8)

**Source:** `src/lib/services/notifications.ts` (the §4.8.1 single notification write path — channel resolution, the `@bounce.example` seam, the retry cycle), `src/lib/services/outbound.ts` (the only `OutboundMessage` writers)

**Observation surfaces:** `GET /api/admin/outbound-messages` (Supervisor Outbound Messages page, REQ-071) · `GET /api/notifications` (recipient's own rows) · `POST /api/notifications/:id/retry` (supervisor manual retry)

Nothing external ever happens in demonstration mode: every "send" is a **real `OutboundMessage` row** plus **one structured log line**.

### Channel Resolution (§4.2.12)

| Recipient | External sends |
|-----------|----------------|
| Staff (Caseworker / Supervisor) | none — in-app only (§4.8.1) |
| Borrower, preference `email` | one email |
| Borrower, preference `sms` | one SMS **if** the mobile number is verified, otherwise falls back to email |
| Borrower, preference `both` | email, plus SMS when verified |

Re-resolved **live** on every delivery attempt, so a preference change between attempts takes effect. In-app delivery is always on.

### Scenario Key

**The recipient address.**

| Recipient condition | Result |
|---------------------|--------|
| email address ending `@bounce.example` (case-insensitive) | `OutboundMessage.status = "failed"` + `Notification.deliveryError` = `Delivery to <addr> bounced (simulated bounce address) — retryable` → **retryable** delivery failure |
| anything else | `OutboundMessage.status = "sent"`, notification `deliveryStatus = "sent"` |

The trigger is **email-only** — an SMS recipient never bounces.

### Delivery Modes

| Mode | Used by | Behavior on a bounce |
|------|---------|----------------------|
| `async` (default, ASYNC-002) | every §4.8.2 workflow / document / assignment / fraud trigger | row commits `pending`, the post-commit executor attempts delivery, a bounce schedules a retry |
| `in-tx` (ASYNC-003) | decision dispatch (approval / denial notes) | the send happens inside the caller's transaction and a bounce **throws**, rolling the transition back — the file stays Approved/Denied with `decisionNotificationPending` and a staff retry endpoint (WF-049 / INV-022) |
| `none` | auth token emails (verification, password reset, invitation, MFA reset) — the caller composes the external message itself | **not subject to the seam**: those rows are written directly by `recordOutboundEmail` and record as `sent` even to a `@bounce.example` address |

### Output

```json
// OutboundMessage row (GET /api/admin/outbound-messages)
{ "id": "…", "channel": "email", "recipient": "borrower@bounce.example",
  "subject": "Bank accounts imported", "body": "…",
  "notificationId": "…", "status": "failed", "createdAt": "…" }

// structured log line — correlation ids only (NFR-027: no recipient, subject or body)
{ "level": "info", "event": "outbound-message", "notificationId": "…",
  "outboundMessageId": "…", "channel": "email", "status": "failed",
  "attempt": 1, "error": "Delivery to … bounced (simulated bounce address) — retryable" }
```

### Retry Policy (ASM-009 / ASYNC-002) — what "retryable" means

| Attempt | On a bounce |
|---------|-------------|
| 1 | `deliveryStatus` back to `pending`, `deliveryError` set, `nextAttemptAt = now + 60 s` (persisted on the row) |
| 2 | `pending`, `nextAttemptAt = now + 120 s` |
| 3 | terminal `deliveryStatus = "failed"` + a "notification delivery failed" alert to every active Supervisor (§4.8.2) |

Constants are contract-fixed (`maxAttempts` 3, exponential, initial 60 s) — deliberately **not** `SystemConfig`, since §4.6.11 defines no notification-retry setting. Attempts are claimed with an atomic guarded update (10-minute in-flight lease), so concurrent executors never double-send; `reconcileDueNotificationDeliveries()` is the at-least-once due-scan. **Manual retry** (`POST /api/notifications/:id/retry`, supervisor) resets the cycle and re-attempts immediately; it answers `409` while the delivery is still cycling (only a terminally `failed` delivery can be retried) and `409` for an in-app-only notification.

### Fault Scenarios

| Trigger | Behavior |
|---------|----------|
| recipient ends `@bounce.example` (input trigger, always active) | retryable delivery failure, as above |
| *(configuration)* | **none** — this integration has no `SIM_FAULT_*` variable and is not exposed by the test-fixture seam. §6.3.8 defines the recipient address as the only fault selector |

### Latency

100 ms per delivery attempt (`SIMULATED_SEND_LATENCY_MS`), applied outside the recording transaction. Fixed — no jitter, no env override.

### Example

```bash
# §4.8.2 trigger fired for a borrower at alex@bounce.example
GET /api/notifications        (as that borrower)
  -> { type: "bank-link-imported", channel: "email", deliveryStatus: "pending",
       deliveryError: "Delivery to alex@bounce.example bounced (simulated bounce address) — retryable" }

GET /api/admin/outbound-messages   (as supervisor)
  -> { channel: "email", recipient: "alex@bounce.example", status: "failed", notificationId: "…" }

POST /api/notifications/<id>/retry (as supervisor, while still cycling)
  -> 409 "Only failed deliveries can be retried (current delivery status: pending)"

# identical trigger for a borrower at alex@example.test
  -> deliveryStatus "sent", OutboundMessage status "sent"
```

---

## INV-037: Legitimate Data Collision

**Important:** Legitimate loan applications can use data that collides with simulation fault triggers:

- Real SSN ending in 9 (triggers 503 → retry on first attempt)
- Real ZIP 99999 (triggers partial AVM response)
- Filename naturally containing "fail", "slow", "blurry", "mismatch" (legitimately uploaded documents)
- Actual loan amount $999,999.00 (triggers pricing invalid-response)
- An aggregator password that happens to be exactly `fail` or `slow` (§6.3.5 — the comparison is exact and case-sensitive, so only those two literals collide)
- An aggregator username containing "match" (§6.3.5 — makes the simulated payroll employer equal the Step-3 employer)
- An address query containing `!!` (§6.3.6 — degrades silently to manual entry)
- A recipient address ending `@bounce.example` (§6.3.8 — records a retryable delivery failure). `bounce.example` is a reserved-style example domain, so this cannot collide with a real mailbox

**This is expected and documented:** When such data appears, the system behaves as the simulation specifies (e.g., AUS returns "refer-with-caution" for the poor-credit digit-9 SSN; OCR returns low confidence for blurry-named file). The design assumes demonstration use only; production deployments can substitute real provider credentials (§6 optional wiring).

---

## Configuration

**Environment variables:**

```bash
# Fault injection (none, slow, timeout, unavailable, partial, invalid)
# — these six are also settable at runtime through the test-only fixture seam
SIM_FAULT_CREDIT=none
SIM_FAULT_INCOME=none
SIM_FAULT_AVM=none
SIM_FAULT_AUS=none
SIM_FAULT_PRICING=none
SIM_FAULT_OCR=none

# Read straight from the process environment (restart required; not in the seam)
SIM_FAULT_BANKLINK=none      # none | slow                                (§6.3.5)
SIM_FAULT_ADDRESS=none       # none | slow | timeout | unavailable        (§6.3.6)
# §6.3.8 email/SMS has no fault variable — the recipient address is the trigger

# Simulated latency (all defaults match the §6.3 figures)
SIM_LATENCY_BANKLINK_BASE_MS=2000
SIM_LATENCY_BANKLINK_JITTER_MS=800
SIM_LATENCY_BANKLINK_SLOW_EXTRA_MS=8000
SIM_LATENCY_ADDRESS_BASE_MS=150
SIM_LATENCY_ADDRESS_JITTER_MS=100
SIM_LATENCY_ADDRESS_SLOW_EXTRA_MS=2000

# Or substitute real providers:
CHECK_PROVIDER_CREDIT=real
CHECK_PROVIDER_CREDIT_BASE_URL=https://api.credit-bureau.com
CHECK_PROVIDER_CREDIT_API_KEY=<key>
```

---

## Support

For simulation behavior questions, see the source modules: the six check simulations in `src/lib/pure/simulations/`, the financial-data aggregator in `src/lib/services/bank-aggregator.ts` + `src/lib/pure/bank-simulation.ts`, address lookup / geocoding in `src/lib/services/geocoding.ts` + `src/lib/data/addresses.ts`, and email / SMS in `src/lib/services/notifications.ts` + `src/lib/services/outbound.ts`. For production wiring of real providers, see [idp-wiring.md](./idp-wiring.md) and the provider interface design in `src/lib/services/idp/provider.ts`.
