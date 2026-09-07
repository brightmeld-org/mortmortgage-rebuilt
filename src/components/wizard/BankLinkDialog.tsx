"use client";

// UrlaWizard (task-016) — bank account linking dialog (REQ-039, §4.2.10,
// FLOW states: institution select / authenticating / success / auth failure).
// Flow: consent + institution select -> credentials -> POST bank-links (auth;
// `slow` password takes ~8s, non-blocking spinner) -> account selection ->
// POST import -> Application returned (asset rows source=bank-link). Income
// evidence from the session surfaces in Step 3 (panel owned by the wizard root).

import { useCallback, useEffect, useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import {
  getInstitutions,
  postBankLinkAuth,
  postBankLinkExchange,
  postBankLinkImport,
  postBankLinkToken,
  readBankLinkMode,
} from "./api";
import type { Application, BankLinkSession, InstitutionInfo } from "./types";
import { formatCurrencyDisplay } from "./format";
import { inputClass } from "./fields";

type Phase =
  | "institutions"
  | "credentials"
  | "authenticating"
  | "accounts"
  | "importing"
  | "failed"
  // CH-025 (INV-054) — real-mode Link-widget flow only:
  | "widget-loading"
  | "widget-ready"
  | "widget-failed";

/**
 * CH-025 Layer B: launch the aggregator's Link widget (Plaid Link) with the
 * issued token. The script loads from https://cdn.plaid.com — admitted by the
 * real-mode CSP (INV-053), and dynamically-injected scripts inherit trust
 * under 'strict-dynamic' since the injecting chunk is nonced. Any failure —
 * script blocked/unreachable, widget error, user exit — lands in the
 * retryable widget-failed state, mirroring the server seam's posture (never a
 * crash). This code path is unreachable under simulation (mode-gated).
 */
const PLAID_LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface PlaidLinkHandle {
  open: () => void;
  exit: (opts?: { force?: boolean }) => void;
}

interface PlaidGlobal {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string, metadata: {
      institution?: { institution_id?: string; name?: string } | null;
    }) => void;
    onExit: (err: { display_message?: string; error_message?: string } | null) => void;
  }) => PlaidLinkHandle;
}

function loadPlaidScript(): Promise<PlaidGlobal> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { Plaid?: PlaidGlobal };
    if (w.Plaid) return resolve(w.Plaid);
    const existing = document.querySelector(`script[src="${PLAID_LINK_SRC}"]`);
    const script = (existing as HTMLScriptElement) ?? document.createElement("script");
    const fail = () => reject(new Error("widget script failed to load"));
    script.addEventListener("load", () => (w.Plaid ? resolve(w.Plaid) : fail()));
    script.addEventListener("error", fail);
    if (!existing) {
      script.src = PLAID_LINK_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

function launchBankLinkWidget(
  linkToken: string,
  onPublicToken: (publicToken: string, meta?: { institutionId?: string; institutionName?: string }) => void,
  onUnavailable: (message: string) => void,
): void {
  loadPlaidScript()
    .then((plaid) => {
      const handler = plaid.create({
        token: linkToken,
        onSuccess: (publicToken, metadata) => {
          onPublicToken(publicToken, {
            ...(metadata.institution?.institution_id
              ? { institutionId: metadata.institution.institution_id }
              : {}),
            ...(metadata.institution?.name ? { institutionName: metadata.institution.name } : {}),
          });
        },
        onExit: (err) => {
          if (err) {
            onUnavailable(
              err.display_message ?? "The bank connection was not completed. Retry to try again.",
            );
          } else {
            onUnavailable("The bank connection was closed before completing. Retry to try again.");
          }
        },
      });
      handler.open();
    })
    .catch(() => {
      onUnavailable(
        "The bank connection widget could not be loaded. Retry later, or contact support.",
      );
    });
}

export function BankLinkDialog({
  applicationId,
  csrfToken,
  onClose,
  onImported,
  onSession,
}: {
  applicationId: string;
  csrfToken: string;
  onClose: () => void;
  /** Import succeeded: fresh Application (bank-link asset rows included). */
  onImported: (app: Application) => void;
  /** Auth succeeded: session (income evidence for the Step 3 panel). */
  onSession: (session: BankLinkSession) => void;
}) {
  // CH-025 (INV-054): the server-exposed mode flag gates the flow — the
  // Link-widget flow renders ONLY under real mode; under simulation the
  // existing institution-picker + credentials form renders unchanged.
  const [bankMode] = useState<"simulation" | "real">(() => readBankLinkMode());
  const [phase, setPhase] = useState<Phase>(
    bankMode === "real" ? "widget-loading" : "institutions",
  );
  const [institutions, setInstitutions] = useState<InstitutionInfo[]>([]);
  const [institution, setInstitution] = useState<InstitutionInfo | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState<BankLinkSession | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // NFR-025 / LENS-014: focus move-in, focus trap, Escape-to-close.
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);

  useEffect(() => {
    if (bankMode === "real") return; // widget flow — no institution roster fetch
    let cancelled = false;
    (async () => {
      const r = await getInstitutions();
      if (!cancelled && r.ok) setInstitutions(r.data.rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [bankMode]);

  // Real mode: issue the short-lived Link token, then hand it to the Layer-B
  // widget seam. A 503 (simulation would never reach here; real-unwired is the
  // contracted retryable outcome) lands in the retryable widget-failed state.
  const requestLinkToken = useCallback(async () => {
    setPhase("widget-loading");
    setError(null);
    const r = await postBankLinkToken(applicationId, csrfToken);
    if (r.ok) {
      setPhase("widget-ready");
      launchBankLinkWidget(
        r.data.linkToken,
        (publicToken, meta) => void completeExchange(publicToken, meta),
        (message) => {
          setError(message);
          setPhase("widget-failed");
        },
      );
    } else {
      setError(r.error.message);
      setPhase("widget-failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- completeExchange is stable per render cycle; re-creating the callback on session state would relaunch the widget
  }, [applicationId, csrfToken]);

  useEffect(() => {
    if (bankMode === "real") void requestLinkToken();
  }, [bankMode, requestLinkToken]);

  /**
   * CH-025 Layer-B seam: the widget's success callback exchanges its public
   * token; the response is the SAME BankLinkSession shape as the credentials
   * flow, so the account-selection + import surface below is shared unchanged
   * between modes (INV-054).
   */
  const completeExchange = async (
    publicToken: string,
    meta?: { institutionId?: string; institutionName?: string },
  ) => {
    const r = await postBankLinkExchange(applicationId, csrfToken, {
      publicToken,
      ...(meta?.institutionId ? { institutionId: meta.institutionId } : {}),
      ...(meta?.institutionName ? { institutionName: meta.institutionName } : {}),
    });
    if (r.ok) {
      setSession(r.data);
      setSelected(new Set(r.data.accounts.map((a) => a.externalAccountId)));
      onSession(r.data);
      setPhase("accounts");
    } else {
      setError(r.error.message);
      setPhase("widget-failed");
    }
  };

  const authenticate = async () => {
    if (!institution) return;
    setPhase("authenticating");
    setError(null);
    const r = await postBankLinkAuth(applicationId, csrfToken, {
      institutionId: institution.id,
      username,
      password,
    });
    if (r.ok) {
      setSession(r.data);
      setSelected(new Set(r.data.accounts.map((a) => a.externalAccountId)));
      onSession(r.data);
      setPhase("accounts");
    } else {
      setError(r.error.message);
      setPhase("failed");
    }
  };

  const importAccounts = async () => {
    if (!session) return;
    setPhase("importing");
    setError(null);
    const r = await postBankLinkImport(applicationId, session.linkId, csrfToken, Array.from(selected));
    if (r.ok) {
      onImported(r.data);
      onClose();
    } else {
      setError(r.error.message);
      setPhase("accounts");
    }
  };

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true" aria-label="Link a bank account">
      <div data-testid="bank-link-dialog" className="w-full max-w-lg rounded-xl border border-line bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="font-display text-xl font-semibold text-ink">Link a bank account</h2>
            <p className="mt-0.5 text-sm text-muted">
              You consent to importing account and deposit information for this application.
            </p>
          </div>
          <button
            type="button"
            data-testid="bank-link-close"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-muted transition-colors duration-200 hover:bg-gray-soft hover:text-ink"
          >
            ✕
          </button>
        </div>

        {phase === "widget-loading" || phase === "widget-ready" || phase === "widget-failed" ? (
          // CH-025 (INV-054): real-mode Link-widget flow — renders ONLY when the
          // server-exposed mode flag reports real mode. The widget itself is
          // Layer B; until wired, the token request / launch fail-softs into the
          // retryable state below.
          <div className="space-y-4" data-testid="bank-link-widget-flow">
            {phase === "widget-failed" && error ? (
              <div
                data-testid="bank-link-widget-error"
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                {error}
              </div>
            ) : null}
            {phase === "widget-loading" ? (
              <p data-testid="bank-link-widget-loading" className="text-sm text-muted">
                Preparing a secure connection to your bank…
              </p>
            ) : null}
            {phase === "widget-ready" ? (
              <p className="text-sm text-muted">
                Follow your bank&apos;s prompts in the secure window to continue.
              </p>
            ) : null}
            {phase === "widget-failed" ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  data-testid="bank-link-widget-retry"
                  onClick={() => void requestLinkToken()}
                  className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep"
                >
                  Retry
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "institutions" ? (
          <div className="space-y-2">
            <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">Select your institution</p>
            <ul className="max-h-72 space-y-1 overflow-auto">
              {institutions.map((inst) => (
                <li key={inst.id}>
                  <button
                    type="button"
                    data-testid={`bank-link-institution-${inst.id}`}
                    onClick={() => {
                      setInstitution(inst);
                      setPhase("credentials");
                    }}
                    className="w-full rounded-md border border-line px-3 py-2 text-left text-sm text-ink transition-colors duration-200 hover:border-navy hover:bg-navy/5"
                  >
                    {inst.name}
                  </button>
                </li>
              ))}
              {institutions.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted">Loading institutions…</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {phase === "credentials" || phase === "authenticating" || phase === "failed" ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void authenticate();
            }}
          >
            <p className="text-sm text-ink">
              Sign in to <span className="font-semibold">{institution?.name}</span>
            </p>
            {phase === "failed" && error ? (
              <div data-testid="bank-link-error" role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </div>
            ) : null}
            <div>
              <label className="mb-1 block text-[13px] font-semibold text-ink" htmlFor="bl-user">Username</label>
              <input id="bl-user" data-testid="bank-link-username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} autoComplete="off" />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-semibold text-ink" htmlFor="bl-pass">Password</label>
              <input id="bl-pass" data-testid="bank-link-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} autoComplete="off" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setPhase("institutions")}
                className="text-sm font-semibold text-ink-soft transition-opacity duration-200 hover:opacity-70"
              >
                ← Back
              </button>
              <button
                type="submit"
                data-testid="bank-link-auth-submit"
                disabled={phase === "authenticating" || username.trim() === "" || password === ""}
                className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === "authenticating" ? "Authenticating…" : "Sign in & link"}
              </button>
            </div>
            {phase === "authenticating" ? (
              <p data-testid="bank-link-authenticating" className="text-xs text-muted">
                Contacting {institution?.name}… this can take a few seconds. You can keep working in the background.
              </p>
            ) : null}
          </form>
        ) : null}

        {phase === "accounts" || phase === "importing" ? (
          <div className="space-y-4">
            {error ? (
              <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </div>
            ) : null}
            <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">
              Select accounts to import
            </p>
            <ul className="space-y-2">
              {session?.accounts.map((a) => (
                <li key={a.externalAccountId}>
                  <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <input
                        data-testid={`bank-link-account-${a.externalAccountId}`}
                        type="checkbox"
                        checked={selected.has(a.externalAccountId)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(a.externalAccountId);
                          else next.delete(a.externalAccountId);
                          setSelected(next);
                        }}
                        className="h-4 w-4 accent-navy"
                      />
                      <span className="text-ink">
                        {a.institution} · {a.accountType} ····{a.last4}
                      </span>
                    </span>
                    <span className="font-semibold text-ink">{formatCurrencyDisplay(a.balance)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="bank-link-import-btn"
                onClick={() => void importAccounts()}
                disabled={phase === "importing" || selected.size === 0}
                className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === "importing" ? "Importing…" : `Import ${selected.size} account${selected.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
