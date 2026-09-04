// Demo-seed dataset SPECIFICATION (task-043, RFP §4.6.12 / §6.4, build-plan §B).
//
// Declarative description of the full demo dataset: 60 applications (every
// §4.6.12 floor is met with headroom), the staff roster, and the persona
// staging for the three demo accounts. `assertSpecFloors` re-counts every
// stated floor at seed time and throws on any shortfall — the distribution is
// asserted, never assumed.
//
// Sizing rationale (floors → seeded):
//   states  8/6/5/5/4/4/3/2/5/3/2/1/1/1 → 8/9/6/7/5/4/3/3/5/3/2/1/2/2 (=60)
//   loans   26/12/8/4                   → 32/14/9/5
//   The overage beyond the 50-app floor exists to stage the §4.6.12 capacity
//   colors (a red caseworker needs ≥13 active assignments, a yellow one 9-12,
//   Demo Caseworker holds 8) while keeping ≥5 claimable unassigned apps.

import type { Priority, WorkflowState, AssignmentMethod, UserRole } from "@prisma/client";
import type { SlaStatusValue } from "@/lib/pure/sla";
import {
  CLEAN_EMPLOYERS,
  DISCREPANCY_EMPLOYER,
  FIXTURE_EMPLOYER,
  FIXTURE_MONTHLY_INCOME,
  FRAUD_EMPLOYER,
  UNVERIFIED_EMPLOYER,
  cleanEmployer,
} from "@/lib/services/demo-seed/content";

// ---------------------------------------------------------------------------
// Staff roster (≥6 caseworkers with ≥1 inactive, ≥2 supervisors — §4.6.12)
// ---------------------------------------------------------------------------

export interface StaffSpec {
  key: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  status: "active" | "inactive";
}

export const STAFF_SPECS: readonly StaffSpec[] = [
  { key: "cw-red", firstName: "Priya", lastName: "Raghavan", email: "priya.raghavan@seedstaff.example", role: "CASEWORKER", status: "active" },
  { key: "cw-yellow", firstName: "Miguel", lastName: "Santana", email: "miguel.santana@seedstaff.example", role: "CASEWORKER", status: "active" },
  { key: "cw-green-a", firstName: "Elena", lastName: "Kovacs", email: "elena.kovacs@seedstaff.example", role: "CASEWORKER", status: "active" },
  { key: "cw-green-b", firstName: "David", lastName: "Okafor", email: "david.okafor@seedstaff.example", role: "CASEWORKER", status: "active" },
  { key: "cw-green-c", firstName: "Hannah", lastName: "Lindqvist", email: "hannah.lindqvist@seedstaff.example", role: "CASEWORKER", status: "active" },
  { key: "cw-inactive", firstName: "Robert", lastName: "Ellsworth", email: "robert.ellsworth@seedstaff.example", role: "CASEWORKER", status: "inactive" },
  { key: "cw-green-d", firstName: "Grace", lastName: "Tanaka", email: "grace.tanaka@seedstaff.example", role: "CASEWORKER", status: "active" },
  { key: "sup-1", firstName: "Marcus", lastName: "Bell", email: "marcus.bell@seedstaff.example", role: "SUPERVISOR", status: "active" },
  { key: "sup-2", firstName: "Lena", lastName: "Fischer", email: "lena.fischer@seedstaff.example", role: "SUPERVISOR", status: "active" },
  { key: "sup-3", firstName: "Omar", lastName: "Haddad", email: "omar.haddad@seedstaff.example", role: "SUPERVISOR", status: "active" },
];

/** 'demo-caseworker' or a STAFF_SPECS key. */
export type AssigneeRef = "demo-caseworker" | string;

// ---------------------------------------------------------------------------
// Application spec
// ---------------------------------------------------------------------------

export interface ApprovalSpec {
  /** 'demo-supervisor' or a supervisor STAFF_SPECS key. */
  by: "demo-supervisor" | string;
  decision: "approve" | "deny";
  /** Condition texts attached to this (approving) record. */
  conditions?: string[];
  /** Days before `now` the decision was recorded. */
  daysAgo: number;
}

export interface AppSpec {
  key: string;
  /** 'demo-borrower' or a synthetic borrower-user index (unique per app). */
  owner: "demo-borrower" | number;
  state: WorkflowState;
  outcome?: "approved" | "denied";
  loanType: "conventional" | "fha" | "va" | "usda";
  loanPurpose: "purchase" | "refinance-rate-term" | "refinance-cash-out";
  propertyType: string;
  occupancy: "primary-residence" | "second-home" | "investment-property";
  numberOfUnits: number;
  loanTermMonths: 120 | 180 | 240 | 360;
  amortizationType: "fixed" | "adjustable";
  estimatedValue: number;
  loanAmount: number;
  /** Primary borrower stated base monthly income. */
  monthlyIncome: number;
  employer: string;
  /** SSN last digit (credit tier: 0-3 good, 4-6 fair, 7-8 poor, 9 fault). */
  tierDigit: number;
  coBorrower?: { tierDigit: number; employer: string; monthlyIncome: number };
  /** Key of another spec whose primary borrower shares this SSN (duplicate-ssn). */
  ssnShareWith?: string;
  militaryService?: boolean;
  previousAddressAndEmployer?: boolean;
  giftFunds?: boolean;
  /** ZIP last-digit constraint for the subject property (AVM §6.3.3 steering). */
  zipLastDigits: readonly number[];
  /** Days before now for submission (T1). Absent for drafts. */
  submittedDaysAgo?: number;
  /** Days before now the FINAL decision was recorded (decidedAt). */
  decidedDaysAgo?: number;
  /** Days before now the terminal transition happened (withdrawn/declined). */
  closedDaysAgo?: number;
  /** Desired SLA badge for the CURRENT state (active states only). */
  sla?: SlaStatusValue;
  priority: Priority;
  /** True → Supervisor priority override staged (audited). */
  priorityOverridden?: boolean;
  /** Purchase closing-date offset (days from now) steering automatic priority. */
  targetClosingOffsetDays?: number;
  assignee?: AssigneeRef;
  assignmentMethod?: AssignmentMethod;
  l1?: ApprovalSpec;
  l2?: ApprovalSpec;
  denialReasons?: string[];
  /** Of the L1 conditions, how many are cleared. */
  conditionsCleared?: number;
  fraud?: "income-variance" | "ocr-mismatch" | "duplicate-ssn" | "employer-unverified";
  fraudStatus?: "open" | "resolved" | "dismissed";
  staleAus?: boolean;
  docsMode: "none" | "partial" | "full";
  fixtureDocs?: boolean;
  blurryDoc?: boolean;
  mismatchDoc?: boolean;
  failDoc?: boolean;
  /** Two application versions (resubmission history) for the diff demo. */
  twoVersions?: boolean;
  chatterFromSupervisor?: boolean;
  /** Formal note + unread borrower notification (Revision Requested staging). */
  formalNote?: boolean;
  documentRequest?: "pending" | "fulfilled";
  demographics: "full" | "not-provided" | "mixed";
  /** 'derog' → foreclosure/bankruptcy declarations true (AUS refer-with-caution). */
  declarationsProfile: "clean" | "derog";
  bankLink?: boolean;
  /** Compose the credit result with the §6.3.1 partial shape (2 bureaus). */
  partialCredit?: boolean;
  /** Seed-time assertion: escalation evaluation must land on this. */
  expectEscalated?: boolean;
}

// ---------------------------------------------------------------------------
// Spec construction
// ---------------------------------------------------------------------------

const PROPERTY_TYPES = [
  "single-family-detached", "townhouse-pud", "condominium", "cooperative",
  "two-unit", "three-unit", "four-unit", "manufactured-home",
] as const;

let ownerCounter = 0;
function nextOwner(): number {
  ownerCounter += 1;
  return ownerCounter;
}

interface FillerOverrides extends Partial<Omit<AppSpec, "key" | "owner">> {
  key: string;
  owner?: "demo-borrower" | number;
}

/** Baseline filler app: conventional purchase, good credit, comfortable ratios. */
function app(i: number, o: FillerOverrides): AppSpec {
  const units = o.propertyType === "two-unit" ? 2 : o.propertyType === "three-unit" ? 3 : o.propertyType === "four-unit" ? 4 : 1;
  const spec: AppSpec = {
    key: o.key,
    owner: o.owner ?? nextOwner(),
    state: o.state ?? "application_received",
    loanType: o.loanType ?? "conventional",
    loanPurpose: o.loanPurpose ?? "purchase",
    propertyType: o.propertyType ?? PROPERTY_TYPES[i % PROPERTY_TYPES.length]!,
    occupancy: o.occupancy ?? "primary-residence",
    numberOfUnits: o.numberOfUnits ?? units,
    loanTermMonths: o.loanTermMonths ?? 360,
    amortizationType: o.amortizationType ?? "fixed",
    estimatedValue: o.estimatedValue ?? 420_000 + (i % 7) * 35_000,
    loanAmount: o.loanAmount ?? Math.round((420_000 + (i % 7) * 35_000) * 0.72),
    monthlyIncome: o.monthlyIncome ?? 8200 + (i % 5) * 400,
    employer: o.employer ?? cleanEmployer(i),
    tierDigit: o.tierDigit ?? (i % 4), // good tier by default
    zipLastDigits: o.zipLastDigits ?? [0, 1, 2, 3, 4, 5],
    priority: o.priority ?? "normal",
    docsMode: o.docsMode ?? "partial",
    demographics: o.demographics ?? (i % 5 === 0 ? "not-provided" : i % 3 === 0 ? "mixed" : "full"),
    declarationsProfile: o.declarationsProfile ?? "clean",
  };
  // copy remaining optional overrides verbatim
  const copyKeys: (keyof AppSpec)[] = [
    "outcome", "coBorrower", "ssnShareWith", "militaryService", "previousAddressAndEmployer",
    "giftFunds", "submittedDaysAgo", "decidedDaysAgo", "closedDaysAgo", "sla",
    "priorityOverridden", "targetClosingOffsetDays", "assignee", "assignmentMethod",
    "l1", "l2", "denialReasons", "conditionsCleared", "fraud", "fraudStatus", "staleAus",
    "fixtureDocs", "blurryDoc", "mismatchDoc", "failDoc", "twoVersions",
    "chatterFromSupervisor", "formalNote", "documentRequest", "bankLink",
    "partialCredit", "expectEscalated",
  ];
  for (const k of copyKeys) {
    const v = (o as unknown as Record<string, unknown>)[k];
    if (v !== undefined) (spec as unknown as Record<string, unknown>)[k] = v;
  }
  return spec;
}

/**
 * Build the full 60-application spec list. Deterministic; `ownerCounter` is
 * reset per call so repeated seeds produce identical owner indices.
 */
export function buildAppSpecs(): AppSpec[] {
  ownerCounter = 0;
  const specs: AppSpec[] = [];
  let i = 0;
  const push = (o: FillerOverrides) => {
    specs.push(app(i, o));
    i += 1;
  };

  // ---- Demo Borrower persona (§4.6.12) -----------------------------------
  // 1) Mid-wizard Draft with co-borrower + uploaded documents (fixture-named,
  //    entered data aligned with the fixture values).
  push({
    key: "demo-draft", owner: "demo-borrower", state: "draft",
    loanType: "conventional", propertyType: "single-family-detached",
    estimatedValue: 480_000, loanAmount: 336_000,
    monthlyIncome: FIXTURE_MONTHLY_INCOME, employer: FIXTURE_EMPLOYER,
    tierDigit: 1, coBorrower: { tierDigit: 2, employer: cleanEmployer(3), monthlyIncome: 5200 },
    docsMode: "partial", fixtureDocs: true, demographics: "full",
  });
  // 2) Revision Requested with formal note + unread notification (ACTIVE slot —
  //    see the INV-016 interpretation note in dataset.ts).
  push({
    key: "demo-rr", owner: "demo-borrower", state: "revision_requested",
    loanType: "conventional", propertyType: "townhouse-pud",
    estimatedValue: 390_000, loanAmount: 292_500, monthlyIncome: 8600,
    tierDigit: 0, submittedDaysAgo: 12, docsMode: "partial",
    assignee: "demo-caseworker", assignmentMethod: "claim",
    formalNote: true, demographics: "full",
  });
  // 3) Approved copy source dated >90 days ago (staleness advisory source).
  //    Staged as declined_by_borrower with outcome=approved after a
  //    borrower_notified stay >90 days ago — INV-016 (borrower_notified is an
  //    ACTIVE state in the shipped partial unique index) forbids a second
  //    active application for the same borrower; the RR staging above owns the
  //    single active slot. Documented interpretation in dataset.ts.
  push({
    key: "demo-approved-old", owner: "demo-borrower", state: "declined_by_borrower",
    outcome: "approved", loanType: "conventional", propertyType: "single-family-detached",
    estimatedValue: 450_000, loanAmount: 315_000, monthlyIncome: 9100,
    tierDigit: 2, submittedDaysAgo: 135, decidedDaysAgo: 122, closedDaysAgo: 98,
    assignee: "demo-caseworker", assignmentMethod: "manual",
    l1: { by: "sup-1", decision: "approve", daysAgo: 122 },
    docsMode: "full", demographics: "full", bankLink: true,
    previousAddressAndEmployer: true,
  });
  // 4) Withdrawn.
  push({
    key: "demo-withdrawn", owner: "demo-borrower", state: "withdrawn",
    loanType: "conventional", propertyType: "condominium",
    estimatedValue: 310_000, loanAmount: 226_300, monthlyIncome: 7400,
    tierDigit: 3, submittedDaysAgo: 230, closedDaysAgo: 226,
    docsMode: "partial", demographics: "mixed",
  });

  // ---- Demo Caseworker persona: 8 ACTIVE assignments ----------------------
  // Priorities span urgent/high/normal/low; SLA spans on-track/at-risk/overdue.
  push({
    key: "dcw-ar-urgent", state: "application_received", assignee: "demo-caseworker",
    assignmentMethod: "claim", submittedDaysAgo: 1, sla: "on-track",
    priority: "urgent", targetClosingOffsetDays: 7,
    loanType: "va", militaryService: true, docsMode: "partial", coBorrower: { tierDigit: 1, employer: cleanEmployer(9), monthlyIncome: 4800 },
  });
  push({
    key: "dcw-ar-overdue", state: "application_received", assignee: "demo-caseworker",
    assignmentMethod: "manual", submittedDaysAgo: 14, sla: "overdue",
    priority: "normal", loanType: "fha", docsMode: "partial",
    previousAddressAndEmployer: true,
  });
  push({
    key: "dcw-cv-chatter", state: "completeness_validated", assignee: "demo-caseworker",
    assignmentMethod: "claim", submittedDaysAgo: 6, sla: "on-track",
    priority: "normal", chatterFromSupervisor: true, docsMode: "partial",
    giftFunds: true, demographics: "mixed",
  });
  push({
    key: "dcw-dr-fraud", state: "documents_received", assignee: "demo-caseworker",
    assignmentMethod: "claim", submittedDaysAgo: 8, sla: "at-risk",
    priority: "normal", employer: FRAUD_EMPLOYER, monthlyIncome: 7900,
    fraud: "income-variance", fraudStatus: "open", docsMode: "full",
    documentRequest: "pending",
  });
  push({
    key: "dcw-aus-stale", state: "aus_executed", assignee: "demo-caseworker",
    assignmentMethod: "claim", submittedDaysAgo: 9, sla: "on-track",
    priority: "high", targetClosingOffsetDays: 21, staleAus: true,
    docsMode: "full", previousAddressAndEmployer: true,
  });
  push({
    key: "dcw-pd", state: "preliminary_decision", assignee: "demo-caseworker",
    assignmentMethod: "claim", submittedDaysAgo: 10, sla: "on-track",
    priority: "normal", docsMode: "full", tierDigit: 2, blurryDoc: true,
    militaryService: true,
  });
  push({
    key: "dcw-ca-conditions", state: "conditional_approval", assignee: "demo-caseworker",
    assignmentMethod: "manual", submittedDaysAgo: 18, sla: "on-track",
    priority: "low", priorityOverridden: true,
    l1: {
      by: "sup-2", decision: "approve", daysAgo: 4,
      conditions: ["Provide an updated pay stub dated within 30 days", "Provide a homeowners insurance quote for the subject property"],
    },
    conditionsCleared: 1, docsMode: "full", fixtureDocs: true, giftFunds: true,
    estimatedValue: 400_000, loanAmount: 300_000, monthlyIncome: 8800, tierDigit: 0,
  });
  // 8th active assignment = the Demo Borrower's Revision Requested app above
  // ("demo-rr", assignee demo-caseworker) — interconnected staging.

  // ---- Demo Supervisor persona / Escalated Review -------------------------
  push({
    key: "er-va-l1-sup1", state: "escalated_review", assignee: "cw-red",
    assignmentMethod: "manual", submittedDaysAgo: 11, sla: "on-track",
    priority: "normal", loanType: "va", militaryService: true,
    l1: { by: "sup-1", decision: "approve", daysAgo: 2 },
    docsMode: "full", expectEscalated: true, coBorrower: { tierDigit: 3, employer: cleanEmployer(12), monthlyIncome: 5100 },
  });
  push({
    key: "er-lowavm-l1-sup2", state: "escalated_review", assignee: "cw-yellow",
    assignmentMethod: "auto", submittedDaysAgo: 13, sla: "at-risk",
    priority: "normal", loanType: "conventional",
    estimatedValue: 500_000, loanAmount: 390_000, // stated LTV 78; AVM 0.90 → ~86.7 > 80
    monthlyIncome: 5400, // high DTI side (>43) jointly with housing+debts
    zipLastDigits: [7], // §6.3.3 low-appraisal band
    l1: { by: "sup-2", decision: "approve", daysAgo: 1 },
    docsMode: "full", expectEscalated: true,
  });
  push({
    key: "er-fha-l1-demo", state: "escalated_review", assignee: "cw-green-c",
    assignmentMethod: "manual", submittedDaysAgo: 12, sla: "on-track",
    priority: "high", targetClosingOffsetDays: 20, loanType: "fha",
    estimatedValue: 380_000, loanAmount: 361_000, // LTV 95
    l1: { by: "demo-supervisor", decision: "approve", daysAgo: 1 },
    docsMode: "full", expectEscalated: true, previousAddressAndEmployer: true,
  });

  // ---- Preliminary Decision (4, all awaiting L1) --------------------------
  push({
    key: "pd-red", state: "preliminary_decision", assignee: "cw-red",
    assignmentMethod: "claim", submittedDaysAgo: 7, sla: "on-track",
    priority: "normal", docsMode: "full", giftFunds: true,
    previousAddressAndEmployer: true,
  });
  push({
    key: "pd-yellow-high", state: "preliminary_decision", assignee: "cw-yellow",
    assignmentMethod: "auto", submittedDaysAgo: 9, sla: "on-track",
    priority: "high", estimatedValue: 1_400_000, loanAmount: 1_050_000, monthlyIncome: 24_000,
    docsMode: "full", fixtureDocs: false, loanType: "fha",
  });
  push({
    key: "pd-green-b", state: "preliminary_decision", assignee: "cw-green-b",
    assignmentMethod: "manual", submittedDaysAgo: 8, sla: "on-track",
    priority: "normal", docsMode: "full", coBorrower: { tierDigit: 0, employer: cleanEmployer(15), monthlyIncome: 6100 },
  });
  // (4th PD is dcw-pd above.)

  // ---- Conditional Approval (2 more) --------------------------------------
  push({
    key: "ca-red", state: "conditional_approval", assignee: "cw-red",
    assignmentMethod: "manual", submittedDaysAgo: 20, sla: "on-track",
    priority: "normal", estimatedValue: 430_000, loanAmount: 322_500, monthlyIncome: 10_200,
    l1: { by: "sup-3", decision: "approve", daysAgo: 5, conditions: ["Provide two months of bank statements for the gift-fund account", "Written explanation of the recent credit inquiry"] },
    conditionsCleared: 0, docsMode: "full", giftFunds: true,
  });
  push({
    key: "ca-yellow", state: "conditional_approval", assignee: "cw-yellow",
    assignmentMethod: "bulk", submittedDaysAgo: 16, sla: "on-track",
    priority: "normal", estimatedValue: 410_000, loanAmount: 307_500, monthlyIncome: 9_600,
    l1: { by: "sup-1", decision: "approve", daysAgo: 3, conditions: ["Provide the fully executed purchase agreement addendum"] },
    conditionsCleared: 0, docsMode: "full", bankLink: true,
    coBorrower: { tierDigit: 1, employer: cleanEmployer(37), monthlyIncome: 6400 },
  });

  // ---- Suspended (1) ------------------------------------------------------
  push({
    key: "susp-green-a", state: "suspended", assignee: "cw-green-a",
    assignmentMethod: "manual", submittedDaysAgo: 15,
    priority: "normal", docsMode: "partial", demographics: "not-provided",
  });

  // ---- Revision Requested (1 more) ----------------------------------------
  push({
    key: "rr-red", state: "revision_requested", assignee: "cw-red",
    assignmentMethod: "claim", submittedDaysAgo: 10, sla: "on-track",
    priority: "normal", loanType: "fha", docsMode: "partial", formalNote: true,
  });

  // ---- Application Received: 5 claimable unassigned + assigned fillers ----
  push({ key: "ar-unassigned-1", state: "application_received", submittedDaysAgo: 1, sla: "on-track", priority: "normal", docsMode: "partial", loanType: "usda", giftFunds: true });
  push({ key: "ar-unassigned-2", state: "application_received", submittedDaysAgo: 2, sla: "on-track", priority: "high", targetClosingOffsetDays: 25, docsMode: "partial", ssnShareWith: "cv-red-dupssn", fraud: "duplicate-ssn", fraudStatus: "open", tierDigit: 1 });
  push({ key: "ar-unassigned-3", state: "application_received", submittedDaysAgo: 3, sla: "at-risk", priority: "normal", docsMode: "partial", loanType: "va", militaryService: true, previousAddressAndEmployer: true });
  push({ key: "ar-unassigned-4", state: "application_received", submittedDaysAgo: 2, sla: "on-track", priority: "urgent", targetClosingOffsetDays: 10, docsMode: "partial", coBorrower: { tierDigit: 4, employer: cleanEmployer(18), monthlyIncome: 4400 } });
  push({ key: "ar-unassigned-5", state: "application_received", submittedDaysAgo: 4, sla: "on-track", priority: "normal", docsMode: "none", loanType: "fha", demographics: "not-provided" });
  push({ key: "ar-red-1", state: "application_received", assignee: "cw-red", assignmentMethod: "bulk", submittedDaysAgo: 3, sla: "on-track", priority: "normal", docsMode: "partial", failDoc: true, loanType: "va", militaryService: true });
  push({ key: "dr-red-unverified", state: "documents_received", assignee: "cw-red", assignmentMethod: "bulk", submittedDaysAgo: 5, sla: "at-risk", priority: "high", targetClosingOffsetDays: 28, docsMode: "full", employer: UNVERIFIED_EMPLOYER, fraud: "employer-unverified", fraudStatus: "open" });

  // ---- Completeness Validated (5 more) ------------------------------------
  push({ key: "cv-red-dupssn", state: "completeness_validated", assignee: "cw-red", assignmentMethod: "claim", submittedDaysAgo: 6, sla: "on-track", priority: "normal", docsMode: "partial", tierDigit: 1 });
  push({ key: "cv-red-2", state: "completeness_validated", assignee: "cw-red", assignmentMethod: "manual", submittedDaysAgo: 7, sla: "at-risk", priority: "normal", loanType: "fha", docsMode: "partial", twoVersions: true, previousAddressAndEmployer: true });
  push({ key: "cv-yellow-1", state: "completeness_validated", assignee: "cw-yellow", assignmentMethod: "auto", submittedDaysAgo: 5, sla: "on-track", priority: "normal", docsMode: "partial", loanType: "fha", blurryDoc: true });
  push({ key: "cv-yellow-2", state: "completeness_validated", assignee: "cw-yellow", assignmentMethod: "claim", submittedDaysAgo: 6, sla: "on-track", priority: "high", estimatedValue: 1_250_000, loanAmount: 1_000_000, monthlyIncome: 26_000, docsMode: "partial", loanType: "usda" });
  push({ key: "cv-green-a", state: "completeness_validated", assignee: "cw-green-a", assignmentMethod: "manual", submittedDaysAgo: 8, sla: "on-track", priority: "normal", docsMode: "partial", loanType: "va", militaryService: true, giftFunds: true });

  // ---- Documents Received (6 more) ----------------------------------------
  push({ key: "dr-red-1", state: "documents_received", assignee: "cw-red", assignmentMethod: "claim", submittedDaysAgo: 9, sla: "on-track", priority: "urgent", targetClosingOffsetDays: 6, docsMode: "full", loanType: "fha" });
  push({ key: "dr-red-2", state: "documents_received", assignee: "cw-red", assignmentMethod: "manual", submittedDaysAgo: 11, sla: "on-track", priority: "normal", docsMode: "full", documentRequest: "fulfilled", previousAddressAndEmployer: true, coBorrower: { tierDigit: 0, employer: cleanEmployer(36), monthlyIncome: 6200 } });
  push({ key: "dr-red-3", state: "documents_received", assignee: "cw-red", assignmentMethod: "auto", submittedDaysAgo: 8, sla: "on-track", priority: "normal", mismatchDoc: true, fraud: "ocr-mismatch", fraudStatus: "open", docsMode: "full", bankLink: true });
  push({ key: "dr-yellow-1", state: "documents_received", assignee: "cw-yellow", assignmentMethod: "claim", submittedDaysAgo: 10, sla: "on-track", priority: "low", priorityOverridden: true, docsMode: "full", loanType: "va", militaryService: true, coBorrower: { tierDigit: 2, employer: cleanEmployer(21), monthlyIncome: 5600 } });
  push({ key: "dr-yellow-2", state: "documents_received", assignee: "cw-yellow", assignmentMethod: "bulk", submittedDaysAgo: 16, sla: "overdue", priority: "normal", docsMode: "full", loanType: "fha", giftFunds: true, previousAddressAndEmployer: true });
  push({ key: "dr-yellow-3", state: "documents_received", assignee: "cw-yellow", assignmentMethod: "manual", submittedDaysAgo: 12, sla: "on-track", priority: "normal", docsMode: "full", employer: DISCREPANCY_EMPLOYER, documentRequest: "pending" });

  // ---- AUS Executed (4 more) ----------------------------------------------
  push({ key: "aus-red-1", state: "aus_executed", assignee: "cw-red", assignmentMethod: "claim", submittedDaysAgo: 10, sla: "on-track", priority: "normal", docsMode: "full", loanType: "fha", coBorrower: { tierDigit: 5, employer: cleanEmployer(24), monthlyIncome: 4900 } });
  push({ key: "aus-red-2", state: "aus_executed", assignee: "cw-red", assignmentMethod: "manual", submittedDaysAgo: 12, sla: "at-risk", priority: "normal", docsMode: "full", tierDigit: 4, occupancy: "investment-property", propertyType: "four-unit", previousAddressAndEmployer: true });
  push({ key: "aus-yellow-1", state: "aus_executed", assignee: "cw-yellow", assignmentMethod: "auto", submittedDaysAgo: 11, sla: "on-track", priority: "urgent", targetClosingOffsetDays: 9, docsMode: "full", loanType: "fha", partialCredit: true });
  push({ key: "aus-yellow-2", state: "aus_executed", assignee: "cw-yellow", assignmentMethod: "claim", submittedDaysAgo: 13, sla: "on-track", priority: "normal", docsMode: "full", loanType: "va", militaryService: true, occupancy: "second-home", propertyType: "condominium" });

  // ---- Borrower Notified — approved (5) -----------------------------------
  push({
    key: "bn-app-1", state: "borrower_notified", outcome: "approved",
    assignee: "demo-caseworker", assignmentMethod: "claim",
    submittedDaysAgo: 28, decidedDaysAgo: 15, sla: undefined, priority: "normal",
    l1: { by: "sup-1", decision: "approve", daysAgo: 15 }, docsMode: "full",
    tierDigit: 0, bankLink: true, previousAddressAndEmployer: true,
    estimatedValue: 400_000, loanAmount: 280_000, monthlyIncome: 11_000,
    coBorrower: { tierDigit: 3, employer: cleanEmployer(35), monthlyIncome: 5700 },
  });
  push({
    key: "bn-app-2", state: "borrower_notified", outcome: "approved",
    assignee: "cw-inactive", assignmentMethod: "manual",
    submittedDaysAgo: 60, decidedDaysAgo: 45, priority: "normal",
    l1: { by: "sup-2", decision: "approve", daysAgo: 45 }, docsMode: "full",
    tierDigit: 1, previousAddressAndEmployer: true, militaryService: true,
    estimatedValue: 380_000, loanAmount: 266_000, monthlyIncome: 10_800,
  });
  push({
    key: "bn-app-3-esc-va", state: "borrower_notified", outcome: "approved",
    assignee: "demo-caseworker", assignmentMethod: "claim",
    submittedDaysAgo: 95, decidedDaysAgo: 80, priority: "normal",
    loanType: "va", militaryService: true,
    l1: { by: "sup-1", decision: "approve", daysAgo: 82 },
    l2: { by: "sup-2", decision: "approve", daysAgo: 80 },
    docsMode: "full", expectEscalated: true, coBorrower: { tierDigit: 1, employer: cleanEmployer(27), monthlyIncome: 5900 },
  });
  push({
    key: "bn-app-4-esc-fha", state: "borrower_notified", outcome: "approved",
    assignee: "cw-green-d", assignmentMethod: "manual",
    submittedDaysAgo: 165, decidedDaysAgo: 150, priority: "normal",
    loanType: "fha", estimatedValue: 360_000, loanAmount: 331_200, // LTV 92
    l1: { by: "sup-2", decision: "approve", daysAgo: 152 },
    l2: { by: "sup-3", decision: "approve", daysAgo: 150 },
    docsMode: "full", expectEscalated: true, giftFunds: true,
  });
  push({
    key: "bn-app-5-old", state: "borrower_notified", outcome: "approved",
    assignee: "demo-caseworker", assignmentMethod: "manual",
    submittedDaysAgo: 335, decidedDaysAgo: 320, priority: "normal",
    l1: { by: "sup-3", decision: "approve", daysAgo: 320 }, docsMode: "full",
    tierDigit: 3, previousAddressAndEmployer: true,
    estimatedValue: 440_000, loanAmount: 308_000, monthlyIncome: 11_500,
  });

  // ---- Borrower Notified — denied (3) -------------------------------------
  push({
    key: "bn-den-1", state: "borrower_notified", outcome: "denied",
    assignee: "demo-caseworker", assignmentMethod: "claim",
    submittedDaysAgo: 40, decidedDaysAgo: 25, priority: "normal",
    tierDigit: 7, declarationsProfile: "derog",
    l1: { by: "sup-2", decision: "deny", daysAgo: 25 },
    denialReasons: ["credit-history", "dti"], docsMode: "full",
    monthlyIncome: 5200,
  });
  push({
    key: "bn-den-2-bounce", state: "borrower_notified", outcome: "denied",
    assignee: "cw-inactive", assignmentMethod: "manual",
    submittedDaysAgo: 145, decidedDaysAgo: 130, priority: "normal",
    tierDigit: 8, loanType: "fha",
    l1: { by: "sup-3", decision: "deny", daysAgo: 130 },
    denialReasons: ["credit-history", "collateral", "other"], docsMode: "full",
  });
  push({
    key: "bn-den-3-old", state: "borrower_notified", outcome: "denied",
    assignee: "demo-caseworker", assignmentMethod: "claim",
    submittedDaysAgo: 355, decidedDaysAgo: 340, priority: "normal",
    tierDigit: 8, declarationsProfile: "derog",
    l1: { by: "sup-1", decision: "deny", daysAgo: 340 },
    denialReasons: ["unverifiable-information", "insufficient-cash"], docsMode: "full",
    monthlyIncome: 4900,
  });

  // ---- Withdrawn / Declined fillers ---------------------------------------
  push({
    key: "wd-usda", state: "withdrawn", assignee: "demo-caseworker", assignmentMethod: "claim",
    submittedDaysAgo: 62, closedDaysAgo: 58, priority: "normal",
    loanType: "usda", docsMode: "partial",
  });
  push({
    key: "decl-ca", state: "declined_by_borrower", outcome: "approved",
    assignee: "cw-green-d", assignmentMethod: "manual",
    submittedDaysAgo: 100, decidedDaysAgo: 90, closedDaysAgo: 70, priority: "normal",
    l1: { by: "sup-1", decision: "approve", daysAgo: 90, conditions: ["Provide an updated homeowners insurance binder"] },
    conditionsCleared: 0,
    estimatedValue: 420_000, loanAmount: 294_000, monthlyIncome: 10_500,
    docsMode: "full",
  });

  // ---- Drafts (7 more) ----------------------------------------------------
  push({ key: "draft-ltv-block", state: "draft", docsMode: "none", estimatedValue: 500_000, loanAmount: 490_000, priority: "normal" }); // LTV 98 (> 97 submission block side)
  push({ key: "draft-pricing-fault", state: "draft", docsMode: "none", loanAmount: 999_999, estimatedValue: 1_300_000, priority: "normal", monthlyIncome: 21_000 }); // §6.3.4 invalid-response trigger
  push({ key: "draft-credit-fault", state: "draft", docsMode: "none", tierDigit: 9, priority: "normal" }); // §6.3.1 unavailable-then-retry
  push({ key: "draft-usda", state: "draft", docsMode: "none", loanType: "usda", priority: "normal", loanTermMonths: 120, coBorrower: { tierDigit: 6, employer: cleanEmployer(30), monthlyIncome: 3900 } });
  push({ key: "draft-fha", state: "draft", docsMode: "none", loanType: "fha", priority: "normal", demographics: "not-provided", coBorrower: { tierDigit: 5, employer: cleanEmployer(31), monthlyIncome: 4100 } });
  push({ key: "draft-va", state: "draft", docsMode: "none", loanType: "va", militaryService: true, priority: "normal", coBorrower: { tierDigit: 4, employer: cleanEmployer(32), monthlyIncome: 4600 } });
  push({ key: "draft-refi", state: "draft", docsMode: "none", loanPurpose: "refinance-cash-out", amortizationType: "adjustable", priority: "normal", coBorrower: { tierDigit: 2, employer: cleanEmployer(33), monthlyIncome: 5300 } });

  // Filler co-borrower/military/prevaddr/gift toppers to clear floors are baked
  // into the specs above; assertSpecFloors() re-counts everything.
  return specs;
}

// ---------------------------------------------------------------------------
// Floor assertions (§4.6.12 — every figure is a floor; throw on shortfall)
// ---------------------------------------------------------------------------

export interface FloorReport {
  total: number;
  byState: Record<string, number>;
  bnApproved: number;
  bnDenied: number;
  byLoanType: Record<string, number>;
  coBorrowers: number;
  military: number;
  prevAddrEmployer: number;
  giftFunds: number;
}

export function countFloors(specs: readonly AppSpec[]): FloorReport {
  const byState: Record<string, number> = {};
  const byLoanType: Record<string, number> = {};
  let bnApproved = 0;
  let bnDenied = 0;
  let coBorrowers = 0;
  let military = 0;
  let prevAddrEmployer = 0;
  let giftFunds = 0;
  for (const s of specs) {
    byState[s.state] = (byState[s.state] ?? 0) + 1;
    byLoanType[s.loanType] = (byLoanType[s.loanType] ?? 0) + 1;
    if (s.state === "borrower_notified" && s.outcome === "approved") bnApproved += 1;
    if (s.state === "borrower_notified" && s.outcome === "denied") bnDenied += 1;
    if (s.coBorrower) coBorrowers += 1;
    if (s.militaryService) military += 1;
    if (s.previousAddressAndEmployer) prevAddrEmployer += 1;
    if (s.giftFunds) giftFunds += 1;
  }
  return {
    total: specs.length, byState, bnApproved, bnDenied, byLoanType,
    coBorrowers, military, prevAddrEmployer, giftFunds,
  };
}

const STATE_FLOORS: Record<string, number> = {
  draft: 8,
  application_received: 6,
  completeness_validated: 5,
  documents_received: 5,
  aus_executed: 4,
  preliminary_decision: 4,
  escalated_review: 3,
  conditional_approval: 2,
  revision_requested: 2,
  suspended: 1,
  withdrawn: 1,
  declined_by_borrower: 1,
};

/** Throws with a full shortfall list when any §4.6.12 floor is unmet. */
export function assertSpecFloors(specs: readonly AppSpec[]): FloorReport {
  const r = countFloors(specs);
  const problems: string[] = [];
  if (r.total < 50) problems.push(`total ${r.total} < 50`);
  for (const [state, floor] of Object.entries(STATE_FLOORS)) {
    if ((r.byState[state] ?? 0) < floor) problems.push(`${state} ${(r.byState[state] ?? 0)} < ${floor}`);
  }
  if (r.bnApproved < 5) problems.push(`borrower_notified(approved) ${r.bnApproved} < 5`);
  if (r.bnDenied < 3) problems.push(`borrower_notified(denied) ${r.bnDenied} < 3`);
  const loanFloors: Record<string, number> = { conventional: 26, fha: 12, va: 8, usda: 4 };
  for (const [lt, floor] of Object.entries(loanFloors)) {
    if ((r.byLoanType[lt] ?? 0) < floor) problems.push(`loanType ${lt} ${(r.byLoanType[lt] ?? 0)} < ${floor}`);
  }
  if (r.coBorrowers < 15) problems.push(`coBorrowers ${r.coBorrowers} < 15`);
  if (r.military < 10) problems.push(`militaryService ${r.military} < 10`);
  if (r.prevAddrEmployer < 12) problems.push(`previousAddressAndEmployer ${r.prevAddrEmployer} < 12`);
  if (r.giftFunds < 8) problems.push(`giftFunds ${r.giftFunds} < 8`);
  // Priority + SLA coverage (every value — §4.6.12).
  const priorities = new Set(specs.map((s) => s.priority));
  for (const p of ["urgent", "high", "normal", "low"]) {
    if (!priorities.has(p as Priority)) problems.push(`priority ${p} not covered`);
  }
  const slas = new Set(specs.map((s) => s.sla).filter(Boolean));
  for (const v of ["on-track", "at-risk", "overdue"]) {
    if (!slas.has(v as SlaStatusValue)) problems.push(`sla ${v} not covered`);
  }
  if (problems.length > 0) {
    throw new Error(`demo seed spec floors unmet: ${problems.join("; ")}`);
  }
  return r;
}

/** All employers referenced anywhere (used by evidence and doc content). */
export const ALL_EMPLOYERS = [...CLEAN_EMPLOYERS, FRAUD_EMPLOYER, UNVERIFIED_EMPLOYER, DISCREPANCY_EMPLOYER];
