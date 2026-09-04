/**
 * contracts.json accessor — the machine-readable authority for endpoints, enums
 * and the workflow transition map. Suites that enumerate routes (RBAC coverage,
 * audit coverage, SSN masking) read from here so the enumeration can never drift
 * from the contract.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTRACTS_PATH = join(process.cwd(), "contracts.json");

export interface ContractEndpoint {
  method: string;
  path: string;
  requestBody: string | null;
  responseBody: string | null;
  status: number;
  errorCodes: Array<number | string>;
  roleGate: string[];
  pagination?: string | null;
  requirementIds: string[];
}

interface ContractsFile {
  endpoints: ContractEndpoint[];
  enums: Record<string, string[]> | Array<{ name: string; values: string[] }>;
  transitions: Record<string, Record<string, string[]>>;
  models: unknown;
}

const raw = JSON.parse(readFileSync(CONTRACTS_PATH, "utf8")) as ContractsFile;

export const endpoints: ContractEndpoint[] = raw.endpoints;

/** Every enum, normalized to name → values. */
export const enums: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  const source = raw.enums as unknown;
  if (Array.isArray(source)) {
    for (const entry of source as Array<{ name: string; values: string[] }>) out[entry.name] = entry.values;
  } else {
    for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
      if (Array.isArray(value)) out[name] = value as string[];
      else if (value && typeof value === "object" && Array.isArray((value as { values?: string[] }).values)) {
        out[name] = (value as { values: string[] }).values;
      }
    }
  }
  return out;
})();

/** Workflow state → allowed target states, verbatim from the contract. */
export const workflowTransitions: Record<string, string[]> = raw.transitions.WorkflowState;

/** Document job status → allowed target statuses. */
export const jobTransitions: Record<string, string[]> = raw.transitions.DocumentJobStatus;

export const WORKFLOW_STATES: string[] = enums.WorkflowState;

/** Terminal states carry no outbound transitions (INV-033). */
export const TERMINAL_STATES: string[] = WORKFLOW_STATES.filter(
  (state) => (workflowTransitions[state] ?? []).length === 0,
);

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const mutatingEndpoints: ContractEndpoint[] = endpoints.filter((entry) =>
  MUTATING_METHODS.has(entry.method),
);

export function endpointKey(entry: ContractEndpoint): string {
  return `${entry.method} ${entry.path}`;
}

export function findEndpoint(method: string, path: string): ContractEndpoint {
  const found = endpoints.find((entry) => entry.method === method && entry.path === path);
  if (!found) throw new Error(`Endpoint not in contract: ${method} ${path}`);
  return found;
}

/** Substitutes :params in a contract path template with concrete values. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value supplied for :${name} in ${template}`);
    return encodeURIComponent(value);
  });
}
