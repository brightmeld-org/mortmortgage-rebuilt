/**
 * §7.7 — transition-id ↔ (from, to) integrity guard (LENS-023).
 *
 * The immutable audit trail (WorkflowHistory + AuditLogEntry) stamps
 * `WorkflowTransition.id` for the (from, to) the engine matched
 * (workflow-engine.ts). LENS-023 found T32 and T33 SWAPPED in the pure table:
 * a conditional-approval decline was recorded as T33 (which §4.5.3 defines as a
 * withdrawal) and vice-versa. contracts.json.transitions is a state-adjacency
 * map carrying no ids, so nothing in the contract JSON could catch this.
 *
 * This guard pins EVERY id to its §4.5.3 (from, to) so the swap class cannot
 * recur: a future edit that re-swaps any pair, or renames a toState under an id,
 * fails here. The expected table below is requirements.md §4.5.3 verbatim
 * (machine state names). T38 is the one id with several targets (resume-to-prev).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WORKFLOW_TRANSITIONS } from "@/lib/pure/workflow";

/** requirements.md §4.5.3 — id → [from, to] (machine names). T38 handled separately. */
const EXPECTED: Record<string, [string, string]> = {
  T1: ["draft", "application_received"],
  T2: ["draft", "withdrawn"],
  T3: ["application_received", "completeness_validated"],
  T4: ["application_received", "revision_requested"],
  T5: ["application_received", "withdrawn"],
  T6: ["application_received", "suspended"],
  T7: ["completeness_validated", "documents_received"],
  T8: ["completeness_validated", "revision_requested"],
  T9: ["completeness_validated", "withdrawn"],
  T10: ["completeness_validated", "suspended"],
  T11: ["documents_received", "aus_executed"],
  T12: ["documents_received", "revision_requested"],
  T13: ["documents_received", "withdrawn"],
  T14: ["documents_received", "suspended"],
  T15: ["aus_executed", "preliminary_decision"],
  T16: ["aus_executed", "revision_requested"],
  T17: ["aus_executed", "withdrawn"],
  T18: ["aus_executed", "suspended"],
  T19: ["preliminary_decision", "approved"],
  T20: ["preliminary_decision", "conditional_approval"],
  T21: ["preliminary_decision", "escalated_review"],
  T22: ["preliminary_decision", "denied"],
  T23: ["preliminary_decision", "revision_requested"],
  T24: ["preliminary_decision", "withdrawn"],
  T25: ["preliminary_decision", "suspended"],
  T26: ["escalated_review", "approved"],
  T26a: ["escalated_review", "conditional_approval"],
  T26b: ["escalated_review", "denied"],
  T26c: ["escalated_review", "withdrawn"],
  T26d: ["escalated_review", "suspended"],
  T27: ["approved", "borrower_notified"],
  T28: ["denied", "borrower_notified"],
  T29: ["approved", "declined_by_borrower"],
  T30: ["conditional_approval", "approved"],
  T31: ["conditional_approval", "denied"],
  T32: ["conditional_approval", "declined_by_borrower"], // §4.5.3 — NOT withdrawn
  T33: ["conditional_approval", "withdrawn"], // §4.5.3 — NOT declined_by_borrower
  T34: ["conditional_approval", "suspended"],
  T35: ["borrower_notified", "declined_by_borrower"],
  T36: ["revision_requested", "completeness_validated"],
  T37: ["revision_requested", "withdrawn"],
  T39: ["suspended", "withdrawn"],
  T40: ["suspended", "denied"],
};

/** T38 (resume) returns to exactly the states a suspend can be entered from. */
const T38_TARGETS = new Set([
  "application_received",
  "completeness_validated",
  "documents_received",
  "aus_executed",
  "preliminary_decision",
  "escalated_review",
  "conditional_approval",
]);

describe("§4.5.3 transition-id ↔ (from, to) mapping (LENS-023 audit-integrity guard)", () => {
  test("every single-target id maps to exactly its §4.5.3 (from, to)", () => {
    for (const [id, [from, to]] of Object.entries(EXPECTED)) {
      const rows = WORKFLOW_TRANSITIONS.filter((t) => t.id === id);
      assert.equal(rows.length, 1, `id ${id} must appear exactly once, found ${rows.length}`);
      assert.equal(rows[0]!.from, from, `${id}.from: §4.5.3 says ${from}, table has ${rows[0]!.from}`);
      assert.equal(rows[0]!.to, to, `${id}.to: §4.5.3 says ${to}, table has ${rows[0]!.to}`);
    }
  });

  test("T38 (resume) maps only to the suspend-reachable states", () => {
    const rows = WORKFLOW_TRANSITIONS.filter((t) => t.id === "T38");
    assert.ok(rows.length > 0, "T38 must exist");
    for (const r of rows) {
      assert.equal(r.from, "suspended", "T38 leaves suspended only");
      assert.ok(T38_TARGETS.has(r.to), `T38 target ${r.to} is not a suspend-reachable state`);
    }
    assert.deepEqual(
      new Set(rows.map((r) => r.to)),
      T38_TARGETS,
      "T38 must cover every suspend-reachable state, no more no less",
    );
  });

  test("no (from, to) edge is stamped by two different ids", () => {
    const seen = new Map<string, string>();
    for (const t of WORKFLOW_TRANSITIONS) {
      const key = `${t.from}->${t.to}`;
      const prior = seen.get(key);
      assert.ok(
        prior === undefined || prior === t.id,
        `edge ${key} is stamped by both ${prior} and ${t.id} — an audit-trail ambiguity`,
      );
      seen.set(key, t.id);
    }
  });

  test("the two historically-swapped ids are the right way round", () => {
    const decline = WORKFLOW_TRANSITIONS.find(
      (t) => t.from === "conditional_approval" && t.to === "declined_by_borrower",
    );
    const withdraw = WORKFLOW_TRANSITIONS.find(
      (t) => t.from === "conditional_approval" && t.to === "withdrawn",
    );
    assert.equal(decline?.id, "T32", "conditional-approval decline must stamp T32 (§4.5.3)");
    assert.equal(withdraw?.id, "T33", "conditional-approval withdrawal must stamp T33 (§4.5.3)");
  });
});
