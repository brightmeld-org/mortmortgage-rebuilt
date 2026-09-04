// Auto-assign candidate-selection strategy — PURE functions only (task-022,
// REQ-056, §4.6.2, WALK-007). No I/O, no prisma, no Date.now(): callers supply
// every input, so this module is testable with zero mocks.
//
// §4.6.2: "Auto-assign ... using workload balancing: each application goes to
// the active caseworker with the fewest active (non-terminal, non-Draft)
// assignments at the moment of assignment, ties broken by least-recently-
// assigned. A configurable option (default off) enables productivity-aware
// weighting: effective load = active count × (1 − w × normalized 90-day
// completion rate), w ∈ [0, 0.5] configurable. The algorithm must be
// implemented behind a strategy interface so additional factors can be added."

/** Live workload snapshot for one active CASEWORKER candidate. */
export interface CandidateWorkload {
  /** User.id of the candidate (role CASEWORKER, status active). */
  userId: string;
  /** Count of ACTIVE assignments (endedAt null) on non-terminal, non-Draft applications. */
  activeCount: number;
  /**
   * Most recent CaseworkerAssignment.assignedAt across ALL of the candidate's
   * assignments (active or ended); null = never assigned. Used for the
   * documented tie-break.
   */
  lastAssignedAt: Date | null;
  /**
   * Completions in the trailing 90 days: applications that reached a final
   * decision (Application.decidedAt within the window) while this caseworker
   * held the assignment covering the decision moment.
   */
  completions90d: number;
}

export interface AutoAssignOptions {
  /** SystemConfig `autoAssign.productivityAware` (§4.6.2 default off). */
  productivityAware: boolean;
  /** SystemConfig `autoAssign.productivityWeight` — clamped to the §4.6.2 domain [0, 0.5]. */
  productivityWeight: number;
}

/**
 * The strategy seam (§4.6.2 "behind a strategy interface"): a replacement
 * strategy (e.g. skill-based routing) implements this interface and is passed
 * to the auto-assign service in place of `workloadBalancingStrategy`.
 */
export interface AutoAssignStrategy {
  readonly name: string;
  /** Pick the winning candidate's userId, or null when there are no candidates. */
  pick(candidates: readonly CandidateWorkload[], options: AutoAssignOptions): string | null;
}

/** Clamp the configured weight into the contract's documented domain w ∈ [0, 0.5] (§4.6.2). */
export function clampProductivityWeight(w: number): number {
  if (!Number.isFinite(w) || w < 0) return 0;
  return Math.min(w, 0.5);
}

/**
 * Normalized 90-day completion rate per candidate: completions90d divided by
 * the MAXIMUM completions90d across the candidate pool, giving a value in
 * [0, 1] (0 for everyone when nobody completed anything). This is the
 * "normalized" term of the §4.6.2 formula — relative productivity within the
 * current pool, so the weighting is scale-free.
 */
export function normalizedCompletionRates(
  candidates: readonly CandidateWorkload[],
): Map<string, number> {
  const max = candidates.reduce((m, c) => Math.max(m, c.completions90d), 0);
  const rates = new Map<string, number>();
  for (const c of candidates) {
    rates.set(c.userId, max > 0 ? c.completions90d / max : 0);
  }
  return rates;
}

/** §4.6.2 formula: effectiveLoad = activeCount × (1 − w × normalizedRate). */
export function effectiveLoad(activeCount: number, normalizedRate: number, w: number): number {
  return activeCount * (1 - clampProductivityWeight(w) * normalizedRate);
}

/**
 * TIE-BREAK (documented, §4.6.2 "ties broken by least-recently-assigned"):
 * among candidates with equal load, the winner is the one whose most recent
 * assignment (`lastAssignedAt`) is OLDEST; a candidate never assigned at all
 * (null) is treated as least-recently-assigned and wins over any timestamp.
 * A residual exact tie (same instant / both never assigned) falls back to
 * ascending userId so the choice is deterministic and testable.
 */
function tieBreak(a: CandidateWorkload, b: CandidateWorkload): number {
  const aTime = a.lastAssignedAt === null ? -Infinity : a.lastAssignedAt.getTime();
  const bTime = b.lastAssignedAt === null ? -Infinity : b.lastAssignedAt.getTime();
  if (aTime !== bTime) return aTime - bTime; // older (smaller) wins
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * Default strategy: fewest active (non-terminal, non-Draft) assignments; with
 * productivity-aware weighting enabled, fewest EFFECTIVE load per the §4.6.2
 * formula. Load comparisons use an epsilon so float artifacts of the weighting
 * math never mask a true tie.
 */
export const workloadBalancingStrategy: AutoAssignStrategy = {
  name: "workload-balancing",
  pick(candidates, options): string | null {
    if (candidates.length === 0) return null;
    const rates = options.productivityAware
      ? normalizedCompletionRates(candidates)
      : null;
    const loadOf = (c: CandidateWorkload): number =>
      rates === null
        ? c.activeCount
        : effectiveLoad(c.activeCount, rates.get(c.userId) ?? 0, options.productivityWeight);

    const EPS = 1e-9;
    let best = candidates[0]!;
    let bestLoad = loadOf(best);
    for (const c of candidates.slice(1)) {
      const load = loadOf(c);
      if (load < bestLoad - EPS) {
        best = c;
        bestLoad = load;
      } else if (Math.abs(load - bestLoad) <= EPS && tieBreak(c, best) < 0) {
        best = c;
        // keep bestLoad — equal within epsilon
      }
    }
    return best.userId;
  },
};

/** Convenience: pick with the default workload-balancing strategy. */
export function pickAutoAssignee(
  candidates: readonly CandidateWorkload[],
  options: AutoAssignOptions,
  strategy: AutoAssignStrategy = workloadBalancingStrategy,
): string | null {
  return strategy.pick(candidates, options);
}
