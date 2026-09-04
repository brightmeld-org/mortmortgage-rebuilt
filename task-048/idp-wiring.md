# External Identity Provider Wiring (AC-09)

This document describes how to wire an external identity provider (IdP) through the pluggable provider interface. The delivered system runs entirely on the built-in provider (email + password + TOTP MFA); external IdP integration is optional and happens outside application code via the provider abstraction.

---

## Table of Contents

1. [The Provider Abstraction](#the-provider-abstraction)
2. [Built-in Provider Reference](#built-in-provider-reference)
3. [What Stays Local (No Matter the Provider)](#what-stays-local-no-matter-the-provider)
4. [Steps to Wire an External IdP](#steps-to-wire-an-external-idp)
5. [Verifying the Swap](#verifying-the-swap)

---

## The Provider Abstraction

**Module:** `src/lib/services/idp/provider.ts`

The `IdentityProvider` interface defines five methods:

```typescript
export interface IdentityProvider {
  /**
   * Authenticate a user (credential exchange).
   * Returns a local Session row or error.
   */
  signIn(req: SignInRequest): Promise<SignInResponse>;

  /**
   * Revoke a user's session.
   */
  signOut(sessionId: string): Promise<void>;

  /**
   * Look up the current session user (called per protected request).
   * Returns User + session state, or null if not found/expired.
   */
  sessionLookup(sessionId: string): Promise<SessionUser | null>;

  /**
   * Provision or update a user after successful upstream authentication.
   * Maps IdP claims to local User row (find-or-create idempotent).
   * Returns local User + optional pre-MFA session state.
   */
  provision(input: ProvisionInput): Promise<ProvisionResult>;

  /**
   * Delegate MFA verification to the external IdP or local TOTP.
   * When IdP owns MFA: return full session immediately.
   * When local MFA: challenge caller for TOTP/recovery-code entry.
   */
  mfaHandoff(sessionId: string, totp?: string, recoveryCode?: string): Promise<SessionUser | null>;
}
```

**Selection Point:** `src/lib/services/idp/index.ts` — `getIdentityProvider()` — select provider by environment variable (e.g., `IDP_PROVIDER=built-in` or `IDP_PROVIDER=external-oidc`).

**Consumers (every protected endpoint):** `src/lib/guard.ts` (`guard`, `guardMfaFlow`), `src/app/api/auth/sign-in/route.ts`, `/sign-out`, `/demo-login`.

---

## Built-in Provider Reference

**Module:** `src/lib/services/idp/built-in.ts`

### signIn

```typescript
signIn(req: SignInRequest): Promise<SignInResponse>
```

1. Look up user by email (case-insensitive index).
2. If not found or account deactivated: return uniform failure ("invalid email or password").
3. If password invalid or account locked: return uniform failure.
4. If account needs MFA: return `{ mfaPending: true, sessionId: "<temp-token>" }`.
5. If MFA not required (unlikely): return `{ ok: true, sessionId: "<session>" }`.

### signOut

```typescript
signOut(sessionId: string): Promise<void>
```

1. Delete the Session row.
2. Session is revoked; cookie invalid.

### sessionLookup

```typescript
sessionLookup(sessionId: string): Promise<SessionUser | null>
```

1. Query Session table by ID.
2. Check idle timeout (30 min default) and absolute timeout (12 hr default).
3. If expired: delete and return null.
4. Otherwise: return User + session state.

**Called per protected request** — every API endpoint validates session via this method.

### provision

```typescript
provision(input: ProvisionInput): Promise<ProvisionResult>
```

Built-in provider: returns null (no external claims to map). External IdPs implement this.

### mfaHandoff

```typescript
mfaHandoff(sessionId: string, totp?: string, recoveryCode?: string): Promise<SessionUser | null>
```

1. Look up pending-MFA session.
2. If `totp` provided: verify against TOTP enrollment. If valid, mark MFA verified and return full session.
3. If `recoveryCode` provided: verify against recovery codes (single-use). If valid, consume code, trigger re-enrollment requirement, return full session.
4. If neither: return null (caller must prompt for code).

---

## What Stays Local (No Matter the Provider)

### 1. User Rows Are the System of Record

All access control and audit attribution reference `User.id`, never the external IdP's subject. The `provision` method maps external subject → local User row. This guarantees:

- Role assignment happens locally (no role-claim parsing across systems)
- User deactivation is enforced locally (set `User.deactivatedAt` and check it on session lookup)
- Audit trails reference local User IDs consistently
- Data scoping (S-1 through S-7) works the same regardless of IdP

### 2. Sessions Stay Server-Side and Revocable (SEC-20)

```
User sends credentials / assertion to IdP or app
                       ↓
                IdP validates and returns token
                       ↓
         App calls IdP callback/validation
                       ↓
      App creates local Session row (one-time exchange)
                       ↓
Session ID returned to user in HttpOnly cookie (mm_session)
                       ↓
Per-request: sessionLookup(sessionId) → checks Session table
                       ↓
Session revocation: DELETE from Session table (immediate effect)
```

**This design ensures:**

- Password reset revokes all sessions (delete all Session rows for user)
- MFA re-enrollment revokes all sessions
- Deactivation is immediate (sessionLookup checks `User.deactivatedAt` on every request)
- No upstream token validation needed per-request (expensive, slow, unreliable)

### 3. Contract Error Posture

Uniform across all providers:

```typescript
// Sign-in failure (any cause: wrong password, locked, unknown email, MFA pending)
{ code: "invalid_credentials", message: "invalid email or password", ... }

// 429 rate limit (persisted, per REQ-018)
{ code: "rate_limited", message: "too many attempts", ... }

// MFA verification failure
{ code: "mfa_failed", message: "invalid code", ... }

// All endpoints return ErrorResponse { code, message, details?, requestId?, ... }
```

---

## Steps to Wire an External IdP

### Step 1: Implement IdentityProvider

Create a new module in `src/lib/services/idp/` (e.g., `external-oidc.ts`):

#### sessionLookup

```typescript
async sessionLookup(sessionId: string): Promise<SessionUser | null> {
  // Unchanged in almost every design: keep delegating to local Session table
  return getSessionUser(sessionId);  // from src/lib/auth.ts
}
```

**Why unchanged:** Upstream token validation per-request is expensive and adds latency. Exchange the assertion once at auth time, then trust the local session table for every subsequent request.

#### provision

Map verified upstream claims to local User row. **This is where role mapping happens.**

```typescript
async provision(input: ProvisionInput): Promise<ProvisionResult> {
  const { upstreamSubject, email, displayName, groups, emailVerified } = input;

  // Role mapping: translate IdP groups/claims to exactly one UserRole
  const role = mapGroupsToRole(groups);  // Your implementation
  if (!role) {
    throw new Error("Claims do not map to a valid role (BORROWER/CASEWORKER/SUPERVISOR)");
  }

  // Find-or-create: idempotent, concurrency-safe
  const user = await findOrCreateUser({
    email,
    role,
    displayName,
    emailVerified,
    externalSubject: upstreamSubject,  // Store for future lookups
  });

  return { user, mfaPreEnrolled: true };  // If delegating MFA upstream
}
```

**Role mapping rule:** Translate the IdP's group/role claim to exactly one verbatim `UserRole` value:

- `"BORROWER"` — a Borrower
- `"CASEWORKER"` — a Caseworker
- `"SUPERVISOR"` — a Supervisor

**Concurrency-safe find-or-create:** Use Prisma's `upsert` with case-insensitive unique email index and handle P2002 (unique constraint) to avoid race conditions on concurrent sign-ins from the same email.

#### signIn

For redirect-based protocols (OIDC, SAML), the credential form is replaced by the provider's hosted flow. Implement the callback as:

```typescript
async signIn(req: SignInRequest): Promise<SignInResponse> {
  // For OIDC: req.code (from ?code=... redirect)
  // For SAML: req.assertion (from form POST)

  // 1. Exchange code/assertion for identity token
  const assertion = await exchangeCodeForAssertion(req.code || req.assertion);

  // 2. Validate signature & claims
  const claims = validateAndDecodeAssertion(assertion, {
    expectedAudience: process.env.IDP_CLIENT_ID,
    expectedIssuer: process.env.IDP_ISSUER,
  });

  // 3. Map claims and provision local user
  const provisionInput: ProvisionInput = {
    upstreamSubject: claims.sub,
    email: claims.email,
    displayName: claims.name,
    groups: claims.groups || [],  // or roles, or custom claim
    emailVerified: claims.email_verified || false,
  };

  const { user, mfaPreEnrolled } = await this.provision(provisionInput);

  // 4. Create local session
  // When delegating MFA upstream: mfaPending = false (MFA already done by IdP)
  // When local MFA: mfaPending = true (user must enroll/verify TOTP)
  const session = await createSession({
    userId: user.id,
    mfaPending: !mfaPreEnrolled,
    ipAddress: req.ip,
    userAgent: req.userAgent,
  });

  return { ok: true, sessionId: session.id };
}
```

#### signOut

```typescript
async signOut(sessionId: string): Promise<void> {
  // 1. Revoke local session (mandatory)
  await deleteSession(sessionId);

  // 2. Optionally call IdP's end-session endpoint (if provider supports SLO)
  // This logs the user out of the IdP's hosted session too
  if (process.env.IDP_END_SESSION_ENDPOINT) {
    // POST or redirect to end-session endpoint
  }
}
```

#### mfaHandoff

**Case A: IdP enforces MFA upstream**

```typescript
async mfaHandoff(sessionId: string, totp?: string): Promise<SessionUser | null> {
  // MFA is done by the IdP; user already has a full session
  return getSessionUser(sessionId);  // Just look up existing session
}
```

Set `mfaPreEnrolled: true` during provision so the session is never in `mfaPending` state.

**Case B: Local TOTP MFA (IdP does not enforce MFA)**

```typescript
async mfaHandoff(sessionId: string, totp?: string, recoveryCode?: string): Promise<SessionUser | null> {
  // Exact same as built-in provider — use local TOTP flow
  // Challenge user for 6-digit code or recovery code
  // Verify & return session
}
```

### Step 2: Return New Implementation from getIdentityProvider()

**File:** `src/lib/services/idp/index.ts`

```typescript
export function getIdentityProvider(): IdentityProvider {
  const provider = process.env.IDP_PROVIDER || "built-in";

  switch (provider) {
    case "built-in":
      return builtInProvider;
    case "external-oidc":
      return externalOidcProvider;  // Your new implementation
    case "external-saml":
      return externalSamlProvider;  // If adding SAML later
    default:
      throw new Error(`Unknown IdP provider: ${provider}`);
  }
}
```

### Step 3: UI Updates

**File:** `src/app/auth/sign-in/page.tsx`

Point the sign-in form's action at the provider's authorize flow when external provider is active:

```typescript
const idpProvider = process.env.IDP_PROVIDER || "built-in";

if (idpProvider === "external-oidc") {
  // Show "Sign in with [IdP]" button
  // onClick: redirect to idp authorize endpoint
  // e.g., https://idp.example.com/oauth/authorize?client_id=...&redirect_uri=.../callback
} else if (idpProvider === "built-in") {
  // Show email + password form (existing)
}
```

### Step 4: Environment Configuration

Add provider-specific env vars (e.g., `compose.env` for local dev, ECS task definition for cloud):

```env
IDP_PROVIDER=external-oidc
IDP_ISSUER=https://idp.example.com
IDP_CLIENT_ID=<your-client-id>
IDP_CLIENT_SECRET=<your-client-secret>
IDP_AUTHORIZE_URL=https://idp.example.com/oauth/authorize
IDP_TOKEN_URL=https://idp.example.com/oauth/token
IDP_USERINFO_URL=https://idp.example.com/oauth/userinfo
IDP_END_SESSION_ENDPOINT=https://idp.example.com/oauth/logout
IDP_REDIRECT_URI=https://mortmortgage.example.com/api/auth/callback
```

---

## Verifying the Swap

### Test Suites to Re-Run

All existing verification suites pass unchanged against the new provider. Re-run:

1. **task-006** (credential/session behavior)
   - Adjust credential steps to match new provider's flow (OIDC authorize redirect, etc.)
   - Verify sessions are created, timeout, and can be revoked
   - Verify sign-out invalidates session

2. **task-007** (MFA)
   - If delegating MFA upstream: verify `mfaPending=false` on sign-in
   - If using local TOTP: verify TOTP flow unchanged

3. **task-008** (seam delegation, rate limiting, demo login)
   - Rate limiting works unchanged (persisted per REQ-018)
   - CSRF unchanged (provider-independent)
   - Demo login (`DEMO_MODE` gates it independently of provider choice; demo accounts remain locally provisioned)

### Record-Level Scoping Unchanged

Re-run access-control verification suites (task-011 through task-013):

- **S-1:** Borrower can only read/write own applications → still enforced on `User.id`
- **S-2 through S-7:** Caseworker/Supervisor scoping → still enforced via `User.role` and `Assignment` table
- If these fail: the swap leaked outside the seam; revert and debug

### External IdP as Optional Feature

The swap is **completely optional**. Customers can:

1. Deploy with `IDP_PROVIDER=built-in` (default) — use email + password + TOTP
2. Later swap to an external IdP by changing one env var and redeploying
3. Swap back to built-in by changing the env var again

No application code changes outside `src/lib/services/idp/`. No schema changes. Existing user data works with both providers (the `User` row is the source of truth).

---

## Key Takeaways

| Aspect | Rule |
|--------|------|
| **User rows** | Always local system of record (`User.id` for access control, audit) |
| **Sessions** | Always server-side, revocable, checked per-request |
| **Role mapping** | Happens during `provision` (from IdP groups → UserRole) |
| **MFA delegation** | Optional; IdP can own it (set `mfaPending=false`) or app uses local TOTP |
| **Rate limiting** | Persisted per REQ-018; unchanged by provider swap |
| **Error posture** | Uniform `ErrorResponse` shape across all providers |
| **Demo mode** | Independent of provider; gated by `DEMO_MODE` env var |

---

## Support

For questions on wiring an external IdP or verifying the integration, contact the development team via internal channels.
