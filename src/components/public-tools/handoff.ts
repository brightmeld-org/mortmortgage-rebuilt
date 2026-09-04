// "Start an application with these numbers" bridge, client side (REQ-045 /
// FLOW-001). The signed token is held BROWSER-SIDE ONLY (sessionStorage) —
// never server-stored for an anonymous visitor. The visitor is routed through
// sign-in (return-to /start-application, honored by the task-009 auth suite);
// the /start-application bridge page consumes the stored token against
// POST /api/applications after authentication.

import { postJson } from "@/components/auth/api";

/** sessionStorage keys shared with src/app/(app)/start-application. */
export const HANDOFF_TOKEN_STORAGE_KEY = "mm.handoffToken";
export const HANDOFF_REQUEST_TOKEN_STORAGE_KEY = "mm.handoffRequestToken";

/** contracts.md §A HandoffTokenRequest — exact field names, all optional. */
export interface HandoffValues {
  grossMonthlyIncome?: number;
  monthlyDebtPayments?: number;
  downPaymentAmount?: number;
  termMonths?: number;
  loanAmount?: number;
  interestRate?: number;
  loanType?: "conventional" | "fha" | "va" | "usda";
}

interface HandoffTokenResponse {
  token: string;
  expiresAt: string;
}

export type StartApplicationResult = { ok: true } | { ok: false; message: string };

/**
 * Mint the signed hand-off token for the current calculator values, stash it in
 * sessionStorage, and route to sign-in with return-to /start-application.
 * On failure the SERVER message is returned verbatim for display.
 */
export async function startApplicationWithNumbers(values: HandoffValues): Promise<StartApplicationResult> {
  const result = await postJson<HandoffTokenResponse>("/api/public/handoff-token", values);
  if (!result.ok) {
    return { ok: false, message: result.error.message };
  }
  try {
    sessionStorage.setItem(HANDOFF_TOKEN_STORAGE_KEY, result.data.token);
    sessionStorage.removeItem(HANDOFF_REQUEST_TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private-mode edge) — proceed; the bridge page
    // creates a plain Draft, exactly the contract's missing-token behavior.
  }
  window.location.assign(`/sign-in?redirectTo=${encodeURIComponent("/start-application")}`);
  return { ok: true };
}
