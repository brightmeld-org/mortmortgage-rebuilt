/**
 * Workflow ladder: drives a fresh application to any §4.5.3 state using only
 * contracted endpoints and the actors the transition map names.
 */
import { GET, PATCH, POST, expectOk, type ApiResult, type Session } from "./http.js";
import {
  buildSubmittableDraft,
  claim,
  getApplication,
  pdfBytes,
  runAllChecks,
  transition,
  transitionOk,
  uploadDocument,
  type Application,
  type DraftShape,
} from "./application.js";

/** Checklist key → the DocumentType that satisfies it (§4.2.9 checklist-by-loan-type). */
const CHECKLIST_DOCUMENT_TYPES: Array<[RegExp, string]> = [
  [/^government-id/, "government-id"],
  [/^pay-stubs/, "pay-stub"],
  [/^w2/, "w2"],
  [/^bank-statements/, "bank-statement"],
  [/^purchase-agreement/, "purchase-agreement"],
  [/^tax-returns?/, "tax-return-1040"],
  [/^gift-letter/, "gift-letter"],
  [/^homeowners-insurance/, "homeowners-insurance-quote"],
];

function documentTypeFor(checklistKey: string): string {
  for (const [pattern, documentType] of CHECKLIST_DOCUMENT_TYPES) {
    if (pattern.test(checklistKey)) return documentType;
  }
  return "other";
}

export interface Actors {
  borrower: Session;
  caseworker: Session;
  supervisor: Session;
}

export interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  satisfied: boolean;
  documentId?: string;
  documentStatus?: string;
}

export async function checklist(session: Session, applicationId: string): Promise<ChecklistItem[]> {
  const path = `/api/applications/${applicationId}/documents`;
  const result = await GET<{ checklist: ChecklistItem[] }>(path, { session });
  return expectOk(result, `GET ${path}`, 200).checklist ?? [];
}

/** Uploads and accepts a document for every unsatisfied required checklist item (T7 precondition). */
export async function satisfyChecklist(staff: Session, applicationId: string): Promise<void> {
  for (const item of await checklist(staff, applicationId)) {
    if (!item.required || item.satisfied) continue;
    const documentType = documentTypeFor(item.key);
    const upload = await uploadDocument(
      staff,
      applicationId,
      `checklist-${item.key}.pdf`,
      pdfBytes(3000),
      documentType,
      documentType === "other" ? item.label : undefined,
    );
    const document = expectOk(upload, `upload for ${item.key}`, 201);
    const statusPath = `/api/documents/${document.id}/status`;
    // retryOn5xx is fixture-setup resilience only — the contract-shape assertion for
    // error responses lives in the documents suite, not here.
    const accepted = await PATCH(statusPath, { session: staff, body: { status: "accepted" }, retryOn5xx: 2 });
    expectOk(accepted, `PATCH ${statusPath}`, 200);
  }
}

export interface ApprovalDecisionBody {
  decision: "approve" | "deny";
  versionStamp?: number;
  notes?: string;
  conditions?: string[];
  denialReasons?: string[];
  denialReasonOtherText?: string;
}

export async function approvalDecision(
  supervisor: Session,
  applicationId: string,
  body: ApprovalDecisionBody,
): Promise<ApiResult<Application>> {
  const path = `/api/applications/${applicationId}/approval-decision`;
  const versionStamp = body.versionStamp ?? (await getApplication(supervisor, applicationId)).versionStamp;
  return POST<Application>(path, { session: supervisor, body: { ...body, versionStamp } });
}

/** Polls until the application reaches one of `states` (SYS T27/T28 dispatch is async). */
export async function awaitState(
  session: Session,
  applicationId: string,
  states: string[],
  timeoutMs = 30000,
): Promise<Application> {
  const deadline = Date.now() + timeoutMs;
  let application = await getApplication(session, applicationId);
  while (Date.now() < deadline) {
    if (states.includes(application.workflowState)) return application;
    await new Promise((resolve) => setTimeout(resolve, 750));
    application = await getApplication(session, applicationId);
  }
  throw new Error(
    `application ${applicationId} stayed in ${application.workflowState}; expected one of ${states.join("/")}`,
  );
}

/** draft → application_received → completeness_validated (claimed by the caseworker). */
export async function toCompletenessValidated(actors: Actors, shape: DraftShape = {}): Promise<Application> {
  const draft = await buildSubmittableDraft(actors.borrower, shape);
  await transitionOk(actors.borrower, draft.id, {
    toState: "application_received",
    versionStamp: draft.versionStamp,
  });
  expectOk(await claim(actors.caseworker, draft.id), "POST claim", 201);
  return transitionOk(actors.caseworker, draft.id, { toState: "completeness_validated" });
}

/** ... → documents_received (every required checklist item accepted). */
export async function toDocumentsReceived(actors: Actors, shape: DraftShape = {}): Promise<Application> {
  const application = await toCompletenessValidated(actors, shape);
  await satisfyChecklist(actors.caseworker, application.id);
  return transitionOk(actors.caseworker, application.id, { toState: "documents_received" });
}

/** ... → aus_executed (four checks completed + AUS recorded). */
export async function toAusExecuted(actors: Actors, shape: DraftShape = {}): Promise<Application> {
  const application = await toDocumentsReceived(actors, shape);
  await runAllChecks(actors.caseworker, application.id);
  return transitionOk(actors.caseworker, application.id, { toState: "aus_executed" });
}

/** ... → preliminary_decision (recommendation + formal note draft). */
export async function toPreliminaryDecision(
  actors: Actors,
  shape: DraftShape = {},
  recommendation: "approve" | "approve-with-conditions" | "deny" = "approve",
): Promise<Application> {
  const application = await toAusExecuted(actors, shape);
  return transitionOk(actors.caseworker, application.id, {
    toState: "preliminary_decision",
    recommendation,
    note: "Preliminary recommendation recorded for the §7.7 fixture.",
  });
}

/** Shape whose LTV (95%) exceeds the default 80% escalation threshold. */
export const ESCALATING_SHAPE: DraftShape = { estimatedValue: 400000, requestedLoanAmount: 380000 };

/** Shape whose LTV (75%) and DTI (~31%) sit below both default escalation thresholds. */
export const NON_ESCALATING_SHAPE: DraftShape = { estimatedValue: 400000, requestedLoanAmount: 300000 };

export { transition, transitionOk, getApplication };
