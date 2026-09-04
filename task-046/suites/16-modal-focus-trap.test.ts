/**
 * §7.7 — MODAL FOCUS-TRAP COVERAGE GUARD (source scan, no server needed).
 *
 * LENS-014 and LENS-022 were the same failure shape, not two different bugs: a
 * surface declares itself modal to assistive technology (`aria-modal="true"` /
 * `role="dialog"` / `role="alertdialog"`) but does NOT contain focus to itself.
 * WCAG 2.1 AA requires that modal claim to be true for keyboard users:
 *   - 2.4.3 Focus Order      — focus moves INTO the dialog and returns to the invoker.
 *   - 2.1.2 No Keyboard Trap — Tab/Shift+Tab cycle WITHIN the dialog, not to the page.
 *   - 2.1.1 Keyboard         — Escape dismisses it.
 *
 * The app has exactly ONE primitive that makes all three true: `useModalFocus`
 * in src/components/a11y/use-modal-focus.ts (LENS-014). LENS-014 wired four
 * modals to it and missed the rest; LENS-022 found two more still open (the
 * supervisor "Add staff account" modal and the borrower ConfirmDialog) — and
 * fixing just those two would leave the NEXT un-trapped modal just as invisible.
 *
 * axe-core cannot catch this: it inspects the static accessibility tree, not
 * focus behaviour, so every one of these dialogs passed the a11y sweep while
 * being broken. An HTTP/Playwright test can only assert on the dialogs it already
 * knows to open. So this guard makes the omission impossible to add SILENTLY: it
 * is a SOURCE SCAN. Every file under src/components or src/app that declares a
 * modal role must, in the SAME file, import and use `useModalFocus` — or be named
 * in the ALLOWLIST below with a reason. It runs offline; no dev server, no DB.
 *
 * WHAT THIS GUARD DOES AND DOES NOT CLAIM. Per-FILE granularity is deliberate:
 * one file often holds several modals behind a single shared shell that calls the
 * hook once (AssignmentDialogs has four `role="dialog"` surfaces and one
 * ModalShell; DocumentsTab has two). A "one hook call per role attribute" rule
 * would false-fail exactly those correct files, so the honest, non-brittle
 * invariant is: a file that declares any modal role must reach the primitive. It
 * proves the wiring EXISTS; it cannot prove every dialog in a multi-modal file
 * attaches the returned ref. That residual is the Exercise pass's job. This guard
 * closes the specific hole LENS-014/022 came through — a modal with no focus
 * primitive anywhere in its module — and nothing wider.
 *
 * THE ALLOWLIST IS TWO-WAY. An entry is not a permanent excuse: assertion 4 fails
 * if an allowlisted file ACQUIRES the hook (the entry is now false — delete it) or
 * stops declaring a modal role at all (stale). So the list can never quietly
 * accumulate dead entries.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/** Client-component trees where modal dialogs live. */
const SCAN_ROOTS = ["src/components", "src/app"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".jsx"]);

/** The ONE sanctioned modal focus primitive. */
const HOOK_MODULE = join("src", "components", "a11y", "use-modal-focus.ts");
const HOOK_IMPORT = "@/components/a11y/use-modal-focus";

/**
 * Files that declare a modal role but legitimately do NOT need `useModalFocus`.
 * Each needs a concrete reason — "nothing traps focus" is the defect this file
 * exists to catch, so it is never the justification for an entry here.
 */
const ALLOWLIST: Record<string, string> = {
  "src/components/staff/underwriting/AvmMap.tsx":
    "AC-37 keyless AVM map marker popup. This `role=\"dialog\"` is a NON-MODAL inline " +
    "popover, not a modal: it carries NO aria-modal, has NO scrim/backdrop, is one of " +
    "several that open over the map, is anchored to its marker (not centred/blocking), " +
    "and is toggled by the same marker button (aria-expanded) that owns it. A focus trap " +
    "here would be WRONG — it would prevent Tab from reaching the other markers and the " +
    "comparables table. WCAG 2.1.2 does not apply because focus is never claimed to be " +
    "contained. If this ever gains aria-modal or a blocking scrim, delete this entry and " +
    "wire the hook.",
};

interface SourceFile {
  /** Repo-relative with forward slashes, for stable messages. */
  display: string;
  /** Original text, split into 1-indexed-able lines. */
  lines: string[];
  /** Text with comments blanked out, same line count. */
  scrubbed: string;
  scrubbedLines: string[];
}

/**
 * Blank out COMMENTS ONLY, preserving every newline so line numbers stay exact.
 * String literals are KEPT — a modal role IS spelled `role="dialog"` (a string
 * literal), so blanking string contents would erase the very evidence this file
 * looks for. Strings are still PARSED so a `//` inside a literal never starts a
 * comment. Blanking comments is what stops the hook module and this test's own
 * prose — which quote `role="dialog"` to DOCUMENT the rule — from being mistaken
 * for a declaration. (Identical to the scrubber in suites 14 and 15.)
 */
function scrub(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  const keep = (ch: string): void => {
    out += ch === "\n" ? "\n" : " ";
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") keep(text[i++]);
      continue;
    }
    if (ch === "/" && next === "*") {
      keep(text[i++]);
      keep(text[i++]);
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) keep(text[i++]);
      if (i < n) {
        keep(text[i++]);
        keep(text[i++]);
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          out += text[i];
          if (i + 1 < n) out += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        out += text[i];
        i += 1;
      }
      if (i < n) {
        out += text[i];
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function listSourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        visit(full);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.slice(dot))) continue;
      const text = readFileSync(full, "utf8");
      const scrubbed = scrub(text);
      out.push({
        display: relative(ROOT, full).split(sep).join("/"),
        lines: text.split("\n"),
        scrubbed,
        scrubbedLines: scrubbed.split("\n"),
      });
    }
  };
  for (const root of SCAN_ROOTS) visit(join(ROOT, root));
  return out;
}

/** A modal role declaration: aria-modal, or role="dialog" / role="alertdialog". */
const MODAL_ROLE = /aria-modal|role\s*=\s*["'`](?:dialog|alertdialog)["'`]/;

/** Does this (scrubbed) source declare a modal role anywhere? */
function declaresModalRole(scrubbed: string): boolean {
  return MODAL_ROLE.test(scrubbed);
}

/** Does this (scrubbed) source reach the sanctioned primitive? */
function usesHook(scrubbed: string): boolean {
  return scrubbed.includes("useModalFocus");
}

/** First line (1-indexed) carrying a modal role, for message locations. */
function firstModalRoleLine(file: SourceFile): number {
  const idx = file.scrubbedLines.findIndex((line) => MODAL_ROLE.test(line));
  return idx < 0 ? 0 : idx + 1;
}

const files = listSourceFiles();
const modalFiles = files.filter((file) => declaresModalRole(file.scrubbed));

describe("§7.7 the scanner itself still sees the codebase", () => {
  // A scanner that silently stops finding modals would turn this file green while
  // guarding nothing — the classic way a source-scan guard rots.
  test("source files and modal declarations were found", () => {
    assert.ok(files.length > 40, `expected the component tree, scanned only ${files.length} files`);
    assert.ok(modalFiles.length >= 8, `expected the modal set, found only ${modalFiles.length}`);
  });

  test("the sanctioned primitive exists and is what we think it is", () => {
    const hook = files.find((file) => file.display === HOOK_MODULE.split(sep).join("/"));
    assert.ok(hook, `${HOOK_MODULE.split(sep).join("/")} must exist — it is the ONE modal focus primitive`);
    assert.match(hook.scrubbed, /export function useModalFocus</, "useModalFocus must be exported from the hook module");
    // The hook module names role="dialog" only in its doc comment; scrubbing must
    // strip that so the module is not treated as a modal declaration itself.
    assert.equal(
      declaresModalRole(hook.scrubbed),
      false,
      "the hook module must not read as declaring a modal role (its role=\"dialog\" mentions are comments)",
    );
  });

  test("known-good consumers are detected — the scanner's positive control", () => {
    // Each of these declares a modal role AND wires the hook. If any stops
    // resolving, the scanner has broken, not the app.
    for (const path of [
      "src/components/wizard/BankLinkDialog.tsx",
      "src/components/staff/detail/CorrectionModal.tsx",
      "src/components/borrower/ui.tsx",
    ]) {
      const file = files.find((f) => f.display === path);
      assert.ok(file, `positive control missing: ${path}`);
      assert.ok(declaresModalRole(file.scrubbed), `scanner regression: ${path} should read as a modal`);
      assert.ok(usesHook(file.scrubbed), `scanner regression: ${path} should read as wiring the hook`);
    }
  });

  test("the detector actually bites — synthetic proof", () => {
    // A modal with no hook must be flagged; the same modal with the hook must not.
    const brokenModal = `export function X(){ return <div role="dialog" aria-modal="true">hi</div>; }`;
    const fixedModal =
      `import { useModalFocus } from "${HOOK_IMPORT}";\n` +
      `export function X(){ const r = useModalFocus(()=>{}); return <div ref={r} role="dialog" aria-modal="true">hi</div>; }`;
    const nonModal = `export function X(){ return <div role="img">hi</div>; }`;

    assert.ok(declaresModalRole(scrub(brokenModal)) && !usesHook(scrub(brokenModal)), "broken modal must be caught");
    assert.ok(declaresModalRole(scrub(fixedModal)) && usesHook(scrub(fixedModal)), "fixed modal must pass");
    assert.equal(declaresModalRole(scrub(nonModal)), false, "a non-modal role must not be treated as a modal");
    // A modal role written only inside a comment must NOT count as a declaration.
    const commentedOnly = `// this file explains role="dialog" and aria-modal="true"\nexport const x = 1;`;
    assert.equal(declaresModalRole(scrub(commentedOnly)), false, "a role named only in a comment is not a declaration");
  });
});

describe("§7.7 every modal dialog wires the one focus primitive (LENS-014/022)", () => {
  test("no file declares a modal role without reaching useModalFocus", () => {
    const offenders = modalFiles
      .filter((file) => !usesHook(file.scrubbed))
      .filter((file) => !(file.display in ALLOWLIST));

    assert.deepEqual(
      offenders.map((file) => `${file.display}:${firstModalRoleLine(file)}`),
      [],
      "these files declare aria-modal / role=\"dialog\" / role=\"alertdialog\" but never import or call " +
        `useModalFocus from ${HOOK_IMPORT} — the LENS-014/022 shape (a modal that lets Tab escape to the ` +
        "page behind the scrim is a WCAG 2.1 AA failure). Attach the hook's ref to the role element (see " +
        "BankLinkDialog.tsx), or, if it is genuinely not a modal, add it to ALLOWLIST in this file with a " +
        "reason:\n  " +
        offenders.map((file) => `${file.display}:${firstModalRoleLine(file)}`).join("\n  "),
    );
  });
});

describe("§7.7 the allowlist stays honest", () => {
  test("every allowlisted file still exists and still declares a modal role", () => {
    for (const path of Object.keys(ALLOWLIST)) {
      const file = files.find((f) => f.display === path);
      assert.ok(file, `allowlisted file no longer exists — delete the entry: ${path}`);
      assert.ok(
        declaresModalRole(file.scrubbed),
        `allowlisted file no longer declares a modal role — delete the entry: ${path}`,
      );
    }
  });

  test("no allowlisted file has quietly acquired the hook", () => {
    // The allowlist asserts "this modal-shaped surface does not need the trap". If
    // someone wires useModalFocus into it, that claim is now false — remove the entry.
    const nowWired = Object.keys(ALLOWLIST).filter((path) => {
      const file = files.find((f) => f.display === path);
      return file !== undefined && usesHook(file.scrubbed);
    });
    assert.deepEqual(
      nowWired,
      [],
      "these files are allowlisted as not-a-modal but now import/use useModalFocus — remove the " +
        "ALLOWLIST entry (the trap is real; the exemption is stale):\n  " +
        nowWired.join("\n  "),
    );
  });

  test("every allowlist entry carries a substantive reason", () => {
    for (const [path, reason] of Object.entries(ALLOWLIST)) {
      assert.ok(reason.length > 120, `allowlist entry ${path} needs a real justification, not a note`);
    }
  });
});
