// UrlaWizard (task-016) — localStorage buffer (REQ-035: "if the page is left,
// [unsaved changes are] persisted from a local buffer on return").
//
// The buffer stores, per application, the DRAFT CONTENT of every section with
// unsaved (dirty) changes. On wizard load the buffered sections are merged over
// the server-derived draft and re-queued for save; the versionStamp is NEVER
// buffered (§A optimistic-concurrency rule: the first write after load sends
// the stamp from the fresh GET).

import type { WizardDraft } from "./payload";
import { parseSectionKey } from "./payload";
import type { BorrowerDraft } from "./payload";

const KEY_PREFIX = "mortmortgage.wizard.buffer.";

interface BufferShape {
  /** Section keys ("<section>:<ordinal|0>") with unsaved changes. */
  dirty: string[];
  /** Draft content snapshot per dirty section key. */
  sections: Record<string, unknown>;
  updatedAt: string;
}

function storageKey(applicationId: string): string {
  return KEY_PREFIX + applicationId;
}

function sectionContent(draft: WizardDraft, key: string): unknown {
  const { section, ordinal } = parseSectionKey(key);
  if (ordinal !== undefined) {
    const b = draft.borrowers[ordinal];
    if (!b) return undefined;
    switch (section) {
      case "identity":
        return b.identity;
      case "address-history":
        return b.addressHistory;
      case "employment-income":
        return b.employmentIncome;
      case "declarations":
        return b.declarations;
      case "demographics":
        return b.demographics;
    }
    return undefined;
  }
  switch (section) {
    case "assets-reo":
      return draft.assetsReo;
    case "liabilities":
      return draft.liabilities;
    case "subject-property":
      return draft.subjectProperty;
    case "loan-details":
      return draft.loanDetails;
  }
  return undefined;
}

/** Persist the dirty sections' draft content. Failures are silently ignored. */
export function writeBuffer(applicationId: string, draft: WizardDraft, dirty: Set<string>): void {
  try {
    if (dirty.size === 0) {
      window.localStorage.removeItem(storageKey(applicationId));
      return;
    }
    const sections: Record<string, unknown> = {};
    for (const key of dirty) {
      const content = sectionContent(draft, key);
      if (content !== undefined) sections[key] = content;
    }
    const shape: BufferShape = {
      dirty: Array.from(dirty),
      sections,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(storageKey(applicationId), JSON.stringify(shape));
  } catch {
    // Storage unavailable (private mode/quota) — auto-save retries still protect data.
  }
}

/** Read the buffer, or null when absent/corrupt. */
export function readBuffer(applicationId: string): BufferShape | null {
  try {
    const raw = window.localStorage.getItem(storageKey(applicationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BufferShape;
    if (!Array.isArray(parsed.dirty) || typeof parsed.sections !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearBuffer(applicationId: string): void {
  try {
    window.localStorage.removeItem(storageKey(applicationId));
  } catch {
    // ignore
  }
}

/**
 * Merge buffered section content over a server-derived draft. Returns the set
 * of section keys restored (to be re-marked dirty and re-queued for save).
 */
export function applyBuffer(draft: WizardDraft, buffer: BufferShape): Set<string> {
  const restored = new Set<string>();
  for (const key of buffer.dirty) {
    const content = buffer.sections[key];
    if (content === undefined) continue;
    const { section, ordinal } = parseSectionKey(key);
    if (ordinal !== undefined) {
      const b = draft.borrowers[ordinal];
      if (!b) continue; // co-borrower removed since the buffer was written
      const target = b as unknown as Record<string, unknown>;
      const field = (
        {
          identity: "identity",
          "address-history": "addressHistory",
          "employment-income": "employmentIncome",
          declarations: "declarations",
          demographics: "demographics",
        } as Record<string, keyof BorrowerDraft>
      )[section];
      if (!field) continue;
      target[field] = content;
    } else {
      const target = draft as unknown as Record<string, unknown>;
      const field = (
        {
          "assets-reo": "assetsReo",
          liabilities: "liabilities",
          "subject-property": "subjectProperty",
          "loan-details": "loanDetails",
        } as Record<string, string>
      )[section];
      if (!field) continue;
      target[field] = content;
    }
    restored.add(key);
  }
  return restored;
}
