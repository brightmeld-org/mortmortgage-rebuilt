// Required-document checklist engine (task-013, REQ-038, §4.2.9, XBR-006).
//
// PURE module — evaluates the §4.2.9 REQUIRED CHECKLIST BY LOAN TYPE table from
// live application data + live document rows handed in by the service layer.
// Nothing here is hardcoded per application; every satisfied flag is derived
// from the inputs on every call (LIVE-STATE BUILDER RULE).
//
// §4.2.9 table (verbatim semantics):
//   | Item                                              | Conventional        | FHA | VA | USDA |
//   | Government-issued ID (each borrower)              | Y                   | Y   | Y  | Y    |
//   | Pay stubs — most recent 30 days (each employed b.)| Y                   | Y   | Y  | Y    |
//   | W-2 — 2 years (each employed borrower)            | Y                   | Y   | Y  | Y    |
//   | Tax returns — 2 years                             | self-employed only  | Y   | Y  | Y    |
//   | Bank statements — 2 months                        | Y                   | Y   | Y  | Y    |
//   | Gift letter                                       | if gift funds (all loan types)         |
//   | Purchase agreement                                | purchase only (all loan types)         |
//   | Certificate of Eligibility (type Other, descr.)   | —                   | —   | Y  | —    |
//
// Satisfaction (§4.2.9): an item is satisfied when a document of that type is
// in status Accepted or Pending review, or the item is Waived (a waived
// document of that type). The T7 transition gate (XBR-006, task-019) is
// STRICTER: it requires Accepted or Waived only — see
// `isChecklistGateSatisfied` below (the exported predicate task-019 consumes).
//
// "each borrower" / "each employed borrower" multiply per borrower ordinal.
// "if gift funds": assets/otherCredits include a gift entry (OtherCreditType
// `gift-of-cash` | `gift-of-equity`) or LoanDetails.downPaymentSource is one of
// those gift types (downPaymentSource holds a Step-4 asset/credit type label).
// The conditional VA COE item maps to documentType `other` + a non-empty
// description (VR-096 basis).

// ---------------------------------------------------------------------------
// Wire shape (contracts.md §A ChecklistItem — exact field names)
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  satisfied: boolean;
  documentId?: string;
  documentStatus?: string;
}

// ---------------------------------------------------------------------------
// Inputs (live application data, projected by the service layer)
// ---------------------------------------------------------------------------

export interface ChecklistBorrowerInput {
  /** 1 = primary borrower, 2 = co-borrower. */
  ordinal: number;
  firstName?: string | null;
  lastName?: string | null;
  /** EmploymentType enum value: employed | self-employed | retired | not-employed. */
  employmentType?: string | null;
  /** EmploymentRecord[] slice — only selfEmployed is consulted. */
  employments?: readonly { selfEmployed?: boolean }[] | null;
}

export interface ChecklistDocumentInput {
  id: string;
  /** DocumentType enum value, verbatim. */
  documentType: string;
  description?: string | null;
  /** DocumentStatus enum value: pending | accepted | insufficient | waived. */
  status: string;
  /** Persisted binding from upload time, when present. */
  checklistItemKey?: string | null;
  createdAt: Date;
}

export interface ChecklistInput {
  /** LoanType enum value (conventional | fha | va | usda), when chosen. */
  loanType?: string | null;
  /** LoanPurpose enum value; `purchase` triggers the purchase-agreement item. */
  loanPurpose?: string | null;
  /** LoanDetails.downPaymentSource (Step-4 asset/credit type label). */
  downPaymentSource?: string | null;
  /** OtherCreditRecord.type values present on the application. */
  otherCreditTypes?: readonly string[] | null;
  borrowers: readonly ChecklistBorrowerInput[];
  documents: readonly ChecklistDocumentInput[];
}

// ---------------------------------------------------------------------------
// Item specs (checklist order = §4.2.9 table row order, per-borrower expanded)
// ---------------------------------------------------------------------------

export interface ChecklistItemSpec {
  key: string;
  label: string;
  /** DocumentType a satisfying document must carry. */
  documentType: string;
  /** COE only: the `other`-type document must carry a non-empty description. */
  requiresDescription: boolean;
}

const GIFT_CREDIT_TYPES = new Set(["gift-of-cash", "gift-of-equity"]);

/** Statuses that satisfy an item for DISPLAY (§4.2.9). */
const DISPLAY_SATISFYING_STATUSES = new Set(["accepted", "pending", "waived"]);
/** Statuses that satisfy an item for the T7 GATE (XBR-006). */
const GATE_SATISFYING_STATUSES = new Set(["accepted", "waived"]);

function borrowerSuffix(b: ChecklistBorrowerInput): string {
  const name = [b.firstName, b.lastName].filter((p) => p && p.trim().length > 0).join(" ");
  return name.length > 0 ? `Borrower ${b.ordinal} (${name})` : `Borrower ${b.ordinal}`;
}

/** Employed = W-2-style employment exists (employmentType or a non-self-employed record). */
function isEmployed(b: ChecklistBorrowerInput): boolean {
  if (b.employmentType === "employed") return true;
  return (b.employments ?? []).some((e) => e.selfEmployed === false);
}

/** Self-employed = employmentType self-employed or any selfEmployed record. */
function isSelfEmployed(b: ChecklistBorrowerInput): boolean {
  if (b.employmentType === "self-employed") return true;
  return (b.employments ?? []).some((e) => e.selfEmployed === true);
}

function hasGiftFunds(input: ChecklistInput): boolean {
  if ((input.otherCreditTypes ?? []).some((t) => GIFT_CREDIT_TYPES.has(t))) return true;
  return input.downPaymentSource != null && GIFT_CREDIT_TYPES.has(input.downPaymentSource);
}

/**
 * Build the ordered required-item specs for the application's current data.
 * Only items required under current conditions are emitted (all carry
 * required=true); an inapplicable conditional item (gift letter without gift
 * funds, purchase agreement on a refinance, COE off-VA) is absent entirely.
 * A missing loanType is treated as `conventional` (the least-demanding
 * baseline) so early drafts still see the unconditional items.
 */
export function buildChecklistSpecs(input: ChecklistInput): ChecklistItemSpec[] {
  const loanType = input.loanType ?? "conventional";
  const borrowers = [...input.borrowers].sort((a, b) => a.ordinal - b.ordinal);
  const specs: ChecklistItemSpec[] = [];

  for (const b of borrowers) {
    specs.push({
      key: `government-id-b${b.ordinal}`,
      label: `Government-issued ID — ${borrowerSuffix(b)}`,
      documentType: "government-id",
      requiresDescription: false,
    });
  }
  for (const b of borrowers) {
    if (!isEmployed(b)) continue;
    specs.push({
      key: `pay-stubs-b${b.ordinal}`,
      label: `Pay stubs — most recent 30 days — ${borrowerSuffix(b)}`,
      documentType: "pay-stub",
      requiresDescription: false,
    });
  }
  for (const b of borrowers) {
    if (!isEmployed(b)) continue;
    specs.push({
      key: `w2-b${b.ordinal}`,
      label: `W-2 — 2 years — ${borrowerSuffix(b)}`,
      documentType: "w2",
      requiresDescription: false,
    });
  }

  const taxReturnsRequired =
    loanType === "fha" || loanType === "va" || loanType === "usda"
      ? true
      : borrowers.some((b) => isSelfEmployed(b));
  if (taxReturnsRequired) {
    specs.push({
      key: "tax-returns",
      label: "Tax returns — 2 years",
      documentType: "tax-return-1040",
      requiresDescription: false,
    });
  }

  specs.push({
    key: "bank-statements",
    label: "Bank statements — 2 months",
    documentType: "bank-statement",
    requiresDescription: false,
  });

  if (hasGiftFunds(input)) {
    specs.push({
      key: "gift-letter",
      label: "Gift letter",
      documentType: "gift-letter",
      requiresDescription: false,
    });
  }

  if (input.loanPurpose === "purchase") {
    specs.push({
      key: "purchase-agreement",
      label: "Purchase agreement",
      documentType: "purchase-agreement",
      requiresDescription: false,
    });
  }

  if (loanType === "va") {
    specs.push({
      key: "certificate-of-eligibility",
      label: "Certificate of Eligibility",
      documentType: "other",
      requiresDescription: true,
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Evaluation — bind live documents to items, derive satisfied flags
// ---------------------------------------------------------------------------

export interface EvaluatedChecklistItem {
  spec: ChecklistItemSpec;
  item: ChecklistItem;
}

function documentMatchesSpec(doc: ChecklistDocumentInput, spec: ChecklistItemSpec): boolean {
  if (doc.documentType !== spec.documentType) return false;
  if (spec.requiresDescription) {
    return doc.description != null && doc.description.trim().length > 0;
  }
  return true;
}

/**
 * Evaluate the checklist against the live document rows.
 *
 * Binding: a persisted `checklistItemKey` wins when it names a still-valid item
 * of the matching type; remaining items bind, in checklist order, to the oldest
 * unbound matching document — preferring documents whose status satisfies the
 * item over ones that do not (e.g. `insufficient`), so a rejected upload plus a
 * newer accepted one reports the accepted document. Each document binds at most
 * one item.
 */
export function evaluateChecklistDetailed(input: ChecklistInput): EvaluatedChecklistItem[] {
  const specs = buildChecklistSpecs(input);
  const docs = [...input.documents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const boundDocIds = new Set<string>();
  const bindings = new Map<string, ChecklistDocumentInput>(); // spec.key -> doc

  // Pass 1: persisted checklistItemKey bindings (validated against the spec).
  for (const spec of specs) {
    const doc = docs.find(
      (d) =>
        !boundDocIds.has(d.id) &&
        d.checklistItemKey === spec.key &&
        documentMatchesSpec(d, spec),
    );
    if (doc) {
      bindings.set(spec.key, doc);
      boundDocIds.add(doc.id);
    }
  }

  // Pass 2: unbound items pick the oldest unbound matching document,
  // satisfying-status documents first.
  for (const spec of specs) {
    if (bindings.has(spec.key)) continue;
    const candidates = docs.filter((d) => !boundDocIds.has(d.id) && documentMatchesSpec(d, spec));
    const doc =
      candidates.find((d) => DISPLAY_SATISFYING_STATUSES.has(d.status)) ?? candidates[0];
    if (doc) {
      bindings.set(spec.key, doc);
      boundDocIds.add(doc.id);
    }
  }

  return specs.map((spec) => {
    const doc = bindings.get(spec.key);
    const satisfied = doc !== undefined && DISPLAY_SATISFYING_STATUSES.has(doc.status);
    const item: ChecklistItem = {
      key: spec.key,
      label: spec.label,
      required: true,
      satisfied,
    };
    if (doc) {
      item.documentId = doc.id;
      item.documentStatus = doc.status;
    }
    return { spec, item };
  });
}

/** Wire-ready ChecklistItem[] (DocumentListResponse.checklist). */
export function evaluateChecklist(input: ChecklistInput): ChecklistItem[] {
  return evaluateChecklistDetailed(input).map((e) => e.item);
}

/**
 * T7 gate predicate (XBR-006) — consumed by task-019's transition engine:
 * every required checklist item must be satisfied by a document in Accepted
 * or Waived status (pending review does NOT pass the gate).
 */
export function isChecklistGateSatisfied(items: readonly ChecklistItem[]): boolean {
  return items.every(
    (item) =>
      !item.required ||
      (item.documentStatus !== undefined && GATE_SATISFYING_STATUSES.has(item.documentStatus)),
  );
}

/**
 * Upload-time binding (task-013 upload flow): the checklist item key a new
 * document of `documentType` (with `description`) should be stamped with — the
 * first item of that type not yet satisfied — or undefined when every matching
 * item is satisfied (the document is stored unmatched, checklistItemKey absent).
 */
export function matchChecklistItemKey(
  input: ChecklistInput,
  documentType: string,
  description?: string | null,
): string | undefined {
  const probe: ChecklistDocumentInput = {
    id: "__candidate__",
    documentType,
    description: description ?? null,
    status: "pending",
    createdAt: new Date(8640000000000000), // sorts last — never displaces real bindings
  };
  for (const { spec, item } of evaluateChecklistDetailed(input)) {
    if (item.satisfied) continue;
    if (documentMatchesSpec(probe, spec)) return spec.key;
  }
  return undefined;
}

/**
 * Display-order index per document id (§4.2.9 "checklist order, then upload
 * time"): documents bound to a checklist item sort by that item's position;
 * unmatched documents sort after all checklist-bound ones.
 */
export function checklistOrderIndex(input: ChecklistInput): Map<string, number> {
  const evaluated = evaluateChecklistDetailed(input);
  const order = new Map<string, number>();
  evaluated.forEach(({ item }, index) => {
    if (item.documentId) order.set(item.documentId, index);
  });
  return order;
}
