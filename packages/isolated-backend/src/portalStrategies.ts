import {
  strategyControlLevelLabels, strategyDeadline, strategyDeadlineSignals, strategyDeadlineSummary,
  strategyPlanByLever, strategyScopeLabel, strategyStatusLabels, strategiesWithoutLever,
  type ClientStrategy, type LibraryStrategy, type StrategyDeadline, type StrategyStatus,
} from "@nzi/contracts";
import { listClientStrategies, listLevers, listLibraryStrategies } from "./reductionStrategies";
import type { Queryable } from "./postgres";

/**
 * The client portal's view of their own reduction plan — READ-ONLY.
 *
 * The portal reads the plan; it never edits it. A strategy is agreed with the NZI
 * consultant and tracked on the client record, so a client-side edit here would fork the
 * one plan into two.
 *
 * **Not** subject to the portal's published-snapshot rule. That rule exists because a
 * *measurement* must not reach a client before it has been reviewed and assured — an
 * unassured tonnage is a claim the platform cannot stand behind. A plan is not a
 * measurement: it is what the client themselves undertook to do, and a deadline they are
 * approaching is only useful while it is still live. Freezing it to the last published
 * report would mean telling a client about a date that passed two quarters ago.
 *
 * **Only strategies marked for the report are shown.** `include_in_report` is the
 * consultant's control over what this client is presented with; a strategy held back may be
 * unagreed, commercially sensitive, or simply not ready to discuss. Surfacing it in the
 * portal would leak precisely what was withheld from the document. Failing closed here is
 * the conservative reading, and is trivially relaxed if it proves wrong.
 *
 * Tenancy: `clientId` comes from the verified portal session, never from the request. The
 * caller wraps this in `withTenantRead(pool, organisationId, …)`.
 */

export type PortalStrategyHighlight = {
  title: string;
  /** What theme it sits under, in the client's words. Never an internal id. */
  category: string;
  targetDate: string;
  deadline: StrategyDeadline;
};

/** An SRS requirement a strategy advances, in words a client can act on. */
export type PortalPlanRequirement = { code: string; title: string };

/**
 * One strategy as the client sees it.
 *
 * Deliberately **not** the whole `ClientStrategy`. Two of its fields are internal and do not
 * cross to the portal:
 *
 * - `owner` is a consultant handle today, not a name the client would recognise (Francis's
 *   call). It is omitted rather than rendered blank.
 * - `notes` is the consultant's working note on this client's copy — the same category of
 *   private as `owner`. The `description` below is the **catalogue** copy from the library
 *   strategy, written to be read, so a bespoke strategy simply has none.
 */
export type PortalPlanStrategy = {
  id: string;
  title: string;
  /** Library catalogue copy. Empty for a bespoke strategy — never filled from `notes`. */
  description: string;
  /** "Scope 2", "Governance" — the client's words, never the raw enum. */
  scopeLabel: string;
  category: string;
  controlLevelLabel: string;
  status: StrategyStatus;
  statusLabel: string;
  progressPct: number;
  /** null when none was set. The portal shows no date rather than inventing one. */
  targetDate: string | null;
  /** The same read-time derivation the signals above use, so the two cannot disagree. */
  deadline: StrategyDeadline;
  /** The readiness gaps this strategy closes — the client-facing half of the shared spine. */
  /**
   * The other lever themes this same action appears under, in this client's plan.
   *
   * Levers are many-to-many with strategies (DESIGN_CONVENTIONS §3.3), so one action can
   * legitimately sit under two themes — and then the plan shows nine rows for seven actions. Both
   * numbers are right and they count different things, which is exactly the situation a reader
   * cannot be expected to work out unaided. Naming the other themes on the row turns an apparent
   * duplicate into an action that does two jobs.
   *
   * Empty for the ordinary single-lever case.
   */
  alsoUnder: string[];
  srsRequirements: PortalPlanRequirement[];
};

/** A lever, or the "Other" bucket for strategies whose only lever was withdrawn. */
export type PortalPlanGroup = { key: string; label: string; strategies: PortalPlanStrategy[] };

export type PortalStrategiesReadModel = {
  /** Every strategy on the plan the client is shown — the denominator for the highlights. */
  total: number;
  overdue: number;
  approaching: number;
  /** Worst first. Empty when nothing is due or late, which is the common and good case. */
  highlights: PortalStrategyHighlight[];
  /**
   * The plan itself, grouped by lever — **live**, resolved from `client_strategies` at
   * request time rather than from a frozen `report_composition`.
   *
   * That exemption is deliberate and narrow. The published-snapshot rule exists so an
   * unassured *measurement* cannot reach a client. A plan is not a measurement: it is what
   * the client undertook to do, and a date is only useful while it is still the date. The
   * report's plan stays frozen; these are two reads of the same rows, for two purposes.
   *
   * Empty when the client has no plan yet — which the portal states rather than drawing an
   * empty list.
   */
  plan: PortalPlanGroup[];
};

export async function getPortalClientStrategies(
  db: Queryable,
  input: { clientId: string; today: string },
): Promise<PortalStrategiesReadModel> {
  const [strategies, levers, library, requirements] = await Promise.all([
    listClientStrategies(db, input.clientId),
    listLevers(db),
    listLibraryStrategies(db),
    // Requirement ids mean nothing to a reader. The report shows codes; the portal shows the
    // code and what it is about, because its reader is the client rather than an assessor.
    db.query<{ requirement_id: string; code: string; title: string }>(
      `SELECT requirement_id, code, title FROM nzi_console.srs_requirements`,
    ).then((result) => new Map(result.rows.map((row) => [row.requirement_id, { code: row.code, title: row.title }]))),
  ]);
  // The one client-facing gate, applied once, before anything is grouped or counted.
  const plan = strategies.filter((strategy) => strategy.active && strategy.includeInReport);
  const signals = strategyDeadlineSignals(plan, input.today);
  const summary = strategyDeadlineSummary(signals);
  return {
    total: plan.length,
    overdue: summary.overdue,
    approaching: summary.approaching,
    highlights: signals.map(({ strategy, deadline }) => ({
      title: strategy.title,
      category: strategy.category,
      // `owner` is deliberately absent, here and on the plan rows below. It holds an
      // internal consultant handle, so it is kept off the wire rather than merely unrendered
      // — an unused field in a JSON response is still a field the client can read.
      // A signal always has a date — that is what made it a signal — but the type is a
      // union, so the date is read from the branch rather than asserted off the strategy.
      targetDate: "targetDate" in deadline ? deadline.targetDate : "",
      deadline,
    })),
    plan: portalPlanGroups(plan, levers, library, requirements, input.today),
  };
}

/**
 * The plan grouped by lever, exactly as the workspace and the report group it.
 *
 * A strategy on two levers appears under both — that is what a many-to-many categorisation
 * means. One whose only lever was withdrawn lands in "Other" rather than vanishing: the
 * client agreed to it, and a plan that quietly shortens itself because the catalogue moved
 * on is not the plan they agreed.
 */
function portalPlanGroups(
  plan: readonly ClientStrategy[],
  levers: Awaited<ReturnType<typeof listLevers>>,
  library: readonly LibraryStrategy[],
  requirements: ReadonlyMap<string, PortalPlanRequirement>,
  today: string,
): PortalPlanGroup[] {
  const descriptions = new Map(library.map((entry) => [entry.id, entry.description]));

  // Which themes each action appears under, worked out once from the same grouping the rows are
  // built from — not from `leverIds`, so a lever that is withdrawn (and therefore groups under
  // "Other") is described to the client the way they actually see it.
  const byLever = strategyPlanByLever(plan, levers);
  const appearsUnder = new Map<string, string[]>();
  for (const group of byLever) {
    for (const strategy of group.strategies) {
      appearsUnder.set(strategy.id, [...(appearsUnder.get(strategy.id) ?? []), group.lever.title]);
    }
  }

  const forClient = (groupLabel: string) => (strategy: ClientStrategy): PortalPlanStrategy => ({
    id: strategy.id,
    title: strategy.title,
    // A bespoke strategy has no catalogue entry, so it has no description. Falling back to
    // `notes` here would put a consultant's private working note in front of the client.
    description: strategy.strategyId === null ? "" : descriptions.get(strategy.strategyId) ?? "",
    scopeLabel: strategyScopeLabel(strategy.scope),
    category: strategy.category,
    controlLevelLabel: strategyControlLevelLabels[strategy.controlLevel],
    status: strategy.status,
    statusLabel: strategyStatusLabels[strategy.status],
    progressPct: strategy.progressPct,
    targetDate: strategy.targetDate === null || strategy.targetDate === "" ? null : strategy.targetDate,
    deadline: strategyDeadline(strategy, today),
    alsoUnder: (appearsUnder.get(strategy.id) ?? []).filter((label) => label !== groupLabel),
    srsRequirements: strategy.srsRequirementIds
      .map((id) => requirements.get(id))
      .filter((entry): entry is PortalPlanRequirement => entry !== undefined)
      .sort((a, b) => a.code.localeCompare(b.code)),
  });

  const groups: PortalPlanGroup[] = byLever
    .map((group) => ({ key: group.lever.id, label: group.lever.title, strategies: group.strategies.map(forClient(group.lever.title)) }));
  const unallocated = strategiesWithoutLever(plan, levers);
  if (unallocated.length > 0) {
    groups.push({ key: "__other", label: "Other", strategies: unallocated.map(forClient("Other")) });
  }
  return groups;
}
