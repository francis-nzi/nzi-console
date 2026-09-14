import { strategyDeadlineSignals, strategyDeadlineSummary, type StrategyDeadline } from "@nzi/contracts";
import { listClientStrategies } from "./reductionStrategies";
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
  owner: string;
  targetDate: string;
  deadline: StrategyDeadline;
};

export type PortalStrategiesReadModel = {
  /** Every strategy on the plan the client is shown — the denominator for the highlights. */
  total: number;
  overdue: number;
  approaching: number;
  /** Worst first. Empty when nothing is due or late, which is the common and good case. */
  highlights: PortalStrategyHighlight[];
};

export async function getPortalClientStrategies(
  db: Queryable,
  input: { clientId: string; today: string },
): Promise<PortalStrategiesReadModel> {
  const plan = (await listClientStrategies(db, input.clientId))
    .filter((strategy) => strategy.active && strategy.includeInReport);
  const signals = strategyDeadlineSignals(plan, input.today);
  const summary = strategyDeadlineSummary(signals);
  return {
    total: plan.length,
    overdue: summary.overdue,
    approaching: summary.approaching,
    highlights: signals.map(({ strategy, deadline }) => ({
      title: strategy.title,
      category: strategy.category,
      owner: strategy.owner,
      // A signal always has a date — that is what made it a signal — but the type is a
      // union, so the date is read from the branch rather than asserted off the strategy.
      targetDate: "targetDate" in deadline ? deadline.targetDate : "",
      deadline,
    })),
  };
}
