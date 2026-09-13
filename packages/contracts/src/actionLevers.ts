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

export const actionScopes = ["1", "2", "3", "governance"] as const;
export type ActionScope = (typeof actionScopes)[number];

/**
 * How much of the outcome the client actually controls — the axis the plan is read by,
 * because it is the one they can act on.
 *
 * NOTE: this is NOT the SBTi "Spheres of Influence" framework in `portalActions.ts`, which
 * is about beyond-value-chain mitigation and uses A/B/C/D. Same words, different idea; see
 * the note on `actionSphereLabels`.
 */
export const actionSpheres = ["direct_control", "supply_chain", "influence"] as const;
export type ActionSphere = (typeof actionSpheres)[number];

export const actionSphereLabels: Record<ActionSphere, string> = {
  direct_control: "Direct control · own operations",
  supply_chain: "Supply chain · procurement",
  influence: "Influence · customers & industry",
};

/** What each grouping typically covers, said once so the three cards stay honest. */
export const actionSphereScopeHint: Record<ActionSphere, string> = {
  direct_control: "Scope 1 & 2",
  supply_chain: "Scope 3 upstream",
  influence: "Scope 3 downstream",
};

export const actionStatuses = ["planned", "in_progress", "complete"] as const;
export type ActionStatus = (typeof actionStatuses)[number];

export const actionStatusLabels: Record<ActionStatus, string> = {
  planned: "Planned", in_progress: "In progress", complete: "Complete",
};

export const actionScopeLabel = (scope: ActionScope) => scope === "governance" ? "Governance" : `Scope ${scope}`;

export type ActionLever = {
  id: string;
  key: string;
  title: string;
  description: string;
  scope: ActionScope;
  category: string;
  sphere: ActionSphere;
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

export type ClientAction = {
  id: string;
  clientId: string;
  /** null for a bespoke action — one that is not in the catalogue. */
  leverId: string | null;
  title: string;
  scope: ActionScope;
  category: string;
  sphere: ActionSphere;
  iconKey: string;
  status: ActionStatus;
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
export function actionProgressForStatus(status: ActionStatus, progressPct: number): number {
  if (status === "complete") return 100;
  // Leaving 100% on a non-complete action would fail the constraint; step it back rather
  // than silently rewriting the status the person actually chose.
  return Math.min(99, Math.max(0, Math.round(progressPct)));
}

export function actionStatusForProgress(progressPct: number, current: ActionStatus): ActionStatus {
  if (progressPct >= 100) return "complete";
  // Dragging a complete action back below 100 makes it in-progress, not planned: work that
  // was finished and then reopened was never "not started".
  return current === "complete" ? "in_progress" : current;
}

export type ActionPlanSummary = {
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

export function actionPlanSummary(actions: readonly ClientAction[]): ActionPlanSummary {
  const live = actions.filter((action) => action.active);
  const summary: ActionPlanSummary = { total: live.length, planned: 0, inProgress: 0, complete: 0, progressPct: null };
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

export type ActionSphereGroup = {
  sphere: ActionSphere;
  label: string;
  scopeHint: string;
  actions: ClientAction[];
};

/**
 * The plan as the workspace draws it: three groups, always in the same order, and only the
 * ones with something in them.
 *
 * Within a group, the order is the order of work rather than of the alphabet — in progress
 * first (what is live), then planned (what is next), then complete (what is behind you).
 */
export function actionPlanGroups(actions: readonly ClientAction[]): ActionSphereGroup[] {
  const rank: Record<ActionStatus, number> = { in_progress: 0, planned: 1, complete: 2 };
  return actionSpheres
    .map((sphere) => ({
      sphere,
      label: actionSphereLabels[sphere],
      scopeHint: actionSphereScopeHint[sphere],
      actions: actions
        .filter((action) => action.active && action.sphere === sphere)
        .sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title)),
    }))
    .filter((group) => group.actions.length > 0);
}

/**
 * The catalogue as the "Add from library" drawer shows it, with what the client already
 * holds marked as added rather than offered twice.
 */
export type ActionLibraryEntry = { lever: ActionLever; assigned: boolean };

export function actionLibrary(levers: readonly ActionLever[], actions: readonly ClientAction[]): ActionLibraryEntry[] {
  const assigned = new Set(actions.filter((action) => action.active && action.leverId !== null).map((action) => action.leverId!));
  return levers
    // A withdrawn lever stays visible while a client still holds it — their plan should not
    // develop a gap because the catalogue moved on — but is not offered to anyone new.
    .filter((lever) => lever.active || assigned.has(lever.id))
    .map((lever) => ({ lever, assigned: assigned.has(lever.id) }))
    .sort((a, b) =>
      actionSpheres.indexOf(a.lever.sphere) - actionSpheres.indexOf(b.lever.sphere)
      || a.lever.title.localeCompare(b.lever.title));
}
