// StaffAccountRow serialization (contracts §A — exact field names) + the
// task-033 staff-management operations (REQ-063, FLOW-011). The serializer was
// introduced by task-007 for POST /api/admin/staff/:id/reset-mfa; task-033 adds
// the list, invitation, accept-invitation, deactivate, and reactivate paths on
// the SAME serializer.
//
// LIVE-STATE: every field is derived from current DB rows at call time — counts
// are real queries, mfaStatus is derived from the MfaEnrollment rows, nothing is
// a hardcoded default.
//
// Invariants owned here:
//   INV-002 — self-deactivation rejected (service-layer guard).
//   INV-005 — the active-Supervisor count never reaches zero: the deactivate
//     transaction takes FOR UPDATE row locks on every active Supervisor row,
//     re-counts under the locks, and flips status with a conditional updateMany
//     — safe under concurrent attempts (two racing deactivations serialize on
//     the row locks; the loser re-evaluates and sees the reduced count).
//   INV-004 — no role-change or hard-delete operation exists in this module
//     (or anywhere): accounts are only ever flipped active/inactive.
//   INV-010 — invitation tokens are single-use hashed rows (tokens.ts).
//   XBR-015 — deactivation revokes sessions, closes active assignments through
//     the assignment.ts close path, and notifies all Supervisors, atomically.
//   AUDIT — every management action audits in-transaction via audit.ts with the
//     actor taken from the authenticated session only.

import { Prisma, type MfaStatus, type UserRole, type UserStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/services/audit";
import { notifyActiveSupervisors } from "@/lib/services/notifications";
import { hashPassword } from "@/lib/services/password-hash";
import { validatePasswordPolicy } from "@/lib/services/password-policy";
import { consumeToken, issueToken, peekToken, sha256Hex, TOKEN_TTL_MINUTES } from "@/lib/services/tokens";
import { appBaseUrl, recordOutboundEmail } from "@/lib/services/outbound";
import { revokeOtherSessions } from "@/lib/services/session";
import { closeAssignmentsForDeactivatedCaseworker } from "@/lib/services/assignment";
import type { RequestMeta } from "@/lib/services/auth-account";

/** Wire shape per contracts.json models.StaffAccountRow — exact field names. */
export interface StaffAccountRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** contracts.json enums.StaffRole: CASEWORKER | SUPERVISOR (verbatim). */
  role: "CASEWORKER" | "SUPERVISOR";
  /** contracts.json enums.UserStatus: active | inactive. */
  status: UserStatus;
  /** contracts.json enums.MfaStatus: enrolled | pending | reset. */
  mfaStatus: MfaStatus;
  activeAssignments: number;
  completedThisMonth: number;
  lastSignInAt?: string;
}

/**
 * Derive the row-level MfaStatus from the user's enrollment rows:
 * an active secret wins; else an issued-but-unverified secret; else the user
 * must (re)enroll at next sign-in — the "reset" bucket, which also covers
 * never-enrolled staff (their next sign-in routes to enrollment exactly like a
 * reset account's).
 */
export function deriveMfaStatus(enrollments: ReadonlyArray<{ status: MfaStatus }>): MfaStatus {
  if (enrollments.some((e) => e.status === "enrolled")) return "enrolled";
  if (enrollments.some((e) => e.status === "pending")) return "pending";
  return "reset";
}

/**
 * Load one staff account as a StaffAccountRow. Returns null when the user does
 * not exist or is not staff (borrowers are never served on /api/admin/staff).
 *
 * completedThisMonth: applications DECIDED (decidedAt) in the current UTC month
 * on which this caseworker held an assignment — the live proxy for "completions"
 * until task-033 lands the full stats definition alongside /api/caseworker/stats.
 */
export async function loadStaffAccountRow(userId: string): Promise<StaffAccountRow | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { mfaEnrollments: { select: { status: true } } },
  });
  if (!user || user.role === "BORROWER") return null;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [activeAssignments, completedThisMonth] = await Promise.all([
    prisma.caseworkerAssignment.count({
      where: { caseworkerUserId: user.id, endedAt: null },
    }),
    prisma.application.count({
      where: {
        decidedAt: { gte: monthStart },
        assignments: { some: { caseworkerUserId: user.id } },
      },
    }),
  ]);

  const row: StaffAccountRow = {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role as "CASEWORKER" | "SUPERVISOR",
    status: user.status,
    mfaStatus: deriveMfaStatus(user.mfaEnrollments),
    activeAssignments,
    completedThisMonth,
  };
  if (user.lastSignInAt !== null) row.lastSignInAt = user.lastSignInAt.toISOString();
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/admin/staff — staff list (contracts §B: none, max 50)
// ---------------------------------------------------------------------------

/** contracts.json models.StaffListResponse — exact field name. */
export interface StaffListResponse {
  rows: StaffAccountRow[];
}

/** §B "none (max 50)" — hard cap, no pagination parameters. */
export const STAFF_LIST_MAX_ROWS = 50;

/**
 * All Caseworker and Supervisor accounts (borrowers never appear) as
 * StaffAccountRows, capped at 50. Stats use the EXACT definitions of
 * loadStaffAccountRow, batched:
 *   activeAssignments  — CaseworkerAssignment rows with endedAt null;
 *   completedThisMonth — applications DECIDED (decidedAt) in the current UTC
 *     month on which the user held an assignment (each application counted
 *     once per user);
 *   lastSignInAt       — User.lastSignInAt verbatim (absent when never).
 * Sort: lastName, firstName, email ascending (contract states no order — the
 * stable roster order for the management table).
 */
export async function listStaffAccountRows(): Promise<StaffListResponse> {
  const users = await prisma.user.findMany({
    where: { role: { in: ["CASEWORKER", "SUPERVISOR"] } },
    include: { mfaEnrollments: { select: { status: true } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { email: "asc" }],
    take: STAFF_LIST_MAX_ROWS,
  });
  const ids = users.map((u) => u.id);

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [activeGroups, decidedRows] = await Promise.all([
    prisma.caseworkerAssignment.groupBy({
      by: ["caseworkerUserId"],
      where: { caseworkerUserId: { in: ids }, endedAt: null },
      _count: { _all: true },
    }),
    prisma.caseworkerAssignment.findMany({
      where: {
        caseworkerUserId: { in: ids },
        application: { decidedAt: { gte: monthStart } },
      },
      select: { caseworkerUserId: true, applicationId: true },
    }),
  ]);

  const activeCounts = new Map(activeGroups.map((g) => [g.caseworkerUserId, g._count._all]));
  const completed = new Map<string, Set<string>>();
  for (const row of decidedRows) {
    let set = completed.get(row.caseworkerUserId);
    if (!set) {
      set = new Set();
      completed.set(row.caseworkerUserId, set);
    }
    set.add(row.applicationId);
  }

  const rows = users.map((user) => {
    const row: StaffAccountRow = {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role as "CASEWORKER" | "SUPERVISOR",
      status: user.status,
      mfaStatus: deriveMfaStatus(user.mfaEnrollments),
      activeAssignments: activeCounts.get(user.id) ?? 0,
      completedThisMonth: completed.get(user.id)?.size ?? 0,
    };
    if (user.lastSignInAt !== null) row.lastSignInAt = user.lastSignInAt.toISOString();
    return row;
  });
  return { rows };
}

// ---------------------------------------------------------------------------
// Shared actor view (identity ALWAYS from the authenticated session — guard ctx)
// ---------------------------------------------------------------------------

export interface StaffActor {
  userId: string;
  role: UserRole;
}

// ---------------------------------------------------------------------------
// POST /api/admin/staff — invitation (REQ-063, AC-41, NFR-011/SEC-10)
// ---------------------------------------------------------------------------

export type InviteStaffResult =
  | { ok: true; userId: string }
  | { ok: false; kind: "duplicate-email" };

/**
 * Create a staff account and send (simulate) the invitation email carrying the
 * set-password link. The account is `active` with a random, undisclosed
 * password hash — it cannot sign in until accept-invitation sets a real
 * password — and has NO MfaEnrollment rows, so its first sign-in routes to MFA
 * enrollment (mfa-enrollment-required), satisfying "enrolls MFA at first
 * sign-in". Only the SHA-256 hash of the invite token is stored (SEC-10); the
 * raw token exists exactly once, inside the OutboundMessage body link.
 */
export async function inviteStaff(
  actor: StaffActor,
  input: { firstName: string; lastName: string; email: string; role: "CASEWORKER" | "SUPERVISOR" },
  meta: RequestMeta,
): Promise<InviteStaffResult> {
  const email = input.email.trim();
  // Random unusable credential — replaced by the invitee via accept-invitation.
  const placeholderHash = await hashPassword(randomBytes(32).toString("base64url"));

  try {
    const userId = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash: placeholderHash,
          role: input.role,
          firstName: input.firstName,
          lastName: input.lastName,
        },
      });

      const { raw } = await issueToken(tx, user.id, "invite");
      const days = Math.round(TOKEN_TTL_MINUTES.invite / (24 * 60));
      await recordOutboundEmail(tx, {
        recipient: email,
        subject: "You are invited to join MortMortgage",
        body:
          `Hello ${input.firstName},\n\n` +
          `A supervisor created a ${input.role === "SUPERVISOR" ? "Supervisor" : "Caseworker"} account ` +
          `for you on MortMortgage.\n\n` +
          `Set your password within ${days} days using this single-use link:\n` +
          `${appBaseUrl()}/accept-invitation?token=${raw}\n\n` +
          `After setting your password, sign in — you will enroll multi-factor ` +
          `authentication on your first sign-in.\n\n` +
          `If you were not expecting this invitation, you can ignore this message.`,
      });

      await audit(tx, {
        actor: actor.userId, // session identity — never the request body
        role: actor.role,
        actionType: "staff-management",
        entityType: "User",
        entityId: user.id,
        summary: `Staff account invited: ${email} (${input.role}) — set-password invitation sent`,
        after: { role: input.role, status: "active", email },
        ip: meta.ip,
        requestId: meta.requestId,
      });

      return user.id;
    });
    return { ok: true, userId };
  } catch (error) {
    // INV-013 unique lower(email). Supervisor-facing endpoint — existence
    // disclosure is fine here (unlike public register's uniform Ack).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, kind: "duplicate-email" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/accept-invitation (public; REQ-063, INV-010, VR-022/VR-023)
// ---------------------------------------------------------------------------

export type AcceptInvitationResult =
  | { ok: true }
  | { ok: false; kind: "invalid-token" }
  | { ok: false; kind: "policy"; details: string[] };

/**
 * Set the invited account's password from the hashed single-use invitation
 * token. Mirrors resetPassword's structure: policy pre-check on a non-consuming
 * peek (a policy failure must not burn the token), then the atomic consume
 * (INV-010) + password write + audit in one transaction. Consuming the emailed
 * link also proves control of the address, so emailVerifiedAt is set — first
 * sign-in then routes straight to MFA enrollment (REQ-063).
 */
export async function acceptInvitation(
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<AcceptInvitationResult> {
  const peeked = await peekToken(prisma, input.token, "invite");
  if (!peeked) return { ok: false, kind: "invalid-token" };

  const details = await validatePasswordPolicy(input.password, {
    field: "password",
    userId: peeked.userId,
  });
  if (details.length > 0) return { ok: false, kind: "policy", details };

  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    // The atomic claim decides the single winner (INV-010) — the peek never does.
    const token = await consumeToken(tx, sha256Hex(input.token), "invite");
    if (!token) return { ok: false, kind: "invalid-token" } as const;

    await tx.user.update({
      where: { id: token.userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        emailVerifiedAt: new Date(), // the emailed link proves address control
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await tx.passwordHistory.create({ data: { userId: token.userId, passwordHash } });

    await audit(tx, {
      actor: null, // public endpoint — the invitee has no session yet
      role: null,
      actionType: "invitation-accepted",
      entityType: "User",
      entityId: token.userId,
      summary: "Staff invitation accepted — password set via single-use invitation token",
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/staff/:id/deactivate (XBR-015, INV-002, INV-005, INV-006)
// ---------------------------------------------------------------------------

export type DeactivateStaffResult =
  | { ok: true }
  | {
      ok: false;
      kind: "not-found" | "self" | "already-inactive" | "last-supervisor";
    };

export async function deactivateStaff(
  actor: StaffActor,
  targetUserId: string,
  meta: RequestMeta,
): Promise<DeactivateStaffResult> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true, status: true, email: true, firstName: true, lastName: true },
  });
  // The /api/admin/staff surface addresses STAFF accounts only.
  if (!target || target.role === "BORROWER") return { ok: false, kind: "not-found" };

  // INV-002: never on self (would revoke the actor's own sessions mid-operation
  // and interact with INV-005 supervisor lockout).
  if (target.id === actor.userId) return { ok: false, kind: "self" };

  if (target.status !== "active") return { ok: false, kind: "already-inactive" };

  return prisma.$transaction(async (tx) => {
    if (target.role === "SUPERVISOR") {
      // INV-005 (transactional-check): lock EVERY active Supervisor row. Two
      // concurrent deactivations serialize on these locks; when the loser
      // resumes, rows flipped by the winner no longer satisfy status='active'
      // and are excluded (Postgres READ COMMITTED re-evaluation), so the
      // re-count below is race-safe. The LOCK SET stays the full active set
      // (a superset of the counted set) — narrowing it would let a row outside
      // the lock flip underneath a concurrent transaction.
      const activeSupervisors = await tx.$queryRaw<
        Array<{ id: string; signInCapable: boolean; isDemo: boolean }>
      >`
        SELECT "id",
               ("lastSignInAt" IS NOT NULL) AS "signInCapable",
               "isDemo"
        FROM "User"
        WHERE "role" = 'SUPERVISOR' AND "status" = 'active'
        FOR UPDATE`;

      // Target liveness is re-checked SEPARATELY from the floor count: a target
      // that is active-but-not-sign-in-capable is absent from the counted set
      // yet is still a perfectly legitimate deactivation.
      const targetRow = activeSupervisors.find((row) => row.id === target.id);
      if (!targetRow) {
        return { ok: false, kind: "already-inactive" } as const;
      }

      // INV-005 (amended): the floor counts SIGN-IN-CAPABLE supervisors only.
      // An invited-but-never-accepted account holds a random unusable
      // passwordHash (inviteStaff above) and cannot rescue the system, so
      // lastSignInAt IS NULL disqualifies it. A demo-provisioned account holds
      // no usable password either — but ONLY when DEMO_MODE is off, because
      // with demo mode on POST /api/auth/demo-login genuinely signs it in.
      const demoCountsAsCapable = process.env.DEMO_MODE === "true";
      const capable = activeSupervisors.filter(
        (row) => row.signInCapable && (demoCountsAsCapable || !row.isDemo),
      );

      // Already at (or below) the floor: no further supervisor deactivation.
      if (capable.length === 0) {
        return { ok: false, kind: "last-supervisor" } as const;
      }
      // Deactivating a counted supervisor must never take the count to zero.
      if (capable.some((row) => row.id === target.id) && capable.length <= 1) {
        return { ok: false, kind: "last-supervisor" } as const;
      }
    }

    // Conditional flip — status='active' guard makes a lost race surface as 409.
    const flipped = await tx.user.updateMany({
      where: { id: target.id, status: "active" },
      data: { status: "inactive" },
    });
    if (flipped.count === 0) return { ok: false, kind: "already-inactive" } as const;

    // XBR-015: blocks sign-in (status; sign-in and session resolution both
    // check it), revokes EVERY session server-side, closes active assignments
    // through the assignment close path (applications return to Unassigned;
    // workflow state never changes), and notifies all Supervisors.
    const revokedSessions = await revokeOtherSessions(tx, target.id, null);
    const closed = await closeAssignmentsForDeactivatedCaseworker(tx, target.id);

    // Notify ALL Supervisors (every remaining active Supervisor, including the
    // actor; the target is inactive as of this transaction) — via THE
    // notification service (task-036, §4.8.1 single-service mandate).
    const targetName = `${target.firstName} ${target.lastName}`;
    const appList = closed.map((c) => c.applicationNumber).join(", ");
    const body =
      closed.length > 0
        ? `${targetName} (${target.email}) was deactivated. ${closed.length} active ` +
          `assignment${closed.length === 1 ? "" : "s"} ${closed.length === 1 ? "was" : "were"} closed and ` +
          `returned to the Unassigned queue: ${appList}.`
        : `${targetName} (${target.email}) was deactivated. They held no active assignments.`;
    await notifyActiveSupervisors(tx, {
      type: "staff-deactivated",
      title: "Staff account deactivated",
      body,
    });

    await audit(tx, {
      actor: actor.userId, // session identity — never the request body
      role: actor.role,
      actionType: "staff-management",
      entityType: "User",
      entityId: target.id,
      summary:
        `Staff account deactivated: ${target.email} — sessions revoked (${revokedSessions}), ` +
        `${closed.length} active assignment(s) returned to Unassigned, all Supervisors notified`,
      before: { status: "active" },
      after: {
        status: "inactive",
        revokedSessions,
        closedAssignmentApplicationIds: closed.map((c) => c.applicationId),
      },
      ip: meta.ip,
      requestId: meta.requestId,
    });

    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/staff/:id/reactivate
// ---------------------------------------------------------------------------

export type ReactivateStaffResult =
  | { ok: true }
  | { ok: false; kind: "not-found" | "already-active" };

/**
 * Flip an inactive staff account back to active. Credentials, MFA posture, and
 * (closed) assignments are untouched — the account simply signs in again; no
 * assignment is recreated (a Supervisor reassigns work explicitly).
 */
export async function reactivateStaff(
  actor: StaffActor,
  targetUserId: string,
  meta: RequestMeta,
): Promise<ReactivateStaffResult> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true, email: true },
  });
  if (!target || target.role === "BORROWER") return { ok: false, kind: "not-found" };

  return prisma.$transaction(async (tx) => {
    const flipped = await tx.user.updateMany({
      where: { id: target.id, status: "inactive" },
      data: { status: "active" },
    });
    if (flipped.count === 0) return { ok: false, kind: "already-active" } as const;

    await audit(tx, {
      actor: actor.userId,
      role: actor.role,
      actionType: "staff-management",
      entityType: "User",
      entityId: target.id,
      summary: `Staff account reactivated: ${target.email} — sign-in re-enabled`,
      before: { status: "inactive" },
      after: { status: "active" },
      ip: meta.ip,
      requestId: meta.requestId,
    });
    return { ok: true } as const;
  });
}
