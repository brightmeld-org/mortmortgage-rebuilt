// The SINGLE shared route guard (INV-038, SEC-19) + the S-1..S-7 scoping helpers
// (INV-026, INV-027, REQ-002..REQ-009).
//
// EVERY API route handler calls `guard(request, { roleGate })` FIRST — before
// touching the request body. The guard:
//   1. resolves the session (src/lib/auth.ts),
//   2. enforces the endpoint's contracts §B roleGate (401 no session / 403 wrong role),
//   3. verifies the session-bound CSRF token on state-changing methods (src/lib/csrf.ts),
//   4. returns a typed context { user, requestId }.
// Body parsing (src/lib/http/validation.ts) happens strictly AFTER a guard pass.
//
// Route-level roleGate answers "may this ROLE call this endpoint at all". The
// RECORD-level questions — "may this user touch THIS application" — are answered by
// the scoping helpers below, which every application-scoped route must call after
// the guard and before returning or mutating data. They are the single
// implementation of S-1..S-4 for the whole app; S-5 (SSN masking) lives in the
// task-002 masking module, S-6/S-7 (staff identifiers / internal notes never reach
// borrowers) are enforced by serializers via src/lib/http/serialize.ts.
//
// Admin endpoints go through this exact same guard — access-control entry points,
// never architectural bypasses.

import type { UserRole, WorkflowState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { getIdentityProvider } from "@/lib/services/idp";
import { csrfFailure, forbidden, requestIdFrom, unauthorized } from "@/lib/http/errors";
import { stashRequestUser } from "@/lib/log";
import { isStateChangingMethod, verifyCsrfRequest } from "@/lib/csrf";
import { clearSessionCookieHeader, hasSessionCookie } from "@/lib/services/session";

// ---------------------------------------------------------------------------
// Route guard
// ---------------------------------------------------------------------------

/**
 * contracts.json endpoints[].roleGate, verbatim semantics:
 *   "public"             — no session required (session still resolved when present)
 *   "authenticated-any"  — any signed-in role
 *   role list            — lowercase contract role names, e.g. ["caseworker","supervisor"]
 */
export type ContractRole = "borrower" | "caseworker" | "supervisor";
export type RoleGate = "public" | "authenticated-any" | readonly ContractRole[];

/** Lowercase contract roleGate name → verbatim UserRole enum value. */
const ROLE_GATE_TO_USER_ROLE: Record<ContractRole, UserRole> = {
  borrower: "BORROWER",
  caseworker: "CASEWORKER",
  supervisor: "SUPERVISOR",
};

export interface GuardOptions {
  roleGate: RoleGate;
  /**
   * CSRF enforcement on state-changing methods. Default true. Set false ONLY for
   * endpoints the contract exempts by design (public unauthenticated auth endpoints —
   * see src/lib/csrf.ts module header). Public endpoints with no session are exempt
   * automatically (there is no session to bind a token to).
   */
  csrf?: boolean;
}

export interface GuardContext<U extends SessionUser | null = SessionUser> {
  user: U;
  requestId: string | undefined;
}

export type GuardResult<U extends SessionUser | null = SessionUser> =
  | { ok: true; ctx: GuardContext<U> }
  | { ok: false; response: Response };

export async function guard(
  request: Request,
  options: GuardOptions & { roleGate: "public" },
): Promise<GuardResult<SessionUser | null>>;
export async function guard(request: Request, options: GuardOptions): Promise<GuardResult<SessionUser>>;
export async function guard(
  request: Request,
  options: GuardOptions,
): Promise<GuardResult<SessionUser | null>> {
  const requestId = requestIdFrom(request);
  // Session resolution goes through the identity-provider seam (task-008,
  // §4.1.8/AC-09) — the built-in provider delegates to src/lib/auth.ts unchanged.
  const user = await getIdentityProvider().sessionLookup(request);
  // task-045 (NFR-027): identity for the request-log completion line — userId/role only.
  if (user) stashRequestUser(request, { userId: user.userId, role: user.role });

  if (options.roleGate !== "public") {
    // 401 before any body parsing (SEC-19). A presented-but-dead cookie (expired,
    // revoked, pre-MFA, unknown) is cleared on the way out (§4.1.7, task-006).
    if (!user) {
      const response = unauthorized(requestId);
      if (hasSessionCookie(request)) {
        response.headers.set("set-cookie", clearSessionCookieHeader());
      }
      return { ok: false, response };
    }

    if (options.roleGate !== "authenticated-any") {
      const allowed = options.roleGate.map((r) => ROLE_GATE_TO_USER_ROLE[r]);
      if (!allowed.includes(user.role)) {
        return { ok: false, response: forbidden(requestId) };
      }
    }
  }

  // Session-bound CSRF on state-changing methods (SEC-3). A session-carrying request
  // is verified even on a "public" roleGate — the bind exists as soon as the session does.
  if (options.csrf !== false && user && isStateChangingMethod(request.method)) {
    if (!verifyCsrfRequest(request, user.sessionId)) {
      return { ok: false, response: csrfFailure(requestId) };
    }
  }

  return { ok: true, ctx: { user, requestId } };
}

// ---------------------------------------------------------------------------
// MFA-flow guard (task-007) — the ONLY pre-MFA-tolerant entry point
// ---------------------------------------------------------------------------

export interface MfaFlowGuardContext {
  user: SessionUser;
  /** True when the session is pre-MFA (§4.1.4 10-minute enrollment/challenge window). */
  preMfa: boolean;
  requestId: string | undefined;
}

export type MfaFlowGuardResult =
  | { ok: true; ctx: MfaFlowGuardContext }
  | { ok: false; response: Response };

export interface MfaFlowGuardOptions {
  /**
   * Admit a PENDING session whose account has not verified its email (§4.1.2:
   * such an account is limited to the verification-pending surface). Default
   * false — the MFA enrollment/challenge endpoints must not be reachable before
   * verification. ONLY POST /api/auth/sign-out sets it true: abandoning a flow
   * and revoking the session row must always be possible.
   */
  allowUnverifiedEmail?: boolean;
}

/**
 * Guard variant for EXACTLY the surfaces a pre-MFA session may reach: the
 * task-007 MFA endpoints (enroll, enroll/verify, verify) and sign-out. It uses
 * the DEDICATED pre-MFA-tolerant accessor (src/lib/auth.ts getMfaFlowSession)
 * — the general getSessionUser keeps rejecting pre-MFA sessions everywhere
 * else, so every other protected API still 401s them.
 *
 * CSRF: verified for FULL sessions (their client holds SessionInfo.csrfToken).
 * Pre-MFA sessions are EXEMPT BY DESIGN, exactly like the public unauthenticated
 * auth endpoints (src/lib/csrf.ts module header): GET /api/auth/session is 401
 * for them, so no token is obtainable, and the session grants nothing but this
 * handshake — there is no privileged state a cross-site request could ride on.
 */
export async function guardMfaFlow(
  request: Request,
  options: MfaFlowGuardOptions = {},
): Promise<MfaFlowGuardResult> {
  const requestId = requestIdFrom(request);
  // MFA hand-off through the provider seam (task-008): built-in delegates to
  // the task-007 pre-MFA-tolerant accessor unchanged.
  const flow = await getIdentityProvider().mfaHandoff(request);
  // task-045 (NFR-027): identity for the request-log completion line — userId/role only.
  if (flow) stashRequestUser(request, { userId: flow.user.userId, role: flow.user.role });

  if (!flow) {
    // Dead / expired-window / absent session — same posture as guard(): 401,
    // clearing a presented-but-dead cookie on the way out.
    const response = unauthorized(requestId);
    if (hasSessionCookie(request)) {
      response.headers.set("set-cookie", clearSessionCookieHeader());
    }
    return { ok: false, response };
  }

  // §4.1.2: an unverified account belongs to the verification-pending surface, not
  // to the MFA surface — it may not enroll or challenge a second factor before the
  // address is verified. Sign-out opts out (allowUnverifiedEmail).
  if (flow.preMfa && !flow.user.emailVerified && options.allowUnverifiedEmail !== true) {
    return { ok: false, response: unauthorized(requestId) };
  }

  if (!flow.preMfa && isStateChangingMethod(request.method)) {
    if (!verifyCsrfRequest(request, flow.user.sessionId)) {
      return { ok: false, response: csrfFailure(requestId) };
    }
  }

  return { ok: true, ctx: { user: flow.user, preMfa: flow.preMfa, requestId } };
}

// ---------------------------------------------------------------------------
// Verification-pending guard (§4.1.2 / REQ-011) — the ONLY surface an
// email-unverified account may reach
// ---------------------------------------------------------------------------

/**
 * Guard for the two endpoints that make the verification-pending PAGE work:
 * GET /api/auth/session (the session handshake the page probes, and the sole
 * source of the CSRF token) and POST /api/auth/resend-verification.
 *
 * Admits exactly two things:
 *   - a normal FULL session (verified account) — behavior identical to
 *     `guard(request, { roleGate: "authenticated-any" })`, and
 *   - the PENDING session issued at sign-in to an account whose email is not yet
 *     verified (§4.1.2 "limited to the verification-pending page").
 * Everything else is 401 — including a pre-MFA session belonging to a VERIFIED
 * account, exactly as before this guard existed. That last point matters: the
 * pre-MFA CSRF exemption in guardMfaFlow is safe precisely because an MFA-challenge
 * session can obtain no csrfToken here.
 *
 * CSRF is verified on state-changing methods for BOTH admitted kinds — a
 * verification-pending session CAN read its token from GET /api/auth/session, so it
 * is held to the same synchronizer-token rule as a full session.
 *
 * Every other protected route keeps using `guard`, whose getSessionUser refuses
 * both kinds of pending session.
 */
export async function guardVerificationPending(request: Request): Promise<GuardResult<SessionUser>> {
  const requestId = requestIdFrom(request);
  // Same provider seam as guardMfaFlow (task-008) — pending-tolerant resolution.
  const flow = await getIdentityProvider().mfaHandoff(request);
  if (flow) stashRequestUser(request, { userId: flow.user.userId, role: flow.user.role });

  if (!flow || (flow.preMfa && flow.user.emailVerified)) {
    const response = unauthorized(requestId);
    if (hasSessionCookie(request)) {
      response.headers.set("set-cookie", clearSessionCookieHeader());
    }
    return { ok: false, response };
  }

  if (isStateChangingMethod(request.method) && !verifyCsrfRequest(request, flow.user.sessionId)) {
    return { ok: false, response: csrfFailure(requestId) };
  }

  return { ok: true, ctx: { user: flow.user, requestId } };
}

// ---------------------------------------------------------------------------
// S-1..S-4 record-level scoping helpers (live DB checks — never constants)
// ---------------------------------------------------------------------------

/**
 * Claimable states (§4.4.1, S-2b): Application Received, or any pre-decision state
 * left unassigned by deactivation/reassignment. "Pre-decision" = non-terminal,
 * non-Draft states before a final decision is recorded (approved/denied and beyond
 * are decided; draft is borrower-private; terminal states are closed).
 */
export const CLAIMABLE_STATES: readonly WorkflowState[] = [
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
  "revision_requested",
  "suspended",
];

/**
 * S-2 summary field set: the ONLY fields serialized for an unassigned claimable
 * application read by a caseworker (QueueRow) — no identity, contact, asset, or
 * liability detail until claimed. Queue serializers (task-022+) must project
 * exactly these.
 */
export const UNASSIGNED_SUMMARY_FIELDS = [
  "applicationNumber",
  "borrowerDisplayName",
  "loanAmount",
  "loanType",
  "submittedAt",
  "workflowState",
  "priority",
  "slaStatus",
] as const;

interface ScopedApplication {
  id: string;
  borrowerUserId: string;
  workflowState: WorkflowState;
  /** Caseworker user id of the current ACTIVE assignment (endedAt IS NULL), if any. */
  activeAssignmentCaseworkerId: string | null;
}

/** Load the scoping-relevant slice of an application. Null when it does not exist. */
async function loadScopedApplication(applicationId: string): Promise<ScopedApplication | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      borrowerUserId: true,
      workflowState: true,
      assignments: {
        where: { endedAt: null },
        select: { caseworkerUserId: true },
        take: 1,
      },
    },
  });
  if (!app) return null;
  return {
    id: app.id,
    borrowerUserId: app.borrowerUserId,
    workflowState: app.workflowState,
    activeAssignmentCaseworkerId: app.assignments[0]?.caseworkerUserId ?? null,
  };
}

export type ReadAccessLevel = "full" | "summary";

export type ApplicationReadAccess =
  | { allowed: true; level: ReadAccessLevel; application: ScopedApplication }
  | { allowed: false; reason: "not-found" | "not-owner" | "not-assigned" };

/**
 * S-1 / S-2 / S-4 read scoping. Verbatim semantics:
 *   BORROWER   — full read iff they OWN the application (S-1); anything else denied.
 *   CASEWORKER — full read iff they hold the current ACTIVE assignment (S-2a);
 *                SUMMARY-ONLY read iff unassigned AND in a claimable state (S-2b) —
 *                callers must serialize only UNASSIGNED_SUMMARY_FIELDS at level
 *                "summary"; otherwise denied.
 *   SUPERVISOR — full read on everything (S-4).
 * Routes map { reason: "not-found" } → 404 and the denial reasons → 403 (or 404 to
 * avoid existence disclosure to borrowers — route's contract decides).
 */
export async function canReadApplication(
  user: SessionUser,
  applicationId: string,
): Promise<ApplicationReadAccess> {
  const application = await loadScopedApplication(applicationId);
  if (!application) return { allowed: false, reason: "not-found" };

  switch (user.role) {
    case "BORROWER":
      return application.borrowerUserId === user.userId
        ? { allowed: true, level: "full", application }
        : { allowed: false, reason: "not-owner" };
    case "CASEWORKER":
      if (application.activeAssignmentCaseworkerId === user.userId) {
        return { allowed: true, level: "full", application };
      }
      if (
        application.activeAssignmentCaseworkerId === null &&
        CLAIMABLE_STATES.includes(application.workflowState)
      ) {
        return { allowed: true, level: "summary", application };
      }
      return { allowed: false, reason: "not-assigned" };
    case "SUPERVISOR":
      return { allowed: true, level: "full", application };
  }
}

export type ApplicationWriteAccess =
  | { allowed: true; application: ScopedApplication }
  | { allowed: false; reason: "not-found" | "not-owner" | "not-assigned" };

/**
 * S-1 / S-3 / S-4 write scoping (INV-026): every mutating operation on an
 * application must be authored by the owning Borrower, the holder of the current
 * ACTIVE assignment, or a Supervisor.
 *   BORROWER   — owns it (S-1). State-eligibility (draft/revision_requested etc.) is
 *                the owning feature's rule, layered on top by its task.
 *   CASEWORKER — current ACTIVE assignment REQUIRED (S-3). Queue visibility never
 *                grants write: an unassigned-but-claimable application is readable
 *                (summary) but NOT writable until claimed.
 *   SUPERVISOR — allowed (S-4) — except borrower-only lifecycle actions, which use
 *                requireBorrowerOwnedAction below (INV-027 precedence over S-4).
 */
export async function canWriteApplication(
  user: SessionUser,
  applicationId: string,
): Promise<ApplicationWriteAccess> {
  const application = await loadScopedApplication(applicationId);
  if (!application) return { allowed: false, reason: "not-found" };

  switch (user.role) {
    case "BORROWER":
      return application.borrowerUserId === user.userId
        ? { allowed: true, application }
        : { allowed: false, reason: "not-owner" };
    case "CASEWORKER":
      return application.activeAssignmentCaseworkerId === user.userId
        ? { allowed: true, application }
        : { allowed: false, reason: "not-assigned" };
    case "SUPERVISOR":
      return { allowed: true, application };
  }
}

export type BorrowerActionAccess =
  | { allowed: true; application: ScopedApplication }
  | { allowed: false; reason: "not-found" | "not-owner" | "staff-forbidden" };

/**
 * INV-027 (§3.3 matrix precedence over S-4): sign, submit, resubmit, withdraw,
 * decline, delete-draft, add/remove co-borrower, and bank-link actions belong to the
 * OWNING BORROWER ONLY — staff, INCLUDING Supervisors, are always rejected.
 * Consumers: task-011/012/014/019 route handlers for those endpoints.
 */
export async function requireBorrowerOwnedAction(
  user: SessionUser,
  applicationId: string,
): Promise<BorrowerActionAccess> {
  const application = await loadScopedApplication(applicationId);
  if (!application) return { allowed: false, reason: "not-found" };
  if (user.role !== "BORROWER") return { allowed: false, reason: "staff-forbidden" };
  if (application.borrowerUserId !== user.userId) return { allowed: false, reason: "not-owner" };
  return { allowed: true, application };
}

/**
 * Live active-assignment lookup (endedAt IS NULL — INV-015 guarantees at most one).
 * Used by queue/claim/assignment features and anywhere the current holder matters.
 */
export async function getActiveAssignment(
  applicationId: string,
): Promise<{ id: string; caseworkerUserId: string; assignedAt: Date } | null> {
  return prisma.caseworkerAssignment.findFirst({
    where: { applicationId, endedAt: null },
    select: { id: true, caseworkerUserId: true, assignedAt: true },
  });
}

/**
 * Prisma WHERE fragment scoping an application-list query to what `user` may see at
 * FULL detail (S-1/S-2a/S-4). Use for list endpoints returning application detail
 * rows; the unassigned-queue endpoint composes its own claimable filter and must
 * serialize summary fields only (S-2b).
 */
export function applicationReadWhere(user: SessionUser): Record<string, unknown> {
  switch (user.role) {
    case "BORROWER":
      return { borrowerUserId: user.userId };
    case "CASEWORKER":
      return { assignments: { some: { caseworkerUserId: user.userId, endedAt: null } } };
    case "SUPERVISOR":
      return {};
  }
}
