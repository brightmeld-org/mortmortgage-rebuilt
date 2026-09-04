// Shared pagination for EVERY list endpoint (INV-036, SEC-14, AC-59).
//
// Contract convention (contracts.md §B): offset-based — `?page` (1-based) and
// `?pageSize`; every paginated response returns the shared wrapper fields
// `rows[] / page / pageSize / total` (the §A `*Page` models: QueuePage, NotePage,
// VersionPage, WorkflowHistoryPage, ...).
//
// The server CLAMPS pageSize to the configured maximum read from SystemConfig
// (pagination.maxPageSize, §4.6.11 default 100) — the client value is never
// trusted: `?pageSize=1000` returns at most the maximum WITHOUT error (AC-59).
// Non-numeric / non-positive values fall back to defaults rather than erroring.

import { CONFIG_DEFAULTS, CONFIG_KEYS, getConfigNumber } from "@/lib/http/config";

/** Default rows per page when the client sends none (audit viewer convention, §B). */
export const DEFAULT_PAGE_SIZE = 25;

export interface Pagination {
  /** 1-based page number (clamped to >= 1). */
  page: number;
  /** Effective page size after server-side clamping — echo this in the envelope. */
  pageSize: number;
  /** Prisma skip. */
  skip: number;
  /** Prisma take. */
  take: number;
}

/** Shared wrapper fields of every §A *Page model. */
export interface PageEnvelope<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
}

function parsePositiveInt(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/**
 * Resolve pagination from a request URL, clamped against the live SystemConfig
 * maximum. `endpointMax` optionally lowers the ceiling for endpoints whose §B row
 * caps a smaller maximum (e.g. "none (max 50)" list endpoints).
 */
export async function getPagination(request: Request, endpointMax?: number): Promise<Pagination> {
  const params = new URL(request.url).searchParams;

  const configuredMax = await getConfigNumber(
    CONFIG_KEYS.maxPageSize,
    CONFIG_DEFAULTS[CONFIG_KEYS.maxPageSize],
  );
  const max = endpointMax !== undefined ? Math.min(endpointMax, configuredMax) : configuredMax;

  const page = parsePositiveInt(params.get("page")) ?? 1;
  const requested = parsePositiveInt(params.get("pageSize")) ?? Math.min(DEFAULT_PAGE_SIZE, max);
  // Never trust the client: clamp, don't error (AC-59 / INV-036).
  const pageSize = Math.min(requested, max);

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Build the contract's list envelope — exact field names rows/page/pageSize/total. */
export function pageEnvelope<T>(
  rows: T[],
  pagination: Pick<Pagination, "page" | "pageSize">,
  total: number,
): PageEnvelope<T> {
  return { rows, page: pagination.page, pageSize: pagination.pageSize, total };
}
