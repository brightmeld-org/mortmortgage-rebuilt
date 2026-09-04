// SystemConfig service (task-004, REQ-065, DATA-005, INV-024, VR-124/VR-125, AC-32).
//
// THE REGISTRY below is the single SystemConfig key authority: every setting the
// §4.6.11 requirements table names, with its declared type, bounds, and stated
// default, plus `company.timeZone` — ratified by contract delta CH-015
// (INV-045 / VR-136, ASM-001) rather than by the §4.6.11 table.
// - READS: all subsystems read via the single cached accessor in
//   src/lib/http/config.ts (INV-024); this module adds typed getters that fall
//   back to the registry default.
// - WRITES: `updateSetting()` validates the key against the registry (VR-124),
//   validates the JSON-encoded value against the declared type/bounds (VR-125,
//   ≤ 4000 chars), and performs the row update + audit entry (actionType
//   "config-change", before/after — AC-32) inside ONE prisma.$transaction, so an
//   audit-insert failure rolls the config change back (task-003 service is
//   tx-only by construction). The read cache is invalidated on success.
// - SEEDING: the migration `seed_system_config` inserts every registry key with
//   its default; the verification script asserts registry ↔ DB parity.
//
// Server-side only — never import from client components.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { audit, type AuditTransactionClient } from "@/lib/services/audit";
import { getConfigValue, invalidateConfigCache } from "@/lib/http/config";

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

/** Declared value type of a setting (drives validation and the edit control). */
export type ConfigValueType =
  | "number" // JSON number; bounds via min/max; integer unless integer:false
  | "percent" // JSON number 0..100 (further narrowed by min/max)
  | "boolean" // JSON true/false
  | "string" // JSON string; allowBlank/pattern/maxLength
  | "enum-list"; // JSON array of distinct strings drawn from allowedValues

export interface ConfigRegistryEntry {
  /** Dotted key — same convention as src/lib/http/config.ts CONFIG_KEYS. */
  key: string;
  /** Short human label (ConfigurationPage). */
  label: string;
  /** Display group on the settings page. */
  group: string;
  /** Seeded into SystemConfig.description and served as ConfigSetting.description. */
  description: string;
  type: ConfigValueType;
  /** §4.6.11 stated default (the migration seeds exactly this value). */
  defaultValue: number | boolean | string | readonly string[];
  min?: number;
  max?: number;
  /** number/percent: require an integer (default true). */
  integer?: boolean;
  /** enum-list: the closed set of allowed member strings. */
  allowedValues?: readonly string[];
  /** string: allow "" (HMDA identifiers start blank). Default false. */
  allowBlank?: boolean;
  /** string: regex the (non-blank) value must match. */
  pattern?: RegExp;
  /** string: human hint for pattern failures. */
  patternHint?: string;
  /**
   * string: an additional semantic format the value must satisfy, checked after
   * pattern. "iana-time-zone" is VR-136 (company.timeZone).
   */
  format?: "iana-time-zone";
}

/** contracts.json enums.LoanType, verbatim. */
const LOAN_TYPES = ["conventional", "fha", "va", "usda"] as const;

// ---------------------------------------------------------------------------
// THE §4.6.11 REGISTRY (order = display order on the ConfigurationPage)
// ---------------------------------------------------------------------------

export const CONFIG_REGISTRY: readonly ConfigRegistryEntry[] = [
  // --- Company (INV-045 / ASM-001) ---
  {
    key: "company.timeZone",
    label: "Company time zone",
    group: "Company",
    description:
      "IANA time zone identifier for every business-day / SLA deadline computation and every date rendered into an operational or regulatory artifact (INV-045 / ASM-001; default America/New_York).",
    type: "string",
    format: "iana-time-zone",
    defaultValue: "America/New_York",
  },

  // --- Underwriting thresholds ---
  {
    key: "escalation.ltvThresholdPercent",
    label: "Escalation LTV threshold (%)",
    group: "Underwriting thresholds",
    description: "LTV above which an application escalates to two-level review (§4.6.11 default 80%).",
    type: "percent",
    defaultValue: 80,
  },
  {
    key: "escalation.dtiThresholdPercent",
    label: "Escalation DTI threshold (%)",
    group: "Underwriting thresholds",
    description: "DTI above which an application escalates to two-level review (§4.6.11 default 43%).",
    type: "percent",
    defaultValue: 43,
  },
  {
    key: "ltv.submissionBlockPercent",
    label: "LTV submission block (%)",
    group: "Underwriting thresholds",
    description: "LTV at or above which submission is blocked (§4.6.11 default 97%).",
    type: "percent",
    defaultValue: 97,
  },
  {
    key: "ltv.warningPercent",
    label: "LTV warning (%)",
    group: "Underwriting thresholds",
    description: "LTV above which the wizard shows a warning (§4.6.11 default 80%).",
    type: "percent",
    defaultValue: 80,
  },
  {
    key: "dti.warningPercent",
    label: "DTI warning (%)",
    group: "Underwriting thresholds",
    description: "DTI above which the wizard shows a warning (§4.6.11 default 43%).",
    type: "percent",
    defaultValue: 43,
  },
  {
    key: "approval.twoLevelLoanTypes",
    label: "Loan types requiring two-level approval",
    group: "Underwriting thresholds",
    description: "Loan types that always require Level-1 + Level-2 approval (§4.6.11 default FHA, VA, USDA).",
    type: "enum-list",
    allowedValues: LOAN_TYPES,
    defaultValue: ["fha", "va", "usda"],
  },

  // --- SLA (per-state business days per §4.4.1 + overall) ---
  {
    key: "sla.businessDays.application_received",
    label: "SLA: Application Received (business days)",
    group: "SLA",
    description: "Business-day SLA for the Application Received state (§4.4.1 default 2).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 2,
  },
  {
    key: "sla.businessDays.completeness_validated",
    label: "SLA: Completeness Validated (business days)",
    group: "SLA",
    description: "Business-day SLA for the Completeness Validated state (§4.4.1 default 3).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 3,
  },
  {
    key: "sla.businessDays.documents_received",
    label: "SLA: Supporting Documents Received (business days)",
    group: "SLA",
    description: "Business-day SLA for the Supporting Documents Received state (§4.4.1 default 2).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 2,
  },
  {
    key: "sla.businessDays.aus_executed",
    label: "SLA: AUS Executed (business days)",
    group: "SLA",
    description: "Business-day SLA for the AUS Executed state (§4.4.1 default 2).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 2,
  },
  {
    key: "sla.businessDays.preliminary_decision",
    label: "SLA: Preliminary Decision (business days)",
    group: "SLA",
    description: "Business-day SLA for the Preliminary Decision state (§4.4.1 default 2).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 2,
  },
  {
    key: "sla.businessDays.escalated_review",
    label: "SLA: Escalated Review (business days)",
    group: "SLA",
    description: "Business-day SLA for the Escalated Review state (§4.4.1 default 2).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 2,
  },
  {
    key: "sla.businessDays.conditional_approval",
    label: "SLA: Conditional Approval (business days)",
    group: "SLA",
    description: "Business-day SLA for the Conditional Approval state (§4.4.1 default 10).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 10,
  },
  {
    key: "sla.businessDays.revision_requested",
    label: "SLA: Revision Requested (business days, borrower clock)",
    group: "SLA",
    description: "Business-day SLA for the Revision Requested state — borrower clock (§4.4.1 default 10).",
    type: "number",
    min: 1,
    max: 90,
    defaultValue: 10,
  },
  {
    key: "sla.overallDecisionCalendarDays",
    label: "Overall decision SLA (calendar days)",
    group: "SLA",
    description: "Calendar days from submission to final decision tracked on the detail page (§4.6.11 default 30).",
    type: "number",
    min: 1,
    max: 365,
    defaultValue: 30,
  },

  // --- Workload & auto-assignment ---
  {
    key: "workload.capacityYellow",
    label: "Workload capacity threshold: yellow",
    group: "Workload & assignment",
    description: "Active-assignment count at which a caseworker shows yellow capacity (§4.6.11 default 9).",
    type: "number",
    min: 1,
    max: 100,
    defaultValue: 9,
  },
  {
    key: "workload.capacityRed",
    label: "Workload capacity threshold: red",
    group: "Workload & assignment",
    description: "Active-assignment count at which a caseworker shows red capacity (§4.6.11 default 13).",
    type: "number",
    min: 1,
    max: 200,
    defaultValue: 13,
  },
  {
    key: "autoAssign.productivityAware",
    label: "Productivity-aware auto-assign",
    group: "Workload & assignment",
    description: "Whether auto-assignment weighs caseworker productivity (§4.6.11 default off).",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "autoAssign.productivityWeight",
    label: "Productivity weight",
    group: "Workload & assignment",
    description: "Weight of productivity in auto-assignment scoring, 0–1 (§4.6.11 default 0.25).",
    type: "number",
    min: 0,
    max: 1,
    integer: false,
    defaultValue: 0.25,
  },

  // --- Applications & documents ---
  {
    key: "application.staleCopyThresholdDays",
    label: "Stale-copy threshold (days)",
    group: "Applications & documents",
    description: "Age in days beyond which a copy-source application triggers the staleness advisory (§4.6.11 default 90).",
    type: "number",
    min: 1,
    max: 3650,
    defaultValue: 90,
  },
  {
    key: "documents.maxFileSizeMb",
    label: "Document size limit (MB)",
    group: "Applications & documents",
    description: "Maximum uploaded document size in megabytes (§4.6.11 default 10, INV-024).",
    type: "number",
    min: 1,
    max: 100,
    defaultValue: 10,
  },
  {
    key: "documents.maxPerApplication",
    label: "Max documents per application",
    group: "Applications & documents",
    description: "Maximum number of documents per application (§4.6.11 default 25, INV-024).",
    type: "number",
    min: 1,
    max: 500,
    defaultValue: 25,
  },
  {
    key: "notes.maxLength",
    label: "Note length limit (chars)",
    group: "Applications & documents",
    description: "Maximum characters for internal/formal notes (§4.6.11 default 4,000, INV-024).",
    type: "number",
    min: 100,
    max: 100000,
    defaultValue: 4000,
  },
  {
    key: "chatter.maxLength",
    label: "Chatter length limit (chars)",
    group: "Applications & documents",
    description: "Maximum characters per chatter message (§4.6.11 default 1,000, INV-024).",
    type: "number",
    min: 100,
    max: 100000,
    defaultValue: 1000,
  },
  {
    key: "ocr.retryLimit",
    label: "OCR automatic retry limit",
    group: "Applications & documents",
    description: "Maximum automatic OCR retry attempts per document job (§4.6.11 default 5, INV-024).",
    type: "number",
    min: 0,
    max: 20,
    defaultValue: 5,
  },

  // --- Sessions & passwords ---
  {
    key: "session.idleTimeoutMinutes",
    label: "Session idle timeout (minutes)",
    group: "Sessions & passwords",
    description: "Idle minutes after which a session expires (§4.6.11 default 30).",
    type: "number",
    min: 5,
    max: 480,
    defaultValue: 30,
  },
  {
    key: "session.absoluteTimeoutHours",
    label: "Session absolute timeout (hours)",
    group: "Sessions & passwords",
    description: "Absolute session lifetime in hours regardless of activity (§4.6.11 default 12).",
    type: "number",
    min: 1,
    max: 72,
    defaultValue: 12,
  },
  {
    key: "password.expiryDays",
    label: "Password expiry (days)",
    group: "Sessions & passwords",
    description: "Days before a password expires and must be changed (§4.6.11 default 180).",
    type: "number",
    min: 1,
    max: 3650,
    defaultValue: 180,
  },
  {
    key: "password.historyDepth",
    label: "Password history depth",
    group: "Sessions & passwords",
    description: "Number of prior passwords that may not be reused (§4.6.11 default 5).",
    type: "number",
    min: 0,
    max: 24,
    defaultValue: 5,
  },
  {
    key: "password.lockoutAttempts",
    label: "Lockout attempts",
    group: "Sessions & passwords",
    description: "Failed sign-in attempts before temporary lockout (§4.6.11 default 5).",
    type: "number",
    min: 1,
    max: 100,
    defaultValue: 5,
  },
  {
    key: "password.lockoutMinutes",
    label: "Lockout duration (minutes)",
    group: "Sessions & passwords",
    description: "Minutes an account stays locked after too many failed attempts (§4.6.11 default 15).",
    type: "number",
    min: 1,
    max: 1440,
    defaultValue: 15,
  },

  // --- Rate limiting (defaults per §4.1.9) ---
  {
    key: "rateLimit.authAttempts",
    label: "Auth endpoints: attempts per window",
    group: "Rate limiting",
    description: "Allowed attempts per window per key (account/IP) for authentication endpoints (§4.1.9 default 10).",
    type: "number",
    min: 1,
    max: 1000,
    defaultValue: 10,
  },
  {
    key: "rateLimit.authWindowMinutes",
    label: "Auth endpoints: window (minutes)",
    group: "Rate limiting",
    description: "Window length in minutes for the authentication-endpoint rate limit (§4.1.9 default 15).",
    type: "number",
    min: 1,
    max: 60,
    defaultValue: 15,
  },
  {
    key: "rateLimit.generalPerMinute",
    label: "Other rate-limited endpoints: per minute",
    group: "Rate limiting",
    description: "Allowed requests per minute per key for non-auth rate-limited endpoints (§4.1.9 default 60).",
    type: "number",
    min: 1,
    max: 10000,
    defaultValue: 60,
  },

  // --- Lists & exports ---
  {
    key: "pagination.maxPageSize",
    label: "Maximum page size",
    group: "Lists & exports",
    description: "Server-enforced maximum page size for every list endpoint (§4.6.11 default 100, INV-036).",
    type: "number",
    min: 1,
    max: 1000,
    defaultValue: 100,
  },
  {
    key: "audit.exportRowCap",
    label: "Audit export row cap",
    group: "Lists & exports",
    description: "Maximum rows per audit-log CSV export (§4.6.11 default 100,000, INV-024).",
    type: "number",
    min: 1000,
    max: 10000000,
    defaultValue: 100000,
  },

  // --- HMDA reporting ---
  {
    key: "hmda.lei",
    label: "HMDA Legal Entity Identifier (LEI)",
    group: "HMDA reporting",
    description:
      "20-character Legal Entity Identifier for HMDA LAR export (§4.6.11 default blank — LAR export blocks until set).",
    type: "string",
    allowBlank: true,
    pattern: /^[A-Z0-9]{20}$/,
    patternHint: "must be exactly 20 characters (A–Z, 0–9), or blank",
    defaultValue: "",
  },
  {
    key: "hmda.agencyCode",
    label: "HMDA agency code",
    group: "HMDA reporting",
    description:
      "Single-digit HMDA agency code for LAR export (§4.6.11 default blank — LAR export blocks until set).",
    type: "string",
    allowBlank: true,
    pattern: /^[1-9]$/,
    patternHint: "must be a single digit 1–9, or blank",
    defaultValue: "",
  },
];

const REGISTRY_BY_KEY: ReadonlyMap<string, ConfigRegistryEntry> = new Map(
  CONFIG_REGISTRY.map((entry) => [entry.key, entry]),
);

export function getRegistryEntry(key: string): ConfigRegistryEntry | undefined {
  return REGISTRY_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Validation (VR-124 / VR-125)
// ---------------------------------------------------------------------------

/** VR-125: ConfigUpdateRequest.value is a JSON-encoded string, ≤ 4000 chars. */
export const CONFIG_VALUE_MAX_ENCODED_LENGTH = 4000;

/** Thrown for VR-124/VR-125 failures; routes map it to the 400 validation ErrorResponse. */
export class ConfigValidationError extends Error {
  readonly details: string[];
  constructor(details: string[]) {
    super(details.join("; "));
    this.name = "ConfigValidationError";
    this.details = details;
  }
}

type JsonValue = number | boolean | string | string[];

// --- VR-136: IANA time-zone identifiers (company.timeZone) -----------------

/**
 * The runtime's time-zone database, canonical names only. Intl.supportedValuesOf
 * deliberately EXCLUDES fixed-offset aliases (UTC, GMT, Etc/GMT±n) and offset
 * strings ("+05:00"), which is exactly the VR-136 rejection set.
 */
let canonicalZones: Set<string> | null = null;

function zoneDatabase(): Set<string> {
  if (canonicalZones === null) canonicalZones = new Set(Intl.supportedValuesOf("timeZone"));
  return canonicalZones;
}

/**
 * VR-136: a non-empty IANA identifier the runtime's zone database accepts.
 * Link names ("US/Eastern") pass because they canonicalize into the database;
 * fixed-offset aliases and unknown names do not (their canonical form is absent).
 */
export function isIanaTimeZone(value: string): boolean {
  if (value.trim() === "") return false;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  return zoneDatabase().has(canonical);
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Decode + validate a JSON-encoded value against a registry entry. Returns the
 * decoded value on success; throws ConfigValidationError listing every failure.
 */
export function decodeAndValidateValue(entry: ConfigRegistryEntry, encoded: string): JsonValue {
  const details: string[] = [];

  if (encoded.length > CONFIG_VALUE_MAX_ENCODED_LENGTH) {
    throw new ConfigValidationError([
      `value: JSON-encoded value exceeds ${CONFIG_VALUE_MAX_ENCODED_LENGTH} characters (VR-125)`,
    ]);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new ConfigValidationError(["value: must be a JSON-encoded value (VR-125)"]);
  }

  switch (entry.type) {
    case "number":
    case "percent": {
      if (typeof decoded !== "number" || !Number.isFinite(decoded)) {
        details.push(`value: ${entry.key} expects a JSON number, got ${typeName(decoded)}`);
        break;
      }
      if (entry.integer !== false && !Number.isInteger(decoded)) {
        details.push(`value: ${entry.key} expects an integer`);
      }
      const min = entry.min ?? (entry.type === "percent" ? 0 : undefined);
      const max = entry.max ?? (entry.type === "percent" ? 100 : undefined);
      if (min !== undefined && decoded < min) details.push(`value: ${entry.key} must be >= ${min}`);
      if (max !== undefined && decoded > max) details.push(`value: ${entry.key} must be <= ${max}`);
      break;
    }
    case "boolean": {
      if (typeof decoded !== "boolean") {
        details.push(`value: ${entry.key} expects a JSON boolean, got ${typeName(decoded)}`);
      }
      break;
    }
    case "string": {
      if (typeof decoded !== "string") {
        details.push(`value: ${entry.key} expects a JSON string, got ${typeName(decoded)}`);
        break;
      }
      if (decoded === "") {
        if (!entry.allowBlank) details.push(`value: ${entry.key} must not be blank`);
      } else if (entry.pattern && !entry.pattern.test(decoded)) {
        details.push(`value: ${entry.key} ${entry.patternHint ?? "has an invalid format"}`);
      } else if (entry.format === "iana-time-zone" && !isIanaTimeZone(decoded)) {
        // VR-136: unknown names and fixed-offset aliases (UTC, GMT, Etc/GMT±n,
        // "+05:00") are rejected — the error names the field.
        details.push(
          `value: ${entry.key} must be an IANA time zone identifier accepted by the runtime time zone database (e.g. "America/New_York"); fixed-offset aliases are not accepted (VR-136)`,
        );
      }
      break;
    }
    case "enum-list": {
      if (!Array.isArray(decoded) || decoded.some((m) => typeof m !== "string")) {
        details.push(`value: ${entry.key} expects a JSON array of strings, got ${typeName(decoded)}`);
        break;
      }
      const allowed = entry.allowedValues ?? [];
      for (const member of decoded as string[]) {
        if (!allowed.includes(member)) {
          details.push(`value: "${member}" is not one of [${allowed.join(", ")}]`);
        }
      }
      if (new Set(decoded).size !== decoded.length) {
        details.push(`value: ${entry.key} must not contain duplicates`);
      }
      break;
    }
  }

  if (details.length > 0) throw new ConfigValidationError(details);
  return decoded as JsonValue;
}

// ---------------------------------------------------------------------------
// Reads — §A serialization + typed getters (INV-024 consumers)
// ---------------------------------------------------------------------------

/** contracts.md §A ConfigSetting — exact field names; value is a JSON-encoded string. */
export interface ConfigSettingWire {
  key: string;
  value: string;
  description?: string;
  updatedByName?: string;
  updatedAt?: string;
}

/** contracts.md §A SystemConfigResponse. */
export interface SystemConfigResponseWire {
  settings: ConfigSettingWire[];
}

/**
 * All settings in registry order, serialized to the §A wire shape. Values come
 * from LIVE SystemConfig rows (migration-seeded); if a row is ever missing the
 * registry default is served so every §4.6.11 setting is always listed.
 */
export async function listSettings(): Promise<ConfigSettingWire[]> {
  const rows = await prisma.systemConfig.findMany({
    include: { updatedByUser: { select: { firstName: true, lastName: true } } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return CONFIG_REGISTRY.map((entry) => {
    const row = byKey.get(entry.key);
    if (!row) {
      // Defensive fallback only — the seed migration guarantees presence.
      return {
        key: entry.key,
        value: JSON.stringify(entry.defaultValue),
        description: entry.description,
      };
    }
    const setting: ConfigSettingWire = {
      key: row.key,
      value: JSON.stringify(row.value),
      description: row.description ?? entry.description,
      updatedAt: row.updatedAt.toISOString(),
    };
    if (row.updatedByUser) {
      setting.updatedByName = `${row.updatedByUser.firstName} ${row.updatedByUser.lastName}`.trim();
    }
    return setting;
  });
}

export async function getSystemConfigResponse(): Promise<SystemConfigResponseWire> {
  return { settings: await listSettings() };
}

/** Typed read with registry-default fallback (single accessor underneath — INV-024). */
export async function getNumberSetting(key: string): Promise<number> {
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry || (entry.type !== "number" && entry.type !== "percent")) {
    throw new Error(`getNumberSetting: "${key}" is not a registered numeric setting`);
  }
  const raw = await getConfigValue(key);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : (entry.defaultValue as number);
}

export async function getBooleanSetting(key: string): Promise<boolean> {
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry || entry.type !== "boolean") {
    throw new Error(`getBooleanSetting: "${key}" is not a registered boolean setting`);
  }
  const raw = await getConfigValue(key);
  return typeof raw === "boolean" ? raw : (entry.defaultValue as boolean);
}

export async function getStringSetting(key: string): Promise<string> {
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry || entry.type !== "string") {
    throw new Error(`getStringSetting: "${key}" is not a registered string setting`);
  }
  const raw = await getConfigValue(key);
  return typeof raw === "string" ? raw : (entry.defaultValue as string);
}

export async function getStringListSetting(key: string): Promise<string[]> {
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry || entry.type !== "enum-list") {
    throw new Error(`getStringListSetting: "${key}" is not a registered list setting`);
  }
  const raw = await getConfigValue(key);
  return Array.isArray(raw) && raw.every((m) => typeof m === "string")
    ? (raw as string[])
    : [...(entry.defaultValue as readonly string[])];
}

// ---------------------------------------------------------------------------
// Write path — validated, audited, transactional (AC-32)
// ---------------------------------------------------------------------------

export interface ConfigUpdateMeta {
  /** Server-derived client IP for the audit entry. */
  ip?: string | null;
  /** Request-correlation id for the audit entry. */
  requestId?: string | null;
}

/**
 * Update one setting. `actor` MUST be the guard's authenticated SessionUser —
 * audit identity never comes from a request body. Validates VR-124 (known
 * §4.6.11 key) and VR-125 (JSON-encoded, typed, bounded, ≤ 4000 chars), then
 * writes row + "config-change" audit entry (before/after) in one transaction.
 * A failure of EITHER write rolls both back. Invalidate-on-write keeps the
 * shared read cache coherent.
 *
 * @throws ConfigValidationError for VR-124/VR-125 failures (no DB write happens).
 */
export async function updateSetting(
  actor: SessionUser,
  key: string,
  encodedValue: string,
  meta: ConfigUpdateMeta = {},
): Promise<void> {
  const entry = REGISTRY_BY_KEY.get(key);
  if (!entry) {
    throw new ConfigValidationError([
      `key: "${key}" is not a known SystemConfig key from the §4.6.11 table (VR-124)`,
    ]);
  }
  const decoded = decodeAndValidateValue(entry, encodedValue);

  await prisma.$transaction(async (tx) => {
    await writeSettingInTx(tx, actor, entry, decoded, meta);
  });

  invalidateConfigCache(key);
}

/**
 * The transactional core: config-row upsert + audit entry on the SAME tx
 * client. Exposed for callers that already hold an open transaction; they are
 * responsible for calling invalidateConfigCache(key) after commit.
 */
export async function writeSettingInTx(
  tx: AuditTransactionClient,
  actor: SessionUser,
  entry: ConfigRegistryEntry,
  decoded: JsonValue,
  meta: ConfigUpdateMeta = {},
): Promise<void> {
  const existing = await tx.systemConfig.findUnique({ where: { key: entry.key } });
  const before: Prisma.InputJsonValue =
    existing === null ? (entry.defaultValue as Prisma.InputJsonValue) : (existing.value as Prisma.InputJsonValue);

  const row = await tx.systemConfig.upsert({
    where: { key: entry.key },
    update: { value: decoded as Prisma.InputJsonValue, updatedByUserId: actor.userId },
    create: {
      key: entry.key,
      value: decoded as Prisma.InputJsonValue,
      description: entry.description,
      updatedByUserId: actor.userId,
    },
  });

  // AC-32: every config change audited with before/after, in-transaction — an
  // audit failure aborts the transaction and rolls the config change back.
  await audit(tx, {
    actor: actor.userId,
    role: actor.role,
    actionType: "config-change",
    entityType: "SystemConfig",
    entityId: row.id,
    summary: `Configuration setting "${entry.key}" changed`,
    before: { key: entry.key, value: before },
    after: { key: entry.key, value: decoded as Prisma.InputJsonValue },
    ip: meta.ip ?? null,
    requestId: meta.requestId ?? null,
  });
}
