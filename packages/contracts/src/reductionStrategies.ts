import type { StrategyEstimate } from "./strategyProjection";
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

/**
 * The status ladder (Actions A1, R3; settled 26 Oct): Proposed → Agreed → In progress → Complete, with On hold and
 * Declined at the edges. In the order a plan is read.
 */
export const strategyStatuses = ["proposed", "agreed", "in_progress", "complete", "on_hold", "declined"] as const;
export type StrategyStatus = (typeof strategyStatuses)[number];
/**
 * What a report **frozen before A1** may carry: 0075's `planned`, which 0186 moved to `agreed` on the live plan
 * but which stays in every composition issued before it. A report is what it said when it was issued.
 */
export type FrozenStrategyStatus = StrategyStatus | "planned";

export const strategyStatusLabels: Record<FrozenStrategyStatus, string> = {
  proposed: "Proposed", agreed: "Agreed", in_progress: "In progress", complete: "Complete", on_hold: "On hold", declined: "Declined",
  planned: "Planned",
};

/**
 * The legal moves (R3). Staff own Proposed → Agreed; the owner drives In progress → Complete (in A1 staff record it
 * on their behalf; A2 gives the client contact the portal path). Every other move here is an edge the ladder needs:
 * agreed work paused or dropped, paused work resumed, finished work reopened, a declined action proposed again.
 * Anything not listed — Proposed straight to In progress, Declined straight to Complete — is refused.
 */
export const strategyTransitions: Readonly<Record<StrategyStatus, readonly StrategyStatus[]>> = {
  proposed: ["agreed", "declined"],
  agreed: ["in_progress", "complete", "on_hold", "declined"],
  in_progress: ["complete", "on_hold", "declined"],
  complete: ["in_progress"],
  on_hold: ["agreed", "in_progress", "declined"],
  declined: ["proposed"],
};

/** Whether `from` may become `to`. Staying put is always allowed — an edit that changes other fields. */
export const strategyTransitionAllowed = (from: StrategyStatus, to: StrategyStatus): boolean =>
  from === to || strategyTransitions[from].includes(to);

/** The states a status select should offer from here: where it is, then where it may go. */
export const strategyNextStatuses = (from: StrategyStatus): StrategyStatus[] =>
  strategyStatuses.filter((status) => strategyTransitionAllowed(from, status));

/** Agreed or beyond on the main ladder — the states a report's Plan section may show (R5). */
export const strategyReportableStatuses: readonly StrategyStatus[] = ["agreed", "in_progress", "complete"];

/**
 * Whether a strategy composes into a client-facing report (R5): on the plan, marked **Include in report**, and
 * **agreed or beyond**. A proposal the client has not agreed, an action they declined, or one on hold is not
 * presented as their plan. The staff workspace shows the whole plan regardless.
 */
export const strategyIsReportable = (strategy: Pick<ClientStrategy, "active" | "includeInReport" | "status">): boolean =>
  strategy.active && strategy.includeInReport && strategyReportableStatuses.includes(strategy.status);

/** Where an action came from (R6, R7) — set when it is created, never changed. */
export const strategyOrigins = ["plan", "srs_gap", "client_proposal"] as const;
export type StrategyOrigin = (typeof strategyOrigins)[number];
export const strategyOriginLabels: Record<StrategyOrigin, string> = {
  plan: "Added by NZI", srs_gap: "From a UK SRS gap", client_proposal: "Proposed by the client",
};

/** The order of work: what is live, then what is next, then what is waiting, then what is behind you. */
const statusRank: Record<StrategyStatus, number> = { in_progress: 0, agreed: 1, proposed: 2, on_hold: 3, complete: 4, declined: 5 };

export const strategyScopeLabel = (scope: StrategyScope) => scope === "governance" ? "Governance" : `Scope ${scope}`;

export type LibraryStrategy = {
  id: string;
  key: string;
  /** The levers this strategy is allocated to (M:N). */
  leverIds: string[];
  /** The SRS requirements a client copy inherits. Never empty in the seeded library. */
  defaultSrsRequirementIds: string[];
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
  /**
   * The SRS requirements this strategy advances. **At least one, always** — a strategy on a
   * plan exists to move something the client has to disclose, and the database enforces it
   * with a deferred constraint trigger rather than trusting the command.
   */
  srsRequirementIds: string[];
  /**
   * Whether it appears in the report plan section. Read when a report composition is frozen
   * at issue, never afterwards — toggling it later cannot rewrite a report already sent.
   */
  includeInReport: boolean;
  /** null for a bespoke action — one that is not in the catalogue. */
  strategyId: string | null;
  title: string;
  scope: StrategyScope;
  category: string;
  controlLevel: StrategyControlLevel;
  iconKey: string;
  status: StrategyStatus;
  /**
   * Who owns it, as a name to show: the owning contact's name when one is chosen, else what 0075's free-text owner
   * held, else "". Kept a string so every surface that prints an owner prints the same thing.
   */
  owner: string;
  /** The owning client contact (A1, R4) — null when none is chosen yet. */
  ownerContactId: string | null;
  /** Where it came from (R6, R7), and for an SRS-gap action, the requirement it bridges. */
  origin: StrategyOrigin;
  originSrsRequirementId: string | null;
  targetDate: string | null;
  progressPct: number;
  notes: string;
  active: boolean;
  version: number;
  /**
   * The consultant's expected annual reduction — an ESTIMATE, never a measurement, and
   * null until one is entered. A strategy with none contributes nothing to the projection
   * and says so, rather than contributing a zero that would read as "this saves nothing".
   */
  estimate: StrategyEstimate | null;
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
  // Reaching 100% completes it only where completing is a legal move — a proposal at 100% is still a proposal.
  if (progressPct >= 100) return strategyTransitionAllowed(current, "complete") ? "complete" : current;
  // Dragging a complete action back below 100 makes it in-progress, not planned: work that
  // was finished and then reopened was never "not started".
  return current === "complete" ? "in_progress" : current;
}

export type StrategyPlanSummary = {
  total: number;
  proposed: number;
  agreed: number;
  inProgress: number;
  complete: number;
  onHold: number;
  declined: number;
  /**
   * Mean progress across the live actions still on the ladder (declined ones excluded — they were never going to
   * progress), or null when there are none — never 0, which would read as "no progress" rather than "nothing yet".
   */
  progressPct: number | null;
};

const summaryKey: Record<StrategyStatus, Exclude<keyof StrategyPlanSummary, "total" | "progressPct">> = {
  proposed: "proposed", agreed: "agreed", in_progress: "inProgress", complete: "complete", on_hold: "onHold", declined: "declined",
};

export function strategyPlanSummary(actions: readonly ClientStrategy[]): StrategyPlanSummary {
  const live = actions.filter((action) => action.active);
  const summary: StrategyPlanSummary = { total: live.length, proposed: 0, agreed: 0, inProgress: 0, complete: 0, onHold: 0, declined: 0, progressPct: null };
  for (const action of live) summary[summaryKey[action.status]] += 1;
  const progressing = live.filter((action) => action.status !== "declined");
  if (progressing.length > 0) summary.progressPct = Math.round(progressing.reduce((total, action) => total + action.progressPct, 0) / progressing.length);
  return summary;
}

/**
 * The lever-coverage summary (R2): for every live lever, how much of the plan sits under it — so a consultant sees
 * where the plan is thin. `agreed` counts agreed-or-beyond (what the client has committed to); a lever with nothing
 * agreed is `thin` even if something is proposed under it. Declined actions count for nothing. A strategy under two
 * levers counts under both, as the grouping shows it.
 */
export type StrategyLeverCoverage = { lever: Lever; actions: number; agreed: number; complete: number; thin: boolean };

export function strategyLeverCoverage(strategies: readonly ClientStrategy[], levers: readonly Lever[]): StrategyLeverCoverage[] {
  const counted = strategies.filter((strategy) => strategy.active && strategy.status !== "declined");
  return [...levers]
    .filter((lever) => lever.active)
    .sort((a, b) => a.ordering - b.ordering || a.title.localeCompare(b.title))
    .map((lever) => {
      const under = counted.filter((strategy) => strategy.leverIds.includes(lever.id));
      const agreed = under.filter((strategy) => strategyReportableStatuses.includes(strategy.status)).length;
      return { lever, actions: under.length, agreed, complete: under.filter((strategy) => strategy.status === "complete").length, thin: agreed === 0 };
    });
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
  /** Bumped on every edit (A1) — an Admin's change is checked against the version they saw. Absent on older reads. */
  version?: number;
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
  const live = strategies.filter((strategy) => strategy.active);
  return [...levers]
    .filter((lever) => lever.active)
    .sort((a, b) => a.ordering - b.ordering || a.title.localeCompare(b.title))
    .map((lever) => ({
      lever,
      strategies: live
        .filter((strategy) => strategy.leverIds.includes(lever.id))
        // The order of work: in progress, agreed, proposed, on hold, complete, declined.
        .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.title.localeCompare(b.title)),
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
  const rank = statusRank;
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

/* ── Deadlines ───────────────────────────────────────────────────────────────────────── */

/**
 * What a strategy's `targetDate` means today.
 *
 * One derivation, read by the staff console, the client portal and (later) the reminder
 * worker, so the three cannot disagree about whether something is overdue. Derived at read
 * time from the date the client actually set — nothing is stored, and no date is invented.
 *
 * Two rules do the real work:
 *
 * - **No date raises nothing.** A strategy without a target is not late; it is undated. The
 *   honest signal is silence, not a warning against a date nobody set.
 * - **A complete strategy raises nothing.** On a finished strategy the date is when it
 *   happened, not a deadline — `targetText` already words it that way — so treating it as
 *   one would flag finished work as late.
 *
 * Days are whole calendar days at midnight UTC, mirroring `trainingPlaceExpiry`: whether
 * something is overdue must not depend on the time of day it is looked at, or on where the
 * person looking is sitting.
 */
export type StrategyDeadline =
  | { state: "none" }
  | { state: "scheduled"; targetDate: string; daysRemaining: number }
  | { state: "approaching"; targetDate: string; daysRemaining: number }
  | { state: "overdue"; targetDate: string; daysOverdue: number };

/** Close enough to act on, far enough ahead to be useful. Documented in DEPLOYMENT.md. */
export const strategyReminderWindowDays = 30;

export function strategyDeadline(
  strategy: Pick<ClientStrategy, "status" | "targetDate" | "active">,
  today: string,
  windowDays: number = strategyReminderWindowDays,
): StrategyDeadline {
  // A strategy taken off the plan is off the plan; it does not go on being late.
  if (!strategy.active) return { state: "none" };
  if (strategy.status === "complete") return { state: "none" };
  const targetDate = strategy.targetDate;
  if (targetDate === null || targetDate === "") return { state: "none" };
  const days = daysUntil(today, targetDate);
  // An unreadable date is not a deadline. Reporting it as "due today" — which a 0 default
  // would — invents a signal out of bad data.
  if (days === null) return { state: "none" };
  if (days < 0) return { state: "overdue", targetDate, daysOverdue: -days };
  return days <= windowDays
    ? { state: "approaching", targetDate, daysRemaining: days }
    : { state: "scheduled", targetDate, daysRemaining: days };
}

const daysUntil = (from: string, to: string): number | null => {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
};

/** Only these two are a signal; the rest is a plan going to plan. */
export const strategyDeadlineRaises = (deadline: StrategyDeadline): boolean =>
  deadline.state === "approaching" || deadline.state === "overdue";

/**
 * The plan's deadline signals, worst first, so a surface can show the ones that matter
 * without re-deriving the ordering. Overdue before approaching, then by date.
 */
export type StrategyDeadlineSignal = { strategy: ClientStrategy; deadline: StrategyDeadline };

export function strategyDeadlineSignals(
  plan: readonly ClientStrategy[],
  today: string,
  windowDays: number = strategyReminderWindowDays,
): StrategyDeadlineSignal[] {
  return plan
    .map((strategy) => ({ strategy, deadline: strategyDeadline(strategy, today, windowDays) }))
    .filter((entry) => strategyDeadlineRaises(entry.deadline))
    .sort((a, b) => {
      if (a.deadline.state !== b.deadline.state) return a.deadline.state === "overdue" ? -1 : 1;
      const aDate = "targetDate" in a.deadline ? a.deadline.targetDate : "";
      const bDate = "targetDate" in b.deadline ? b.deadline.targetDate : "";
      return aDate.localeCompare(bDate) || a.strategy.title.localeCompare(b.strategy.title);
    });
}

/** How a surface counts what it is about to show. */
export type StrategyDeadlineSummary = { overdue: number; approaching: number; total: number };

export const strategyDeadlineSummary = (signals: readonly StrategyDeadlineSignal[]): StrategyDeadlineSummary => ({
  overdue: signals.filter((entry) => entry.deadline.state === "overdue").length,
  approaching: signals.filter((entry) => entry.deadline.state === "approaching").length,
  total: signals.length,
});

/* ── The reverse of the SRS alignment ────────────────────────────────────────────────── */

/**
 * Which strategies on a client's plan advance each SRS requirement.
 *
 * Every strategy carries the requirements it advances (`srsRequirementIds`, stored in
 * `strategy_srs_requirements` and indexed by requirement for exactly this read). Readiness
 * needs to ask it the other way round: given a requirement — usually a gap — what is this
 * client actually doing about it?
 *
 * Derived from the plan already loaded rather than re-queried. Whoever shows readiness shows
 * the plan beside it, and a second query could disagree with the list next to it mid-render.
 *
 * Withdrawn strategies are excluded: a strategy the client no longer holds does not answer a
 * requirement, and showing it would overstate readiness — the failure this view exists to
 * avoid.
 */
export function strategiesBySrsRequirement(
  plan: readonly ClientStrategy[],
): Map<string, ClientStrategy[]> {
  const byRequirement = new Map<string, ClientStrategy[]>();
  for (const strategy of plan) {
    if (!strategy.active) continue;
    for (const requirementId of strategy.srsRequirementIds) {
      const existing = byRequirement.get(requirementId);
      if (existing) existing.push(strategy);
      else byRequirement.set(requirementId, [strategy]);
    }
  }
  // Furthest along first, then by title: a stable order, so the same plan does not reshuffle
  // between renders.
  for (const strategies of byRequirement.values()) {
    strategies.sort((a, b) => b.progressPct - a.progressPct || a.title.localeCompare(b.title));
  }
  return byRequirement;
}
