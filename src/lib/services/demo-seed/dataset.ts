// Demo-seed dataset BUILDER (task-043, REQ-066, RFP §4.6.12 / §6.4, ASYNC-006).
//
// Creates the full §4.6.12 demo dataset inside the caller's open transaction
// (single-tx boundary). Interconnectedness strategy (profile Seed Data Quality
// Rules): CPU-heavy material (argon2 hashes) is prepared BEFORE the
// transaction; inside the transaction every DERIVED value is produced by the
// REAL engines — application numbers by `generateApplicationNumber` (INV-014
// sequence), dti/ltv/cltv by `computeApplicationQualification`, escalation by
// `evaluateEscalation`, signature dataHash by `computeApplicationDataHash`,
// version snapshots by `buildVersionSnapshot`, underwriting payloads by the
// §6.3 pure simulations, OCR extractions by `simulateOcrExtraction`, and OCR
// fraud candidates by the exported task-027 predicates — so aggregates
// reconcile with source rows BY CONSTRUCTION, and seed-time assertions throw
// on any drift (floors, escalation expectations, §6.4 coverage).
//
// DOCUMENTED INTERPRETATIONS (contract-silent / contract-tension decisions):
//   1. INV-016 vs §4.6.12 Demo Borrower staging: the shipped one-active partial
//      unique index counts `borrower_notified` as ACTIVE, so Demo Borrower
//      cannot simultaneously own a Revision Requested application AND a
//      Borrower Notified (approved) one. The Revision Requested staging keeps
//      the single active slot (it powers FLOW-004's revision loop, the formal
//      note, and the unread notification); the ">90-day approved copy source"
//      is staged as `declined_by_borrower` with outcome=approved whose history
//      shows a >90-day-old borrower_notified stay — its section-save
//      timestamps are >90 days old, so it still triggers the §4.2.3 staleness
//      advisory as a copy source. Flagged as a namedOpenDefects candidate.
//   2. Historical seeded audit entries are written directly (with backdated
//      `timestamp` and isSeed=true) because the task-003 `audit()` API cannot
//      backdate; the LIVE seed/remove ACTION audits go through `audit()` and
//      are NOT seed-flagged (they must survive Remove Demo Data as the record
//      that it happened).
//   3. Seeded notifications addressed to demo accounts always carry a seeded
//      applicationId, so Remove Demo Data can find them (Notification has no
//      isSeed column; removal deletes notifications whose recipient is seeded
//      OR whose application is seeded).
//   4. `avm-low` FraudFlag type is not seedable consistently (the §6.3.3 value
//      factor never goes below 0.90, above the 0.85 flag threshold), so the
//      seeded flag mix covers the other four types; the low-AVM §6.4 scenario
//      is exercised through the LTV>threshold escalation instead.

import { randomUUID, createHash } from "node:crypto";
import type { Prisma, UserRole, WorkflowState } from "@prisma/client";
import { AUDIT_ACTION_TYPES, type AuditActionType } from "@/lib/services/audit";
import { generateApplicationNumber } from "@/lib/services/application";
import { APPLICATION_INCLUDE, buildVersionSnapshot, type ApplicationWithRelations } from "@/lib/services/application-serializer";
import { computeApplicationDataHash } from "@/lib/services/signature-validity";
import { computeApplicationQualification } from "@/lib/services/qualification";
import { evaluateEscalation } from "@/lib/services/approval";
import { encryptField, encryptFieldToJson } from "@/lib/crypto/encryption";
import { ssnBlindIndex, ssnLast4 } from "@/lib/crypto/ssn";
import { formatDobDisplay } from "@/lib/crypto/masking";
import { newStorageKey } from "@/lib/services/storage";
import { ATTESTATION_TEXT, ATTESTATION_VERSION } from "@/lib/services/signature";
import { SIMULATED_INSTITUTIONS } from "@/lib/services/bank-aggregator";
import { getCompanyTimeZone } from "@/lib/services/sla";
import { classifySlaStatus, netBusinessMinutes, type SlaStatusValue } from "@/lib/pure/sla";
import { buildChecklistSpecs, type ChecklistInput } from "@/lib/pure/checklist";
import { simulateBorrowerCredit, composeCreditCheckResult, type BorrowerCreditReport } from "@/lib/pure/simulations/credit";
import { simulateIncomeVerification, type IncomeEmploymentInput } from "@/lib/pure/simulations/income";
import { simulateAvm } from "@/lib/pure/simulations/avm";
import { simulateAus, hasDerogatoryWithin24Months } from "@/lib/pure/simulations/aus";
import { simulatePricing, monthlyPayment } from "@/lib/pure/simulations/pricing";
import { simulateOcrExtraction, type OcrEnteredData } from "@/lib/pure/simulations/ocr";
// The VR-132 window arithmetic authority — imported rather than re-implemented
// so the seeded address intervals cannot drift from the rule that checks them.
import { monthsBefore } from "@/lib/pure/urla-validation";
import { ocrMaterialFindings, ocrMismatchCandidate } from "@/lib/services/fraud";
import type { CreditCheckResult, IncomeCheckResult, AvmCheckResult, PricingCheckResult, AusCheckResult } from "@/lib/pure/simulations/check-results";
import {
  FIXTURE_BANK_BALANCE, FIXTURE_BANK_INSTITUTION, FIXTURE_BANK_LAST4,
  FIXTURE_GIFT_AMOUNT, FIXTURE_GIFT_DONOR,
  SEED_SIGNATURE_PNG, addressShapeFor, daysAgo, formatAddressText, hoursAgo,
  isoDateOffset, makeSeedPdf, personName, syntheticSsn, type AddressShape,
} from "@/lib/services/demo-seed/content";
import { geocodeAddress } from "@/lib/services/geocoding";
import {
  STAFF_SPECS, assertSpecFloors, buildAppSpecs, type AppSpec, type StaffSpec,
} from "@/lib/services/demo-seed/specs";

// ---------------------------------------------------------------------------
// Shared runtime shapes
// ---------------------------------------------------------------------------

export interface DemoAccountRefs {
  borrower: { id: string; firstName: string; lastName: string; email: string };
  caseworker: { id: string; firstName: string; lastName: string; email: string };
  supervisor: { id: string; firstName: string; lastName: string; email: string };
}

export interface PreparedStaff {
  spec: StaffSpec;
  id: string;
  passwordHash: string;
  mfaSecret: ReturnType<typeof encryptField>;
}

export interface PreparedBorrowerUser {
  ownerIndex: number;
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
}

export interface PreparedIdentities {
  staff: PreparedStaff[];
  borrowers: PreparedBorrowerUser[];
  specs: AppSpec[];
}

export interface FileWrite {
  key: string;
  bytes: Buffer;
}

export interface SeedBuildResult {
  counts: Record<string, number>;
  fileWrites: FileWrite[];
}

/**
 * Prepare CPU-heavy identity material OUTSIDE the transaction: password hashes
 * (random, immediately discarded — seeded accounts can never sign in) and MFA
 * secrets. Deterministic structure; random secrets.
 */
export async function prepareIdentities(
  hashPassword: (pw: string) => Promise<string>,
): Promise<PreparedIdentities> {
  const specs = buildAppSpecs();
  assertSpecFloors(specs);

  const ownerIndices = [...new Set(specs.map((s) => s.owner).filter((o): o is number => typeof o === "number"))];

  // One random password per account, hashed, then discarded — undisclosed.
  const hashOne = async () => hashPassword(randomUUID() + randomUUID());

  const staff: PreparedStaff[] = [];
  for (const spec of STAFF_SPECS) {
    staff.push({
      spec,
      id: randomUUID(),
      passwordHash: await hashOne(),
      mfaSecret: encryptField(randomUUID().replace(/-/g, "").toUpperCase()),
    });
  }
  const borrowers: PreparedBorrowerUser[] = [];
  for (const ownerIndex of ownerIndices) {
    const { firstName, lastName } = personName(ownerIndex + 17);
    borrowers.push({
      ownerIndex,
      id: randomUUID(),
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${ownerIndex}@${ownerIndex === bounceOwnerIndex(specs) ? "bounce.example" : "seedmail.example"}`,
      passwordHash: await hashOne(),
    });
  }
  return { staff, borrowers, specs };
}

/** Owner index of the bn-den-2-bounce spec (delivery-failure staging §6.3.8). */
function bounceOwnerIndex(specs: readonly AppSpec[]): number {
  const spec = specs.find((s) => s.key === "bn-den-2-bounce");
  return typeof spec?.owner === "number" ? spec.owner : -1;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

class Counts {
  readonly map: Record<string, number> = {};
  bump(model: string, n = 1): void {
    this.map[model] = (this.map[model] ?? 0) + n;
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Cast a plain serializable structure to Prisma's JSON input type. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Deterministic DOB (age 30-47 at seed time). */
function dobFor(i: number, now: Date): string {
  const year = now.getUTCFullYear() - 30 - (i % 18);
  const month = (i % 12) + 1;
  const day = (i % 27) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function phoneFor(i: number): string {
  return `555-${String(100 + (i % 900)).padStart(3, "0")}-${String(1000 + ((i * 37) % 9000)).padStart(4, "0")}`;
}

/** Strictly increasing times spread across (start, end]. */
function spreadTimes(start: Date, end: Date, n: number): Date[] {
  const s = start.getTime();
  const e = Math.max(end.getTime(), s + n * 60_000);
  const out: Date[] = [];
  for (let k = 1; k <= n; k += 1) out.push(new Date(s + ((e - s) * k) / n));
  return out;
}

/**
 * INV-049 (CH-023): forward-offset event derivation clamp. A seeded EVENT
 * timestamp derived by offsetting forward from another seeded event must
 * never pass seed-time `now` — clamp to it. Validity bounds (e.g. a token's
 * expiresAt) are not events and are deliberately NOT clamped.
 */
function forwardOf(anchor: Date, offsetMs: number, now: Date): Date {
  return new Date(Math.min(anchor.getTime() + offsetMs, now.getTime()));
}

/** §4.4.1 per-state SLA business-day defaults (timestamp placement only). */
const SLA_TARGET_DAYS: Partial<Record<WorkflowState, number>> = {
  application_received: 2,
  completeness_validated: 3,
  documents_received: 2,
  aus_executed: 2,
  preliminary_decision: 2,
  escalated_review: 2,
  conditional_approval: 10,
  revision_requested: 10,
};

/**
 * Find a state-entry instant whose CURRENT elapsed business time classifies as
 * `want` for `targetDays`, robust on any calendar day (uses the real pure SLA
 * engine, honoring weekends).
 */
function enteredAtForSla(
  now: Date,
  targetDays: number,
  want: SlaStatusValue,
  timeZone: string,
): Date {
  for (let h = 1; h <= 24 * 40; h += 1) {
    const cand = hoursAgo(now, h);
    const elapsed = netBusinessMinutes(cand, now, [], timeZone);
    const got = classifySlaStatus(elapsed, targetDays);
    if (got === want) {
      if (want === "at-risk") {
        // nudge 2h deeper into the band so the badge survives a long evidence run
        const nudged = hoursAgo(now, h + 2);
        const nudgedElapsed = netBusinessMinutes(nudged, now, [], timeZone);
        return classifySlaStatus(nudgedElapsed, targetDays) === "at-risk" ? nudged : cand;
      }
      if (want === "overdue") return hoursAgo(now, h + 36); // deep margin — stays overdue
      return cand; // on-track: smallest offset
    }
  }
  throw new Error(`enteredAtForSla: no instant found for ${want}/${targetDays}d`);
}

/** Local mirror of the task-025 summary/riskBadge composition (private there). */
function summarizeCheck(
  checkType: "credit" | "income" | "avm" | "pricing" | "aus",
  payload: CreditCheckResult | IncomeCheckResult | AvmCheckResult | PricingCheckResult | AusCheckResult,
): { summary: string; riskBadge: "green" | "yellow" | "red" | null } {
  switch (checkType) {
    case "credit": {
      const credit = payload as CreditCheckResult;
      const score = credit.qualifyingScore ?? credit.middleScore;
      const tierLabel = credit.riskTier === "good" ? "Good" : credit.riskTier === "fair" ? "Fair" : credit.riskTier === "poor" ? "Poor" : null;
      const badge = credit.riskTier === "good" ? "green" : credit.riskTier === "fair" ? "yellow" : credit.riskTier === "poor" ? "red" : null;
      return { summary: `credit: score ${score ?? "unavailable"}${tierLabel ? `, tier ${tierLabel}` : ""}`, riskBadge: badge };
    }
    case "income": {
      const income = payload as IncomeCheckResult;
      const rows = income.employments;
      const verified = rows.filter((r) => r.employerVerified).length;
      const maxVariance = rows.reduce((m, r) => (typeof r.variancePct === "number" && r.variancePct > m ? r.variancePct : m), 0);
      const anyUnverified = rows.some((r) => !r.employerVerified);
      const badge = anyUnverified || maxVariance > 10 ? "red" : maxVariance > 5 ? "yellow" : "green";
      return { summary: `income: ${verified}/${rows.length} employers verified, max variance ${maxVariance.toFixed(1)}%`, riskBadge: badge };
    }
    case "avm": {
      const avm = payload as AvmCheckResult;
      const ltv = typeof avm.recomputedLtv === "number" ? avm.recomputedLtv : null;
      const badge = ltv === null ? null : ltv <= 80 ? "green" : ltv <= 95 ? "yellow" : "red";
      return {
        summary: `avm: value $${Math.round(avm.estimatedValue).toLocaleString("en-US")}${ltv === null ? "" : `, AVM LTV ${ltv.toFixed(1)}%`}`,
        riskBadge: badge,
      };
    }
    case "pricing": {
      const pricing = payload as PricingCheckResult;
      const par = pricing.scenarios.find((s) => s.name === "par") ?? pricing.scenarios[0];
      const base = typeof pricing.baseRate === "number" ? pricing.baseRate : null;
      const delta = par && base !== null ? par.interestRate - base : null;
      const badge = delta === null ? null : delta <= 0.25 ? "green" : delta <= 0.75 ? "yellow" : "red";
      return {
        summary: `pricing: par ${par ? `${par.interestRate.toFixed(3)}%` : "unavailable"}${base !== null ? ` (base ${base.toFixed(3)}%)` : ""}`,
        riskBadge: badge,
      };
    }
    case "aus": {
      const aus = payload as AusCheckResult;
      const badge = aus.recommendation === "approve-eligible" ? "green" : aus.recommendation === "refer" ? "yellow" : "red";
      return { summary: `aus: ${aus.recommendation}, ${aus.reasons.length} reason(s)`, riskBadge: badge };
    }
  }
}

// ---------------------------------------------------------------------------
// Audit helper (historical, backdated, seed-flagged — see interpretation 2)
// ---------------------------------------------------------------------------

interface SeededAudit {
  timestamp: Date;
  actorUserId: string | null;
  actorRole: UserRole | "SYSTEM" | null;
  actionType: AuditActionType;
  applicationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export async function buildFullDataset(
  tx: Tx,
  now: Date,
  demo: DemoAccountRefs,
  prepared: PreparedIdentities,
): Promise<SeedBuildResult> {
  const counts = new Counts();
  const fileWrites: FileWrite[] = [];
  const audits: SeededAudit[] = [];
  const specs = prepared.specs;

  const staffByKey = new Map(prepared.staff.map((s) => [s.spec.key, s]));
  const borrowerByOwner = new Map(prepared.borrowers.map((b) => [b.ownerIndex, b]));

  const resolveStaffId = (ref: string): string => {
    if (ref === "demo-caseworker") return demo.caseworker.id;
    if (ref === "demo-supervisor") return demo.supervisor.id;
    const found = staffByKey.get(ref);
    if (!found) throw new Error(`unknown staff ref ${ref}`);
    return found.id;
  };
  const staffRole = (ref: string): UserRole =>
    ref === "demo-caseworker" ? "CASEWORKER" : ref === "demo-supervisor" ? "SUPERVISOR" : staffByKey.get(ref)!.spec.role;

  // ---- Staff roster -------------------------------------------------------
  for (const s of prepared.staff) {
    const createdAt = daysAgo(now, 420 - prepared.staff.indexOf(s) * 7);
    await tx.user.create({
      data: {
        id: s.id,
        email: s.spec.email,
        passwordHash: s.passwordHash,
        role: s.spec.role,
        firstName: s.spec.firstName,
        lastName: s.spec.lastName,
        emailVerifiedAt: createdAt,
        status: s.spec.status,
        passwordChangedAt: createdAt,
        isDemo: false,
        isSeed: true,
        lastSignInAt: null,
        createdAt,
        updatedAt: createdAt,
      },
    });
    counts.bump("User");
    await tx.mfaEnrollment.create({
      data: {
        userId: s.id,
        secretCiphertext: new Uint8Array(s.mfaSecret.ciphertext),
        secretKeyId: s.mfaSecret.keyId,
        status: "enrolled",
        verifiedAt: createdAt,
        recoveryCodeHashes: [],
        createdAt,
        updatedAt: createdAt,
      },
    });
    counts.bump("MfaEnrollment");
    await tx.passwordHistory.create({
      data: { userId: s.id, passwordHash: s.passwordHash, createdAt, updatedAt: createdAt },
    });
    counts.bump("PasswordHistory");
    // Consumed staff-invitation token (§9 PasswordResetToken representation).
    await tx.passwordResetToken.create({
      data: {
        userId: s.id,
        tokenHash: sha256Hex(Buffer.from(`seed-invite|${s.id}`)),
        purpose: "invite",
        expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000),
        usedAt: forwardOf(createdAt, 3_600_000, now),
        createdAt,
        updatedAt: createdAt,
      },
    });
    counts.bump("PasswordResetToken");
  }
  // Two expired+revoked historical sessions (§9 Session representation) —
  // token hashes are random-derived, never issued, unreplayable.
  for (const s of prepared.staff.slice(0, 2)) {
    const at = daysAgo(now, 200);
    await tx.session.create({
      data: {
        userId: s.id,
        tokenHash: sha256Hex(Buffer.from(`seed-session|${randomUUID()}`)),
        lastSeenAt: at,
        expiresAt: new Date(at.getTime() + 1_800_000),
        revokedAt: forwardOf(at, 1_700_000, now),
        ip: "203.0.113.10",
        userAgent: "seed-fixture",
        createdAt: at,
        updatedAt: at,
      },
    });
    counts.bump("Session");
  }

  // ---- Borrower users -----------------------------------------------------
  for (const b of prepared.borrowers) {
    const createdAt = daysAgo(now, 370 - (b.ownerIndex % 300));
    await tx.user.create({
      data: {
        id: b.id,
        email: b.email,
        passwordHash: b.passwordHash,
        role: "BORROWER",
        firstName: b.firstName,
        lastName: b.lastName,
        phone: phoneFor(b.ownerIndex),
        emailVerifiedAt: createdAt,
        status: "active",
        passwordChangedAt: createdAt,
        notificationChannel: "email",
        isDemo: false,
        isSeed: true,
        createdAt,
        updatedAt: createdAt,
      },
    });
    counts.bump("User");
    await tx.passwordHistory.create({
      data: { userId: b.id, passwordHash: b.passwordHash, createdAt, updatedAt: createdAt },
    });
    counts.bump("PasswordHistory");
  }

  // ---- Rate-limit buckets (§9 representation; removable by key prefix).
  // windowStart = seed time: an already-expired bucket would be pruned by the
  // live limiter's opportunistic cleanup before evidence could observe it.
  for (let k = 0; k < 2; k += 1) {
    await tx.rateLimitBucket.create({
      data: {
        key: `demo-seed:fixture:${k}`,
        windowStart: now,
        count: 3 + k,
        createdAt: now,
        updatedAt: now,
      },
    });
    counts.bump("RateLimitBucket");
  }

  // ---- Applications -------------------------------------------------------
  const coverage = {
    ltvBelow80: false, ltvAbove80: false, ltvBelow97: false, ltvAbove97: false,
    dtiBelow43: false, dtiAbove43: false,
    tiers: new Set<string>(), loanTypes: new Set<string>(),
    propertyTypes: new Set<string>(), occupancies: new Set<string>(),
    lowAvmEscalated: false, incomeVarianceFlag: false, ocrMismatchFlag: false,
    partialCredit: false, creditFaultDigit: false, pricingFaultAmount: false,
  };

  for (let idx = 0; idx < specs.length; idx += 1) {
    const spec = specs[idx]!;
    await createOneApplication(tx, now, spec, idx, specs, {
      demo, staffByKey, borrowerByOwner, resolveStaffId, staffRole,
      counts, fileWrites, audits, coverage,
    });
  }

  // ---- §6.4 coverage assertions ------------------------------------------
  const missing: string[] = [];
  if (!coverage.ltvBelow80 || !coverage.ltvAbove80) missing.push("LTV both sides of 80");
  if (!coverage.ltvBelow97 || !coverage.ltvAbove97) missing.push("LTV both sides of 97");
  if (!coverage.dtiBelow43 || !coverage.dtiAbove43) missing.push("DTI both sides of 43");
  for (const t of ["good", "fair", "poor"]) if (!coverage.tiers.has(t)) missing.push(`credit tier ${t}`);
  for (const lt of ["conventional", "fha", "va", "usda"]) if (!coverage.loanTypes.has(lt)) missing.push(`loan type ${lt}`);
  if (coverage.propertyTypes.size < 8) missing.push(`property types ${coverage.propertyTypes.size}/8`);
  if (coverage.occupancies.size < 3) missing.push(`occupancy types ${coverage.occupancies.size}/3`);
  if (!coverage.lowAvmEscalated) missing.push("low-AVM escalation");
  if (!coverage.incomeVarianceFlag) missing.push("income-variance flag");
  if (!coverage.ocrMismatchFlag) missing.push("ocr-mismatch flag");
  if (!coverage.partialCredit) missing.push("partial credit response");
  if (!coverage.creditFaultDigit) missing.push("credit fault digit 9 staging");
  if (!coverage.pricingFaultAmount) missing.push("pricing $999,999 staging");
  if (missing.length > 0) throw new Error(`§6.4 scenario coverage unmet: ${missing.join("; ")}`);

  // ---- Flush historical audits (backdated, seed-flagged) ------------------
  for (const a of audits) {
    if (!AUDIT_ACTION_TYPES.includes(a.actionType)) {
      throw new Error(`seed audit uses unknown actionType ${a.actionType}`);
    }
    if (a.timestamp.getTime() > now.getTime()) {
      throw new Error(
        `INV-048: seed audit entry is future-dated — ${a.actionType} on ${a.entityType ?? "?"}/${a.entityId ?? "?"} at ${a.timestamp.toISOString()} > seed time ${now.toISOString()}`,
      );
    }
  }
  const CHUNK = 200;
  for (let i = 0; i < audits.length; i += CHUNK) {
    await tx.auditLogEntry.createMany({
      data: audits.slice(i, i + CHUNK).map((a) => ({
        timestamp: a.timestamp,
        actorUserId: a.actorUserId,
        actorRole: a.actorRole,
        actionType: a.actionType,
        applicationId: a.applicationId ?? null,
        entityType: a.entityType ?? null,
        entityId: a.entityId ?? null,
        summary: a.summary,
        before: a.before,
        after: a.after,
        reason: a.reason ?? null,
        ip: "203.0.113.20",
        requestId: null,
        isSeed: true,
        createdAt: a.timestamp,
        updatedAt: a.timestamp,
      })),
    });
  }
  counts.bump("AuditLogEntry", audits.length);

  return { counts: counts.map, fileWrites };
}

// ---------------------------------------------------------------------------
// Per-application creation
// ---------------------------------------------------------------------------

interface BuildCtx {
  demo: DemoAccountRefs;
  staffByKey: Map<string, PreparedStaff>;
  borrowerByOwner: Map<number, PreparedBorrowerUser>;
  resolveStaffId: (ref: string) => string;
  staffRole: (ref: string) => UserRole;
  counts: Counts;
  fileWrites: FileWrite[];
  audits: SeededAudit[];
  coverage: {
    ltvBelow80: boolean; ltvAbove80: boolean; ltvBelow97: boolean; ltvAbove97: boolean;
    dtiBelow43: boolean; dtiAbove43: boolean;
    tiers: Set<string>; loanTypes: Set<string>;
    propertyTypes: Set<string>; occupancies: Set<string>;
    lowAvmEscalated: boolean; incomeVarianceFlag: boolean; ocrMismatchFlag: boolean;
    partialCredit: boolean; creditFaultDigit: boolean; pricingFaultAmount: boolean;
  };
}

interface TransitionStep {
  tid: string;
  from: WorkflowState;
  to: WorkflowState;
  at: Date;
  actorUserId: string | null;
  actorRole: UserRole | "SYSTEM";
  versionNumber?: number;
}

const DECLARATION_KEYS_CLEAN: Record<string, unknown> = {
  aOccupyPrimary: true, a1PriorOwnership: false, bSellerRelationship: false,
  cUndisclosedBorrowing: false, d1OtherMortgageApplication: false,
  d2NewCreditApplication: false, ePriorityLien: false, fCosignerUndisclosed: false,
  gOutstandingJudgments: false, hFederalDebtDelinquent: false, iPartyToLawsuit: false,
  jConveyedTitleInLieu: false, kPreForeclosureSale: false, lForeclosed: false,
  mBankruptcy: false,
};

function declarationsFor(spec: AppSpec, idx: number): Record<string, unknown> {
  const d: Record<string, unknown> = { ...DECLARATION_KEYS_CLEAN };
  d.aOccupyPrimary = spec.occupancy === "primary-residence";
  if (d.aOccupyPrimary && idx % 3 === 0) {
    d.a1PriorOwnership = true;
    d.a1PropertyType = "primary-residence";
    d.a1TitleHeld = idx % 2 === 0 ? "by-yourself" : "jointly-with-spouse";
  }
  if (idx % 9 === 0) { d.cUndisclosedBorrowing = true; d.cAmount = 4000 + (idx % 5) * 500; }
  if (idx % 7 === 0) d.d2NewCreditApplication = true;
  if (spec.declarationsProfile === "derog") {
    d.lForeclosed = true;
    d.mBankruptcy = true;
    d.mBankruptcyType = "chapter-7";
  }
  return d;
}

function demographicsFor(spec: AppSpec, idx: number): Record<string, unknown> {
  if (spec.demographics === "not-provided") {
    return { ethnicity: ["not-provided"], race: ["not-provided"], sex: "not-provided", collectionMethod: "self-reported", visualObservation: false };
  }
  const ethnicities = [["not-hispanic-or-latino"], ["hispanic-or-latino", "mexican"], ["not-hispanic-or-latino"], ["hispanic-or-latino", "puerto-rican"]];
  const races = [["white"], ["black-or-african-american"], ["asian", "asian-indian"], ["white", "american-indian-or-alaska-native"], ["native-hawaiian-or-pacific-islander", "samoan"], ["asian", "chinese"]];
  const sexes = ["female", "male"];
  if (spec.demographics === "mixed") {
    return { ethnicity: ["not-provided"], race: races[idx % races.length], sex: sexes[idx % 2], collectionMethod: "self-reported", visualObservation: false };
  }
  return {
    ethnicity: ethnicities[idx % ethnicities.length],
    race: races[(idx * 3) % races.length],
    sex: sexes[idx % 2],
    collectionMethod: "self-reported",
    visualObservation: false,
  };
}

async function createOneApplication(
  tx: Tx,
  now: Date,
  spec: AppSpec,
  idx: number,
  allSpecs: readonly AppSpec[],
  ctx: BuildCtx,
): Promise<void> {
  const { counts, audits, coverage } = ctx;
  const appId = randomUUID();
  const isDraft = spec.state === "draft";
  const submitted = !isDraft;

  // Owner identity
  const owner =
    spec.owner === "demo-borrower"
      ? { id: ctx.demo.borrower.id, firstName: ctx.demo.borrower.firstName, lastName: ctx.demo.borrower.lastName, email: ctx.demo.borrower.email, ownerIndex: 9999 }
      : { ...ctx.borrowerByOwner.get(spec.owner)!, ownerIndex: spec.owner };

  // ---- Timeline -----------------------------------------------------------
  const timeZone = await getCompanyTimeZone(); // INV-045: resolved at call time
  const slaTarget = SLA_TARGET_DAYS[spec.state];
  let submittedAt: Date | null = null;
  let stateEnteredAt: Date;
  let decidedAt: Date | null = null;
  const closedAt = spec.closedDaysAgo !== undefined ? daysAgo(now, spec.closedDaysAgo) : null;

  if (isDraft) {
    stateEnteredAt = spec.key === "demo-draft" ? hoursAgo(now, 3) : daysAgo(now, 6 + (idx % 30));
  } else if (spec.state === "application_received" && spec.sla && slaTarget) {
    // AR is entered at submission — the SLA badge is pinned by submittedAt itself.
    submittedAt = enteredAtForSla(now, slaTarget, spec.sla, timeZone);
    stateEnteredAt = submittedAt;
  } else {
    submittedAt = daysAgo(now, spec.submittedDaysAgo ?? 10);
    if (spec.decidedDaysAgo !== undefined) decidedAt = daysAgo(now, spec.decidedDaysAgo);
    if (spec.state === "borrower_notified") {
      stateEnteredAt = forwardOf(decidedAt!, 2 * 60_000, now);
    } else if (closedAt) {
      stateEnteredAt = closedAt;
    } else if (spec.sla && slaTarget) {
      stateEnteredAt = enteredAtForSla(now, slaTarget, spec.sla, timeZone);
    } else if (spec.state === "suspended") {
      stateEnteredAt = daysAgo(now, 2);
    } else {
      stateEnteredAt = daysAgo(now, 1);
    }
    if (stateEnteredAt.getTime() <= submittedAt.getTime()) {
      stateEnteredAt = forwardOf(submittedAt, 3_600_000, now);
    }
  }
  const draftCreatedAt = submittedAt ? new Date(submittedAt.getTime() - 4 * 86_400_000) : stateEnteredAt;
  const sectionsSavedAt = submittedAt ? new Date(submittedAt.getTime() - 86_400_000) : stateEnteredAt;

  // ---- Transition path ----------------------------------------------------
  const assigneeId = spec.assignee ? ctx.resolveStaffId(spec.assignee) : null;
  const assigneeRole: UserRole = spec.assignee ? ctx.staffRole(spec.assignee) : "CASEWORKER";
  const cwActor = { id: assigneeId ?? ctx.resolveStaffId("cw-green-d"), role: assigneeRole };
  const l1ById = spec.l1 ? ctx.resolveStaffId(spec.l1.by) : null;
  const l2ById = spec.l2 ? ctx.resolveStaffId(spec.l2.by) : null;

  const steps: TransitionStep[] = [];
  if (submitted && submittedAt) {
    const b = (tid: string, from: WorkflowState, to: WorkflowState, at: Date, actor: "borrower" | "cw" | "l1" | "l2" | "sys" | "sup1") => {
      const actorUserId = actor === "borrower" ? owner.id : actor === "cw" ? cwActor.id : actor === "l1" ? l1ById : actor === "l2" ? l2ById : actor === "sup1" ? ctx.resolveStaffId("sup-1") : null;
      const actorRole: UserRole | "SYSTEM" =
        actor === "borrower" ? "BORROWER" : actor === "cw" ? cwActor.role : actor === "sys" ? "SYSTEM" : "SUPERVISOR";
      steps.push({ tid, from, to, at, actorUserId, actorRole });
    };
    const t1At = submittedAt;
    const preDecisionEnd =
      decidedAt ?? (spec.state === "withdrawn" || spec.state === "revision_requested" || spec.state === "suspended"
        ? stateEnteredAt
        : spec.state === "declined_by_borrower" && !decidedAt
          ? closedAt!
          : stateEnteredAt);

    // INV-049: spreadTimes can extend past `end` (its s + n*60_000 floor) — clamp its outputs.
    const mkMid = (n: number) => spreadTimes(t1At, new Date(preDecisionEnd.getTime() - 60_000), n + 1).slice(0, n).map((d) => forwardOf(d, 0, now));

    switch (spec.state) {
      case "application_received":
        b("T1", "draft", "application_received", t1At, "borrower");
        break;
      case "completeness_validated": {
        if (spec.twoVersions) {
          const [a1, a2] = mkMid(2);
          b("T1", "draft", "application_received", t1At, "borrower");
          b("T4", "application_received", "revision_requested", a1!, "cw");
          steps.push({ tid: "T36", from: "revision_requested", to: "completeness_validated", at: stateEnteredAt, actorUserId: owner.id, actorRole: "BORROWER", versionNumber: 2 });
          void a2;
        } else {
          b("T1", "draft", "application_received", t1At, "borrower");
          b("T3", "application_received", "completeness_validated", stateEnteredAt, "cw");
        }
        break;
      }
      case "documents_received": {
        const [a1] = mkMid(1);
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T3", "application_received", "completeness_validated", a1!, "cw");
        b("T7", "completeness_validated", "documents_received", stateEnteredAt, "cw");
        break;
      }
      case "aus_executed": {
        const [a1, a2] = mkMid(2);
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T3", "application_received", "completeness_validated", a1!, "cw");
        b("T7", "completeness_validated", "documents_received", a2!, "cw");
        b("T11", "documents_received", "aus_executed", stateEnteredAt, "cw");
        break;
      }
      case "preliminary_decision": {
        const [a1, a2, a3] = mkMid(3);
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T3", "application_received", "completeness_validated", a1!, "cw");
        b("T7", "completeness_validated", "documents_received", a2!, "cw");
        b("T11", "documents_received", "aus_executed", a3!, "cw");
        b("T15", "aus_executed", "preliminary_decision", stateEnteredAt, "cw");
        break;
      }
      case "escalated_review": {
        const [a1, a2, a3, a4] = mkMid(4);
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T3", "application_received", "completeness_validated", a1!, "cw");
        b("T7", "completeness_validated", "documents_received", a2!, "cw");
        b("T11", "documents_received", "aus_executed", a3!, "cw");
        b("T15", "aus_executed", "preliminary_decision", a4!, "cw");
        b("T21", "preliminary_decision", "escalated_review", stateEnteredAt, "l1");
        break;
      }
      case "conditional_approval": {
        const [a1, a2, a3, a4] = mkMid(4);
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T3", "application_received", "completeness_validated", a1!, "cw");
        b("T7", "completeness_validated", "documents_received", a2!, "cw");
        b("T11", "documents_received", "aus_executed", a3!, "cw");
        b("T15", "aus_executed", "preliminary_decision", a4!, "cw");
        b("T20", "preliminary_decision", "conditional_approval", stateEnteredAt, "l1");
        break;
      }
      case "borrower_notified": {
        const [a1, a2, a3, a4] = mkMid(4);
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T3", "application_received", "completeness_validated", a1!, "cw");
        b("T7", "completeness_validated", "documents_received", a2!, "cw");
        b("T11", "documents_received", "aus_executed", a3!, "cw");
        b("T15", "aus_executed", "preliminary_decision", a4!, "cw");
        if (spec.outcome === "approved") {
          if (spec.l2) {
            b("T21", "preliminary_decision", "escalated_review", daysAgo(now, spec.l1!.daysAgo), "l1");
            b("T26", "escalated_review", "approved", decidedAt!, "l2");
          } else {
            b("T19", "preliminary_decision", "approved", decidedAt!, "l1");
          }
          b("T27", "approved", "borrower_notified", stateEnteredAt, "sys");
        } else {
          b("T22", "preliminary_decision", "denied", decidedAt!, "l1");
          b("T28", "denied", "borrower_notified", stateEnteredAt, "sys");
        }
        break;
      }
      case "revision_requested":
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T4", "application_received", "revision_requested", stateEnteredAt, "cw");
        break;
      case "suspended":
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T6", "application_received", "suspended", stateEnteredAt, "sup1");
        break;
      case "withdrawn":
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T5", "application_received", "withdrawn", closedAt ?? stateEnteredAt, "borrower");
        break;
      case "declined_by_borrower": {
        const [a1, a2, a3, a4] = mkMid(4);
        b("T1", "draft", "application_received", t1At, "borrower");
        b("T3", "application_received", "completeness_validated", a1!, "cw");
        b("T7", "completeness_validated", "documents_received", a2!, "cw");
        b("T11", "documents_received", "aus_executed", a3!, "cw");
        b("T15", "aus_executed", "preliminary_decision", a4!, "cw");
        if (spec.key === "decl-ca") {
          b("T20", "preliminary_decision", "conditional_approval", decidedAt!, "l1");
          b("T32", "conditional_approval", "declined_by_borrower", closedAt!, "borrower"); // §4.5.3 T32 = Declined by Borrower (LENS-023)
        } else {
          b("T19", "preliminary_decision", "approved", decidedAt!, "l1");
          b("T27", "approved", "borrower_notified", forwardOf(decidedAt!, 2 * 60_000, now), "sys");
          b("T35", "borrower_notified", "declined_by_borrower", closedAt!, "borrower");
        }
        break;
      }
      default:
        throw new Error(`unhandled state path for ${spec.state}`);
    }
  }

  // ---- SSN / names --------------------------------------------------------
  const ssnSourceSpec = spec.ssnShareWith ? allSpecs.find((s) => s.key === spec.ssnShareWith) : undefined;
  const ssnSourceIdx = ssnSourceSpec ? allSpecs.indexOf(ssnSourceSpec) : idx;
  const primarySsn = syntheticSsn(ssnSourceIdx + 3, (ssnSourceSpec ?? spec).tierDigit);
  if (spec.tierDigit === 9) coverage.creditFaultDigit = true;
  if (spec.loanAmount === 999_999) coverage.pricingFaultAmount = true;

  const currentAddress = addressShapeFor(idx + 5, []);
  const subjectAddrShape = addressShapeFor(idx + 200, spec.zipLastDigits);

  // ---- Application row ----------------------------------------------------
  const applicationNumber = await generateApplicationNumber(tx);
  const versionCount = isDraft ? 0 : spec.twoVersions ? 2 : 1;
  const prelim =
    ["preliminary_decision", "escalated_review", "conditional_approval", "borrower_notified"].includes(spec.state) || spec.key === "demo-approved-old" || spec.key === "decl-ca"
      ? spec.outcome === "denied" ? "deny" : spec.state === "conditional_approval" || spec.key === "decl-ca" ? "approve-with-conditions" : "approve"
      : null;

  await tx.application.create({
    data: {
      id: appId,
      applicationNumber,
      borrowerUserId: owner.id,
      workflowState: spec.state,
      previousStateForSuspend: spec.state === "suspended" ? "application_received" : null,
      priority: spec.priority,
      priorityOverride: spec.priorityOverridden ?? false,
      currentVersionNumber: versionCount,
      versionStamp: steps.length + 2,
      submittedAt,
      decidedAt,
      outcome: spec.outcome ?? null,
      stateEnteredAt,
      slaPausedAt: spec.state === "suspended" ? stateEnteredAt : null,
      revisionCycles: spec.twoVersions ? 1 : 0,
      ausStale: spec.staleAus ?? false,
      preliminaryRecommendation: prelim,
      isSeed: true,
      decisionNotificationPending: false,
      createdAt: draftCreatedAt,
      updatedAt: stateEnteredAt,
    },
  });
  counts.bump("Application");
  coverage.loanTypes.add(spec.loanType);
  coverage.propertyTypes.add(spec.propertyType);
  coverage.occupancies.add(spec.occupancy);
  const tier = spec.tierDigit <= 3 ? "good" : spec.tierDigit <= 6 ? "fair" : spec.tierDigit <= 8 ? "poor" : "good";
  coverage.tiers.add(tier);

  // ---- Borrower rows ------------------------------------------------------
  //
  // VR-133 employment coverage. The rule is the gap-free UNION of the
  // employment intervals over the trailing 24 months measured back from the
  // APPLICATION DATE (`Application.createdAt` — see application.ts
  // `applicationDate: app.createdAt`), NOT from `now`. Two arithmetic bugs
  // lived here:
  //   1. every span was offset from `now`, so a file submitted 355 days ago
  //      needed ~1085 days of history and only got 700-1600;
  //   2. the previous job ENDED 20 days BEFORE the current job STARTED for
  //      every idx in 0..299, leaving a hole in the middle of the window.
  // Both are fixed by anchoring the current job's start to the application
  // date plus a full window (800 days > the 731-day maximum of 24 calendar
  // months) and having the previous job overlap that start rather than stop
  // short of it. Overlap is correct under the union rule — concurrent jobs
  // count once, they do not sum.
  const applicationAgeDays = Math.round((now.getTime() - draftCreatedAt.getTime()) / 86_400_000);
  /** Days before `now` that the current job started — always covers the window. */
  const currentJobStartDaysAgo = applicationAgeDays + 800 + (idx % 900);
  /** Previous job ends 15 days AFTER the current job starts (deliberate overlap). */
  const previousJobEndDaysAgo = currentJobStartDaysAgo - 15;

  // ---- VR-132 address coverage (CH-016 / LENS-005) ------------------------
  // Same class of defect as VR-133 above, one field over: previousAddresses
  // rows were emitted with NO fromDate/toDate at all. Under CH-016 an undatable
  // row contributes no coverage AND fails the check outright, so any seeded
  // borrower with a previous address was blocked at the submission gate.
  // The dates are derived from the same anchor the validator uses — the
  // application date walked back by the CURRENT address's declared duration —
  // so the two intervals meet by construction.
  const primaryYearsAtAddress = spec.previousAddressAndEmployer ? 1 : 4 + (idx % 6);
  const primaryMonthsAtAddress = idx % 12;
  /** The instant the borrower moved into the CURRENT address (VR-132 anchor). */
  const currentAddressStartMs = monthsBefore(
    draftCreatedAt.getTime(),
    primaryYearsAtAddress * 12 + primaryMonthsAtAddress,
  );
  const PREVIOUS_ADDRESS_YEARS = 3;
  const PREVIOUS_ADDRESS_MONTHS = 2;
  // One-day overlap: fromDate/toDate are date-only (midnight UTC) while the
  // current-address interval carries the application timestamp's time-of-day,
  // so a toDate on the same calendar day would leave a sub-day hole. Overlap
  // counts once under the union rule — it is correct, not slack.
  const previousAddressToMs = currentAddressStartMs + 86_400_000;
  const previousAddressFromMs = monthsBefore(
    previousAddressToMs,
    PREVIOUS_ADDRESS_YEARS * 12 + PREVIOUS_ADDRESS_MONTHS,
  );
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const useFixtureBank = spec.fixtureDocs === true;
  const primaryEmployment = {
    id: randomUUID(),
    employerName: spec.employer,
    employerAddress: addressShapeFor(idx + 400, []),
    position: ["Senior Analyst", "Operations Manager", "Field Engineer", "Account Executive", "Registered Nurse"][idx % 5],
    startDate: isoDateOffset(now, -currentJobStartDaysAgo),
    yearsInLineOfWork: 4 + (idx % 9),
    selfEmployed: false,
    ownershipShareGte25: false,
    employedByFamilyOrParty: false,
    baseMonthlyIncome: spec.monthlyIncome,
    overtime: idx % 4 === 0 ? 250 : 0,
    bonus: idx % 5 === 0 ? 400 : 0,
    commission: 0,
    militaryEntitlements: spec.militaryService ? 300 : 0,
    otherMonthlyIncome: 0,
  };
  const encSsn = encryptField(primarySsn.replace(/\D/g, ""));
  const encDob = encryptField(dobFor(idx + 4, now));
  const primaryBorrowerId = randomUUID();
  // LENS-019: the §E-preamble REO rule (urla-validation validateAssetsReo) fires
  // when ANY borrower declares A.1 prior ownership OR occupancy is not primary —
  // so the REO array below must be populated exactly when this is true. Only the
  // primary borrower can answer A.1 Yes (co-borrower declarations are always the
  // clean template), so this single object is the authority for a1YesAny.
  const primaryDeclarations = declarationsFor(spec, idx);
  const a1YesAny = primaryDeclarations.a1PriorOwnership === true;
  await tx.borrower.create({
    data: {
      id: primaryBorrowerId,
      applicationId: appId,
      ordinal: 1,
      firstName: owner.firstName,
      lastName: owner.lastName,
      alternateNames: [],
      ssnCiphertext: new Uint8Array(encSsn.ciphertext),
      ssnKeyId: encSsn.keyId,
      ssnLast4: ssnLast4(primarySsn),
      ssnBlindIndex: ssnBlindIndex(primarySsn),
      dateOfBirthCiphertext: new Uint8Array(encDob.ciphertext),
      dateOfBirthKeyId: encDob.keyId,
      citizenship: idx % 11 === 0 ? "permanent-resident-alien" : "us-citizen",
      maritalStatus: spec.coBorrower ? "married" : idx % 3 === 0 ? "unmarried" : idx % 3 === 1 ? "married" : "separated",
      dependentsCount: idx % 4,
      dependentsAges: idx % 4 > 0 ? Array.from({ length: idx % 4 }, (_, k) => 4 + k * 5).join(", ") : null,
      cellPhone: phoneFor(idx + 40),
      email: owner.email,
      creditType: spec.coBorrower ? "joint" : "individual",
      militaryService: asJson(
        spec.militaryService
          ? { served: true, status: idx % 2 === 0 ? "retired-discharged" : "currently-serving", ...(idx % 2 === 1 ? { projectedExpirationDate: isoDateOffset(now, 400) } : {}) }
          : { served: false },
      ),
      currentAddress: asJson(currentAddress),
      housingStatus: idx % 3 === 0 ? "own" : "rent",
      monthlyRent: idx % 3 === 0 ? null : 1650 + (idx % 6) * 90,
      yearsAtAddress: primaryYearsAtAddress,
      monthsAtAddress: primaryMonthsAtAddress,
      previousAddresses: asJson(
        spec.previousAddressAndEmployer
          ? [{
              address: addressShapeFor(idx + 600, []),
              housingStatus: "rent",
              yearsAtAddress: PREVIOUS_ADDRESS_YEARS,
              monthsAtAddress: PREVIOUS_ADDRESS_MONTHS,
              // VR-132 interval endpoints — required at the submission gate.
              fromDate: isoDay(previousAddressFromMs),
              toDate: isoDay(previousAddressToMs),
            }]
          : [],
      ),
      mailingAddress: asJson(currentAddress),
      employmentType: "employed",
      employments: asJson([primaryEmployment]),
      previousEmployments: asJson(
        spec.previousAddressAndEmployer
          ? [{ id: randomUUID(), employerName: "Lakeshore Fabrication Co", employerAddress: addressShapeFor(idx + 700, []), position: "Associate", startDate: isoDateOffset(now, -(previousJobEndDaysAgo + 1200)), endDate: isoDateOffset(now, -previousJobEndDaysAgo), previousGrossMonthlyIncome: Math.round(spec.monthlyIncome * 0.8) }]
          : [],
      ),
      otherIncome: asJson(idx % 6 === 0 ? [{ id: randomUUID(), source: "interest-dividends", monthlyAmount: 150 }] : []),
      declarations: asJson(primaryDeclarations),
      demographics: asJson(demographicsFor(spec, idx)),
      createdAt: sectionsSavedAt,
      updatedAt: sectionsSavedAt,
    },
  });
  counts.bump("Borrower");

  let coBorrowerId: string | null = null;
  if (spec.coBorrower) {
    const coName = personName(idx + 61);
    const coSsn = syntheticSsn(idx + 71, spec.coBorrower.tierDigit);
    const coEncSsn = encryptField(coSsn.replace(/\D/g, ""));
    const coEncDob = encryptField(dobFor(idx + 9, now));
    coBorrowerId = randomUUID();
    await tx.borrower.create({
      data: {
        id: coBorrowerId,
        applicationId: appId,
        ordinal: 2,
        firstName: coName.firstName,
        lastName: owner.lastName,
        alternateNames: [],
        ssnCiphertext: new Uint8Array(coEncSsn.ciphertext),
        ssnKeyId: coEncSsn.keyId,
        ssnLast4: ssnLast4(coSsn),
        ssnBlindIndex: ssnBlindIndex(coSsn),
        dateOfBirthCiphertext: new Uint8Array(coEncDob.ciphertext),
        dateOfBirthKeyId: coEncDob.keyId,
        citizenship: "us-citizen",
        maritalStatus: "married",
        dependentsCount: 0,
        cellPhone: phoneFor(idx + 90),
        email: `co.${owner.email}`,
        creditType: "joint",
        militaryService: asJson({ served: false }),
        currentAddress: asJson(currentAddress),
        housingStatus: idx % 3 === 0 ? "own" : "rent",
        // LENS-019: §E-preamble "monthly rent iff renting" (urla-validation
        // validateAddressHistory) is per-borrower — a renting co-borrower with a
        // null monthlyRent fails the gate exactly as a renting primary would.
        monthlyRent: idx % 3 === 0 ? null : 1725 + (idx % 5) * 85,
        yearsAtAddress: 4,
        monthsAtAddress: 0,
        previousAddresses: asJson([]),
        mailingAddress: asJson(currentAddress),
        employmentType: "employed",
        employments: asJson([{
          id: randomUUID(),
          employerName: spec.coBorrower.employer,
          position: "Coordinator",
          // VR-133 applies per borrower: the co-borrower's single current job
          // must cover the trailing 24 months on its own (it has no previous
          // employment), so it uses the same application-date anchor.
          startDate: isoDateOffset(now, -(applicationAgeDays + 800 + (idx % 700))),
          selfEmployed: false,
          baseMonthlyIncome: spec.coBorrower.monthlyIncome,
        }]),
        previousEmployments: asJson([]),
        otherIncome: asJson([]),
        declarations: asJson({ ...DECLARATION_KEYS_CLEAN, aOccupyPrimary: spec.occupancy === "primary-residence" }),
        demographics: asJson(demographicsFor(spec, idx + 1)),
        createdAt: sectionsSavedAt,
        updatedAt: sectionsSavedAt,
      },
    });
    counts.bump("Borrower");
  }

  // ---- ApplicationData ----------------------------------------------------
  const bankInstitution = useFixtureBank ? FIXTURE_BANK_INSTITUTION : SIMULATED_INSTITUTIONS[idx % SIMULATED_INSTITUTIONS.length]!.name;
  const bankBalance = useFixtureBank ? FIXTURE_BANK_BALANCE : 12_000 + (idx % 9) * 6500;
  const bankLast4 = useFixtureBank ? FIXTURE_BANK_LAST4 : String(3000 + ((idx * 53) % 6999));
  const assetId = randomUUID();
  const assets: Prisma.InputJsonValue = asJson([
    {
      id: assetId,
      accountType: "checking",
      financialInstitution: bankInstitution,
      accountNumber: encryptFieldToJson(`00184472${bankLast4}`),
      accountNumberLast4: bankLast4,
      cashOrMarketValue: bankBalance,
      source: spec.bankLink ? "bank-link" : "manual",
    },
    {
      id: randomUUID(),
      accountType: "savings",
      financialInstitution: bankInstitution,
      accountNumber: encryptFieldToJson(`00920011${String(1000 + (idx % 8999))}`),
      accountNumberLast4: String(1000 + (idx % 8999)),
      cashOrMarketValue: 18_000 + (idx % 5) * 4000,
      source: "manual",
    },
  ]);
  const otherCredits: Prisma.InputJsonValue = asJson(
    spec.giftFunds
      ? [{ id: randomUUID(), type: "gift-of-cash", sourceOrDonor: spec.fixtureDocs ? FIXTURE_GIFT_DONOR : `${personName(idx + 80).firstName} ${owner.lastName}`, value: spec.fixtureDocs ? FIXTURE_GIFT_AMOUNT : 10_000 + (idx % 4) * 2500 }]
      : [],
  );
  const liabilities: Prisma.InputJsonValue = asJson([
    { id: randomUUID(), accountType: "revolving", companyName: "Summit Ridge Card Services", accountNumber: encryptFieldToJson(`4111${String(100000 + idx)}`), accountNumberLast4: String(idx % 10000).padStart(4, "0"), unpaidBalance: 3200 + (idx % 7) * 300, monthlyPayment: 120 + (idx % 5) * 25, paidOffAtClosing: false },
    { id: randomUUID(), accountType: "installment", companyName: "Lakeview Auto Finance", accountNumber: encryptFieldToJson(`77120${String(4000 + idx)}`), accountNumberLast4: String((idx * 7) % 10000).padStart(4, "0"), unpaidBalance: 14_500, monthlyPayment: 340, monthsLeft: 44, paidOffAtClosing: false },
  ]);
  const subjectGeo = geocodeAddress(subjectAddrShape);
  const isPurchase = spec.loanPurpose === "purchase";
  const targetClosingDate = isPurchase ? isoDateOffset(now, spec.targetClosingOffsetDays ?? 60 + (idx % 60)) : undefined;
  const piRate = spec.loanType === "va" ? 6.05 : spec.loanType === "fha" ? 6.15 : spec.loanType === "usda" ? 6.1 : 6.5;
  const firstMortgagePi = spec.loanAmount === 999_999 ? 6300 : Math.round(monthlyPayment(spec.loanAmount, piRate, spec.loanTermMonths) * 100) / 100;
  const proposedHousingExpense = {
    firstMortgagePi,
    homeownersInsurance: 120,
    propertyTaxes: Math.round((spec.estimatedValue * 0.011) / 12),
    ...(spec.propertyType === "condominium" ? { hoaDues: 260 } : {}),
    ...(spec.loanType === "fha" ? { mortgageInsurance: Math.round((spec.loanAmount * 0.0055) / 12) } : {}),
  };

  await tx.applicationData.create({
    data: {
      applicationId: appId,
      assets,
      otherCredits,
      // LENS-019: REO is REQUIRED at the gate when A.1 prior ownership is Yes OR
      // the subject occupancy is not primary (validateAssetsReo). Populate it in
      // exactly those cases so every post-submission app (and every submit-ready
      // draft) clears the gate. The pre-existing demo-variety row (a rental REO
      // with net income, on apps with no decision context) is unchanged; the
      // REQUIRED row added here is DTI-NEUTRAL (netMonthlyRentalIncome 0) so it
      // cannot shift DTI on the decisioned/escalated apps that now carry it and
      // trip the escalation-drift assertions below.
      realEstateOwned: asJson(
        idx % 8 === 0 && !spec.l1
          ? [{ id: randomUUID(), address: addressShapeFor(idx + 800, []), propertyValue: 260_000, status: "retained", intendedOccupancy: "investment-property", monthlyInsuranceTaxesHoa: 310, monthlyRentalIncome: 1900, netMonthlyRentalIncome: 1425, mortgages: [{ id: randomUUID(), creditorName: "Pinehurst Mortgage Co.", accountNumber: encryptFieldToJson(`88332211${idx}`), accountNumberLast4: String(2211), monthlyPayment: 1210, unpaidBalance: 168_000, paidOffAtClosing: false }] }]
          : a1YesAny || spec.occupancy !== "primary-residence"
            ? [{ id: randomUUID(), address: addressShapeFor(idx + 850, []), propertyValue: 285_000, status: "retained", intendedOccupancy: spec.occupancy !== "primary-residence" ? "primary-residence" : "second-home", monthlyInsuranceTaxesHoa: 300, monthlyRentalIncome: 0, netMonthlyRentalIncome: 0, mortgages: [{ id: randomUUID(), creditorName: "Rivermark Bank, N.A.", accountNumber: encryptFieldToJson(`77441100${idx}`), accountNumberLast4: String(1100), monthlyPayment: 1180, unpaidBalance: 171_000, paidOffAtClosing: false }] }]
            : [],
      ),
      liabilities,
      otherLiabilities: asJson(idx % 10 === 0 && !spec.l1 ? [{ id: randomUUID(), type: "child-support", monthlyPayment: 400 }] : []),
      subjectProperty: asJson({
        address: subjectAddrShape,
        geocode: subjectGeo,
        numberOfUnits: spec.numberOfUnits,
        propertyType: spec.propertyType,
        occupancy: spec.occupancy,
        mixedUse: false,
        manufacturedHome: spec.propertyType === "manufactured-home",
        estimatedValue: spec.estimatedValue,
        ...(spec.occupancy === "investment-property" ? { expectedMonthlyRentalIncome: 2400 } : {}),
        titleNames: `${owner.firstName} ${owner.lastName}`,
        titleManner: spec.coBorrower ? "joint-tenancy-right-of-survivorship" : "sole-ownership",
        estate: "fee-simple",
        ...(targetClosingDate ? { targetClosingDate } : {}),
      }),
      loan: asJson({
        loanPurpose: spec.loanPurpose,
        loanType: spec.loanType,
        amortizationType: spec.amortizationType,
        ...(spec.amortizationType === "adjustable" ? { armInitialFixedMonths: 60, armAdjustmentMonths: 12 } : {}),
        loanTermMonths: spec.loanTermMonths,
        requestedLoanAmount: spec.loanAmount,
        downPaymentAmount: Math.max(0, spec.estimatedValue - spec.loanAmount),
        downPaymentSource: spec.giftFunds ? "gift-of-cash" : "checking-savings",
        // LENS-019: §E-preamble "refinance details iff refinance purpose"
        // (validateLoanDetails) requires loan.refinance with originalCost,
        // existingLiens and purposeOfRefinance for any refinance. Fields match
        // refinanceDetailsSchema (strict) verbatim.
        ...(spec.loanPurpose === "refinance-rate-term" || spec.loanPurpose === "refinance-cash-out"
          ? {
              refinance: {
                originalCost: Math.round(spec.estimatedValue * 0.82),
                existingLiens: Math.round(spec.loanAmount * 0.85),
                purposeOfRefinance:
                  spec.loanPurpose === "refinance-cash-out" ? "cash-out" : "no-cash-out",
              },
            }
          : {}),
      }),
      proposedHousingExpense: asJson(proposedHousingExpense),
      createdAt: sectionsSavedAt,
      updatedAt: sectionsSavedAt,
    },
  });
  counts.bump("ApplicationData");

  // ---- Documents ----------------------------------------------------------
  const checklistInput: ChecklistInput = {
    loanType: spec.loanType,
    loanPurpose: spec.loanPurpose,
    downPaymentSource: spec.giftFunds ? "gift-of-cash" : "checking-savings",
    otherCreditTypes: spec.giftFunds ? ["gift-of-cash"] : [],
    borrowers: [
      { ordinal: 1, firstName: owner.firstName, lastName: owner.lastName, employmentType: "employed", employments: [{ selfEmployed: false }] },
      ...(spec.coBorrower ? [{ ordinal: 2, firstName: personName(idx + 61).firstName, lastName: owner.lastName, employmentType: "employed" as const, employments: [{ selfEmployed: false }] }] : []),
    ],
    documents: [],
  };
  const checklist = buildChecklistSpecs(checklistInput);
  // Partial uploads pick the items that exercise this spec's staging (fixture
  // names need w2/pay-stub items; the 'fail' trigger needs a w2 item).
  const partialItems = (() => {
    if (spec.fixtureDocs) {
      const picked = checklist.filter((i) => ["w2", "pay-stub"].includes(i.documentType) && i.key.endsWith("b1"));
      return picked.length > 0 ? picked.slice(0, 2) : checklist.slice(0, 2);
    }
    if (spec.failDoc) {
      const picked = checklist.filter((i) => ["government-id", "w2"].includes(i.documentType) && i.key.endsWith("b1"));
      return picked.length > 0 ? picked.slice(0, 2) : checklist.slice(0, 2);
    }
    return checklist.slice(0, 2);
  })();
  const docSpecs = spec.docsMode === "none" ? [] : spec.docsMode === "partial" ? partialItems : checklist;
  const docsAt = submitted ? forwardOf(sectionsSavedAt, 3_600_000, now) : stateEnteredAt;
  const docStatus = spec.docsMode === "full" ? "accepted" : "pending";
  const docVersionIdByType = new Map<string, string>();
  let firstDocumentId: string | null = null;
  let docCursor = 0;

  const enteredOcr: OcrEnteredData = {
    borrowerFullName: `${owner.firstName} ${owner.lastName}`,
    // LENS-017 / INV-044 / SEC-2: OcrEnteredData.dateOfBirth is persisted to the
    // UNENCRYPTED OcrExtraction.fields column and served to staff, so it must be
    // the "Mon D, YYYY" DISPLAY form — never the raw ISO DOB. The production path
    // (document-ocr.ts assembleEnteredData) decrypts then formatDobDisplay; the
    // seeder must match it (it previously wrote raw ISO here, leaking DOB on the
    // staff OCR panel via GET /api/documents/:id/ocr).
    dateOfBirth: formatDobDisplay(dobFor(idx + 4, now)),
    ssnLast4: ssnLast4(primarySsn),
    employerName: spec.employer,
    baseMonthlyIncome: spec.monthlyIncome,
    bankInstitution,
    accountLast4: bankLast4,
    accountBalance: bankBalance,
    giftDonor: spec.giftFunds ? (spec.fixtureDocs ? FIXTURE_GIFT_DONOR : `${personName(idx + 80).firstName} ${owner.lastName}`) : null,
    giftAmount: spec.giftFunds ? (spec.fixtureDocs ? FIXTURE_GIFT_AMOUNT : 10_000 + (idx % 4) * 2500) : null,
  };

  for (const item of docSpecs) {
    docCursor += 1;
    let fileName = `${item.documentType}-${applicationNumber.toLowerCase()}-${docCursor}.pdf`;
    if (spec.fixtureDocs && item.documentType === "w2") fileName = "fixture-w2-northwind.pdf";
    if (spec.fixtureDocs && item.documentType === "pay-stub") fileName = "fixture-paystub-northwind.pdf";
    if (spec.fixtureDocs && item.documentType === "bank-statement") fileName = "fixture-bank-contoso.pdf";
    if (spec.fixtureDocs && item.documentType === "gift-letter") fileName = "fixture-gift-letter.pdf";
    if (spec.mismatchDoc && item.documentType === "bank-statement") fileName = "bank-statement-mismatch.pdf";
    if (spec.blurryDoc && item.documentType === "bank-statement") fileName = "blurry-scan.pdf";
    if (spec.failDoc && item.documentType === "w2") fileName = "w2-upload-fail.pdf";

    const bytes = makeSeedPdf(`${item.label}`, [
      `Application ${applicationNumber}`,
      `Borrower: ${owner.firstName} ${owner.lastName}`,
      `Employer: ${spec.employer}`,
      `Prepared for demonstration seeding.`,
    ]);
    const sha = sha256Hex(bytes);
    const storageKey = newStorageKey(appId);
    ctx.fileWrites.push({ key: storageKey, bytes });

    const documentId = randomUUID();
    const versionId = randomUUID();
    if (!firstDocumentId) firstDocumentId = documentId;
    await tx.document.create({
      data: {
        id: documentId,
        applicationId: appId,
        documentType: item.documentType,
        description: item.requiresDescription ? "Certificate of Eligibility (VA)" : null,
        checklistItemKey: item.key,
        status: docStatus,
        statusReason: null,
        uploadedByUserId: owner.id,
        isSeed: true,
        createdAt: docsAt,
        updatedAt: docsAt,
      },
    });
    counts.bump("Document");
    await tx.documentVersion.create({
      data: {
        id: versionId,
        documentId,
        versionNumber: 1,
        storageKey,
        originalFileName: fileName,
        sniffedContentType: "application/pdf",
        sizeBytes: bytes.length,
        sha256: sha,
        uploadedByUserId: owner.id,
        createdAt: docsAt,
        updatedAt: docsAt,
      },
    });
    counts.bump("DocumentVersion");
    await tx.document.update({ where: { id: documentId }, data: { currentVersionId: versionId, updatedAt: docsAt } });
    docVersionIdByType.set(item.documentType, versionId);

    const isFail = fileName.includes("fail");
    await tx.documentJob.create({
      data: {
        documentVersionId: versionId,
        status: isFail ? "failed" : "completed",
        attempt: isFail ? 3 : 1,
        maxAttempts: 5,
        provider: "simulated",
        startedAt: forwardOf(docsAt, 10_000, now),
        finishedAt: forwardOf(docsAt, 25_000, now),
        error: isFail ? "Simulated extraction failure ('fail' trigger): the document intelligence service could not process this file." : null,
        createdAt: docsAt,
        updatedAt: forwardOf(docsAt, 25_000, now),
      },
    });
    counts.bump("DocumentJob");

    if (!isFail) {
      const outcome = simulateOcrExtraction({
        documentType: item.documentType,
        fileName,
        contentSha256: sha,
        attempt: 1,
        referenceDate: docsAt,
        entered: enteredOcr,
      });
      if (outcome.ok) {
        await tx.ocrExtraction.create({
          data: {
            documentVersionId: versionId,
            provider: "simulated",
            fields: outcome.fields as unknown as Prisma.InputJsonValue,
            rawText: outcome.rawText,
            createdAt: forwardOf(docsAt, 26_000, now),
            updatedAt: forwardOf(docsAt, 26_000, now),
          },
        });
        counts.bump("OcrExtraction");

        // ocr-mismatch flag from the REAL task-027 predicates.
        if (spec.fraud === "ocr-mismatch" && fileName.includes("mismatch")) {
          const findings = ocrMaterialFindings(outcome.fields);
          const candidate = ocrMismatchCandidate(findings, versionId);
          if (!candidate) throw new Error(`ocr-mismatch staging produced no material findings (${spec.key})`);
          const flagAt = forwardOf(docsAt, 27_000, now);
          const flag = await tx.fraudFlag.create({
            data: {
              applicationId: appId,
              type: candidate.type,
              severity: candidate.severity,
              sourceDocumentVersionId: versionId,
              details: candidate.details,
              status: spec.fraudStatus ?? "open",
              createdAt: flagAt,
              updatedAt: flagAt,
            },
          });
          counts.bump("FraudFlag");
          coverage.ocrMismatchFlag = true;
          audits.push({ timestamp: flagAt, actorUserId: null, actorRole: "SYSTEM", actionType: "fraud-flag", applicationId: appId, entityType: "FraudFlag", entityId: flag.id, summary: `Fraud flag created (ocr-mismatch, ${candidate.severity}) from OCR comparison` });
        }
      }
    }
    audits.push({ timestamp: docsAt, actorUserId: owner.id, actorRole: "BORROWER", actionType: "document-upload", applicationId: appId, entityType: "Document", entityId: documentId, summary: `Document uploaded (${item.documentType}) — ${fileName}` });
  }

  // ---- Underwriting results ----------------------------------------------
  const runChecks =
    ["aus_executed", "preliminary_decision", "escalated_review", "conditional_approval", "borrower_notified", "declined_by_borrower"].includes(spec.state)
    && spec.key !== "demo-withdrawn" && spec.state !== "declined_by_borrower"
      ? "all"
      : spec.state === "declined_by_borrower" ? "all"
      : spec.state === "documents_received" ? "partial"
      : "none";

  let creditPayload: CreditCheckResult | null = null;
  let qualificationDti: number | null = null;
  let qualificationLtv: number | null = null;

  if (runChecks !== "none" && submittedAt) {
    const t11Step = steps.find((s) => s.tid === "T11");
    const checksAt = t11Step ? new Date(t11Step.at.getTime() - 30 * 60_000) : new Date(stateEnteredAt.getTime() - 30 * 60_000);
    const requestedBy = assigneeId ?? ctx.resolveStaffId("cw-green-d");

    const insertResult = async (
      checkType: "credit" | "income" | "avm" | "pricing" | "aus",
      payload: CreditCheckResult | IncomeCheckResult | AvmCheckResult | PricingCheckResult | AusCheckResult,
      offsetMinutes: number,
      isStale = false,
    ) => {
      const { summary, riskBadge } = summarizeCheck(checkType, payload);
      const at = forwardOf(checksAt, offsetMinutes * 60_000, now);
      const row = await tx.underwritingResult.create({
        data: {
          applicationId: appId,
          checkType,
          status: "completed",
          provider: "simulated",
          requestedByUserId: requestedBy,
          requestedAt: at,
          completedAt: forwardOf(at, 4_000, now),
          result: payload as unknown as Prisma.InputJsonValue,
          summary,
          riskBadge,
          isStale,
          createdAt: at,
          updatedAt: forwardOf(at, 4_000, now),
        },
      });
      counts.bump("UnderwritingResult");
      audits.push({ timestamp: forwardOf(at, 4_000, now), actorUserId: requestedBy, actorRole: assigneeRole, actionType: "underwriting-check", applicationId: appId, entityType: "UnderwritingResult", entityId: row.id, summary: `${checkType} check completed — ${summary}` });
      return row;
    };

    // credit (primary + optional co-borrower, §6.3.1)
    const primaryReport = simulateBorrowerCredit(
      { ssnLast4: ssnLast4(primarySsn), fullName: `${owner.firstName} ${owner.lastName}`, dateOfBirth: dobFor(idx + 4, now) },
      { attempt: 2, partial: spec.partialCredit ?? false, referenceDate: checksAt },
    );
    if (primaryReport.kind !== "report") throw new Error(`credit sim unavailable for ${spec.key}`);
    let coReport: BorrowerCreditReport | null = null;
    if (spec.coBorrower) {
      const co = simulateBorrowerCredit(
        { ssnLast4: String(spec.coBorrower.tierDigit).padStart(4, "0"), fullName: `co-${owner.lastName}`, dateOfBirth: dobFor(idx + 9, now) },
        { attempt: 2, partial: false, referenceDate: checksAt },
      );
      if (co.kind === "report") coReport = co.report;
    }
    creditPayload = composeCreditCheckResult(primaryReport.report, coReport);
    if (spec.partialCredit) coverage.partialCredit = true;

    const employments: IncomeEmploymentInput[] = [
      { employerName: spec.employer, statedBaseMonthlyIncome: spec.monthlyIncome, startDate: primaryEmployment.startDate },
      ...(spec.coBorrower ? [{ employerName: spec.coBorrower.employer, statedBaseMonthlyIncome: spec.coBorrower.monthlyIncome }] : []),
    ];
    const incomePayload = simulateIncomeVerification(employments, checksAt);

    const avmPayload = simulateAvm(
      {
        addressText: formatAddressText(subjectAddrShape),
        zip: subjectAddrShape.zip,
        statedValue: spec.estimatedValue,
        propertyType: spec.propertyType,
        latitude: subjectGeo.latitude,
        longitude: subjectGeo.longitude,
        requestedLoanAmount: spec.loanAmount,
      },
      { partial: false, referenceDate: checksAt },
    );

    await insertResult("credit", creditPayload, 0);
    const incomeRow = await insertResult("income", incomePayload, 3);

    // income-variance fraud flag (factor-9 employer, §6.3.2/§6.4) — mirrors
    // the exported task-027 candidate logic (severity high on >20% variance).
    if (spec.fraud === "income-variance") {
      const varianceRow = incomePayload.employments.find((r) => typeof r.variancePct === "number" && r.variancePct > 20);
      if (!varianceRow) throw new Error(`income-variance staging produced no >20% variance row (${spec.key})`);
      const flagAt = forwardOf(checksAt, 5 * 60_000, now);
      const flag = await tx.fraudFlag.create({
        data: {
          applicationId: appId,
          type: "income-variance",
          severity: "high",
          sourceResultId: incomeRow.id,
          details: `Verified income variance exceeds 20% — ${varianceRow.employerName}: verified $${varianceRow.verifiedMonthlyIncome?.toFixed(2)}/mo vs stated $${varianceRow.statedMonthlyIncome?.toFixed(2)}/mo (variance ${varianceRow.variancePct!.toFixed(1)}%).`,
          status: spec.fraudStatus ?? "open",
          createdAt: flagAt,
          updatedAt: flagAt,
        },
      });
      counts.bump("FraudFlag");
      coverage.incomeVarianceFlag = true;
      audits.push({ timestamp: flagAt, actorUserId: null, actorRole: "SYSTEM", actionType: "fraud-flag", applicationId: appId, entityType: "FraudFlag", entityId: flag.id, summary: "Fraud flag created (income-variance, high) from income verification" });
    }
    if (spec.fraud === "employer-unverified") {
      const unverifiedRow = incomePayload.employments.find((r) => r.employerVerified === false);
      if (!unverifiedRow) throw new Error(`employer-unverified staging produced no unverified row (${spec.key})`);
      const flagAt = forwardOf(checksAt, 5 * 60_000, now);
      const flag = await tx.fraudFlag.create({
        data: {
          applicationId: appId,
          type: "employer-unverified",
          severity: "medium",
          sourceResultId: incomeRow.id,
          details: `Stated employer could not be verified: ${unverifiedRow.employerName}.`,
          status: spec.fraudStatus ?? "open",
          createdAt: flagAt,
          updatedAt: flagAt,
        },
      });
      counts.bump("FraudFlag");
      audits.push({ timestamp: flagAt, actorUserId: null, actorRole: "SYSTEM", actionType: "fraud-flag", applicationId: appId, entityType: "FraudFlag", entityId: flag.id, summary: "Fraud flag created (employer-unverified, medium) from income verification" });
    }

    if (runChecks === "all") {
      await insertResult("avm", avmPayload, 6);

      // Qualification AFTER the AVM row exists — AVM-aware LTV (ASM-006).
      const qual = await computeApplicationQualification(appId, tx);
      qualificationDti = qual.dti;
      qualificationLtv = qual.ltv;

      const pricingOutcome = simulatePricing({
        loanType: spec.loanType,
        amortizationType: spec.amortizationType,
        loanTermMonths: spec.loanTermMonths,
        requestedLoanAmount: spec.loanAmount,
        qualifyingCreditScore: creditPayload.qualifyingScore ?? creditPayload.middleScore ?? null,
        ltv: qual.ltv,
        occupancy: spec.occupancy,
        propertyType: spec.propertyType,
        numberOfUnits: spec.numberOfUnits,
        cashOut: spec.loanPurpose === "refinance-cash-out",
        monthlyPropertyTaxes: proposedHousingExpense.propertyTaxes,
        monthlyInsurance: proposedHousingExpense.homeownersInsurance,
      });
      if (pricingOutcome.kind !== "result") throw new Error(`pricing sim invalid for ${spec.key}`);
      await insertResult("pricing", pricingOutcome.result, 9);

      const openHighFraudFlagCount = spec.fraud === "income-variance" && (spec.fraudStatus ?? "open") === "open" ? 1 : 0;
      const ausPayload = simulateAus({
        middleScore: creditPayload.qualifyingScore ?? creditPayload.middleScore ?? null,
        dti: qual.dti,
        ltv: qual.ltv,
        openHighFraudFlagCount,
        derogatoryWithin24Months: hasDerogatoryWithin24Months(creditPayload.collections ?? null, checksAt),
        foreclosureOrBankruptcyWithin7Years: spec.declarationsProfile === "derog",
      });
      await insertResult("aus", ausPayload, 12, spec.staleAus ?? false);

      // Stale-AUS staging: a post-AUS correction marks the AUS stale (§4.4.4).
      if (spec.staleAus) {
        const corrAt = forwardOf(checksAt, 60 * 60_000, now);
        audits.push({
          timestamp: corrAt,
          actorUserId: assigneeId,
          actorRole: assigneeRole,
          actionType: "correction",
          applicationId: appId,
          entityType: "Borrower",
          entityId: primaryBorrowerId,
          summary: "Correction: employments[0].baseMonthlyIncome adjusted after document review — AUS marked stale",
          before: { baseMonthlyIncome: spec.monthlyIncome },
          after: { baseMonthlyIncome: spec.monthlyIncome + 150 },
          reason: "Pay stub shows updated base salary",
        });
      }
    } else {
      // documents_received: credit+income only — qualification without AVM.
      const qual = await computeApplicationQualification(appId, tx);
      qualificationDti = qual.dti;
      qualificationLtv = qual.ltv;
    }
  } else {
    const qual = await computeApplicationQualification(appId, tx);
    qualificationDti = qual.dti;
    qualificationLtv = qual.ltv;
  }

  // duplicate-ssn flag (blind-index match with the referenced application).
  if (spec.fraud === "duplicate-ssn" && spec.ssnShareWith) {
    const flagAt = submittedAt ?? stateEnteredAt;
    const flag = await tx.fraudFlag.create({
      data: {
        applicationId: appId,
        type: "duplicate-ssn",
        severity: "high",
        details: `SSN ending ${ssnLast4(primarySsn)} entered for borrower 1 matches a borrower on another application (blind-index match).`,
        status: spec.fraudStatus ?? "open",
        createdAt: flagAt,
        updatedAt: flagAt,
      },
    });
    counts.bump("FraudFlag");
    audits.push({ timestamp: flagAt, actorUserId: null, actorRole: "SYSTEM", actionType: "fraud-flag", applicationId: appId, entityType: "FraudFlag", entityId: flag.id, summary: "Fraud flag created (duplicate-ssn, high) from blind-index match" });
  }

  // ---- Aggregates + escalation via the real engines -----------------------
  const finalQual = await computeApplicationQualification(appId, tx);
  const hasDecisionContext = spec.l1 !== undefined;
  let escalation: Awaited<ReturnType<typeof evaluateEscalation>> | null = null;
  if (hasDecisionContext || spec.expectEscalated !== undefined) {
    escalation = await evaluateEscalation(tx, appId);
    if (spec.expectEscalated !== undefined && escalation.required !== spec.expectEscalated) {
      throw new Error(`escalation drift on ${spec.key}: expected ${spec.expectEscalated}, engine says ${escalation.required} (dti=${escalation.dti} ltv=${escalation.ltv})`);
    }
    // One-level decided apps must NOT require escalation; L2-present must.
    if (spec.l1 && ["borrower_notified", "declined_by_borrower"].includes(spec.state) && spec.outcome === "approved") {
      if (spec.l2 && !escalation.required) throw new Error(`two-level app ${spec.key} does not meet escalation criteria`);
      if (!spec.l2 && escalation.required) throw new Error(`one-level app ${spec.key} unexpectedly meets escalation criteria (dti=${escalation.dti} ltv=${escalation.ltv})`);
    }
  }

  if (finalQual.dti !== null) (finalQual.dti < 43 ? (coverage.dtiBelow43 = true) : (coverage.dtiAbove43 = true));
  if (finalQual.ltv !== null) {
    if (finalQual.ltv < 80) coverage.ltvBelow80 = true; else coverage.ltvAbove80 = true;
    if (finalQual.ltv < 97) coverage.ltvBelow97 = true; else coverage.ltvAbove97 = true;
  }
  if (spec.key === "er-lowavm-l1-sup2" && escalation?.required && (escalation.ltv ?? 0) > 80) {
    coverage.lowAvmEscalated = true;
  }

  await tx.application.update({
    where: { id: appId },
    data: {
      dti: finalQual.dti,
      ltv: finalQual.ltv,
      cltv: finalQual.cltv,
      escalationRequired: escalation?.required ?? false,
      escalationCriteriaMet: escalation?.metLabels ?? [],
      updatedAt: stateEnteredAt,
    },
  });
  qualificationDti = finalQual.dti;
  qualificationLtv = finalQual.ltv;

  // ---- Signatures ---------------------------------------------------------
  if (submitted && submittedAt) {
    const dataHash = await computeApplicationDataHash(tx, appId);
    const signBase = new Date(submittedAt.getTime() - 2 * 3_600_000);
    const borrowerIds = [primaryBorrowerId, ...(coBorrowerId ? [coBorrowerId] : [])];
    for (let bi = 0; bi < borrowerIds.length; bi += 1) {
      const sig = await tx.signature.create({
        data: {
          applicationId: appId,
          borrowerId: borrowerIds[bi]!,
          mode: bi % 2 === 0 ? "typed" : "drawn",
          imageData: new Uint8Array(SEED_SIGNATURE_PNG),
          attestationText: ATTESTATION_TEXT,
          attestationVersion: ATTESTATION_VERSION,
          signedAt: forwardOf(signBase, bi * 60_000, now),
          ip: "203.0.113.30",
          userAgent: "seed-fixture",
          dataHash,
          createdAt: forwardOf(signBase, bi * 60_000, now),
          updatedAt: forwardOf(signBase, bi * 60_000, now),
        },
      });
      counts.bump("Signature");
      audits.push({ timestamp: sig.signedAt, actorUserId: owner.id, actorRole: "BORROWER", actionType: "signature-capture", applicationId: appId, entityType: "Signature", entityId: sig.id, summary: `Signature captured for borrower ${bi + 1} (${sig.mode})` });
    }
  }

  // ---- Workflow history + versions ---------------------------------------
  let t4HistoryId: string | null = null;
  for (const step of steps) {
    const row = await tx.workflowHistory.create({
      data: {
        applicationId: appId,
        fromState: step.from,
        toState: step.to,
        actorUserId: step.actorUserId,
        actorRole: step.actorRole,
        versionNumber: step.tid === "T1" ? 1 : step.versionNumber ?? null,
        createdAt: step.at,
        updatedAt: step.at,
      },
    });
    counts.bump("WorkflowHistory");
    if (step.tid === "T4") t4HistoryId = row.id;
    audits.push({ timestamp: step.at, actorUserId: step.actorUserId, actorRole: step.actorRole, actionType: "workflow-transition", applicationId: appId, entityType: "Application", entityId: appId, summary: `Workflow transition ${step.tid}: ${step.from} → ${step.to} (${applicationNumber})` });
  }

  if (submitted && submittedAt) {
    const loaded = (await tx.application.findUnique({ where: { id: appId }, include: APPLICATION_INCLUDE })) as ApplicationWithRelations | null;
    if (!loaded) throw new Error(`application ${appId} vanished mid-seed`);
    const snapshot = buildVersionSnapshot(loaded);
    if (spec.twoVersions) {
      // v1 carries a slightly different income figure so the diff is non-empty.
      const v1 = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
      // HOLISTIC-REVIEW FIX: this read the employments array at
      // `borrowers[0].employments`, but buildVersionSnapshot groups borrower
      // fields BY URLA SECTION — the array lives at
      // `borrowers[0]["employment-income"].employments`. The resulting
      // TypeError was swallowed by a bare catch, so the only two-version
      // seeded application got byte-identical v1/v2 snapshots and the AC-28
      // version-diff demo rendered `sections: []`. Confirmed against the
      // seeded data (2 versions, 1 distinct snapshot) before the fix.
      const borrowers = v1.borrowers as Array<Record<string, unknown>>;
      const employmentIncome = borrowers[0]?.["employment-income"] as
        | Record<string, unknown>
        | undefined;
      const employments = employmentIncome?.employments as
        | Array<Record<string, unknown>>
        | undefined;
      if (!employments?.[0]) {
        // Fail loudly rather than silently seeding a demo whose headline
        // feature has nothing to show (profile §Seed Data Quality Rules).
        throw new Error(
          "demo seed: cannot build the two-version diff fixture — no employments[0] at " +
            'borrowers[0]["employment-income"] in the version snapshot',
        );
      }
      employments[0].baseMonthlyIncome = Math.round(spec.monthlyIncome * 0.94);
      await tx.applicationVersion.create({
        data: { applicationId: appId, versionNumber: 1, snapshot: v1 as Prisma.InputJsonValue, reason: "initial-submission", createdByUserId: owner.id, createdAt: submittedAt, updatedAt: submittedAt },
      });
      const t36 = steps.find((s) => s.tid === "T36")!;
      await tx.applicationVersion.create({
        data: { applicationId: appId, versionNumber: 2, snapshot, reason: "resubmission", createdByUserId: owner.id, createdAt: t36.at, updatedAt: t36.at },
      });
      counts.bump("ApplicationVersion", 2);
    } else {
      await tx.applicationVersion.create({
        data: { applicationId: appId, versionNumber: 1, snapshot, reason: "initial-submission", createdByUserId: owner.id, createdAt: submittedAt, updatedAt: submittedAt },
      });
      counts.bump("ApplicationVersion");
    }
    audits.push({ timestamp: submittedAt, actorUserId: owner.id, actorRole: "BORROWER", actionType: "application-submitted", applicationId: appId, entityType: "Application", entityId: appId, summary: `Application ${applicationNumber} submitted (Version 1)` });
  }

  // ---- Assignment ---------------------------------------------------------
  if (spec.assignee && submittedAt) {
    const assignedAt = forwardOf(submittedAt, 45 * 60_000, now);
    const activeStates: WorkflowState[] = ["application_received", "completeness_validated", "documents_received", "aus_executed", "preliminary_decision", "escalated_review", "conditional_approval", "revision_requested", "suspended"];
    const isActive = activeStates.includes(spec.state);
    const endedAt = isActive ? null : decidedAt ?? closedAt ?? stateEnteredAt;
    const endReason = isActive ? null : spec.state === "withdrawn" ? "borrower withdrew" : spec.state === "declined_by_borrower" ? "borrower declined" : "decision recorded";
    const method = spec.assignmentMethod ?? "manual";
    const assignedById = method === "claim" ? assigneeId : ctx.resolveStaffId(idx % 2 === 0 ? "sup-1" : "sup-2");
    const assignment = await tx.caseworkerAssignment.create({
      data: {
        applicationId: appId,
        caseworkerUserId: assigneeId!,
        assignedByUserId: assignedById,
        method,
        reason: method === "reassign" ? "workload rebalancing" : null,
        assignedAt,
        endedAt,
        endReason,
        createdAt: assignedAt,
        updatedAt: endedAt ?? assignedAt,
      },
    });
    counts.bump("CaseworkerAssignment");
    audits.push({ timestamp: assignedAt, actorUserId: assignedById, actorRole: method === "claim" ? assigneeRole : "SUPERVISOR", actionType: "assignment", applicationId: appId, entityType: "CaseworkerAssignment", entityId: assignment.id, summary: `Application ${applicationNumber} assigned via ${method}` });
  }

  // Priority override staging (audited — §4.6.3).
  if (spec.priorityOverridden) {
    const at = forwardOf(stateEnteredAt, 10 * 60_000, now);
    audits.push({ timestamp: at, actorUserId: ctx.resolveStaffId("sup-1"), actorRole: "SUPERVISOR", actionType: "priority-override", applicationId: appId, entityType: "Application", entityId: appId, summary: `Priority manually overridden to ${spec.priority}`, before: { priority: "normal" }, after: { priority: spec.priority }, reason: "Demo staging: supervisor override" });
  }

  // ---- Approvals + conditions --------------------------------------------
  const approvalTimes: Date[] = [];
  if (spec.l1) {
    const l1At = (() => {
      if (spec.state === "escalated_review") return steps.find((s) => s.tid === "T21")?.at ?? daysAgo(now, spec.l1!.daysAgo);
      if (spec.state === "conditional_approval" || spec.key === "decl-ca") return steps.find((s) => s.tid === "T20")?.at ?? daysAgo(now, spec.l1!.daysAgo);
      if (spec.l2) return steps.find((s) => s.tid === "T21")?.at ?? daysAgo(now, spec.l1!.daysAgo);
      return decidedAt ?? daysAgo(now, spec.l1!.daysAgo);
    })();
    approvalTimes.push(l1At);
    const l1DenialReasons = spec.l1.decision === "deny" ? spec.denialReasons ?? ["credit-history"] : [];
    const l1 = await tx.approvalRecord.create({
      data: {
        applicationId: appId,
        level: 1,
        decision: spec.l1.decision,
        approverUserId: l1ById!,
        notes: spec.l1.decision === "deny" ? "Level-1 review: application does not meet lending criteria." : "Level-1 review complete.",
        denialReasons: l1DenialReasons,
        // VR-088: denialReasonOtherText is REQUIRED whenever denialReasons
        // contains "other". The API validator enforces it (schemas/approval.ts),
        // but the seeder writes ApprovalRecord rows straight through Prisma and
        // so bypasses that boundary. Without it the HMDA LAR emits field 70 = 9
        // with field 72 empty, which fails the FFIEC validity edit and rejects
        // the ENTIRE submission, not just the row (INV-043(c)).
        denialReasonOtherText: l1DenialReasons.includes("other")
          ? "Insufficient reserves after closing to cover the required post-close liquidity."
          : null,
        criteriaEvaluated: escalation?.evaluatedLabels ?? [],
        dtiAtDecision: qualificationDti,
        ltvAtDecision: qualificationLtv,
        versionNumber: Math.max(1, versionCount),
        createdAt: l1At,
        updatedAt: l1At,
      },
    });
    counts.bump("ApprovalRecord");
    audits.push({ timestamp: l1At, actorUserId: l1ById, actorRole: "SUPERVISOR", actionType: "approval-decision", applicationId: appId, entityType: "ApprovalRecord", entityId: l1.id, summary: `Level-1 ${spec.l1.decision} recorded for ${applicationNumber}` });

    for (let ci = 0; ci < (spec.l1.conditions?.length ?? 0); ci += 1) {
      const text = spec.l1.conditions![ci]!;
      const cleared = ci < (spec.conditionsCleared ?? 0);
      // INV-049 / BUG-16: a late-anchored L1 decision put clear-time past seed `now` — clamp.
      const clearedAt = cleared ? forwardOf(l1At, 26 * 3_600_000, now) : null;
      const condition = await tx.condition.create({
        data: {
          applicationId: appId,
          approvalRecordId: l1.id,
          text,
          status: cleared ? "cleared" : "open",
          clearedByUserId: cleared ? assigneeId : null,
          clearedAt,
          createdAt: l1At,
          updatedAt: clearedAt ?? l1At,
        },
      });
      counts.bump("Condition");
      if (cleared) {
        audits.push({ timestamp: clearedAt!, actorUserId: assigneeId, actorRole: assigneeRole, actionType: "condition-clear", applicationId: appId, entityType: "Condition", entityId: condition.id, summary: `Condition cleared: ${text.slice(0, 60)}` });
      }
    }
  }
  if (spec.l2) {
    const l2At = decidedAt ?? daysAgo(now, spec.l2.daysAgo);
    const l2 = await tx.approvalRecord.create({
      data: {
        applicationId: appId,
        level: 2,
        decision: spec.l2.decision,
        approverUserId: l2ById!,
        notes: "Level-2 review complete (different approver rule satisfied).",
        denialReasons: [],
        criteriaEvaluated: escalation?.evaluatedLabels ?? [],
        dtiAtDecision: qualificationDti,
        ltvAtDecision: qualificationLtv,
        versionNumber: Math.max(1, versionCount),
        createdAt: l2At,
        updatedAt: l2At,
      },
    });
    counts.bump("ApprovalRecord");
    audits.push({ timestamp: l2At, actorUserId: l2ById, actorRole: "SUPERVISOR", actionType: "approval-decision", applicationId: appId, entityType: "ApprovalRecord", entityId: l2.id, summary: `Level-2 ${spec.l2.decision} recorded for ${applicationNumber}` });
  }

  // ---- Bank link ----------------------------------------------------------
  if (spec.bankLink && submittedAt) {
    const inst = SIMULATED_INSTITUTIONS[idx % SIMULATED_INSTITUTIONS.length]!;
    const encTokenValue = encryptField(`seed-link-${randomUUID()}`);
    const linkedAt = new Date(sectionsSavedAt.getTime() - 3_600_000);
    const link = await tx.bankLink.create({
      data: {
        applicationId: appId,
        borrowerId: primaryBorrowerId,
        provider: "simulated-aggregator",
        institution: useFixtureBank ? FIXTURE_BANK_INSTITUTION : inst.name,
        accessTokenCiphertext: new Uint8Array(encTokenValue.ciphertext),
        accessTokenKeyId: encTokenValue.keyId,
        linkedAt,
        importedAccountIds: [assetId],
        createdAt: linkedAt,
        updatedAt: linkedAt,
      },
    });
    counts.bump("BankLink");
    audits.push({ timestamp: linkedAt, actorUserId: owner.id, actorRole: "BORROWER", actionType: "bank-link", applicationId: appId, entityType: "BankLink", entityId: link.id, summary: `Bank account linked (${useFixtureBank ? FIXTURE_BANK_INSTITUTION : inst.name})` });
  }

  // ---- Notes (internal / formal / chatter) --------------------------------
  if (submitted && spec.assignee) {
    const noteAt = new Date(stateEnteredAt.getTime() - 30 * 60_000);
    const internal = await tx.applicationNote.create({
      data: {
        applicationId: appId,
        authorUserId: assigneeId!,
        type: "internal",
        content: `Initial review of ${applicationNumber}: documents ${spec.docsMode === "full" ? "complete" : "in progress"}; ${spec.employer} employment on file.`,
        createdAt: noteAt,
        updatedAt: noteAt,
      },
    });
    counts.bump("ApplicationNote");
    audits.push({ timestamp: noteAt, actorUserId: assigneeId, actorRole: assigneeRole, actionType: "note", applicationId: appId, entityType: "ApplicationNote", entityId: internal.id, summary: "Internal note added" });
  }
  if (spec.formalNote && submittedAt) {
    const formalAt = stateEnteredAt;
    const formal = await tx.applicationNote.create({
      data: {
        applicationId: appId,
        authorUserId: assigneeId ?? ctx.resolveStaffId("cw-red"),
        type: "formal",
        content: "Please provide your two most recent bank statements and correct the employment start date in Section 1d, then resubmit. The listed statement period does not cover the last 60 days.",
        relatedTransitionId: t4HistoryId,
        createdAt: formalAt,
        updatedAt: formalAt,
      },
    });
    counts.bump("ApplicationNote");
    audits.push({ timestamp: formalAt, actorUserId: assigneeId ?? ctx.resolveStaffId("cw-red"), actorRole: "CASEWORKER", actionType: "note", applicationId: appId, entityType: "ApplicationNote", entityId: formal.id, summary: "Formal note recorded with revision request" });
  }
  if (spec.chatterFromSupervisor) {
    const chatterAt = hoursAgo(now, 5);
    const chatter = await tx.applicationNote.create({
      data: {
        applicationId: appId,
        authorUserId: ctx.resolveStaffId("sup-1"),
        type: "chatter",
        content: `@${ctx.demo.caseworker.firstName} can you prioritize the completeness review on ${applicationNumber}? Borrower called about timing.`,
        createdAt: chatterAt,
        updatedAt: chatterAt,
      },
    });
    counts.bump("ApplicationNote");
    audits.push({ timestamp: chatterAt, actorUserId: ctx.resolveStaffId("sup-1"), actorRole: "SUPERVISOR", actionType: "chatter", applicationId: appId, entityType: "ApplicationNote", entityId: chatter.id, summary: "Chatter message posted" });
    await createSeedNotification(tx, counts, now, {
      recipientUserId: ctx.demo.caseworker.id,
      type: "chatter",
      title: `New chatter on ${applicationNumber}`,
      body: `A supervisor posted a chatter message on application ${applicationNumber}.`,
      applicationId: appId,
      channel: "in-app",
      createdAt: chatterAt,
      read: false,
    });
  }

  // ---- Document requests --------------------------------------------------
  if (spec.documentRequest) {
    const reqAt = hoursAgo(now, 30);
    const request = await tx.documentRequest.create({
      data: {
        applicationId: appId,
        documentType: "bank-statement",
        reason: "Most recent statement is older than 60 days — please provide the current one.",
        requestedByUserId: assigneeId ?? ctx.resolveStaffId("sup-1"),
        fulfilledByDocumentId: spec.documentRequest === "fulfilled" ? firstDocumentId : null,
        createdAt: reqAt,
        updatedAt: reqAt,
      },
    });
    counts.bump("DocumentRequest");
    audits.push({ timestamp: reqAt, actorUserId: assigneeId ?? ctx.resolveStaffId("sup-1"), actorRole: assigneeRole, actionType: "document-request", applicationId: appId, entityType: "DocumentRequest", entityId: request.id, summary: "Additional document requested (bank-statement)" });
  }

  // ---- Notifications ------------------------------------------------------
  const bounceEmail = owner.email.endsWith("@bounce.example");
  if (submittedAt) {
    // Borrower "submitted" confirmation (email, historical, read).
    await createSeedNotification(tx, counts, now, {
      recipientUserId: owner.id,
      type: "submitted",
      title: `Application ${applicationNumber} received`,
      body: `Your application ${applicationNumber} was received and is in the review queue.`,
      applicationId: appId,
      channel: "email",
      createdAt: submittedAt,
      read: true,
      outbound: { recipient: owner.email, status: "sent" },
    });
  }
  if (spec.state === "borrower_notified" && decidedAt) {
    const failed = bounceEmail;
    await createSeedNotification(tx, counts, now, {
      recipientUserId: owner.id,
      type: "decision",
      title: `Decision on application ${applicationNumber}`,
      body:
        spec.outcome === "approved"
          ? `Congratulations — your application ${applicationNumber} has been approved. See the formal decision notice in your portal.`
          : `A decision has been reached on application ${applicationNumber}. Unfortunately we are unable to approve it at this time. Denial reasons are listed in your portal.`,
      applicationId: appId,
      channel: "email",
      createdAt: stateEnteredAt,
      read: spec.decidedDaysAgo !== undefined && spec.decidedDaysAgo > 30,
      deliveryStatus: failed ? "failed" : "sent",
      deliveryError: failed ? `Delivery to ${owner.email} bounced (simulated bounce address) — retryable` : null,
      outbound: { recipient: owner.email, status: failed ? "failed" : "sent" },
    });
    if (failed) {
      await createSeedNotification(tx, counts, now, {
        recipientUserId: ctx.demo.supervisor.id,
        type: "delivery-failure",
        title: `Notification delivery failed for ${applicationNumber}`,
        body: `The decision notification for ${applicationNumber} failed to deliver (simulated bounce). Retry from Outbound Messages.`,
        applicationId: appId,
        channel: "in-app",
        createdAt: forwardOf(stateEnteredAt, 60_000, now),
        read: false,
      });
    }
  }
  if (spec.key === "demo-rr") {
    // Unread revision notification for the Demo Borrower (§4.6.12 staging).
    await createSeedNotification(tx, counts, now, {
      recipientUserId: owner.id,
      type: "revision-requested",
      title: `Revision requested on ${applicationNumber}`,
      body: "Your application was returned for revision. Please review the formal note, correct the requested items, and resubmit.",
      applicationId: appId,
      channel: "email",
      createdAt: stateEnteredAt,
      read: false,
      outbound: { recipient: owner.email, status: "sent" },
    });
  }
  if (spec.key === "dcw-ar-urgent") {
    await createSeedNotification(tx, counts, now, {
      recipientUserId: ctx.demo.caseworker.id,
      type: "assignment",
      title: `New assignment: ${applicationNumber}`,
      body: `Application ${applicationNumber} (urgent) is now assigned to you.`,
      applicationId: appId,
      channel: "in-app",
      createdAt: hoursAgo(now, 2),
      read: false,
    });
  }
  if (spec.key === "dcw-dr-fraud") {
    await createSeedNotification(tx, counts, now, {
      recipientUserId: ctx.demo.caseworker.id,
      type: "fraud-flag-created",
      title: `Fraud flag on ${applicationNumber}`,
      body: `A high-severity income-variance fraud flag was created on application ${applicationNumber}.`,
      applicationId: appId,
      channel: "in-app",
      createdAt: hoursAgo(now, 8),
      read: false,
    });
  }
  if (["pd-red", "pd-yellow-high"].includes(spec.key)) {
    await createSeedNotification(tx, counts, now, {
      recipientUserId: ctx.demo.supervisor.id,
      type: "approval-pending",
      title: `Level-1 approval pending: ${applicationNumber}`,
      body: `Application ${applicationNumber} reached Preliminary Decision and awaits a Level-1 supervisor decision.`,
      applicationId: appId,
      channel: "in-app",
      createdAt: hoursAgo(now, 12),
      read: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Notification + outbound helper (direct rows — backdated historical staging;
// live flows always use THE notification service, task-036)
// ---------------------------------------------------------------------------

async function createSeedNotification(
  tx: Tx,
  counts: Counts,
  now: Date,
  input: {
    recipientUserId: string;
    type: string;
    title: string;
    body: string;
    applicationId: string;
    channel: "in-app" | "email" | "sms";
    createdAt: Date;
    read: boolean;
    deliveryStatus?: "pending" | "sent" | "failed";
    deliveryError?: string | null;
    outbound?: { recipient: string; status: "sent" | "failed" };
  },
): Promise<void> {
  const deliveryStatus = input.deliveryStatus ?? (input.channel === "in-app" ? "sent" : "sent");
  const notification = await tx.notification.create({
    data: {
      recipientUserId: input.recipientUserId,
      type: input.type,
      title: input.title,
      body: input.body,
      applicationId: input.applicationId,
      channel: input.channel,
      deliveryStatus,
      deliveryError: input.deliveryError ?? null,
      deliveryAttempts: input.channel === "in-app" ? 0 : deliveryStatus === "failed" ? 3 : 1,
      nextAttemptAt: null,
      readAt: input.read ? forwardOf(input.createdAt, 3_600_000, now) : null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  });
  counts.bump("Notification");
  if (input.outbound) {
    await tx.outboundMessage.create({
      data: {
        channel: "email",
        recipient: input.outbound.recipient,
        subject: input.title,
        body: input.body,
        notificationId: notification.id,
        status: input.outbound.status,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });
    counts.bump("OutboundMessage");
  }
}
