/**
 * Client for the sanctioned test-only fixture seam, `POST /api/test/fixtures`.
 * The request/response contract lives in task-046/test-fixtures-contract.md.
 *
 * Only `zz-seam-*.test.ts` files import this. Every other suite is green without it.
 */
import { POST } from "./http.js";

export interface SeamResult {
  ok: boolean;
  [key: string]: unknown;
}

const SEAM_PATH = "/api/test/fixtures";

const MISSING_SEAM =
  "POST /api/test/fixtures is not available. This file depends on the sanctioned test-only " +
  "fixture seam specified in task-046/test-fixtures-contract.md (non-production + DEMO_MODE only).";

/** Throws with a pointer to the contract when the seam is absent — never skips silently. */
export async function requireSeam(): Promise<void> {
  const probe = await POST(SEAM_PATH, { body: { op: "set-simulation-fault", provider: "credit", mode: "none" } });
  if (probe.status === 404) throw new Error(MISSING_SEAM);
}

export async function seam(op: string, fields: Record<string, unknown> = {}): Promise<SeamResult> {
  const result = await POST<SeamResult>(SEAM_PATH, { body: { op, ...fields } });
  if (result.status === 404) throw new Error(MISSING_SEAM);
  if (result.status !== 200) {
    throw new Error(`${SEAM_PATH} op=${op}: ${result.status} ${result.text.slice(0, 400)}`);
  }
  return result.body as SeamResult;
}
