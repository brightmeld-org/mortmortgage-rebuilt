"use client";

// UrlaWizard (task-016) — the 10-step URLA 2020 wizard orchestrator.
//
// Navigation path (navigation completeness rule): reached from the borrower
// dashboard "Continue" action, from /applications/new after Create, and from
// the public-tools start-application bridge — all landing on /applications/:id
// (deep-linkable step via ?step=n).
//
// Responsibilities (contracts §C UrlaWizard): steps 1-10 with every §4.2.4
// field; co-borrower tabs on steps 1/2/3/8/9; 2s-debounced auto-save via
// PUT /api/applications/:id/sections/:section with a localStorage buffer,
// exponential-backoff retry and a Saved/Saving/Save-failed-retrying indicator;
// versionStamp 409 -> reload prompt; per-step error banner + inline messages +
// collapsible all-steps validation panel + progress bar; live DTI (step 5 on)
// and LTV (step 7 on) badges rendering SERVER values verbatim (never a client
// recomputation); address autocomplete; bank-link entry (steps 3/4); Step 10
// review/checklist/upload/signature/Submit gated on validation + LTV <= 97 +
// all signed + one-active, posting T1/T36 via the transition endpoint and
// surfacing server 409 bodies VERBATIM in a dismissible banner.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalFocus } from "@/components/a11y/use-modal-focus";
import {
  addCoBorrower,
  getApplication,
  getApplicationList,
  getDocuments,
  getIdentityOwn,
  getNotes,
  getSessionLite,
  getValidation,
  postTransition,
  removeCoBorrower,
  saveSection,
} from "./api";
import type {
  Application,
  AppDocument,
  BankLinkSession,
  ChecklistItem,
  IncomeEvidence,
  SignatureInfo,
  ValidationIssue,
  ValidationSummary,
  WizardSection,
} from "./types";
import { EDITABLE_STATES, PER_BORROWER_STEPS, STEP_SECTION, STEP_TITLES, isActiveUnderwritingState } from "./types";
import type { WizardDraft } from "./payload";
import { borrowerDraftFromRecord, buildSaveBody, draftFromApplication, sectionKey } from "./payload";
import { applyBuffer, clearBuffer, readBuffer, writeBuffer } from "./local-buffer";
import { formatClock } from "./format";
import { Step1Identity } from "./steps/Step1Identity";
import { Step2AddressHistory } from "./steps/Step2AddressHistory";
import { Step3Employment } from "./steps/Step3Employment";
import { Step4Assets } from "./steps/Step4Assets";
import { Step5Liabilities } from "./steps/Step5Liabilities";
import { Step6SubjectProperty } from "./steps/Step6SubjectProperty";
import { Step7LoanDetails } from "./steps/Step7LoanDetails";
import { Step8Declarations } from "./steps/Step8Declarations";
import { Step9Demographics } from "./steps/Step9Demographics";
import { Step10Review } from "./steps/Step10Review";
import { BankLinkDialog } from "./BankLinkDialog";

type SaveState = "idle" | "saving" | "saved" | "retrying";

interface Metrics {
  dti?: number;
  ltv?: number;
  cltv?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function WizardRoot({
  applicationId,
  initialStep,
  demoMode,
}: {
  applicationId: string;
  initialStep: number;
  demoMode: boolean;
}) {
  // ---------------------------------------------------------------- state
  const [app, setApp] = useState<Application | null>(null);
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(() => Math.min(10, Math.max(1, initialStep || 1)));
  const [ordinal, setOrdinal] = useState(1);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>({});
  const [sectionIssues, setSectionIssues] = useState<Record<string, ValidationIssue[]>>({});
  const [signatureInvalidatedFlag, setSignatureInvalidatedFlag] = useState(false);
  const [staleAdvisories, setStaleAdvisories] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [bannerNonce, setBannerNonce] = useState(0);
  const [revisionNote, setRevisionNote] = useState<string | null>(null);
  const [otherActiveNumber, setOtherActiveNumber] = useState<string | null>(null);
  const [documents, setDocuments] = useState<AppDocument[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [bankOpen, setBankOpen] = useState(false);
  const [bankSession, setBankSession] = useState<BankLinkSession | null>(null);
  const [attestationAccepted, setAttestationAccepted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // ---------------------------------------------------------------- refs
  const csrfRef = useRef("");
  const stampRef = useRef(0);
  const draftRef = useRef<WizardDraft | null>(null);
  const dirtyRef = useRef<Set<string>>(new Set());
  const editGenRef = useRef<Map<string, number>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const conflictRef = useRef(false);
  const mountedRef = useRef(true);
  const bannerRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef(false);

  const editable = app !== null && EDITABLE_STATES.includes(app.workflowState);
  editableRef.current = editable;
  conflictRef.current = conflict;

  const hasCoBorrower = (app?.borrowers.length ?? 0) > 1;
  const activeSection: WizardSection | null = STEP_SECTION[step];
  const isPerBorrowerStep = PER_BORROWER_STEPS.includes(step);
  const activeOrdinal = isPerBorrowerStep ? ordinal : undefined;

  // ---------------------------------------------------------------- load
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    (async () => {
      const session = await getSessionLite();
      if (cancelled) return;
      if (!session) {
        window.location.assign(`/sign-in?redirectTo=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      csrfRef.current = session.csrfToken;

      const appRes = await getApplication(applicationId);
      if (cancelled) return;
      if (!appRes.ok) {
        setLoadError(appRes.error.message);
        return;
      }
      const application = appRes.data;
      stampRef.current = application.versionStamp;
      const nextDraft = draftFromApplication(application);

      // Unmasked identity values (SSN ###-##-####, ISO DOB) come only from the
      // owner identity endpoint (§A SSN rule).
      for (const b of application.borrowers) {
        const idRes = await getIdentityOwn(applicationId, b.ordinal);
        if (cancelled) return;
        if (idRes.ok) {
          const identity = idRes.data.identity;
          nextDraft.borrowers[b.ordinal] = {
            ...nextDraft.borrowers[b.ordinal],
            identity: {
              ...nextDraft.borrowers[b.ordinal].identity,
              ssn: identity.ssn,
              dateOfBirth: identity.dateOfBirth,
            },
          };
        }
      }

      // Local buffer replay (REQ-035): restore unsaved sections, re-queue saves.
      const isEditable = EDITABLE_STATES.includes(application.workflowState);
      if (isEditable) {
        const buffer = readBuffer(applicationId);
        if (buffer) {
          const restored = applyBuffer(nextDraft, buffer);
          for (const key of restored) dirtyRef.current.add(key);
        }
      } else {
        clearBuffer(applicationId);
      }

      draftRef.current = nextDraft;
      setDraft(nextDraft);
      setApp(application);
      setMetrics({ dti: application.dti, ltv: application.ltv, cltv: application.cltv });
      setSignatureInvalidatedFlag(
        (application.signatures ?? []).length > 0 &&
          (application.signatures ?? []).every((s) => s.invalidatedAt),
      );

      const [valRes, listRes, docsRes] = await Promise.all([
        getValidation(applicationId),
        getApplicationList(),
        getDocuments(applicationId),
      ]);
      if (cancelled) return;
      if (valRes.ok) setValidation(valRes.data);
      if (docsRes.ok) {
        setChecklist(docsRes.data.checklist);
        setDocuments(docsRes.data.documents);
      }
      if (listRes.ok) {
        const other = listRes.data.rows.find(
          (r) => r.id !== applicationId && isActiveUnderwritingState(r.workflowState),
        );
        setOtherActiveNumber(other ? other.applicationNumber : null);
      }
      if (application.workflowState === "revision_requested") {
        // The formal note rides on the revision transition (VR-080: the
        // TransitionRequest note BECOMES the formal note). GET notes is the
        // contracted source (live since task-030) — the server serves the
        // borrower ONLY formal notes (S-7).
        const notesRes = await getNotes(applicationId);
        if (!cancelled && notesRes.ok) {
          const formals = notesRes.data.rows.filter(
            (row) => row.type === "formal" && row.content,
          );
          if (formals.length > 0) {
            const latest = formals.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
            setRevisionNote(latest.content);
          }
        }
      }
      if (dirtyRef.current.size > 0 && isEditable) scheduleFlush(500);
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId]);

  // Deep-linkable step in the URL (?step=n).
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(step));
    window.history.replaceState(null, "", url.toString());
  }, [step]);

  // ---------------------------------------------------------------- save engine
  const refreshValidation = useCallback(async () => {
    const r = await getValidation(applicationId);
    if (mountedRef.current && r.ok) setValidation(r.data);
  }, [applicationId]);

  const runFlush = useCallback(async () => {
    let attempt = 0;
    while (
      mountedRef.current &&
      dirtyRef.current.size > 0 &&
      !conflictRef.current &&
      editableRef.current
    ) {
      const key = dirtyRef.current.values().next().value as string;
      const currentDraft = draftRef.current;
      if (!currentDraft) break;
      const gen = editGenRef.current.get(key) ?? 0;
      const built = buildSaveBody(currentDraft, key, stampRef.current);
      if (!built) {
        dirtyRef.current.delete(key);
        continue;
      }
      setSaveState("saving");
      const r = await saveSection(applicationId, built.section, csrfRef.current, built.body);
      if (!mountedRef.current) return;
      if (r.ok) {
        attempt = 0;
        stampRef.current = r.data.versionStamp;
        setMetrics({ dti: r.data.dti, ltv: r.data.ltv, cltv: r.data.cltv });
        setSectionIssues((prev) => ({ ...prev, [key]: r.data.issues ?? [] }));
        setSavedAt(r.data.savedAt);
        if (r.data.signatureInvalidated) {
          setSignatureInvalidatedFlag(true);
          const invalidatedAt = new Date().toISOString();
          setApp((prev) =>
            prev
              ? {
                  ...prev,
                  signatures: (prev.signatures ?? []).map((s) =>
                    s.invalidatedAt ? s : { ...s, invalidatedAt },
                  ),
                }
              : prev,
          );
        }
        setStaleAdvisories(r.data.staleCopyAdvisories ?? []);
        // Keep borrower tab labels live: identity saves update the name shown
        // on the Primary/Co-borrower tabs (live-state rule — from the saved draft).
        if (built.section === "identity") {
          const { ordinal: savedOrdinal } = { ordinal: (built.body.borrowerOrdinal as number) ?? 1 };
          const savedIdentity = draftRef.current?.borrowers[savedOrdinal]?.identity;
          if (savedIdentity) {
            setApp((prev) =>
              prev
                ? {
                    ...prev,
                    borrowers: prev.borrowers.map((b) =>
                      b.ordinal === savedOrdinal
                        ? { ...b, firstName: savedIdentity.firstName, lastName: savedIdentity.lastName }
                        : b,
                    ),
                  }
                : prev,
            );
          }
        }
        // Clear dirty only when no further edits landed while in flight.
        if ((editGenRef.current.get(key) ?? 0) === gen) dirtyRef.current.delete(key);
        if (draftRef.current) writeBuffer(applicationId, draftRef.current, dirtyRef.current);
      } else if (r.status === 409) {
        setConflict(true);
        conflictRef.current = true;
        setSaveState("retrying");
        break;
      } else if (r.status === 401) {
        window.location.assign(`/sign-in?redirectTo=${encodeURIComponent(window.location.pathname)}`);
        return;
      } else {
        // Transient failure (network/5xx) or a rejected payload: exponential
        // backoff, never silently drop (REQ-035).
        attempt += 1;
        setSaveState("retrying");
        await sleep(Math.min(1000 * 2 ** attempt, 30000));
      }
    }
    if (mountedRef.current && dirtyRef.current.size === 0) {
      setSaveState("saved");
      void refreshValidation();
    }
  }, [applicationId, refreshValidation]);

  const flushNow = useCallback((): Promise<void> => {
    if (!flushPromiseRef.current) {
      flushPromiseRef.current = runFlush().finally(() => {
        flushPromiseRef.current = null;
      });
    }
    return flushPromiseRef.current;
  }, [runFlush]);

  const scheduleFlush = useCallback(
    (delay = 2000) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void flushNow();
      }, delay);
    },
    [flushNow],
  );

  /** Apply a draft mutation for one section and queue its auto-save (2s debounce). */
  const updateSection = useCallback(
    (key: string, mutate: (d: WizardDraft) => WizardDraft) => {
      if (!editableRef.current || conflictRef.current) return;
      const current = draftRef.current;
      if (!current) return;
      const next = mutate(current);
      draftRef.current = next;
      setDraft(next);
      dirtyRef.current.add(key);
      editGenRef.current.set(key, (editGenRef.current.get(key) ?? 0) + 1);
      writeBuffer(applicationId, next, dirtyRef.current);
      setSaveState("saving");
      scheduleFlush(2000);
    },
    [applicationId, scheduleFlush],
  );

  // ---------------------------------------------------------------- issues
  const issuesForSectionKey = useCallback(
    (section: WizardSection, o?: number): ValidationIssue[] => {
      const key = sectionKey(section, o);
      const fromSave = sectionIssues[key];
      if (fromSave) return fromSave;
      return (validation?.issues ?? []).filter(
        (i) => i.section === section && (o === undefined || i.borrowerOrdinal === undefined || i.borrowerOrdinal === o),
      );
    },
    [sectionIssues, validation],
  );

  const currentStepIssues = activeSection ? issuesForSectionKey(activeSection, activeOrdinal) : [];
  const currentStepErrors = currentStepIssues.filter((i) => i.severity === "error");

  // Server issue paths use bracket indices (employments[0].employerName);
  // component paths use dots (employments.0.employerName) — normalize both.
  const normalizePath = (p: string) => p.replace(/\[(\d+)\]/g, ".$1");
  const errorFor = useCallback(
    (path: string): string | undefined =>
      currentStepIssues.find((i) => normalizePath(i.fieldPath) === path && i.severity === "error")
        ?.message,
    [currentStepIssues],
  );

  // ---------------------------------------------------------------- navigation
  const goToStep = useCallback(
    (n: number) => {
      const clamped = Math.min(10, Math.max(1, n));
      setStep(clamped);
      setBannerNonce(0);
      window.scrollTo({ top: 0 });
      if (editableRef.current) void flushNow(); // save on step navigation (§4.2.6)
    },
    [flushNow],
  );

  const onNext = useCallback(async () => {
    if (editableRef.current) await flushNow();
    const section = STEP_SECTION[step];
    if (section && editableRef.current) {
      const errors = issuesForSectionKey(section, activeOrdinal).filter((i) => i.severity === "error");
      if (errors.length > 0) {
        // Failed "Next" (§4.2.7): banner + scroll; free navigation stays available
        // via the step indicators.
        setBannerNonce((n) => n + 1);
        requestAnimationFrame(() => bannerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        return;
      }
    }
    goToStep(step + 1);
  }, [step, activeOrdinal, issuesForSectionKey, goToStep, flushNow]);

  // ---------------------------------------------------------------- documents
  const refreshDocuments = useCallback(async () => {
    const r = await getDocuments(applicationId);
    if (mountedRef.current && r.ok) {
      setChecklist(r.data.checklist);
      setDocuments(r.data.documents);
    }
  }, [applicationId]);

  useEffect(() => {
    if (step !== 10) return;
    void refreshDocuments();
    const timer = setInterval(() => {
      // Poll while any OCR job is still running so the job badge updates.
      if (documents.some((d) => d.jobStatus === "queued" || d.jobStatus === "processing")) {
        void refreshDocuments();
      }
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, documents.some((d) => d.jobStatus === "queued" || d.jobStatus === "processing")]);

  // ---------------------------------------------------------------- co-borrower
  const onAddCoBorrower = useCallback(async () => {
    setActionError(null);
    const r = await addCoBorrower(applicationId, csrfRef.current);
    if (!r.ok) {
      setActionError(r.error.message);
      return;
    }
    const application = r.data;
    stampRef.current = application.versionStamp;
    setApp(application);
    const current = draftRef.current;
    if (current) {
      const co = application.borrowers.find((b) => b.ordinal === 2);
      if (co) {
        const next = { ...current, borrowers: { ...current.borrowers, 2: borrowerDraftFromRecord(co) } };
        draftRef.current = next;
        setDraft(next);
      }
    }
    void refreshValidation();
  }, [applicationId, refreshValidation]);

  const onRemoveCoBorrower = useCallback(async () => {
    setActionError(null);
    setRemoveConfirm(false);
    const r = await removeCoBorrower(applicationId, csrfRef.current);
    if (!r.ok) {
      setActionError(r.error.message);
      return;
    }
    const application = r.data;
    stampRef.current = application.versionStamp;
    setApp(application);
    setOrdinal(1);
    const current = draftRef.current;
    if (current) {
      const nextBorrowers = { ...current.borrowers };
      delete nextBorrowers[2];
      const next = { ...current, borrowers: nextBorrowers };
      draftRef.current = next;
      setDraft(next);
    }
    // Drop dirty flags and buffered content for the removed borrower.
    for (const key of Array.from(dirtyRef.current)) {
      if (key.endsWith(":2")) dirtyRef.current.delete(key);
    }
    if (draftRef.current) writeBuffer(applicationId, draftRef.current, dirtyRef.current);
    void refreshValidation();
  }, [applicationId, refreshValidation]);

  // ---------------------------------------------------------------- bank link
  /**
   * Adopt an Application returned by a bank-link mutation: import (asset rows
   * appended, source=bank-link) and unlink (BUG-28 — this link's rows flipped to
   * source=manual, the link gone from Application.bankLinks) both answer with
   * the full refreshed §A Application, so both land here.
   */
  const applyBankLinkApplication = useCallback(
    (application: Application) => {
      stampRef.current = application.versionStamp;
      setApp(application);
      setMetrics({ dti: application.dti, ltv: application.ltv, cltv: application.cltv });
      const current = draftRef.current;
      if (current) {
        const data = application.data ?? {};
        const next: WizardDraft = {
          ...current,
          assetsReo: {
            assets: data.assets ?? [],
            otherCredits: data.otherCredits ?? [],
            realEstateOwned: data.realEstateOwned ?? [],
          },
        };
        draftRef.current = next;
        setDraft(next);
      }
      dirtyRef.current.delete(sectionKey("assets-reo"));
      if (draftRef.current) writeBuffer(applicationId, draftRef.current, dirtyRef.current);
      void refreshValidation();
    },
    [applicationId, refreshValidation],
  );

  const onAcceptIncomeEvidence = useCallback(
    (evidence: IncomeEvidence) => {
      const o = activeOrdinal ?? 1;
      updateSection(sectionKey("employment-income", o), (d) => {
        const b = d.borrowers[o];
        const employments = [...(b.employmentIncome.employments ?? [])];
        if (employments.length === 0) {
          employments.push({ employerName: evidence.employerName, selfEmployed: false, baseMonthlyIncome: evidence.averageMonthlyDeposit });
        } else {
          employments[0] = { ...employments[0], baseMonthlyIncome: evidence.averageMonthlyDeposit };
        }
        return {
          ...d,
          borrowers: { ...d.borrowers, [o]: { ...b, employmentIncome: { ...b.employmentIncome, employments } } },
        };
      });
    },
    [activeOrdinal, updateSection],
  );

  // ---------------------------------------------------------------- signatures
  const onSigned = useCallback(async (_sig: SignatureInfo) => {
    setActionError(null);
    setSignatureInvalidatedFlag(false);
    const r = await getApplication(applicationId);
    if (mountedRef.current && r.ok) {
      stampRef.current = r.data.versionStamp;
      setApp(r.data);
    }
  }, [applicationId]);

  // ---------------------------------------------------------------- submit
  const allSigned =
    app !== null &&
    app.borrowers.length > 0 &&
    app.borrowers.every((b) =>
      (app.signatures ?? []).some((s) => s.borrowerId === b.id && !s.invalidatedAt),
    );

  const validationErrors = (validation?.issues ?? []).filter((i) => i.severity === "error");
  const ltvKnownOver97 = metrics.ltv !== undefined && metrics.ltv > 97;
  const oneActiveMessage = otherActiveNumber
    ? `You already have an application in underwriting: ${otherActiveNumber}`
    : null;

  const submitDisabled =
    !editable ||
    submitting ||
    conflict ||
    validationErrors.length > 0 ||
    ltvKnownOver97 ||
    !allSigned ||
    oneActiveMessage !== null;

  const onSubmit = useCallback(async () => {
    if (!app) return;
    setSubmitting(true);
    setSubmitError(null);
    await flushNow();
    const toState = app.workflowState === "revision_requested" ? "completeness_validated" : "application_received";
    const r = await postTransition(applicationId, csrfRef.current, {
      toState,
      versionStamp: stampRef.current,
    });
    setSubmitting(false);
    if (r.ok) {
      stampRef.current = r.data.versionStamp;
      setApp(r.data);
      setSubmitted(true);
      clearBuffer(applicationId);
      window.scrollTo({ top: 0 });
    } else {
      // Server error body VERBATIM in a dismissible banner (REQ-033/NFR-025).
      setSubmitError(r.error.message);
    }
  }, [app, applicationId, flushNow]);

  // ---------------------------------------------------------------- render
  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl">
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
          {loadError}
        </div>
      </div>
    );
  }

  if (!app || !draft) {
    return (
      <div className="mx-auto max-w-6xl animate-pulse space-y-4" aria-busy="true" aria-label="Loading application">
        <div className="h-8 w-2/3 rounded bg-line" />
        <div className="h-2 w-full rounded bg-line" />
        <div className="h-96 rounded-xl bg-line/60" />
      </div>
    );
  }

  const completionPct = validation?.completionPct ?? 0;
  const activeBorrowerDraft = draft.borrowers[activeOrdinal ?? 1] ?? draft.borrowers[1];
  const borrowerLabel = (o: number) => {
    const b = app.borrowers.find((x) => x.ordinal === o);
    const name = b ? [b.firstName, b.lastName].filter(Boolean).join(" ") : "";
    return o === 1 ? `Primary${name ? ` — ${name}` : ""}` : `Co-borrower${name ? ` — ${name}` : ""}`;
  };

  const stepStatusFor = (n: number) => validation?.stepStatuses.find((s) => s.step === n)?.status ?? "not-started";

  const saveIndicator = (() => {
    if (!editable) return null;
    if (conflict) return <span className="font-semibold text-danger">Save conflict — reload required</span>;
    switch (saveState) {
      case "saving":
        return <span className="text-ink-soft">Saving…</span>;
      case "retrying":
        return <span className="font-semibold text-warn">Save failed — retrying</span>;
      case "saved":
        return <span className="text-success">✓ Saved at {savedAt ? formatClock(savedAt) : ""}</span>;
      default:
        return <span className="text-muted">All changes save automatically</span>;
    }
  })();

  return (
    <div className="mx-auto max-w-6xl pb-16" data-testid={`wizard-step-${step}`}>
      {/* ------------------------------------------------ title + save indicator */}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl font-bold text-ink sm:text-3xl">
          URLA Application — Step {step} of 10 · {STEP_TITLES[step]}
        </h1>
        <p data-testid="autosave-indicator" aria-live="polite" className="text-sm">
          {saveIndicator}
        </p>
      </div>
      <p className="mt-1 text-sm text-muted">
        Application <span className="font-semibold text-ink">{app.applicationNumber}</span> ·{" "}
        <span className="font-semibold text-ink">{app.workflowStateLabel}</span>
      </p>

      {/* ------------------------------------------------ progress + steps */}
      <div className="mt-4">
        <div
          data-testid="wizard-progress"
          role="progressbar"
          aria-valuenow={Math.round(completionPct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Application completion"
          className="h-2 w-full overflow-hidden rounded-full bg-line"
        >
          <div
            className="h-full bg-copper transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]"
            style={{ width: `${Math.round(completionPct)}%` }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
            const status = stepStatusFor(n);
            const isCurrent = n === step;
            const cls = isCurrent
              ? "bg-navy-deep text-white ring-2 ring-navy/30"
              : status === "complete"
                ? "bg-success text-white"
                : status === "in-progress"
                  ? "bg-warn-soft text-warn border border-warn/40"
                  : "bg-card text-ink-soft border border-line";
            return (
              <button
                key={n}
                type="button"
                data-testid={`step-indicator-${n}`}
                data-status={status}
                aria-label={`Step ${n}: ${STEP_TITLES[n]} (${status})`}
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => goToStep(n)}
                className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-transform duration-100 active:scale-95 ${cls}`}
              >
                {n}
              </button>
            );
          })}
          <span className="ml-2 text-xs text-muted">
            {Math.round(completionPct)}% complete · steps freely navigable
          </span>
        </div>
      </div>

      {/* ------------------------------------------------ borrower tabs */}
      {isPerBorrowerStep ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b border-line">
          <div className="flex gap-1" role="tablist" aria-label="Borrower">
            {app.borrowers.map((b) => (
              <button
                key={b.ordinal}
                type="button"
                role="tab"
                data-testid={`borrower-tab-${b.ordinal}`}
                aria-selected={ordinal === b.ordinal}
                onClick={() => setOrdinal(b.ordinal)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${
                  ordinal === b.ordinal
                    ? "border-copper text-copper"
                    : "border-transparent text-ink-soft hover:text-ink"
                }`}
              >
                {borrowerLabel(b.ordinal)}
              </button>
            ))}
          </div>
          {editable ? (
            <div className="flex items-center gap-3 pb-1">
              {!hasCoBorrower ? (
                <button
                  type="button"
                  data-testid="coborrower-add-toggle"
                  onClick={() => void onAddCoBorrower()}
                  className="text-sm font-semibold text-copper transition-opacity duration-200 hover:opacity-70"
                >
                  + Add a co-borrower
                </button>
              ) : removeConfirm ? (
                <span className="flex items-center gap-2 text-sm">
                  <span className="text-ink-soft">Remove co-borrower and delete their data?</span>
                  <button
                    type="button"
                    data-testid="coborrower-remove-confirm"
                    onClick={() => void onRemoveCoBorrower()}
                    className="rounded-md bg-danger px-3 py-1 text-xs font-semibold text-white hover:opacity-90"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    data-testid="coborrower-remove-cancel"
                    onClick={() => setRemoveConfirm(false)}
                    className="rounded-md border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:border-navy/40"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="coborrower-remove-btn"
                  onClick={() => setRemoveConfirm(true)}
                  className="text-sm font-semibold text-danger transition-opacity duration-200 hover:opacity-70"
                >
                  Remove co-borrower
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------ banners */}
      <div className="mt-4 space-y-3">
        {submitted ? (
          <div data-testid="submit-success-banner" className="rounded-lg border border-success/40 bg-success-soft p-4 text-sm text-success" role="status">
            <span className="font-semibold">Application submitted.</span> Your application is now in{" "}
            <span className="font-semibold">{app.workflowStateLabel}</span>.
          </div>
        ) : null}
        {!editable && !submitted ? (
          <div data-testid="readonly-banner" className="rounded-lg border border-info/30 bg-info-soft p-4 text-sm text-ink-soft" role="status">
            This application is in <span className="font-semibold text-ink">{app.workflowStateLabel}</span> and is
            read-only. Fields cannot be edited in this state.
          </div>
        ) : null}
        {app.workflowState === "revision_requested" ? (
          <div data-testid="revision-banner" className="rounded-lg border border-warn/40 bg-warn-soft p-4 text-sm text-ink" role="status">
            <p className="font-semibold text-warn">Revision requested</p>
            {revisionNote ? <p className="mt-1 whitespace-pre-wrap">{revisionNote}</p> : null}
            <p className="mt-1 text-xs text-ink-soft">
              Update the requested information, re-sign, and resubmit from Step 10.
            </p>
          </div>
        ) : null}
        {signatureInvalidatedFlag && editable ? (
          <div data-testid="signature-invalidated-banner" className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
            <span className="font-semibold">Signature invalidated</span> — the application changed after signing.
            All borrowers must re-sign in Step 10 before submission.
          </div>
        ) : null}
        {staleAdvisories.map((advisory, i) => (
          <div key={i} data-testid={`staleness-advisory-${i}`} className="rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-sm text-ink-soft" role="status">
            {advisory}
          </div>
        ))}
        {actionError ? (
          <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss" className="font-bold">✕</button>
          </div>
        ) : null}
        {currentStepErrors.length > 0 && editable ? (
          <div
            ref={bannerRef}
            data-testid="validation-banner"
            data-nonce={bannerNonce}
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm"
          >
            <span className="font-semibold text-danger">
              {currentStepErrors.length} item{currentStepErrors.length === 1 ? "" : "s"} need attention:
            </span>{" "}
            <span className="text-danger">{currentStepErrors.map((i) => i.message).join(" · ")}</span>
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------ main grid */}
      <div className="mt-5 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="rounded-xl border border-line bg-card p-6 shadow-sm">
          {step === 1 ? (
            <Step1Identity
              data={activeBorrowerDraft.identity}
              onChange={(next) =>
                updateSection(sectionKey("identity", activeOrdinal ?? 1), (d) => ({
                  ...d,
                  borrowers: { ...d.borrowers, [activeOrdinal ?? 1]: { ...d.borrowers[activeOrdinal ?? 1], identity: next } },
                }))
              }
              disabled={!editable}
              errorFor={errorFor}
              hasCoBorrower={hasCoBorrower}
            />
          ) : null}
          {step === 2 ? (
            <Step2AddressHistory
              data={activeBorrowerDraft.addressHistory}
              onChange={(next) =>
                updateSection(sectionKey("address-history", activeOrdinal ?? 1), (d) => ({
                  ...d,
                  borrowers: { ...d.borrowers, [activeOrdinal ?? 1]: { ...d.borrowers[activeOrdinal ?? 1], addressHistory: next } },
                }))
              }
              disabled={!editable}
              errorFor={errorFor}
            />
          ) : null}
          {step === 3 ? (
            <Step3Employment
              data={activeBorrowerDraft.employmentIncome}
              onChange={(next) =>
                updateSection(sectionKey("employment-income", activeOrdinal ?? 1), (d) => ({
                  ...d,
                  borrowers: { ...d.borrowers, [activeOrdinal ?? 1]: { ...d.borrowers[activeOrdinal ?? 1], employmentIncome: next } },
                }))
              }
              disabled={!editable}
              errorFor={errorFor}
              onOpenBankLink={() => setBankOpen(true)}
              incomeEvidence={bankSession?.incomeEvidence ?? null}
              onAcceptIncomeEvidence={onAcceptIncomeEvidence}
            />
          ) : null}
          {step === 4 ? (
            <Step4Assets
              data={draft.assetsReo}
              onChange={(next) => updateSection(sectionKey("assets-reo"), (d) => ({ ...d, assetsReo: next }))}
              disabled={!editable}
              errorFor={errorFor}
              onOpenBankLink={() => setBankOpen(true)}
              applicationId={applicationId}
              csrfToken={csrfRef.current}
              bankLinks={app.bankLinks ?? []}
              onUnlinked={applyBankLinkApplication}
            />
          ) : null}
          {step === 5 ? (
            <Step5Liabilities
              data={draft.liabilities}
              onChange={(next) => updateSection(sectionKey("liabilities"), (d) => ({ ...d, liabilities: next }))}
              disabled={!editable}
              errorFor={errorFor}
            />
          ) : null}
          {step === 6 ? (
            <Step6SubjectProperty
              data={draft.subjectProperty}
              onChange={(next) => updateSection(sectionKey("subject-property"), (d) => ({ ...d, subjectProperty: next }))}
              disabled={!editable}
              errorFor={errorFor}
              loanPurpose={draft.loanDetails.loanPurpose}
            />
          ) : null}
          {step === 7 ? (
            <Step7LoanDetails
              data={draft.loanDetails}
              onChange={(next) => updateSection(sectionKey("loan-details"), (d) => ({ ...d, loanDetails: next }))}
              disabled={!editable}
              errorFor={errorFor}
            />
          ) : null}
          {step === 8 ? (
            <Step8Declarations
              data={activeBorrowerDraft.declarations}
              onChange={(next) =>
                updateSection(sectionKey("declarations", activeOrdinal ?? 1), (d) => ({
                  ...d,
                  borrowers: { ...d.borrowers, [activeOrdinal ?? 1]: { ...d.borrowers[activeOrdinal ?? 1], declarations: next } },
                }))
              }
              disabled={!editable}
              errorFor={errorFor}
            />
          ) : null}
          {step === 9 ? (
            <Step9Demographics
              data={activeBorrowerDraft.demographics}
              onChange={(next) =>
                updateSection(sectionKey("demographics", activeOrdinal ?? 1), (d) => ({
                  ...d,
                  borrowers: { ...d.borrowers, [activeOrdinal ?? 1]: { ...d.borrowers[activeOrdinal ?? 1], demographics: next } },
                }))
              }
              disabled={!editable}
              errorFor={errorFor}
            />
          ) : null}
          {step === 10 ? (
            <Step10Review
              app={app}
              validation={validation}
              checklist={checklist}
              documents={documents}
              csrfToken={csrfRef.current}
              demoMode={demoMode}
              disabled={!editable}
              // BUG-33 (§4.2.9): document deletion is Draft-ONLY — narrower
              // than `editable`, which also covers Revision Requested.
              canDeleteDocuments={app.workflowState === "draft"}
              attestationAccepted={attestationAccepted}
              onAttestationChange={setAttestationAccepted}
              goToStep={goToStep}
              onUploaded={() => void refreshDocuments()}
              onDocumentDeleted={() => void refreshDocuments()}
              onSigned={(s) => void onSigned(s)}
              onError={(m) => setActionError(m)}
            />
          ) : null}

          {/* footer navigation */}
          <div className="mt-8 flex items-center justify-between border-t border-line pt-5">
            <button
              type="button"
              data-testid="wizard-back-btn"
              onClick={() => goToStep(step - 1)}
              disabled={step === 1}
              className="rounded-md border border-line bg-card px-4 py-2 text-sm font-semibold text-ink-soft transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-navy/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Back
            </button>
            {step < 10 ? (
              <button
                type="button"
                data-testid="wizard-next-btn"
                onClick={() => void onNext()}
                className="rounded-md bg-navy px-5 py-2 text-sm font-semibold text-white transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-navy-deep active:scale-[0.99]"
              >
                Next: {STEP_TITLES[step + 1]} →
              </button>
            ) : (
              <span />
            )}
          </div>
        </div>

        {/* ------------------------------------------------ right rail */}
        <div className="space-y-4 lg:sticky lg:top-6">
          {step === 10 ? (
            <div className="rounded-xl border-t-4 border-copper bg-card p-5 shadow-sm ring-1 ring-line">
              <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">Submit</p>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex items-center justify-between gap-2">
                  <span className="text-ink">Required fields</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      validationErrors.length === 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
                    }`}
                  >
                    {validationErrors.length === 0 ? "Pass" : `${validationErrors.length} error${validationErrors.length === 1 ? "" : "s"}`}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-ink">LTV ≤ 97%</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      metrics.ltv === undefined
                        ? "bg-gray-soft text-ink-soft"
                        : metrics.ltv > 97
                          ? "bg-danger-soft text-danger"
                          : "bg-success-soft text-success"
                    }`}
                  >
                    {metrics.ltv === undefined ? "—" : `${String(metrics.ltv)}%`}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-ink">All borrowers signed</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      allSigned ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
                    }`}
                  >
                    {
                      app.borrowers.filter((b) =>
                        (app.signatures ?? []).some((s) => s.borrowerId === b.id && !s.invalidatedAt),
                      ).length
                    }{" "}
                    of {app.borrowers.length}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span className="text-ink">One active application</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      oneActiveMessage ? "bg-danger-soft text-danger" : "bg-success-soft text-success"
                    }`}
                  >
                    {oneActiveMessage ? "Blocked" : "OK"}
                  </span>
                </li>
              </ul>
              <button
                type="button"
                data-testid="submit-application-btn"
                onClick={() => void onSubmit()}
                disabled={submitDisabled}
                className="mt-4 w-full rounded-md bg-copper px-4 py-2.5 text-sm font-bold text-white transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-copper/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-copper-soft disabled:text-copper/60"
              >
                {submitting
                  ? "Submitting…"
                  : app.workflowState === "revision_requested"
                    ? "Resubmit application"
                    : "Submit application"}
              </button>
              <p className="mt-2 text-xs text-muted">
                Enabled when every check passes. Server errors appear here verbatim in a dismissible banner.
              </p>
              {submitError || oneActiveMessage ? (
                <div
                  data-testid="submit-error-banner"
                  role="alert"
                  className="mt-3 flex items-start justify-between gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
                >
                  <span>{submitError ?? oneActiveMessage}</span>
                  {submitError ? (
                    <button
                      type="button"
                      data-testid="submit-error-dismiss"
                      onClick={() => setSubmitError(null)}
                      aria-label="Dismiss"
                      className="font-bold"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {step >= 5 ? (
            <div className="rounded-xl border border-line bg-card p-5 shadow-sm">
              <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">Live qualification</p>
              <dl className="mt-3 space-y-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-ink">DTI</dt>
                  <dd
                    data-testid="dti-badge"
                    className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${
                      metrics.dti === undefined
                        ? "bg-gray-soft text-ink-soft"
                        : metrics.dti > 43
                          ? "bg-warn-soft text-warn"
                          : "bg-success-soft text-success"
                    }`}
                  >
                    {metrics.dti === undefined ? "—" : `${String(metrics.dti)}%`}
                  </dd>
                </div>
                {step >= 7 ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-ink">LTV / CLTV</dt>
                    <dd
                      data-testid="ltv-badge"
                      className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${
                        metrics.ltv === undefined
                          ? "bg-gray-soft text-ink-soft"
                          : metrics.ltv > 97
                            ? "bg-danger-soft text-danger"
                            : metrics.ltv > 80
                              ? "bg-warn-soft text-warn"
                              : "bg-success-soft text-success"
                      }`}
                    >
                      {metrics.ltv === undefined ? "—" : `${String(metrics.ltv)}%`}
                      {metrics.cltv !== undefined ? ` / ${String(metrics.cltv)}%` : ""}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p className="mt-2 text-[11px] text-muted">Server-computed on every save.</p>
            </div>
          ) : null}

          <div className="rounded-xl border border-line bg-card shadow-sm">
            <button
              type="button"
              data-testid="validation-panel-toggle"
              onClick={() => setPanelOpen((v) => !v)}
              aria-expanded={panelOpen}
              className="flex w-full items-center justify-between px-5 py-4 text-left"
            >
              <span className="text-[13px] font-semibold uppercase tracking-wide text-ink-soft">
                All-steps validation
              </span>
              <span aria-hidden="true" className={`text-muted transition-transform duration-200 ${panelOpen ? "rotate-180" : ""}`}>
                ▾
              </span>
            </button>
            {panelOpen ? (
              <div data-testid="validation-panel" className="border-t border-line px-5 py-4">
                {(validation?.issues ?? []).length === 0 ? (
                  <p className="text-sm text-success">✓ No outstanding errors or warnings.</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {(validation?.issues ?? []).map((issue, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span
                          className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                            issue.severity === "error" ? "bg-danger" : "bg-warn"
                          }`}
                          aria-hidden="true"
                        />
                        <span className="text-ink-soft">
                          <span className="font-semibold text-ink">
                            Step {stepForSection(issue.section)}
                            {issue.borrowerOrdinal ? ` · ${issue.borrowerOrdinal === 1 ? "Primary" : "Co-borrower"}` : ""}
                            :
                          </span>{" "}
                          {issue.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ conflict reload prompt */}
      {conflict ? (
        <ConflictReloadPrompt
          onReload={() => {
            // The prompt states the stale tab's unsaved edits are discarded —
            // drop the buffer so they are not replayed over the other tab's
            // accepted save (never silently overwrite).
            clearBuffer(applicationId);
            window.location.reload();
          }}
        />
      ) : null}

      {/* ------------------------------------------------ bank link dialog */}
      {bankOpen ? (
        <BankLinkDialog
          applicationId={applicationId}
          csrfToken={csrfRef.current}
          onClose={() => setBankOpen(false)}
          onImported={applyBankLinkApplication}
          onSession={(s) => setBankSession(s)}
        />
      ) : null}
    </div>
  );
}

// INV-039 stale-write reload prompt. A blocking modal — the only action is
// Reload, so Escape is a deliberate no-op (there is nothing to cancel to).
// Extracted so `useModalFocus` can be called unconditionally (open == mounted):
// focus move-in onto Reload + a real Tab trap (NFR-025 / LENS-014 / LENS-022).
function ConflictReloadPrompt({ onReload }: { onReload: () => void }) {
  const dialogRef = useModalFocus<HTMLDivElement>(() => {});
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label="Save conflict"
    >
      <div data-testid="conflict-reload-prompt" className="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-2xl">
        <h2 className="font-display text-lg font-semibold text-ink">This application changed elsewhere</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Your changes could not be saved because the application was updated in another tab or
          session. Reload to pick up the latest data — unsaved edits in this tab will be discarded.
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-testid="conflict-reload-btn"
            onClick={onReload}
            className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy-deep"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

function stepForSection(section: WizardSection): number {
  const entries = Object.entries(STEP_SECTION) as [string, WizardSection | null][];
  for (const [n, s] of entries) {
    if (s === section) return Number(n);
  }
  return 10;
}
