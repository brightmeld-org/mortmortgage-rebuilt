"use client";

// NotesAndVersionsPanel (task-030 — contracts §C; REQ-051/REQ-052/REQ-008,
// §4.4.5/§4.4.6, S-7, VR-093/094).
//
// Navigation path: staff queue / all-applications row click →
// /staff/applications/:id (StaffApplicationDetailClient) → Notes tab
// (notes-panel-mount) and Versions tab (versions-panel-mount); the chatter
// stream additionally renders as the persistent right-rail card the frame
// shows on screen-detail.png (ChatterRailCard below the Assignment card —
// hidden while the Notes tab is active so the §C chatter selectors stay
// unique in the DOM).
//
// Notes view — the three §4.4.5 streams with their verbatim rules:
//   Internal — staff only; immutable; composer.
//   Formal   — staff + borrower; attached to a decision/revision transition;
//              immutable; delivered to the borrower as a notification.
//   Chatter  — staff only; chronological; immutable/undeletable; refreshes by
//              POLLING every 15 s while mounted (?since= incremental — real-
//              time push is intentionally not used); posting notifies the
//              other staff participants in-app (server-side).
// There are no edit or delete affordances ANYWHERE — immutability is a §4.4.5
// rule, mirrored by the API surface (no mutation endpoints exist).
//
// Length limits are enforced SERVER-side at the live SystemConfig values
// (VR-094: internal/formal default 4,000 chars, chatter 1,000). The composer
// shows a live character count and surfaces the server's validation error
// VERBATIM (NFR-025) — it does not hard-cap client-side because the
// configured limit is not readable by caseworkers.
//
// Versions view — the SAME shared VersionsCard the owning Borrower sees
// (§4.4.6 "The Borrower sees the same version list and diff"): list with
// number / timestamp / reason / current marker, two-version field-level diff
// grouped by URLA section, computed server-side.
//
// Selector contract (§C NotesAndVersionsPanel): note-type-{type}, note-input,
// note-submit, note-item-{id}, chatter-list, chatter-input, chatter-send.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDate, humanizeEnum } from "@/components/borrower/format";
import type { ApplicationNote, NotePage, VersionPage } from "@/components/borrower/types";
import {
  ApiErrorBanner,
  Badge,
  Card,
  CardHeading,
  SkeletonBlock,
  btnPrimary,
} from "@/components/borrower/ui";
import { VersionsCard } from "@/components/borrower/VersionsCard";
import { getJson, postWithCsrf, type ErrorResponseBody } from "@/components/staff/detail/api";

type NoteType = "internal" | "formal" | "chatter";

const POLL_INTERVAL_MS = 15_000; // §4.4.5: refresh by polling every 15 s

// ---------------------------------------------------------------------------
// Shared notes store: full load + 15 s ?since= incremental poll
// ---------------------------------------------------------------------------

function mergeNotes(current: ApplicationNote[], incoming: ApplicationNote[]): ApplicationNote[] {
  const byId = new Map(current.map((note) => [note.id, note]));
  for (const note of incoming) byId.set(note.id, note);
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function useApplicationNotes(applicationId: string) {
  const [notes, setNotes] = useState<ApplicationNote[] | null>(null);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);
  // Newest createdAt seen — the ?since= cursor for the chatter poll.
  const latestRef = useRef<string | null>(null);

  const absorb = useCallback((incoming: ApplicationNote[]) => {
    setNotes((current) => {
      const merged = mergeNotes(current ?? [], incoming);
      latestRef.current = merged.length > 0 ? merged[merged.length - 1].createdAt : null;
      return merged;
    });
  }, []);

  const loadAll = useCallback(async () => {
    const first = await getJson<NotePage>(`/api/applications/${applicationId}/notes?page=1&pageSize=100`);
    if (!first.ok) {
      setLoadError(first.error);
      return;
    }
    setLoadError(null);
    let rows = first.data.rows;
    if (first.data.total > rows.length) {
      // Chronological ASC — the newest window is the LAST page.
      const lastPage = Math.ceil(first.data.total / first.data.pageSize);
      const tail = await getJson<NotePage>(
        `/api/applications/${applicationId}/notes?page=${lastPage}&pageSize=100`,
      );
      if (tail.ok) rows = [...rows, ...tail.data.rows];
    }
    absorb(rows);
  }, [applicationId, absorb]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // §4.4.5: poll every 15 s while the surface is open (?since= incremental).
  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        const since = latestRef.current;
        if (since === null) {
          await loadAll();
          return;
        }
        const result = await getJson<NotePage>(
          `/api/applications/${applicationId}/notes?since=${encodeURIComponent(since)}&page=1&pageSize=100`,
        );
        if (result.ok && result.data.rows.length > 0) absorb(result.data.rows);
      })();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [applicationId, loadAll, absorb]);

  return { notes, loadError, absorb };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const VISIBILITY_LABEL: Record<NoteType, string> = {
  internal: "Staff only",
  formal: "Staff + borrower",
  chatter: "Staff only",
};

const VISIBILITY_TONE: Record<NoteType, "gray" | "info"> = {
  internal: "gray",
  formal: "info",
  chatter: "gray",
};

function authorLine(note: ApplicationNote): string {
  return `${note.authorDisplayName} · ${humanizeEnum(note.authorRole.toLowerCase())}`;
}

function NoteItem({ note }: { note: ApplicationNote }) {
  return (
    <li
      data-testid={`note-item-${note.id}`}
      className="rounded-md border border-line bg-paper px-4 py-3"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
        {authorLine(note)}
        <span className="font-normal text-muted">{formatDate(note.createdAt)}</span>
        <Badge tone={VISIBILITY_TONE[note.type as NoteType]}>{VISIBILITY_LABEL[note.type as NoteType]}</Badge>
        {note.type === "formal" && note.relatedTransitionId ? (
          <Badge tone="info">Attached to decision/revision</Badge>
        ) : null}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{note.content}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Chatter stream (used by the Notes tab; the rail card wraps it)
// ---------------------------------------------------------------------------

function ChatterStream({
  applicationId,
  notes,
  onPosted,
  compact,
}: {
  applicationId: string;
  notes: ApplicationNote[] | null;
  onPosted: (note: ApplicationNote) => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorResponseBody | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);

  const chatter = (notes ?? []).filter((note) => note.type === "chatter");

  // Keep the newest message in view as the poll appends (chronological list).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatter.length]);

  async function send() {
    const content = draft.trim();
    if (content.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const result = await postWithCsrf<ApplicationNote>(`/api/applications/${applicationId}/notes`, {
      type: "chatter",
      content,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraft("");
    onPosted(result.data);
  }

  return (
    <div>
      {notes === null ? (
        <SkeletonBlock className="h-24 w-full" />
      ) : chatter.length === 0 ? (
        <p className="text-sm text-ink-soft" data-testid="chatter-empty">
          No chatter yet — start the conversation.
        </p>
      ) : null}
      <ol
        ref={listRef}
        data-testid="chatter-list"
        aria-label="Chatter messages, oldest first"
        className={`space-y-2 overflow-y-auto pr-1 ${compact ? "max-h-64" : "max-h-96"} ${
          chatter.length > 0 ? "" : "hidden"
        }`}
      >
        {chatter.map((note) => (
          <li key={note.id} data-testid={`note-item-${note.id}`} className="text-sm">
            <span className="font-semibold text-ink">{authorLine(note)}</span>
            <span className="text-muted"> · {formatDate(note.createdAt)}</span>
            <p className="whitespace-pre-wrap text-ink-soft">{note.content}</p>
          </li>
        ))}
      </ol>
      {error ? (
        <div className="mt-2">
          <ApiErrorBanner message={error.message} details={error.details} testId="chatter-error" />
        </div>
      ) : null}
      <div className="mt-3 flex items-end gap-2">
        <textarea
          data-testid="chatter-input"
          aria-label="Write a chatter message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={compact ? 2 : 3}
          placeholder="Write a message…"
          className="min-w-0 flex-1 rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-copper focus:outline-none focus:ring-2 focus:ring-copper/20"
        />
        <button
          type="button"
          data-testid="chatter-send"
          onClick={() => void send()}
          disabled={busy || draft.trim().length === 0}
          className={`${btnPrimary} shrink-0`}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        Staff only · messages are permanent and refresh every 15 seconds · other staff on this
        application are notified.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-rail chatter card (frame: screen-detail.png, below Assignment)
// ---------------------------------------------------------------------------

export function ChatterRailCard({ applicationId }: { applicationId: string }) {
  const { notes, loadError, absorb } = useApplicationNotes(applicationId);
  return (
    <section data-testid="chatter-rail-card" className="rounded-lg border border-line bg-card p-5 shadow-sm">
      <h2 className="text-xs font-bold uppercase tracking-wider text-ink">Chatter (polls every 15 s)</h2>
      <div className="mt-3">
        {loadError ? (
          <ApiErrorBanner message={loadError.message} details={loadError.details} testId="chatter-rail-error" />
        ) : (
          <ChatterStream applicationId={applicationId} notes={notes} onPosted={(note) => absorb([note])} compact />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Notes composer (internal / formal) + streams
// ---------------------------------------------------------------------------

const COMPOSER_TYPES: { type: NoteType; label: string; hint: string }[] = [
  { type: "internal", label: "Internal", hint: "Staff only · limit 4,000 chars (configured)" },
  {
    type: "formal",
    label: "Formal",
    hint: "Visible to the borrower and delivered as a notification · attaches to the latest decision/revision · limit 4,000 chars (configured)",
  },
  { type: "chatter", label: "Chatter", hint: "Staff only · chronological · limit 1,000 chars (configured)" },
];

function NotesView({ applicationId }: { applicationId: string }) {
  const { notes, loadError, absorb } = useApplicationNotes(applicationId);
  const [draftType, setDraftType] = useState<NoteType>("internal");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<ErrorResponseBody | null>(null);

  const internal = (notes ?? []).filter((note) => note.type === "internal");
  const formal = (notes ?? []).filter((note) => note.type === "formal");

  async function submit() {
    const content = draft.trim();
    if (content.length === 0 || busy) return;
    setBusy(true);
    setPostError(null);
    const result = await postWithCsrf<ApplicationNote>(`/api/applications/${applicationId}/notes`, {
      type: draftType,
      content,
    });
    setBusy(false);
    if (!result.ok) {
      setPostError(result.error);
      return;
    }
    setDraft("");
    absorb([result.data]);
  }

  const activeHint = COMPOSER_TYPES.find((option) => option.type === draftType)?.hint ?? "";

  if (loadError) {
    return <ApiErrorBanner message={loadError.message} details={loadError.details} testId="notes-load-error" />;
  }

  return (
    <div className="space-y-5">
      {/* ---------------- Composer ---------------- */}
      <Card testId="note-composer">
        <CardHeading>Add a note</CardHeading>
        <div className="mt-3 flex flex-wrap gap-1" role="radiogroup" aria-label="Note type">
          {COMPOSER_TYPES.map((option) => (
            <button
              key={option.type}
              type="button"
              role="radio"
              aria-checked={draftType === option.type}
              data-testid={`note-type-${option.type}`}
              onClick={() => setDraftType(option.type)}
              className={`rounded-full border px-3 py-1 text-sm font-semibold transition-colors duration-200 ${
                draftType === option.type
                  ? "border-copper bg-copper/10 text-copper"
                  : "border-line text-ink-soft hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">{activeHint} · Notes are immutable once posted.</p>
        <textarea
          data-testid="note-input"
          aria-label="Note content"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={4}
          placeholder={draftType === "chatter" ? "Write a message…" : "Write a note…"}
          className="mt-2 w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-copper focus:outline-none focus:ring-2 focus:ring-copper/20"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted" data-testid="note-char-count">
            {draft.trim().length.toLocaleString("en-US")} characters
          </span>
          <button
            type="button"
            data-testid="note-submit"
            onClick={() => void submit()}
            disabled={busy || draft.trim().length === 0}
            className={btnPrimary}
          >
            {busy ? "Posting…" : "Post note"}
          </button>
        </div>
        {postError ? (
          <div className="mt-3">
            <ApiErrorBanner message={postError.message} details={postError.details} testId="note-error" />
          </div>
        ) : null}
      </Card>

      {/* ---------------- Internal stream ---------------- */}
      <Card testId="internal-notes">
        <CardHeading>
          Internal notes <Badge tone="gray">Staff only</Badge>
        </CardHeading>
        {notes === null ? (
          <SkeletonBlock className="mt-3 h-16 w-full" />
        ) : internal.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No internal notes yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {[...internal].reverse().map((note) => (
              <NoteItem key={note.id} note={note} />
            ))}
          </ul>
        )}
      </Card>

      {/* ---------------- Formal stream ---------------- */}
      <Card testId="formal-notes">
        <CardHeading>
          Formal notes <Badge tone="info">Staff + borrower</Badge>
        </CardHeading>
        <p className="mt-1 text-xs text-muted">
          Attached to decisions and revision requests; delivered to the borrower as notifications.
        </p>
        {notes === null ? (
          <SkeletonBlock className="mt-3 h-16 w-full" />
        ) : formal.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No formal notes yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {[...formal].reverse().map((note) => (
              <NoteItem key={note.id} note={note} />
            ))}
          </ul>
        )}
      </Card>

      {/* ---------------- Chatter stream ---------------- */}
      <Card testId="chatter-card">
        <CardHeading>
          Chatter <Badge tone="gray">Staff only</Badge>
        </CardHeading>
        <div className="mt-3">
          <ChatterStream applicationId={applicationId} notes={notes} onPosted={(note) => absorb([note])} />
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Versions view — the SAME shared list + diff the borrower sees (§4.4.6)
// ---------------------------------------------------------------------------

function VersionsView({ applicationId }: { applicationId: string }) {
  const [versions, setVersions] = useState<VersionPage | null>(null);
  const [loadError, setLoadError] = useState<ErrorResponseBody | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<VersionPage>(
        `/api/applications/${applicationId}/versions?page=1&pageSize=100`,
      );
      if (cancelled) return;
      if (result.ok) setVersions(result.data);
      else setLoadError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  if (loadError) {
    return <ApiErrorBanner message={loadError.message} details={loadError.details} testId="versions-load-error" />;
  }
  if (versions === null) return <SkeletonBlock className="h-40 w-full" />;
  return <VersionsCard applicationId={applicationId} versions={versions} />;
}

// ---------------------------------------------------------------------------
// Panel root (contracts §C: props applicationId; parent StaffApplicationDetail)
// ---------------------------------------------------------------------------

export function NotesAndVersionsPanel({
  applicationId,
  view,
}: {
  applicationId: string;
  /** Which detail tab is hosting the panel. */
  view: "notes" | "versions";
}) {
  return view === "notes" ? (
    <NotesView applicationId={applicationId} />
  ) : (
    <VersionsView applicationId={applicationId} />
  );
}
