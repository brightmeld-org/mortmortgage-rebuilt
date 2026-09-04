"use client";

// NFR-025 (WCAG 2.1 AA) — the ONE modal focus primitive (LENS-014).
//
// Every `role="dialog"` / `aria-modal="true"` surface in the app declares
// itself modal to assistive technology; WCAG 2.1 AA requires that claim to be
// true for keyboard users too:
//   - 2.4.3 Focus Order      — focus moves INTO the dialog when it opens and
//                              returns to the invoker when it closes.
//   - 2.1.2 No Keyboard Trap — Tab/Shift+Tab cycle WITHIN the dialog instead of
//                              escaping to the page behind the scrim.
//   - 2.1.1 Keyboard         — Escape dismisses the dialog.
//
// axe-core cannot see any of these (it inspects the static tree, not focus
// behaviour), which is why the sweep passed while all four dialogs were broken.
//
// Usage — attach the returned ref to the element carrying role="dialog":
//
//   const dialogRef = useModalFocus<HTMLDivElement>(onClose);
//   <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="…">
//
// The hook must be called unconditionally, so the dialog has to be its own
// component that the parent mounts/unmounts (open = mounted).

import { useEffect, useRef } from "react";

/** Tabbable candidates, in DOM order. Disabled and tabindex=-1 are excluded. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function tabbableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute("hidden") &&
      el.getAttribute("aria-hidden") !== "true" &&
      // Explicitly removed from the sequential tab order (e.g. the PDF preview
      // iframe, which is a separate browsing context).
      el.getAttribute("tabindex") !== "-1" &&
      // Rendered (rules out display:none / detached subtrees).
      el.getClientRects().length > 0,
  );
}

/**
 * Focus move-in + focus trap + Escape-to-close for one modal dialog.
 *
 * @param onClose invoked on Escape. Read through a ref, so an inline arrow
 *   function is fine — the listeners are installed once per open, not per
 *   render.
 * @returns a ref to place on the `role="dialog"` element.
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const containerRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 2.4.3: remember the invoker so focus can go home on close.
    const invoker = document.activeElement as HTMLElement | null;

    // Move focus IN. Prefer the first tabbable control; fall back to the
    // dialog itself so focus is never left behind on the page.
    const firstTabbable = tabbableWithin(container)[0];
    if (firstTabbable) {
      firstTabbable.focus();
    } else {
      if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
      container.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      const el = containerRef.current;
      if (!el) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = tabbableWithin(el);
      if (items.length === 0) {
        // Nothing to move to — keep focus on the dialog rather than losing it.
        event.preventDefault();
        el.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && el.contains(active);

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Backstop for what keydown alone cannot cover: focus can leave the dialog
    // without the trap ever seeing a Tab — e.g. Tab pressed while focus sits in
    // an <iframe>, whose keystrokes belong to that document, not this one.
    // focusin still fires here the moment focus lands back on a parent-document
    // element, so pull it home.
    function onFocusIn(event: FocusEvent) {
      const el = containerRef.current;
      if (!el) return;
      const target = event.target as Node | null;
      if (target && el.contains(target)) return;
      const items = tabbableWithin(el);
      (items[0] ?? el).focus();
    }

    // Capture phase: the trap must win before any page-level key handling.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      if (invoker && typeof invoker.focus === "function" && invoker.isConnected) invoker.focus();
    };
    // Install once per mount — "open" is expressed by mounting the dialog.
  }, []);

  return containerRef;
}
