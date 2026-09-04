// Notes service (task-030) — REQ-051 §4.4.5, S-7, VR-093/094, INV-021/024/036.
//
// The three note types (contracts.json enums.NoteType, verbatim):
//   internal — staff-only; immutable; audited (actionType "note").
//   formal   — staff + owning Borrower; attached to a decision/revision
//              transition; immutable; audited; delivered as an in-app Borrower
//              notification (§4.4.5 "delivered as a Borrower notification").
//   chatter  — staff-only chronological message list; immutable/undeletable;
//              each message audited (actionType "chatter"); posting notifies
//              the OTHER staff participants in-app.
//
// IMMUTABILITY: this module exposes create + list ONLY. No update or delete
// code path exists anywhere for ApplicationNote (schema comment mirrors the
// audit-log posture) — the sole exception is seed-flagged demo-data removal.
//
// S-7 (server-enforced): borrowers receive ONLY formal notes — the type filter
// is part of the SQL WHERE clause, never post-filtering, so internal/chatter
// content can never transit a borrower-facing response. Staff record-level
// scoping: assigned caseworker or any supervisor (S-2a/S-3/S-4 via the shared
// guard helpers); an unassigned caseworker's S-2b summary access does NOT
// include notes.
//
// VR-094: the per-type length limit is a LIVE SystemConfig read
// (notes.maxLength for internal/formal, chatter.maxLength for chatter) —
// flipping the setting changes the enforced limit on the next request.
// Content is stored verbatim and rendered exclusively through React text
// nodes (auto-escaped), satisfying "sanitized before render" (SEC-18).
//
// Documented interpretations (contract-silent points):
//   - POST returns 409 while the application is in `draft`: the staff notes
//     surface begins at submission (a draft has no staff pipeline presence).
//   - Formal notes posted through this endpoint attach to the LATEST
//     decision/revision WorkflowHistory row of the same application when one
//     exists (INV-021 same-application reference), else relatedTransitionId
//     stays null. (Workflow-created formal notes attach exactly in
//     workflow-engine.ts.)
//   - "Other staff participants" for chatter notification = the distinct
//     authors of prior chatter on the application PLUS the currently assigned
//     caseworker, minus the poster, active accounts only.
//   - List order is chronological (createdAt ASC) — §4.4.5 fixes chatter as
//     chronological; one ordering serves the whole endpoint and the `?since=`
//     incremental poll.

import type { NoteType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { canReadApplication, canWriteApplication } from "@/lib/guard";
import { ERROR_CODES, HttpProblem } from "@/lib/http/errors";
import type { RequestMetaBundle } from "@/lib/http/client-ip";
import { pageEnvelope, type PageEnvelope, type Pagination } from "@/lib/http/pagination";
import { audit } from "@/lib/services/audit";
import { createNotification, staffAttribution } from "@/lib/services/notifications";
import { getNumberSetting } from "@/lib/services/config";
import type { NoteRequest } from "@/lib/schemas/notes";

// ---------------------------------------------------------------------------
// Wire shape (contracts.md §A ApplicationNote — exact field names)
// ---------------------------------------------------------------------------

export interface ApplicationNoteWire {
  id: string;
  applicationId: string;
  /** Display name + role only — never email/userId on borrower surfaces (S-6). */
  authorDisplayName: string;
  authorRole: string;
  type: NoteType;
  content: string;
  relatedTransitionId?: string;
  createdAt: string;
}

type NoteRow = {
  id: string;
  applicationId: string;
  type: NoteType;
  content: string;
  relatedTransitionId: string | null;
  createdAt: Date;
  authorUser: { firstName: string; lastName: string; role: string };
};

const NOTE_AUTHOR_SELECT = {
  id: true,
  applicationId: true,
  type: true,
  content: true,
  relatedTransitionId: true,
  createdAt: true,
  authorUser: { select: { firstName: true, lastName: true, role: true } },
} satisfies Prisma.ApplicationNoteSelect;

function toNoteWire(row: NoteRow): ApplicationNoteWire {
  const wire: ApplicationNoteWire = {
    id: row.id,
    applicationId: row.applicationId,
    authorDisplayName: `${row.authorUser.firstName} ${row.authorUser.lastName}`.trim(),
    authorRole: row.authorUser.role,
    type: row.type,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.relatedTransitionId !== null) wire.relatedTransitionId = row.relatedTransitionId;
  return wire;
}

// ---------------------------------------------------------------------------
// GET — NotePage (S-7 borrower filter in the WHERE clause; ?since= poll)
// ---------------------------------------------------------------------------

export async function listNotes(
  user: SessionUser,
  applicationId: string,
  pagination: Pagination,
  since?: Date,
): Promise<PageEnvelope<ApplicationNoteWire>> {
  const access = await canReadApplication(user, applicationId);
  if (!access.allowed) {
    // Borrower non-owner → 404 (no existence disclosure, getApplicationWire
    // precedent); caseworker not assigned → 403.
    if (access.reason === "not-assigned") {
      throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
    }
    throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  }
  if (access.level !== "full") {
    // S-2b summary-level claimable access covers QueueRow fields only.
    throw new HttpProblem(403, ERROR_CODES.forbidden, "Claim this application to view its notes");
  }

  const where: Prisma.ApplicationNoteWhereInput = {
    applicationId,
    // S-7: formal-only for borrowers, enforced IN the query.
    ...(user.role === "BORROWER" ? { type: "formal" as const } : {}),
    ...(since !== undefined ? { createdAt: { gt: since } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.applicationNote.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: pagination.skip,
      take: pagination.take,
      select: NOTE_AUTHOR_SELECT,
    }),
    prisma.applicationNote.count({ where }),
  ]);

  return pageEnvelope(rows.map(toNoteWire), pagination, total);
}

// ---------------------------------------------------------------------------
// POST — create (staff only; immutable once written; audited in-tx)
// ---------------------------------------------------------------------------

/** toStates a POSTed formal note may attach to (§4.4.5 "decision or revision"). */
const FORMAL_ATTACH_TO_STATES = [
  "revision_requested",
  "conditional_approval",
  "approved",
  "denied",
  "borrower_notified",
] as const;

const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  internal: "Internal note",
  formal: "Formal note",
  chatter: "Chatter message",
};

export async function createNote(
  user: SessionUser,
  applicationId: string,
  input: NoteRequest,
  meta: RequestMetaBundle,
): Promise<ApplicationNoteWire> {
  const access = await canWriteApplication(user, applicationId);
  if (!access.allowed) {
    if (access.reason === "not-assigned") {
      throw new HttpProblem(403, ERROR_CODES.forbidden, "You are not assigned to this application");
    }
    throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");
  }
  if (access.application.workflowState === "draft") {
    throw new HttpProblem(
      409,
      ERROR_CODES.conflict,
      "Notes cannot be added while the application is still a draft",
    );
  }

  // VR-094: LIVE configured limit by type (INV-024).
  const limitKey = input.type === "chatter" ? "chatter.maxLength" : "notes.maxLength";
  const limit = await getNumberSetting(limitKey);
  const content = input.content.trim();
  if (content.length > limit) {
    throw new HttpProblem(400, ERROR_CODES.validationError, "Request validation failed", {
      details: [
        `content exceeds the configured ${limit.toLocaleString("en-US")}-character limit for ${input.type} notes`,
      ],
    });
  }

  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { applicationNumber: true, borrowerUserId: true },
  });
  if (!app) throw new HttpProblem(404, ERROR_CODES.notFound, "Application not found");

  const created = await prisma.$transaction(async (tx) => {
    // Formal notes attach to the latest decision/revision transition when one
    // exists (INV-021: same application by construction of this query).
    let relatedTransitionId: string | null = null;
    if (input.type === "formal") {
      const transition = await tx.workflowHistory.findFirst({
        where: { applicationId, toState: { in: [...FORMAL_ATTACH_TO_STATES] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      relatedTransitionId = transition?.id ?? null;
    }

    const note = await tx.applicationNote.create({
      data: {
        applicationId,
        authorUserId: user.userId, // session identity only — never from the body
        type: input.type,
        content,
        relatedTransitionId,
      },
      select: NOTE_AUTHOR_SELECT,
    });

    // SEC-8: every note audited; chatter messages each ARE an audit record.
    await audit(tx, {
      actor: user.userId,
      role: user.role,
      actionType: input.type === "chatter" ? "chatter" : "note",
      applicationId,
      entityType: "ApplicationNote",
      entityId: note.id,
      summary: `${NOTE_TYPE_LABEL[input.type]} added to application ${app.applicationNumber}`,
      ip: meta.ip,
      requestId: meta.requestId,
    });

    const authorName = `${user.firstName} ${user.lastName}`.trim();
    const preview = content.length > 180 ? `${content.slice(0, 177)}…` : content;

    if (input.type === "formal") {
      // §4.4.5: formal notes are delivered as a Borrower notification via THE
      // notification service (task-036, §4.8.1). Author shown as display name
      // + role only (S-6 — staffAttribution is the central formatter; the
      // service also scrubs the actor's email/user id from borrower content).
      const staffActor = {
        userId: user.userId,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      };
      await createNotification(tx, {
        recipientUserId: app.borrowerUserId,
        type: "formal-note",
        title: "New message from your loan team",
        body: `${staffAttribution(staffActor)}: ${preview}`,
        applicationId,
        staffActor,
      });
    }

    if (input.type === "chatter") {
      // §4.4.5: in-app notification to the OTHER staff participants — prior
      // chatter authors plus the assigned caseworker, minus the poster.
      const priorAuthors = await tx.applicationNote.findMany({
        where: { applicationId, type: "chatter", id: { not: note.id } },
        select: { authorUserId: true },
        distinct: ["authorUserId"],
      });
      const candidateIds = new Set(priorAuthors.map((r) => r.authorUserId));
      if (access.application.activeAssignmentCaseworkerId) {
        candidateIds.add(access.application.activeAssignmentCaseworkerId);
      }
      candidateIds.delete(user.userId);
      if (candidateIds.size > 0) {
        const recipients = await tx.user.findMany({
          where: { id: { in: [...candidateIds] }, status: "active" },
          select: { id: true },
        });
        for (const recipient of recipients) {
          await createNotification(tx, {
            recipientUserId: recipient.id,
            type: "chatter",
            title: `New chatter on ${app.applicationNumber}`,
            body: `${authorName}: ${preview}`,
            applicationId,
          });
        }
      }
    }

    return note;
  });

  return toNoteWire(created);
}
