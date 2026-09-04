// Identity-provider abstraction (task-008). Requirements §4.1.8 / AC-09.
//
// The authentication layer is implemented BEHIND this documented interface so an
// external identity provider (e.g. an OIDC/SAML vendor) can be substituted for
// production WITHOUT changes to application code outside the provider module:
// the shared route guard (src/lib/guard.ts) and the auth route handlers consume
// ONLY this seam. The delivered System runs entirely on the built-in provider
// (src/lib/services/idp/built-in.ts) — see WIRING.md in this directory for what
// an operator must implement/configure to swap in an external IdP.
//
// Contract of the seam (what any implementation MUST honor):
//   - Local User rows remain the system of record for identity/role/scoping —
//     every audit entry, assignment, and record-level scope check references
//     User.id. An external provider maps its subject to a local User row via
//     `provision` and never bypasses it.
//   - Sessions remain SERVER-SIDE and revocable (SEC-20): whatever the upstream
//     protocol, the app session is the local Session row addressed by the
//     mm_session cookie. Revocation lists (password reset, deactivation, MFA
//     reset) must keep working, which they do as long as sessionLookup resolves
//     through the Session table.
//   - Error posture is fixed by the §B contract and does NOT vary by provider:
//     uniform sign-in 401 ("invalid email or password"), uniform Ack responses,
//     ErrorResponse everywhere.

import type { SessionUser, MfaFlowSession } from "@/lib/auth";
import type { UserRole } from "@prisma/client";
import type { RequestMeta, SignInOutcome } from "@/lib/services/auth-account";

/**
 * Input to the provisioning hook: the identity attributes the provider asserts.
 * The built-in provider uses it for demo-account find-or-create; an external
 * IdP implementation uses it to map verified upstream claims (subject, email,
 * name, mapped role) to a local User row on first sign-in.
 */
export interface ProvisionInput {
  /** Asserted email — the local unique account key (case-insensitive, INV-013). */
  email: string;
  /** Verbatim UserRole enum value the identity maps to. */
  role: UserRole;
  firstName: string;
  lastName: string;
  /** Provider-verified email → the local row is created already verified. */
  emailVerified: boolean;
  /** Demo-account flag (NFR-016) — only demo login provisions with true. */
  isDemo: boolean;
  /**
   * When true, the local row is provisioned with an ACTIVE MFA enrollment
   * (demo accounts are pre-enrolled per §4.1.4; an external IdP that performs
   * MFA upstream provisions with true so no local challenge blocks sign-in).
   */
  mfaPreEnrolled: boolean;
}

export interface ProvisionResult {
  userId: string;
  role: UserRole;
  email: string;
  /** True when this call created the local row (idempotent find-or-create). */
  created: boolean;
}

/**
 * The provider interface (§4.1.8: sign-in, sign-out, session lookup, user
 * provisioning hook, MFA hand-off). All request-scoped methods receive the
 * standard Fetch Request so implementations can read cookies/headers.
 */
export interface IdentityProvider {
  /** Machine name of the implementation (diagnostics only — never branches app logic). */
  readonly name: string;

  /**
   * Credential sign-in. Returns the full outcome union: uniform failure
   * (`ok: false` — the route emits the byte-identical §4.1.3 401) or success
   * with SignInStatus, redirect target, and the issued server-side session.
   * An external IdP implementation typically does not use this path (browser
   * redirect flow instead) — see WIRING.md.
   */
  signIn(input: { email: string; password: string }, meta: RequestMeta): Promise<SignInOutcome>;

  /**
   * Revoke the server-side session (SEC-20) and write the session-revocation
   * audit entry attributed to the session identity. Idempotent: revoking an
   * already-revoked session is a no-op (no duplicate audit row).
   */
  signOut(user: SessionUser, meta: RequestMeta): Promise<void>;

  /**
   * Resolve the request's FULL session or null (expired, revoked, pre-MFA,
   * absent, inactive user). This is the single accessor the shared route guard
   * uses for every protected endpoint (SEC-19/INV-038).
   */
  sessionLookup(request: Request): Promise<SessionUser | null>;

  /**
   * Idempotent find-or-create of the local User row for an asserted identity.
   * Concurrency-safe: simultaneous first calls for the same email converge on
   * ONE row (both callers succeed). Never returns or logs credential material.
   */
  provision(input: ProvisionInput, meta: RequestMeta): Promise<ProvisionResult>;

  /**
   * MFA hand-off: resolve the request's MFA-flow state — a full session, a
   * live pre-MFA session inside the §4.1.4 challenge window, or null. The
   * built-in provider runs the local TOTP challenge on top of this; an
   * external IdP that delegates MFA upstream reports pre-MFA never (its
   * sessions arrive with the factor already satisfied) — see WIRING.md.
   */
  mfaHandoff(request: Request): Promise<MfaFlowSession | null>;
}
