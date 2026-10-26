import {
  strategyControlLevelLabels, strategyDeadline, strategyDeadlineSignals, strategyDeadlineSummary,
  strategyClientNextStatuses, strategyOnPlan, strategyPlanByLever, strategyScopeLabel, strategyStatusLabels, strategiesWithoutLever,
  type ClientStrategy, type LibraryStrategy, type StrategyDeadline, type StrategyProposalState, type StrategyStatus,
} from "@nzi/contracts";
import { portalUserContactIds } from "./portalStrategyCommands";
import { listClientStrategies, listLevers, listLibraryStrategies } from "./reductionStrategies";
import type { Queryable } from "./postgres";

/**
 * The client portal's view of their own reduction plan.
 *
 * Read-only until Actions A2: since A2 (behind its own flag, `participation` below) the client also adds from the library,
 * proposes a custom action, nominates owners and — as an action's owner — moves its date, progress and status. Those
 * writes are commands (`portalStrategyCommands.ts`); this read says what the client may do, per action, so the page
 * never offers a move the command would refuse. Staff keep the gate: agreeing, declining, deciding proposals,
 * alignment and what is shown.
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
 * **Declined actions are not shown** (A1 review note, A2 R7): a declined action lingering on the client's plan would read
 * as a mistake. A client's **proposals** are not on the plan until approved; they are listed apart, as "with your adviser"
 * or "not taken forward", with the reason.
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
 * Deliberately **not** the whole `ClientStrategy`. `notes` is the consultant's working note on this client's copy and
 * never crosses; the `description` below is the **catalogue** copy from the library strategy, written to be read, so a
 * bespoke strategy simply has none.
 *
 * The owner is shown only when it is one of the client's own contacts (A1, R4) — their team, by name. 0075's free-text
 * owner, which held a consultant handle, still never crosses.
 */
export type PortalPlanStrategy = {
  id: string;
  /** For the client's own edits (A2): the version an update is made against. */
  version: number;
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
  srsRequirements: PortalPlanRequirement[];
  /** The owning client contact's name, or "" when none is chosen yet. Never a consultant. */
  owner: string;
  ownerContactId: string | null;
  /** Whether the person reading owns it — the owner moves its date, progress and status (A2, R4). */
  yours: boolean;
  /** The statuses the owner may choose from here (the owner's half of the ladder); empty when it is not theirs. */
  nextStatuses: StrategyStatus[];
};

/** A lever, or the "Other" bucket for strategies whose only lever was withdrawn. */
export type PortalPlanGroup = { key: string; label: string; strategies: PortalPlanStrategy[] };

/** A library action the client can add to their plan (A2, R1). */
export type PortalLibraryOption = { id: string; title: string; description: string; scopeLabel: string; category: string };
/** One of the client's own contacts — who an action's owner can be (A2, R5). */
export type PortalContactOption = { id: string; name: string };
/** A custom action the client proposed (A2, R2): with their adviser, or not taken forward — with the reason. */
export type PortalProposal = {
  id: string; title: string; scopeLabel: string; note: string;
  state: Exclude<StrategyProposalState, "approved">;
  reason: string | null; proposedOn: string; decidedOn: string | null;
};

/** What the client may do with their plan (A2). Present only when participation is switched on for the portal. */
export type PortalPlanParticipation = {
  library: PortalLibraryOption[];
  contacts: PortalContactOption[];
  proposals: PortalProposal[];
  scopes: Array<{ value: string; label: string }>;
};

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
  /** A2: what the client may do — null when the portal shows the plan read-only (the flag off, or the staff preview). */
  participation: PortalPlanParticipation | null;
};

/** The scopes as a client chooses between them when proposing: the plain words, not the enum. */
const proposalScopes = [
  { value: "1", label: "Fuel we burn ourselves (Scope 1)" },
  { value: "2", label: "Electricity and heat we buy (Scope 2)" },
  { value: "3", label: "Our supply chain, travel and products (Scope 3)" },
  { value: "governance", label: "How we manage and report (governance)" },
];

export async function getPortalClientStrategies(
  db: Queryable,
  input: {
    clientId: string; today: string;
    /** A2: the portal user reading, for "the actions you own" — null for the staff preview, which owns nothing. */
    viewer?: { organisationId: string; portalUserId: string } | null;
    /** A2: include what the client may do (the `portal-plan-participation` flag). Off, the read is exactly as before. */
    participation?: boolean;
  },
): Promise<PortalStrategiesReadModel> {
  const [strategies, levers, library, requirements, viewerContacts] = await Promise.all([
    listClientStrategies(db, input.clientId),
    listLevers(db),
    listLibraryStrategies(db),
    // Requirement ids mean nothing to a reader. The report shows codes; the portal shows the
    // code and what it is about, because its reader is the client rather than an assessor.
    db.query<{ requirement_id: string; code: string; title: string }>(
      `SELECT requirement_id, code, title FROM nzi_console.srs_requirements`,
    ).then((result) => new Map(result.rows.map((row) => [row.requirement_id, { code: row.code, title: row.title }]))),
    input.viewer ? portalUserContactIds(db, input.viewer.organisationId, input.viewer.portalUserId) : Promise.resolve([] as string[]),
  ]);
  // The one client-facing gate, applied once, before anything is grouped or counted: on the plan (a client's proposal
  // only once approved), marked for the client, and not declined.
  const plan = strategies.filter((strategy) => strategyOnPlan(strategy) && strategy.includeInReport && strategy.status !== "declined");
  const signals = strategyDeadlineSignals(plan, input.today);
  const summary = strategyDeadlineSummary(signals);
  const mine = new Set(viewerContacts);
  const participate = input.participation === true;
  return {
    total: plan.length,
    overdue: summary.overdue,
    approaching: summary.approaching,
    highlights: signals.map(({ strategy, deadline }) => ({
      title: strategy.title,
      category: strategy.category,
      // A signal always has a date — that is what made it a signal — but the type is a
      // union, so the date is read from the branch rather than asserted off the strategy.
      targetDate: "targetDate" in deadline ? deadline.targetDate : "",
      deadline,
    })),
    plan: portalPlanGroups(plan, levers, library, requirements, input.today, participate ? mine : new Set()),
    participation: participate ? await participationFor(db, input.clientId, strategies, library) : null,
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
  viewerContacts: ReadonlySet<string>,
): PortalPlanGroup[] {
  const descriptions = new Map(library.map((entry) => [entry.id, entry.description]));
  const forClient = (strategy: ClientStrategy): PortalPlanStrategy => {
    const yours = strategy.ownerContactId !== null && viewerContacts.has(strategy.ownerContactId);
    return {
      id: strategy.id,
      version: strategy.version,
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
      srsRequirements: strategy.srsRequirementIds
        .map((id) => requirements.get(id))
        .filter((entry): entry is PortalPlanRequirement => entry !== undefined)
        .sort((a, b) => a.code.localeCompare(b.code)),
      // A client contact by name; 0075's free text (a consultant handle) never crosses.
      owner: strategy.ownerContactId !== null ? strategy.owner : "",
      ownerContactId: strategy.ownerContactId,
      yours,
      nextStatuses: yours ? strategyClientNextStatuses(strategy.status) : [],
    };
  };

  const groups: PortalPlanGroup[] = strategyPlanByLever(plan, levers)
    .map((group) => ({ key: group.lever.id, label: group.lever.title, strategies: group.strategies.map(forClient) }));
  const unallocated = strategiesWithoutLever(plan, levers);
  if (unallocated.length > 0) {
    groups.push({ key: "__other", label: "Other", strategies: unallocated.map(forClient) });
  }
  return groups;
}

/** What the client may add (the active library, less what they hold, and only what has a default alignment), who may own, and their proposals. */
async function participationFor(db: Queryable, clientId: string, strategies: readonly ClientStrategy[], library: readonly LibraryStrategy[]): Promise<PortalPlanParticipation> {
  const held = new Set(strategies.filter((strategy) => strategy.active && strategy.strategyId !== null).map((strategy) => strategy.strategyId!));
  const contacts = await db.query<{ contact_id: string; full_name: string | null }>(
    `SELECT contact_id, full_name FROM nzi_console.client_contacts WHERE client_id = $1 AND status = 'active' ORDER BY lower(full_name), contact_id`, [clientId]);
  return {
    library: library
      .filter((entry) => entry.active && !held.has(entry.id) && entry.defaultSrsRequirementIds.length > 0)
      .map((entry) => ({ id: entry.id, title: entry.title, description: entry.description, scopeLabel: strategyScopeLabel(entry.scope), category: entry.category }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    // An erased contact has no name to offer; such a contact is not someone to nominate.
    contacts: contacts.rows.filter((row) => (row.full_name ?? "").trim() !== "").map((row) => ({ id: row.contact_id, name: row.full_name! })),
    proposals: strategies
      .filter((strategy) => strategy.active && strategy.proposal !== null && strategy.proposal.state !== "approved")
      .reverse()
      .map((strategy) => ({
        id: strategy.id, title: strategy.title, scopeLabel: strategyScopeLabel(strategy.scope), note: strategy.proposal!.note,
        state: strategy.proposal!.state as "pending" | "declined", reason: strategy.proposal!.decisionReason,
        proposedOn: strategy.proposal!.proposedOn, decidedOn: strategy.proposal!.decidedOn,
      })),
    scopes: proposalScopes,
  };
}
