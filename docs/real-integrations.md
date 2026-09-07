# Real integrations — flip-to-live guide (CH-025 + Layer B)

The app runs **fully simulated by default** (zero external keys — the delivered §6.1 posture).
CI and the §7.7 suites always run keyless on simulation; nothing below is ever set in CI or
committed anywhere. Real providers are enabled **per deployment** via the gitignored `.env`
(verify: `git check-ignore .env`).

Contract provenance: seams ratified as CH-025 (contracts revision 25 — INV-051..054, VR-137,
INT-023, endpoints `POST /api/applications/:id/bank-links/link-token` + `.../exchange`).
Real adapter bodies are Layer-B code behind those seams.

Fail-fast rule (INV-051): enabling a real provider with its keys missing crashes at module
load with a message naming the missing variables. Simulation needs no configuration.

## 1. OCR — Claude Vision

| Variable | Value |
|---|---|
| `OCR_PROVIDER` | `real` |
| `OCR_PROVIDER_KIND` | `claude` |
| `OCR_PROVIDER_API_KEY` | your Anthropic API key (console.anthropic.com) |
| `OCR_CLAUDE_MODEL` | optional; default `claude-sonnet-5` |

Behavior: document uploads are extracted by Claude Vision (images: JPEG/PNG/WebP/GIF; PDFs
via the document block). Field vocabulary and masking match the simulation (SSN last-4 only,
DOB display form — enforced by a deterministic post-pass, never trusted to the model).
Failures are retryable via the staff panel's Retry; manual entry (corrections) always works.
`OCR_PROVIDER_KIND=http` (default) keeps the original generic-HTTP real slot
(`OCR_PROVIDER_BASE_URL` + `OCR_PROVIDER_API_KEY`).

Smoke test (run dir, keyed `.env.local`, prod server on :3083):
```
npx tsx --env-file=.env scripts/smoke-real-providers.ts ocr
```
Result: see §Smoke record below.

## 2. Address suggest — Google Places

| Variable | Value |
|---|---|
| `ADDRESS_PROVIDER` | `real` |
| `GOOGLE_PLACES_API_KEY` | Google Cloud key with Places API (legacy Web Service) enabled |

Behavior: wizard type-ahead suggestions come from Places Autocomplete (+ per-prediction
Details for full components), US addresses only, max 8. Any provider fault degrades
silently to manual entry (INV-052). **The deterministic geocoder is NOT switched** —
`geocodeAddress`/`withServerGeocode` (AVM, HMDA, subject-property save) stay simulated in
both modes, by contract.

Smoke test:
```
npx tsx --env-file=.env scripts/smoke-real-providers.ts address
```
Result: see §Smoke record below.

## 3. Bank linking — Plaid

| Variable | Value |
|---|---|
| `BANK_PROVIDER` | `real` |
| `PLAID_CLIENT_ID` | dashboard.plaid.com → Team settings → Keys |
| `PLAID_SECRET` | the secret for the environment below |
| `PLAID_ENV` | `sandbox` \| `development` \| `production` |

Behavior: the borrower bank-link dialog switches to the Plaid Link widget (script loaded
from `cdn.plaid.com`, admitted by the real-mode CSP per INV-053 — the default CSP never
includes it). Flow: server issues a link token → widget → public-token exchange → same
account-selection/import UI as simulation (INV-054). `BankLink.externalItemId` is persisted
for item revocation at unlink (best-effort). Income evidence is `null` under Plaid (the
income product is not enabled) — the Step 3 evidence panel simply doesn't render for real
links. Access tokens live only in the encrypted envelope (`accessTokenCiphertext`).

Sandbox credentials inside the widget: institution "First Platypus Bank" (or any),
username `user_good`, password `pass_good`, MFA `1234`.

Smoke test (server-side flow; the widget itself is browser-verified):
```
npx tsx --env-file=.env scripts/smoke-real-providers.ts bank
```
Result: see §Smoke record below.

## Smoke record + key validity

**2026-09-07 — operator-run smoke, all three integrations proven live** (production server on
:3083, keys in gitignored `.env.local` copied from App A; the autonomous session's permission
layer had blocked the key transfer, so the operator ran the placement + smoke by hand):

- `address` — **PASS**: `GET /api/address/suggest?q=1600 Amphitheatre Parkway Mountain View`
  → 1 suggestion, `"1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA"` (real Google data).
- `bank/link-token` — **PASS**: `POST .../bank-links/link-token` → live Plaid sandbox link
  token issued (4-hour expiry).
- `ocr` — **PASS**: uploaded `scripts/smoke-paystub.pdf` as borrower →
  `provider=claude-ocr-provider`, completed on **attempt 1 in ~10 s**, **9 fields**,
  `paystub.grossPay="$4,250.00"` — the exact value printed in the PDF.
- Plaid Link widget flow — **PASS** (operator browser pass, 2026-09-07): the widget loaded
  from `cdn.plaid.com` under the real-mode CSP, the sandbox login (`user_good`/`pass_good`,
  MFA `1234`) exchanged, accounts imported into Step 4, and unlink completed (best-effort
  sandbox item revocation).

To reproduce: steps in this section's history (copy App A `.env.local` → append the five
selector lines → `npm run build; npm run start` → `npx tsx --env-file=.env
scripts/smoke-real-providers.ts all`). Remove `.env.local` afterwards to return to the
keyless default.

| Key | Status (2026-09-07) |
|---|---|
| `ANTHROPIC_API_KEY` (App A `.env.local`) | **VALID** — live Claude Vision extraction succeeded |
| `GOOGLE_PLACES_API_KEY` | **VALID** — live autocomplete+details succeeded |
| `PLAID_CLIENT_ID`/`PLAID_SECRET` (`PLAID_ENV=sandbox`) | **VALID** — live link-token issuance succeeded |

## Never do

- Never set any `*_PROVIDER=real` in CI, tests, or committed files.
- Never commit a key (`.env` only; it is gitignored).
- Never expect the §7.7 suites to run against real mode — they are contracted to the
  keyless simulation.
