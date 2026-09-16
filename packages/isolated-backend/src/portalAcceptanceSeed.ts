import { createHash } from "node:crypto";
import {
  commandGrantForRole, strategyControlLevels, strategyScopes, strategyStatuses,
  type CommandContext, type SrsFramework, type SrsRequirement,
} from "@nzi/contracts";
import {
  assignClientStrategy, listClientStrategies, listLibraryStrategies,
  removeClientStrategy, setClientStrategyEstimate, updateClientStrategy,
} from "./reductionStrategies";
import { completeSrsAssessment, setSrsAssessmentItem, startSrsAssessment } from "./srsReadiness";
import { getSrsAssessment, getSrsFramework, listSrsAssessments } from "./srsReadinessRecords";
import { withTenantRead } from "./postgres";
import type { PoolLike, Queryable } from "./postgres";

/**
 * The portal acceptance seed (NZC-080), as a function rather than a script.
 *
 * It lives in `src/` so CI can drive the whole sequence against a real Postgres. That is not
 * tidiness: the first two failures here were only reproducible by running it on staging, which
 * cost a round-trip each and put a half-applied fixture in a real client's plan. A fixture whose
 * only test environment is production-adjacent is a fixture nobody can fix cheaply.
 *
 * Everything is written through the commands the staff console calls, so rows carry their audit
 * event, outbox entry, version and provenance. See `scripts/seed-portal-acceptance.ts` for the
 * runnable wrapper and the fuller rationale.
 */

export type SeedOptions = {
  organisationId: string;
  actorId: string;
  clientId: string;
  /** Somewhere to narrate to. Silent by default, which is what tests want. */
  log?: (line: string) => void;
  /** Deactivate every seeded strategy instead of seeding. Never deletes. */
  withdrawAll?: boolean;
};

export type SeedSummary = {
  strategies: Array<{ caseId: string; clientStrategyId: string; action: "created" | "reused" | "already-withdrawn" }>;
  assessmentId: string | null;
  assessmentState: "completed" | "resumed-and-completed" | "already-complete" | "not-seeded";
  reserved: { addressed: string; withdrawn: string; outOfReport: string; noStrategy: string };
};

/* ── Cases ───────────────────────────────────────────────────────────────────────────── */

export type StrategyCase = {
  id: string;
  what: string;
  /** Which acceptance-record criterion this row exists to satisfy. */
  proves: string;
  targetDateOffset: number | null;
  status: string;
  progressPct: number;
  includeInReport: boolean;
  bespoke?: boolean;
  withdraw?: boolean;
  estimate?: boolean;
};

export const BESPOKE = {
  title: "Site-specific heat recovery (acceptance seed)",
  scope: "1",
  controlLevel: "direct_control",
};

export const STRATEGY_CASES: StrategyCase[] = [
  { id: "overdue", what: "target date 45 days ago", proves: "plan #13 — due state `overdue`",
    targetDateOffset: -45, status: "in_progress", progressPct: 40, includeInReport: true },
  { id: "approaching", what: "target date in 14 days", proves: "plan #14 — due state `approaching` (inside the 30-day window)",
    targetDateOffset: 14, status: "in_progress", progressPct: 25, includeInReport: true },
  { id: "scheduled", what: "target date in 120 days, carries a reduction estimate", proves: "plan #15 — `scheduled`; plan set-up #7 — estimate linkage",
    targetDateOffset: 120, status: "planned", progressPct: 0, includeInReport: true, estimate: true },
  { id: "undated", what: "bespoke, no target date, no library description", proves: "plan #16 — due state `none`; plan #5 — bespoke shows no description",
    targetDateOffset: null, status: "planned", progressPct: 10, includeInReport: true, bespoke: true },
  { id: "complete-past", what: "complete, target date 60 days ago", proves: "plan #17 — completed work shows `none`, not overdue",
    targetDateOffset: -60, status: "complete", progressPct: 100, includeInReport: true },
  { id: "hidden", what: "include_in_report = false", proves: "plan #3 — absent from the portal entirely",
    targetDateOffset: 20, status: "in_progress", progressPct: 50, includeInReport: false },
  { id: "gap-addressed", what: "live, in-report, aligned to the addressed gap", proves: "readiness #5 — the gap lists this strategy",
    targetDateOffset: 60, status: "in_progress", progressPct: 30, includeInReport: true },
  { id: "gap-withdrawn", what: "aligned to a gap, then withdrawn", proves: "readiness #6 — the gap must read unaddressed",
    targetDateOffset: 30, status: "planned", progressPct: 0, includeInReport: true, withdraw: true },
  { id: "gap-out-of-report", what: "aligned to a gap, include_in_report = false", proves: "readiness #7 — the gap must read unaddressed",
    targetDateOffset: 45, status: "in_progress", progressPct: 20, includeInReport: false },
];

/* ── Helpers ─────────────────────────────────────────────────────────────────────────── */

/** Stable across runs for the same payload; different the moment the payload changes. */
function idempotencyKey(caseId: string, payload: unknown): string {
  return `seed:portal-acceptance:${caseId}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16)}`;
}

export const dayOffset = (days: number, from = new Date()): string => {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * The command inputs type `status`, `scope` and `controlLevel` as plain `string`, so the compiler
 * cannot tell a valid value from a typo — only the runtime validator can, half way through a run
 * that has already written rows. It caught two on its first use.
 */
export function assertVocabulary(): void {
  const bad: string[] = [];
  for (const entry of STRATEGY_CASES) {
    if (!(strategyStatuses as readonly string[]).includes(entry.status)) {
      bad.push(`status "${entry.status}" (case ${entry.id}) — expected one of ${strategyStatuses.join(", ")}`);
    }
  }
  if (!(strategyScopes as readonly string[]).includes(BESPOKE.scope)) bad.push(`scope "${BESPOKE.scope}"`);
  if (!(strategyControlLevels as readonly string[]).includes(BESPOKE.controlLevel)) bad.push(`controlLevel "${BESPOKE.controlLevel}"`);
  if (bad.length) throw new Error(`The seed uses values the commands will reject:\n  ${bad.join("\n  ")}`);
}

/** Requirements a person answers; `nzi-data` ones are derived and must not be set by hand. */
const answerable = (framework: SrsFramework): SrsRequirement[] =>
  framework.requirements.filter((requirement) => requirement.active && requirement.source === "entered");

/**
 * Names the command and case in flight, so a failure says where it happened.
 *
 * `CommandValidationError`'s message is the constant "Command validation failed."; without this
 * and without its `issues`, a failed run says nothing a person can act on.
 */
export class SeedStepError extends Error {
  constructor(readonly step: string, readonly cause: unknown) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SeedStepError";
  }
  get issues(): Array<{ field: string; code: string; message: string }> | undefined {
    const issues = (this.cause as { issues?: Array<{ field: string; code: string; message: string }> }).issues;
    return Array.isArray(issues) ? issues : undefined;
  }
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw new SeedStepError(label, error); }
}

/* ── The seed ────────────────────────────────────────────────────────────────────────── */

export async function seedPortalAcceptance(pool: PoolLike, options: SeedOptions): Promise<SeedSummary> {
  assertVocabulary();
  const { organisationId, actorId, clientId } = options;
  const log = options.log ?? (() => undefined);

  const context = (caseId: string, payload: unknown, reason?: string): CommandContext => ({
    organisationId, actorId, principal: "staff",
    idempotencyKey: idempotencyKey(caseId, payload),
    correlationId: `seed-portal-acceptance-${caseId}`,
    grant: commandGrantForRole("admin", organisationId, actorId),
    ...(reason === undefined ? {} : { reason }),
  });

  const readStrategies = () => withTenantRead(pool, organisationId, (db: Queryable) => listClientStrategies(db, clientId));

  if (options.withdrawAll) {
    const live = (await readStrategies()).filter((entry) => entry.active && (entry.notes ?? "").includes("NZC-080 portal acceptance"));
    for (const strategy of live) {
      const input = { clientStrategyId: strategy.id, expectedVersion: strategy.version, reason: "Acceptance run complete — seeded strategy withdrawn." };
      await step(`client.strategy.remove (cleanup ${strategy.id})`, () => removeClientStrategy(pool, input, context(`cleanup:${strategy.id}`, input, input.reason)));
      log(`  - ${strategy.id}`);
    }
    return { strategies: [], assessmentId: null, assessmentState: "not-seeded", reserved: { addressed: "", withdrawn: "", outOfReport: "", noStrategy: "" } };
  }

  const { framework, library } = await withTenantRead(pool, organisationId, async (db: Queryable) => ({
    framework: await getSrsFramework(db),
    library: await listLibraryStrategies(db),
  }));
  if (!framework) throw new Error("No SRS framework is published; the readiness half cannot be seeded.");

  const requirements = answerable(framework);
  if (requirements.length < 8) throw new Error(`The framework has only ${requirements.length} answerable requirements; the seed needs at least 8.`);

  const reserved = {
    addressed: requirements[0]!, withdrawn: requirements[1]!,
    outOfReport: requirements[2]!, noStrategy: requirements[3]!,
  };
  const reservedIds = new Set(Object.values(reserved).map((requirement) => requirement.id));

  // Library strategies across levers, none touching the reserved requirements — otherwise the
  // "no strategy aligned" gap would quietly acquire one and criterion 8 would test nothing.
  const usable = library.filter((entry) =>
    entry.leverIds.length > 0 && entry.defaultSrsRequirementIds.length > 0 &&
    !entry.defaultSrsRequirementIds.some((id) => reservedIds.has(id)));
  const byLever = new Map<string, typeof usable>();
  for (const entry of usable) byLever.set(entry.leverIds[0]!, [...(byLever.get(entry.leverIds[0]!) ?? []), entry]);
  if (byLever.size < 2) throw new Error(`The library offers strategies on only ${byLever.size} lever(s); grouping needs at least 2.`);
  const spread = [...byLever.values()].flatMap((entries, index) => entries.map((entry) => ({ entry, index })))
    .sort((a, b) => a.index - b.index).map((item) => item.entry);

  // One distinct library strategy per non-bespoke case, fixed up front.
  //
  // The cursor this replaces wrapped with `% spread.length`, so a short library silently gave two
  // cases the same strategy — and then the second case's update overwrote the first's, leaving
  // one of the acceptance criteria testing nothing. Failing loudly is the right answer: a seed
  // that cannot produce its cases has not produced them.
  const nonBespoke = STRATEGY_CASES.filter((entry) => !entry.bespoke);
  if (spread.length < nonBespoke.length) {
    throw new Error(`The library offers ${spread.length} usable strategies; ${nonBespoke.length} cases need one each.`);
  }
  const libraryByCase = new Map(nonBespoke.map((entry, index) => [entry.id, spread[index]!]));

  const strategies: SeedSummary["strategies"] = [];

  for (const entry of STRATEGY_CASES) {
    const requirementIds =
      entry.id === "gap-addressed" ? [reserved.addressed.id] :
      entry.id === "gap-withdrawn" ? [reserved.withdrawn.id] :
      entry.id === "gap-out-of-report" ? [reserved.outOfReport.id] : null;

    const chosen = entry.bespoke ? null : libraryByCase.get(entry.id)!;

    // **Reconcile by reading, not by idempotency key.**
    //
    // A key only replays a command issued by *this* build: it is a hash of the payload, so a
    // seed whose payload has changed since — a different library strategy, a reworded note, an
    // earlier version of this file — produces a different key, the replay misses, and the assign
    // is issued for real. `client.strategy.assign` then refuses it (`ALREADY_ASSIGNED`), because
    // the business rule is about the plan, not about who asked.
    //
    // Keys therefore prove convergence within one version of the seed, and nothing about
    // convergence over state a previous version left behind. Reading the plan first does: the
    // question "is this action already on this client's plan?" has one answer regardless of which
    // build asked it.
    //
    // Matched **regardless of `active`**. The guard only blocks an active duplicate, so an
    // assign after a withdrawal would succeed and leave two rows for one strategy — a second copy
    // of the same action, which is worse than the error it avoided. That is also why
    // `--withdraw-all` does not clear this: it makes the assign possible again rather than making
    // it unnecessary.
    const plan = await readStrategies();
    const found = entry.bespoke
      ? plan.find((row) => row.strategyId === null && row.title === BESPOKE.title)
      : plan.find((row) => row.strategyId === chosen!.id);

    let clientStrategyId: string;
    if (found) {
      clientStrategyId = found.id;
      log(`  = ${entry.id.padEnd(18)} already on the plan — reusing it`);
    } else {
      const assignInput = entry.bespoke
        ? { clientId, bespoke: BESPOKE, srsRequirementIds: requirementIds ?? [requirements[4]!.id], owner: actorId, notes: "Seeded for the NZC-080 portal acceptance run." }
        : { clientId, strategyId: chosen!.id, srsRequirementIds: requirementIds ?? chosen!.defaultSrsRequirementIds, owner: actorId, notes: "Seeded for the NZC-080 portal acceptance run." };
      const assigned = await step(`client.strategy.assign (${entry.id})`, () => assignClientStrategy(pool, assignInput, context(`assign:${entry.id}`, assignInput)));
      clientStrategyId = assigned.data.clientStrategyId;
      log(`  + ${entry.id.padEnd(18)} ${entry.what}`);
    }

    const current = found ?? (await readStrategies()).find((row) => row.id === clientStrategyId);
    if (!current) throw new Error(`Strategy ${clientStrategyId} (${entry.id}) vanished after assignment.`);

    // An inactive strategy is skipped **whatever the case wants**: `client.strategy.update`
    // refuses a withdrawn row outright (issue code `REMOVED`), so there is no update to make and
    // attempting one is an error, not a no-op. Exempting the `withdraw` cases — on the reasoning
    // that they are *meant* to end inactive — was backwards, and made every run after the first
    // successful one fail here.
    if (!current.active) {
      log(entry.withdraw ? `    = ${entry.id} already withdrawn — nothing to do`
        : `    ! ${entry.id} is withdrawn on the client's plan; leaving it alone rather than reinstating it.`);
      strategies.push({ caseId: entry.id, clientStrategyId, action: "already-withdrawn" });
      continue;
    }
    strategies.push({ caseId: entry.id, clientStrategyId, action: found ? "reused" : "created" });

    const updateInput = {
      clientStrategyId, expectedVersion: current.version, status: entry.status, owner: actorId,
      targetDate: entry.targetDateOffset === null ? null : dayOffset(entry.targetDateOffset),
      progressPct: entry.progressPct, notes: "Seeded for the NZC-080 portal acceptance run.",
      srsRequirementIds: current.srsRequirementIds, includeInReport: entry.includeInReport,
    };
    const updated = await step(`client.strategy.update (${entry.id})`, () => updateClientStrategy(pool, updateInput, context(`update:${entry.id}`, updateInput)));
    let version = updated.data.version;

    if (entry.estimate) {
      const estimateInput = {
        clientStrategyId, expectedVersion: version,
        estimate: {
          amount: 42.5, unit: "tco2e_per_year" as const, scope: "1" as const,
          assumptions: "Seeded estimate for the NZC-080 acceptance run — not a real figure.",
          source: "consultant" as const,
        },
      };
      const priced = await step(`client.strategy.estimate.set (${entry.id})`, () => setClientStrategyEstimate(pool, estimateInput, context(`estimate:${entry.id}`, estimateInput)));
      version = priced.data.version;
    }

    if (entry.withdraw) {
      const removeInput = { clientStrategyId, expectedVersion: version, reason: "Withdrawn for the NZC-080 acceptance run — the gap it addressed must read as unaddressed." };
      await step(`client.strategy.remove (${entry.id})`, () => removeClientStrategy(pool, removeInput, context(`remove:${entry.id}`, removeInput, removeInput.reason)));
      log(`    withdrawn (deactivated, not deleted)`);
    }
  }

  const assessment = await seedAssessment(pool, { organisationId, clientId, log, context, requirements, reserved });
  return {
    strategies, assessmentId: assessment.assessmentId, assessmentState: assessment.state,
    reserved: { addressed: reserved.addressed.code, withdrawn: reserved.withdrawn.code, outOfReport: reserved.outOfReport.code, noStrategy: reserved.noStrategy.code },
  };
}

async function seedAssessment(
  pool: PoolLike,
  args: {
    organisationId: string; clientId: string; log: (line: string) => void;
    context: (caseId: string, payload: unknown, reason?: string) => CommandContext;
    requirements: SrsRequirement[];
    reserved: { addressed: SrsRequirement; withdrawn: SrsRequirement; outOfReport: SrsRequirement; noStrategy: SrsRequirement };
  },
): Promise<{ assessmentId: string; state: SeedSummary["assessmentState"] }> {
  const { organisationId, clientId, log, context, requirements, reserved } = args;
  const existing = await withTenantRead(pool, organisationId, (db: Queryable) => listSrsAssessments(db, clientId));

  const complete = existing.find((assessment) => assessment.status === "complete");
  if (complete) {
    log(`\n  = SRS assessment ${complete.assessmentId} already complete — left as it is.`);
    return { assessmentId: complete.assessmentId, state: "already-complete" };
  }

  // Resume a draft rather than starting beside it: `srs.assessment.start` refuses outright while
  // one is open, which is exactly the state a failed run leaves behind.
  const draft = existing.find((assessment) => assessment.status === "draft");
  let assessmentId: string;
  let resumed = false;
  if (draft) {
    assessmentId = draft.assessmentId;
    resumed = true;
    log(`\n  = SRS assessment ${assessmentId} already started — resuming it`);
  } else {
    const startInput = { clientId, assessedOn: dayOffset(0), notes: "Seeded for the NZC-080 portal acceptance run." };
    const started = await step("srs.assessment.start", () => startSrsAssessment(pool, startInput, context("srs:start", startInput)));
    assessmentId = started.data.assessmentId;
    log(`\n  + SRS assessment ${assessmentId} started`);
  }

  const answers = [
    { requirement: reserved.addressed, maturity: 0, note: "deep gap, addressed by a live strategy" },
    { requirement: reserved.withdrawn, maturity: 1, note: "gap whose only strategy is withdrawn" },
    { requirement: reserved.outOfReport, maturity: 1, note: "gap whose only strategy is out of report" },
    { requirement: reserved.noStrategy, maturity: 2, note: "gap with no strategy at all" },
    ...requirements.slice(4, 10).map((requirement) => ({ requirement, maturity: Math.max(requirement.targetMaturity, 1), note: "met" })),
  ];

  // `srs.assessment.item.set` versions the ITEM, not the assessment: a fresh header is v1, while
  // an unanswered requirement has no row and expects v0. Read per requirement, then thread each
  // command's returned version rather than assuming an increment.
  const itemVersions = new Map<string, number>();
  const before = await withTenantRead(pool, organisationId, (db: Queryable) => getSrsAssessment(db, assessmentId));
  if (!before) throw new Error(`Assessment ${assessmentId} disappeared mid-seed.`);
  for (const item of before.items) itemVersions.set(item.requirementId, item.version);

  for (const answer of answers) {
    const itemInput = {
      assessmentId, requirementId: answer.requirement.id, maturity: Math.min(answer.maturity, 4),
      evidenceKind: "note" as const,
      evidenceNote: `Seeded for the NZC-080 acceptance run — ${answer.note}.`,
      expectedVersion: itemVersions.get(answer.requirement.id) ?? 0,
    };
    const saved = await step(`srs.assessment.item.set (${answer.requirement.code})`, () => setSrsAssessmentItem(pool, itemInput, context(`srs:item:${answer.requirement.id}`, itemInput)));
    itemVersions.set(answer.requirement.id, saved.data.version);
  }

  const finalState = await withTenantRead(pool, organisationId, (db: Queryable) => getSrsAssessment(db, assessmentId));
  if (!finalState) throw new Error(`Assessment ${assessmentId} disappeared before completion.`);
  const completeInput = { assessmentId, expectedVersion: finalState.version };
  await step("srs.assessment.complete", () => completeSrsAssessment(pool, completeInput, context("srs:complete", completeInput)));
  log(`  + SRS assessment completed — not a draft, so the portal will show it`);
  return { assessmentId, state: resumed ? "resumed-and-completed" : "completed" };
}
