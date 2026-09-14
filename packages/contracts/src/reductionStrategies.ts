/**
 * The action-lever library — the PLAN half of a CRP.
 *
 * Kept deliberately apart from the measurement half. A scope row says what was emitted and
 * carries a factor, a quality tier and a provenance trail; an action says what the client
 * intends to do about it. The two are different kinds of claim and must not be able to
 * borrow each other's authority.
 *
 * Everything here is **qualitative** (A2-lite). There is a slot for a modelled tCO₂e impact
 * because Stage 2 needs one, but it is empty, and the type makes it impossible to carry a
 * figure without its basis — an unsourced reduction number on a client's plan is exactly
 * what ends up quoted in a report.
 */

export const strategyScopes = ["1", "2", "3", "governance"] as const;
export type StrategyScope = (typeof strategyScopes)[number];

/**
 * How much of the outcome the client actually controls — the axis the plan is read by,
 * because it is the one they can act on.
 *
 * NOTE: this is NOT the SBTi "Spheres of Influence" framework in `portalActions.ts`, which
 * is about beyond-value-chain mitigation and uses A/B/C/D. Same words, different idea; see
 * the note on `strategyControlLevelLabels`.
 */
export const strategyControlLevels = ["direct_control", "supply_chain", "influence"] as const;
export type StrategyControlLevel = (typeof strategyControlLevels)[number];

export const strategyControlLevelLabels: Record<StrategyControlLevel, string> = {
  direct_control: "Direct control · own operations",
  supply_chain: "Supply chain · procurement",
  influence: "Influence · customers & industry",
};

/** What each grouping typically covers, said once so the three cards stay honest. */
export const strategyControlLevelScopeHint: Record<StrategyControlLevel, string> = {
  direct_control: "Scope 1 & 2",
  supply_chain: "Scope 3 upstream",
  influence: "Scope 3 downstream",
};

export const strategyStatuses = ["planned", "in_progress", "complete"] as const;
export type StrategyStatus = (typeof strategyStatuses)[number];

export const strategyStatusLabels: Record<StrategyStatus, string> = {
  planned: "Planned", in_progress: "In progress", complete: "Complete",
};

export const strategyScopeLabel = (scope: StrategyScope) => scope === "governance" ? "Governance" : `Scope ${scope}`;

export type LibraryStrategy = {
  id: string;
  key: string;
  /** The levers this strategy is allocated to (M:N). */
  leverIds: string[];
  title: string;
  description: string;
  scope: StrategyScope;
  category: string;
  controlLevel: StrategyControlLevel;
  iconKey: string;
  active: boolean;
  version: number;
  /**
   * Stage 2. `null` today, everywhere. When it arrives it arrives with its basis — the
   * pairing is a tuple rather than two optional fields precisely so one cannot be set
   * without the other.
   */
  modelledImpact: { tco2ePerYear: number; basis: string } | null;
};

export type ClientStrategy = {
  id: string;
  clientId: string;
  /** Inherited from the library strategy, or chosen directly for a bespoke one. */
  leverIds: string[];
  /** null for a bespoke action — one that is not in the catalogue. */
  strategyId: string | null;
  title: string;
  scope: StrategyScope;
  category: string;
  controlLevel: StrategyControlLevel;
  iconKey: string;
  status: StrategyStatus;
  owner: string;
  targetDate: string | null;
  progressPct: number;
  notes: string;
  active: boolean;
  version: number;
};

/**
 * "Done" means one thing.
 *
 * The database enforces this as a CHECK; this is the same rule where the UI can act on it,
 * so a form cannot offer a combination that will be refused on save. A plan that disagrees
 * with itself in front of a client is worse than one that refuses an edit.
 */
export function strategyProgressForStatus(status: StrategyStatus, progressPct: number): number {
  if (status === "complete") return 100;
  // Leaving 100% on a non-complete action would fail the constraint; step it back rather
  // than silently rewriting the status the person actually chose.
  return Math.min(99, Math.max(0, Math.round(progressPct)));
}

export function strategyStatusForProgress(progressPct: number, current: StrategyStatus): StrategyStatus {
  if (progressPct >= 100) return "complete";
  // Dragging a complete action back below 100 makes it in-progress, not planned: work that
  // was finished and then reopened was never "not started".
  return current === "complete" ? "in_progress" : current;
}

export type StrategyPlanSummary = {
  total: number;
  planned: number;
  inProgress: number;
  complete: number;
  /**
   * Mean progress across live actions, or null when the plan is empty — never 0, which
   * would read as "no progress" rather than "nothing planned yet".
   */
  progressPct: number | null;
};

export function strategyPlanSummary(actions: readonly ClientStrategy[]): StrategyPlanSummary {
  const live = actions.filter((action) => action.active);
  const summary: StrategyPlanSummary = { total: live.length, planned: 0, inProgress: 0, complete: 0, progressPct: null };
  let progressTotal = 0;
  for (const action of live) {
    if (action.status === "planned") summary.planned += 1;
    else if (action.status === "in_progress") summary.inProgress += 1;
    else summary.complete += 1;
    progressTotal += action.progressPct;
  }
  if (live.length > 0) summary.progressPct = Math.round(progressTotal / live.length);
  return summary;
}

/**
 * A lever — the theme a strategy belongs to.
 *
 * A categorisation, and deliberately many-to-many: "switch to a renewable tariff" is an
 * energy strategy, but installing solar is energy *and* buildings. Control level answers a
 * different question — how much of it the client controls — and stays its own single-value
 * axis. Collapsing the two would lose both answers.
 */
export type Lever = {
  id: string;
  key: string;
  title: string;
  iconKey: string;
  ordering: number;
  active: boolean;
};

export type StrategyLeverGroup = { lever: Lever; strategies: ClientStrategy[] };

/**
 * The plan grouped by lever, which is how the workspace draws it.
 *
 * A strategy allocated to two levers appears under both — that is what a many-to-many
 * categorisation means, and hiding it from one of its themes would make the grouping lie.
 * The counts on each header are therefore per-group, not a partition of the plan; the
 * summary strip above counts each strategy once.
 */
export function strategyPlanByLever(
  strategies: readonly ClientStrategy[],
  levers: readonly Lever[],
): StrategyLeverGroup[] {
  const rank: Record<StrategyStatus, number> = { in_progress: 0, planned: 1, complete: 2 };
  const live = strategies.filter((strategy) => strategy.active);
  return [...levers]
    .filter((lever) => lever.active)
    .sort((a, b) => a.ordering - b.ordering || a.title.localeCompare(b.title))
    .map((lever) => ({
      lever,
      strategies: live
        .filter((strategy) => strategy.leverIds.includes(lever.id))
        // In progress first (what is live), then planned (what is next), then complete.
        .sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title)),
    }))
    .filter((group) => group.strategies.length > 0);
}

/**
 * Strategies allocated to no live lever at all.
 *
 * Shown in their own group rather than dropped: a plan grouped by lever would otherwise
 * silently lose a strategy whose only lever was withdrawn, and the client would be left
 * with a plan that is quietly shorter than the one they agreed.
 */
export function strategiesWithoutLever(
  strategies: readonly ClientStrategy[],
  levers: readonly Lever[],
): ClientStrategy[] {
  const liveLevers = new Set(levers.filter((lever) => lever.active).map((lever) => lever.id));
  return strategies.filter((strategy) =>
    strategy.active && !strategy.leverIds.some((id) => liveLevers.has(id)));
}

export type StrategyControlLevelGroup = {
  controlLevel: StrategyControlLevel;
  label: string;
  scopeHint: string;
  actions: ClientStrategy[];
};

/**
 * The plan as the workspace draws it: three groups, always in the same order, and only the
 * ones with something in them.
 *
 * Within a group, the order is the order of work rather than of the alphabet — in progress
 * first (what is live), then planned (what is next), then complete (what is behind you).
 */
export function strategyPlanGroups(actions: readonly ClientStrategy[]): StrategyControlLevelGroup[] {
  const rank: Record<StrategyStatus, number> = { in_progress: 0, planned: 1, complete: 2 };
  return strategyControlLevels
    .map((controlLevel) => ({
      controlLevel,
      label: strategyControlLevelLabels[controlLevel],
      scopeHint: strategyControlLevelScopeHint[controlLevel],
      actions: actions
        .filter((action) => action.active && action.controlLevel === controlLevel)
        .sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title)),
    }))
    .filter((group) => group.actions.length > 0);
}

/**
 * The catalogue as the "Add from library" drawer shows it, with what the client already
 * holds marked as added rather than offered twice.
 */
export type StrategyLibraryEntry = { strategy: LibraryStrategy; assigned: boolean };

export function strategyLibrary(
  library: readonly LibraryStrategy[],
  plan: readonly ClientStrategy[],
): StrategyLibraryEntry[] {
  const assigned = new Set(plan.filter((entry) => entry.active && entry.strategyId !== null).map((entry) => entry.strategyId!));
  return library
    // A withdrawn strategy stays visible while a client still holds it — their plan should
    // not develop a gap because the library moved on — but is not offered to anyone new.
    .filter((strategy) => strategy.active || assigned.has(strategy.id))
    .map((strategy) => ({ strategy, assigned: assigned.has(strategy.id) }))
    .sort((a, b) =>
      strategyControlLevels.indexOf(a.strategy.controlLevel) - strategyControlLevels.indexOf(b.strategy.controlLevel)
      || a.strategy.title.localeCompare(b.strategy.title));
}
