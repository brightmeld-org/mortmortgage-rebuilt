# External Identity Provider — Wiring Notes (AC-09)

Requirements §4.1.8 mandates that the authentication layer sits behind a
documented provider abstraction so an external identity provider (an OIDC or
SAML vendor such as a corporate SSO) can be substituted for production without
changes to application code outside the provider module. This document is the
required wiring description. **The delivered System runs entirely on the
built-in provider** — nothing below is implemented against a live vendor.

## The seam

| Piece | File / symbol |
|---|---|
| Interface | `src/lib/services/idp/provider.ts` — `IdentityProvider` (`signIn`, `signOut`, `sessionLookup`, `provision`, `mfaHandoff`), `ProvisionInput`, `ProvisionResult` |
| Built-in implementation | `src/lib/services/idp/built-in.ts` — `builtInProvider` |
| Selection point | `src/lib/services/idp/index.ts` — `getIdentityProvider()` |
| Consumers (complete list) | `src/lib/guard.ts` (`guard`, `guardMfaFlow`, `guardVerificationPending` — every protected endpoint), `src/app/api/auth/sign-in/route.ts`, `src/app/api/auth/sign-out/route.ts`, `src/app/api/auth/demo-login/route.ts` |

Everything else in the application reaches identity exclusively through the
shared guard, so a provider swap touches only this directory plus
configuration.

## What stays local no matter the provider

- **User rows are the system of record.** Audit attribution, record-level
  scoping (S-1..S-7), assignments, and role gates all reference `User.id`.
  An external IdP maps its subject to a local row via `provision` — it never
  replaces the table.
- **Sessions stay server-side and revocable (SEC-20).** The app session is the
  `Session` row addressed by the `mm_session` HttpOnly cookie. Password reset,
  deactivation, and MFA reset revoke rows; that guarantee holds because
  `sessionLookup` resolves through the table. Keep it that way: exchange the
  upstream assertion for a local session once, at callback time.
- **Contract error posture.** Uniform sign-in failure body, uniform Acks,
  `ErrorResponse` everywhere, and the persisted rate limiting
  (`src/lib/services/rate-limit.ts`) — all provider-independent.

## Steps to wire an external IdP

1. **Implement `IdentityProvider`** in a new module in this directory
   (e.g. `external-oidc.ts`):
   - `sessionLookup` — unchanged in almost every design: keep delegating to the
     local `Session`-row resolution (`src/lib/auth.ts#getSessionUser`). The
     upstream token is verified once at the auth callback, not per request.
   - `provision` — map verified upstream claims (subject, email, name, groups)
     to `ProvisionInput`. **Role mapping** happens here: translate the IdP's
     group/role claim to exactly one verbatim `UserRole` value
     (`BORROWER`/`CASEWORKER`/`SUPERVISOR`, INV-004); reject sign-ins whose
     claims map to no role. Set `emailVerified` from the provider's
     email-verification claim. Keep the find-or-create idempotent and
     concurrency-safe (the built-in implementation shows the P2002 pattern
     against the case-insensitive unique email index).
   - `signIn` — for redirect-based protocols the credential form is replaced by
     the provider's hosted flow; implement the callback as: validate the
     assertion → `provision` → create the local session
     (`src/lib/services/session.ts#createSession`) with `mfaPending: false`
     when MFA is delegated upstream (see `mfaHandoff` below). The local
     password path may then return the uniform failure unconditionally.
   - `signOut` — revoke the local session (keep the built-in body) and, if the
     vendor supports single log-out, additionally call its end-session
     endpoint.
   - `mfaHandoff` — **MFA delegation**: when the external IdP enforces MFA
     upstream, local enrollment/challenge must never block sign-in. Provision
     with `mfaPreEnrolled: true` and issue sessions with `mfaPending: false`;
     `mfaHandoff` then only ever resolves full sessions (`preMfa: false`), and
     the local TOTP endpoints become unreachable dead paths for
     externally-provisioned users. If the IdP does NOT enforce MFA, keep the
     local TOTP flow exactly as the built-in provider does (§4.1.4 is
     mandatory either way).
2. **Return the new implementation** from `getIdentityProvider()`
   (`index.ts`), selected by configuration (e.g. an `IDP_PROVIDER` environment
   variable defaulting to `built-in`). Configuration the external module will
   need: issuer URL, client id/secret, redirect/callback URL, the role-claim
   name, and the claim-to-role mapping table.
3. **UI**: point the sign-in page's form/action at the provider's authorize
   flow when the external provider is active. No other page changes — the
   session cookie and `GET /api/auth/session` contract are unchanged.
4. **Out of scope for the swap** (unchanged by design): rate limiting
   (persisted, keyed on account + IP, provider-independent), CSRF, audit,
   demo login (`DEMO_MODE` gates it independently of provider choice; demo
   accounts remain locally provisioned).

## Verifying a swap

Re-run the auth verification suites against the new provider:
`verification/increment-2/task-006` (credential/session behavior — adjust the
credential steps to the provider's flow), `task-007` (MFA posture), and
`task-008` (seam delegation, rate limiting, demo login). The record-level
scoping and audit suites must pass untouched — if they do not, the swap leaked
outside the seam.
