/**
 * Seed the staging test client for the portal acceptance run (NZC-080).
 *
 * Produces every case `docs/STAGING_ACCEPTANCE_PORTAL_PLAN.md` and
 * `docs/STAGING_ACCEPTANCE_PORTAL_READINESS.md` ask for, so the run is a spot-check against known
 * expected values rather than an exploration of whatever happens to be in the database.
 *
 *   npm run seed:portal-acceptance
 *
 * ## Through the command layer, not around it
 *
 * Every row is written by the same commands the staff console calls — `client.strategy.assign`,
 * `client.strategy.update`, `client.strategy.estimate.set`, `client.strategy.remove`,
 * `srs.assessment.start` / `.item.set` / `.complete`. Nothing here writes a domain row with SQL.
 *
 * That is not ceremony. A seed of raw INSERTs would produce rows that *look* right and carry no
 * audit event, no outbox entry, no version and no provenance — and the acceptance run would then
 * be checking the portal against data the real write path has never produced. The commands also
 * enforce their own invariants (every strategy needs at least one SRS requirement, backed by a
 * deferred constraint trigger), so a seed that goes through them cannot create a shape the console
 * could not. If a command refuses this data, the seed is wrong and should fail here.
 *
 * The one exception is the seed actor's **membership** row, upserted with SQL below. That is
 * identity plumbing — there is no command for "make this user exist" — and it is called out rather
 * than hidden.
 *
 * ## Idempotent, via the layer's own machinery
 *
 * Commands are idempotent on `(organisation_id, idempotency_key)` and a **replay returns the
 * original outcome**, including the id it created. So each creation uses a key derived from a hash
 * of its own payload: the first run creates, every later run replays and hands back the same
 * `clientStrategyId`. The idempotency table is the seed's state — there is no marker column, no
 * second source of truth, and nothing to reconcile.
 *
 * Updates are keyed by their payload too, which gives a useful property: **re-running refreshes
 * the due-date windows**. The dates are relative to the run (overdue, within 30 days, beyond 30
 * days), so a run three weeks later moves them back into their intended buckets rather than
 * letting "due soon" quietly become "overdue" and invalidate the criteria.
 *
 * The SRS assessment is reconciled by reading instead, because `assessedOn` is a date and a
 * payload-derived key would start a second assessment tomorrow. One completed assessment is the
 * point, so the seed looks for one first.
 *
 * ## Fail-closed
 *
 * `validateDatabaseBoundary` is the same guard the app uses: production `APP_ENV` is refused, and
 * `NZI_DATABASE_BOUNDARY` must say `isolated-non-production`. There is no flag to override it.
 *
 * ## Cleanup
 *
 * Deactivate-not-delete. `--withdraw-all` takes every strategy this seed created off the plan
 * through `client.strategy.remove`, which deactivates and audits exactly as the console does.
 * Nothing is ever deleted, so the audit trail of the acceptance run survives it.
 */
import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  commandGrantForRole, strategyControlLevels, strategyScopes, strategyStatuses,
  type CommandContext, type SrsFramework, type SrsRequirement,
} from "@nzi/contracts";
import {
  assignClientStrategy, completeSrsAssessment, getSrsAssessment, getSrsFramework, listClientStrategies,
  listLibraryStrategies, listSrsAssessments, removeClientStrategy, setClientStrategyEstimate,
  setSrsAssessmentItem, startSrsAssessment, updateClientStrategy, validateDatabaseBoundary,
  withTenantRead,
} from "../src/index";

const ORG = process.env.NZI_DEMO_ORGANISATION_ID ?? "demo-nzi-console";
const ACTOR = process.env.SEED_ACTOR_ID ?? "acceptance-admin";
const CLIENT_HINT = process.env.SEED_CLIENT_NAME ?? "Bushy Tails";
const WITHDRAW_ALL = process.argv.includes("--withdraw-all");

/** Stable across runs for the same payload; different the moment the payload changes. */
function idempotencyKey(caseId: string, payload: unknown): string {
  const stable = JSON.stringify(payload, Object.keys(payload as object).sort());
  return `seed:portal-acceptance:${caseId}:${createHash("sha256").update(stable).digest("hex").slice(0, 16)}`;
}

function context(caseId: string, payload: unknown, reason?: string): CommandContext {
  return {
    organisationId: ORG, actorId: ACTOR, principal: "staff",
    idempotencyKey: idempotencyKey(caseId, payload),
    correlationId: `seed-portal-acceptance-${caseId}`,
    grant: commandGrantForRole("admin", ORG, ACTOR),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Dates relative to the run, so the due-state buckets stay in their buckets on a re-run. */
const dayOffset = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const log = (line: string) => process.stdout.write(`${line}\n`);

/**
 * The command inputs type `status`, `scope` and `controlLevel` as plain `string`, so the compiler
 * cannot tell a valid value from a typo — only the runtime validator can, half way through a run
 * that has already written rows. Checking the literals against the exported vocabularies up front
 * turns that into an immediate, obvious failure, and makes a future rename break here rather than
 * on staging.
 */
function assertVocabulary(): void {
  const bad: string[] = [];
  for (const strategyCase of STRATEGY_CASES) {
    if (!(strategyStatuses as readonly string[]).includes(strategyCase.status)) {
      bad.push(`status "${strategyCase.status}" (case ${strategyCase.id}) — expected one of ${strategyStatuses.join(", ")}`);
    }
  }
  if (!(strategyScopes as readonly string[]).includes(BESPOKE.scope)) {
    bad.push(`scope "${BESPOKE.scope}" — expected one of ${strategyScopes.join(", ")}`);
  }
  if (!(strategyControlLevels as readonly string[]).includes(BESPOKE.controlLevel)) {
    bad.push(`controlLevel "${BESPOKE.controlLevel}" — expected one of ${strategyControlLevels.join(", ")}`);
  }
  if (bad.length) throw new Error(`The seed uses values the commands will reject:\n  ${bad.join("\n  ")}`);
}

/** The one bespoke strategy — named here so the vocabulary check can reach it. */
const BESPOKE = {
  title: "Site-specific heat recovery (acceptance seed)",
  scope: "1",
  controlLevel: "direct_control",
};

/* ── The cases ───────────────────────────────────────────────────────────────────────── */

type StrategyCase = {
  id: string;
  what: string;
  /** Which template criterion this row exists to satisfy — printed in the summary. */
  proves: string;
  targetDate: string | null;
  status: string;
  progressPct: number;
  includeInReport: boolean;
  bespoke?: boolean;
  withdraw?: boolean;
  estimate?: boolean;
};

const STRATEGY_CASES: StrategyCase[] = [
  { id: "overdue", what: "target date 45 days ago", proves: "plan #13 — due state `overdue`",
    targetDate: dayOffset(-45), status: "in_progress", progressPct: 40, includeInReport: true },
  { id: "approaching", what: "target date in 14 days", proves: "plan #14 — due state `approaching` (inside the 30-day window)",
    targetDate: dayOffset(14), status: "in_progress", progressPct: 25, includeInReport: true },
  { id: "scheduled", what: "target date in 120 days, carries a reduction estimate", proves: "plan #15 — due state `scheduled`; plan #7 set-up — estimate linkage",
    targetDate: dayOffset(120), status: "planned", progressPct: 0, includeInReport: true, estimate: true },
  { id: "undated", what: "bespoke, no target date, no library description", proves: "plan #16 — due state `none`; plan #5 — bespoke shows no description",
    targetDate: null, status: "planned", progressPct: 10, includeInReport: true, bespoke: true },
  { id: "complete-past", what: "complete, target date 60 days ago", proves: "plan #17 — completed work must show `none`, not overdue",
    targetDate: dayOffset(-60), status: "complete", progressPct: 100, includeInReport: true },
  { id: "hidden", what: "include_in_report = false", proves: "plan #3 — must be absent from the portal entirely",
    targetDate: dayOffset(20), status: "in_progress", progressPct: 50, includeInReport: false },
  { id: "gap-addressed", what: "live, in-report, aligned to the addressed gap", proves: "readiness #5 — the gap lists this strategy",
    targetDate: dayOffset(60), status: "in_progress", progressPct: 30, includeInReport: true },
  { id: "gap-withdrawn", what: "aligned to a gap, then withdrawn", proves: "readiness #6 — silently-covered case: the gap must read unaddressed",
    targetDate: dayOffset(30), status: "planned", progressPct: 0, includeInReport: true, withdraw: true },
  { id: "gap-out-of-report", what: "aligned to a gap, include_in_report = false", proves: "readiness #7 — silently-covered case: the gap must read unaddressed",
    targetDate: dayOffset(45), status: "in_progress", progressPct: 20, includeInReport: false },
];

/* ── Requirement picking ─────────────────────────────────────────────────────────────── */

/**
 * Requirements a person actually answers. `nzi-data` ones are resolved from the client's own
 * assured record rather than asked, so setting them by hand would seed a figure the app is
 * supposed to derive.
 */
const answerable = (framework: SrsFramework): SrsRequirement[] =>
  framework.requirements.filter((requirement) => requirement.active && requirement.source === "entered");

async function main(): Promise<void> {
  assertVocabulary();
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });

  const pool = new Pool({ connectionString: url.toString(), max: 3, application_name: "nzi-portal-acceptance-seed" });
  try {
    // Identity plumbing — the one SQL write here, and the only thing without a command.
    await pool.query(
      `INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (organisation_id, user_id) DO UPDATE SET role_id = 'admin', status = 'active'`,
      [ORG, ACTOR],
    );

    const client = await pool.query<{ client_id: string; name: string }>(
      `SELECT client_id, name FROM nzi_console.clients
        WHERE organisation_id = $1 AND (name ILIKE $2 OR client_id = $2)
        ORDER BY name LIMIT 1`,
      [ORG, CLIENT_HINT],
    );
    const target = client.rows[0];
    if (!target) throw new Error(`No client matching "${CLIENT_HINT}" in ${ORG}. Set SEED_CLIENT_NAME to one that exists.`);
    log(`\nSeeding portal acceptance data for ${target.name} (${target.client_id}) in ${ORG}.\n`);

    const { framework, library } = await withTenantRead(pool, ORG, async (db) => ({
      framework: await getSrsFramework(db),
      library: await listLibraryStrategies(db),
    }));
    if (!framework) throw new Error("No SRS framework is published; the readiness half cannot be seeded.");

    const requirements = answerable(framework);
    if (requirements.length < 8) throw new Error(`The framework has only ${requirements.length} answerable requirements; the seed needs at least 8.`);

    // Three requirements reserved for the reverse-link cases, and one that must stay untouched by
    // every strategy so it can be the honest "no strategy aligned yet" gap.
    const reqAddressed = requirements[0]!;
    const reqWithdrawn = requirements[1]!;
    const reqOutOfReport = requirements[2]!;
    const reqNoStrategy = requirements[3]!;
    const reservedIds = new Set([reqAddressed.id, reqWithdrawn.id, reqOutOfReport.id, reqNoStrategy.id]);

    // Library strategies spread across levers, and none of them touching the reserved
    // requirements — otherwise the "no strategy" gap would quietly acquire one.
    const usable = library.filter((entry) =>
      entry.leverIds.length > 0 &&
      entry.defaultSrsRequirementIds.length > 0 &&
      !entry.defaultSrsRequirementIds.some((id) => reservedIds.has(id)));
    const byLever = new Map<string, typeof usable>();
    for (const entry of usable) {
      const lever = entry.leverIds[0]!;
      byLever.set(lever, [...(byLever.get(lever) ?? []), entry]);
    }
    if (byLever.size < 2) throw new Error(`The library offers strategies on only ${byLever.size} lever(s); the grouping criterion needs at least 2.`);
    // Round-robin across levers so the plan genuinely groups rather than showing one heading.
    const spread = [...byLever.values()].flatMap((entries, index) => entries.map((entry) => ({ entry, index })))
      .sort((a, b) => a.index - b.index).map((item) => item.entry);

    if (WITHDRAW_ALL) return await withdrawAll(pool, target.client_id);

    const created = new Map<string, string>();
    let libraryCursor = 0;

    for (const strategyCase of STRATEGY_CASES) {
      const requirementIds = strategyCase.id === "gap-addressed" ? [reqAddressed.id]
        : strategyCase.id === "gap-withdrawn" ? [reqWithdrawn.id]
        : strategyCase.id === "gap-out-of-report" ? [reqOutOfReport.id]
        : null;

      let assignInput;
      if (strategyCase.bespoke) {
        assignInput = {
          clientId: target.client_id,
          bespoke: BESPOKE,
          srsRequirementIds: requirementIds ?? [requirements[4]!.id],
          owner: ACTOR, notes: "Seeded for the NZC-080 portal acceptance run.",
        };
      } else {
        const chosen = spread[libraryCursor % spread.length]!;
        libraryCursor += 1;
        assignInput = {
          clientId: target.client_id, strategyId: chosen.id,
          srsRequirementIds: requirementIds ?? chosen.defaultSrsRequirementIds,
          owner: ACTOR, notes: "Seeded for the NZC-080 portal acceptance run.",
        };
      }

      const assigned = await assignClientStrategy(pool, assignInput, context(`assign:${strategyCase.id}`, assignInput));
      const clientStrategyId = assigned.data.clientStrategyId;
      if (!clientStrategyId) throw new Error(`assign returned no id for case ${strategyCase.id}`);
      created.set(strategyCase.id, clientStrategyId);
      log(`  ${assigned.replayed ? "=" : "+"} ${strategyCase.id.padEnd(18)} ${strategyCase.what}`);

      // Current version, read back rather than assumed — a replayed assign says nothing about
      // what has happened to the row since.
      const current = (await withTenantRead(pool, ORG, (db) => listClientStrategies(db, target.client_id)))
        .find((entry) => entry.id === clientStrategyId);
      if (!current) throw new Error(`Strategy ${clientStrategyId} (${strategyCase.id}) vanished after assignment.`);
      if (!current.active && !strategyCase.withdraw) {
        log(`    ! ${strategyCase.id} is withdrawn on the client's plan; leaving it alone rather than silently reinstating it.`);
        continue;
      }

      const updateInput = {
        clientStrategyId, expectedVersion: current.version,
        status: strategyCase.status, owner: ACTOR, targetDate: strategyCase.targetDate,
        progressPct: strategyCase.progressPct, notes: "Seeded for the NZC-080 portal acceptance run.",
        srsRequirementIds: current.srsRequirementIds, includeInReport: strategyCase.includeInReport,
      };
      await updateClientStrategy(pool, updateInput, context(`update:${strategyCase.id}`, updateInput));

      if (strategyCase.estimate) {
        const afterUpdate = (await withTenantRead(pool, ORG, (db) => listClientStrategies(db, target.client_id)))
          .find((entry) => entry.id === clientStrategyId)!;
        const estimateInput = {
          clientStrategyId, expectedVersion: afterUpdate.version,
          estimate: {
            amount: 42.5, unit: "tco2e_per_year" as const, scope: "1" as const,
            assumptions: "Seeded estimate for the NZC-080 acceptance run — not a real figure.",
            source: "consultant" as const,
          },
        };
        await setClientStrategyEstimate(pool, estimateInput, context(`estimate:${strategyCase.id}`, estimateInput));
      }

      if (strategyCase.withdraw) {
        const afterUpdate = (await withTenantRead(pool, ORG, (db) => listClientStrategies(db, target.client_id)))
          .find((entry) => entry.id === clientStrategyId)!;
        if (afterUpdate.active) {
          const removeInput = { clientStrategyId, expectedVersion: afterUpdate.version, reason: "Withdrawn for the NZC-080 acceptance run — the gap it addressed must read as unaddressed." };
          await removeClientStrategy(pool, removeInput, context(`remove:${strategyCase.id}`, removeInput, removeInput.reason));
          log(`    withdrawn (deactivated, not deleted)`);
        }
      }
    }

    await seedAssessment(pool, target.client_id, framework, requirements, {
      addressed: reqAddressed, withdrawn: reqWithdrawn, outOfReport: reqOutOfReport, noStrategy: reqNoStrategy,
    });

    summary(target.name, { addressed: reqAddressed, withdrawn: reqWithdrawn, outOfReport: reqOutOfReport, noStrategy: reqNoStrategy });
  } finally {
    await pool.end();
  }
}

/* ── The assessment ──────────────────────────────────────────────────────────────────── */

async function seedAssessment(
  pool: Pool, clientId: string, framework: SrsFramework, requirements: SrsRequirement[],
  reserved: { addressed: SrsRequirement; withdrawn: SrsRequirement; outOfReport: SrsRequirement; noStrategy: SrsRequirement },
): Promise<void> {
  // Read first, rather than key off a payload containing today's date — that would start a second
  // assessment tomorrow, and one completed assessment is the whole point.
  const existing = (await withTenantRead(pool, ORG, (db) => listSrsAssessments(db, clientId)))
    .find((assessment) => assessment.status === "complete");
  if (existing) {
    log(`\n  = SRS assessment ${existing.assessmentId} already complete — left as it is.`);
    return;
  }

  const startInput = { clientId, assessedOn: dayOffset(0), notes: "Seeded for the NZC-080 portal acceptance run." };
  const started = await startSrsAssessment(pool, startInput, context("srs:start", startInput));
  const assessmentId = started.data.assessmentId;
  if (!assessmentId) throw new Error("srs.assessment.start returned no assessment id.");
  log(`\n  + SRS assessment ${assessmentId} started`);

  // Gap depth varies so "ordered by shortfall" is actually testable — equal shortfalls would
  // make any order look correct.
  const answers: Array<{ requirement: SrsRequirement; maturity: number; note: string }> = [
    { requirement: reserved.addressed, maturity: 0, note: "deep gap, addressed by a live strategy" },
    { requirement: reserved.withdrawn, maturity: 1, note: "gap whose only strategy is withdrawn" },
    { requirement: reserved.outOfReport, maturity: 1, note: "gap whose only strategy is out of report" },
    { requirement: reserved.noStrategy, maturity: 2, note: "gap with no strategy at all" },
  ];
  // Everything else answerable is met, so met/gap is a genuine mix rather than all-gap.
  for (const requirement of requirements.slice(4, 10)) {
    answers.push({ requirement, maturity: Math.max(requirement.targetMaturity, 1), note: "met" });
  }

  for (const answer of answers) {
    const assessment = await withTenantRead(pool, ORG, (db) => getSrsAssessment(db, assessmentId));
    if (!assessment) throw new Error(`Assessment ${assessmentId} disappeared mid-seed.`);
    const itemInput = {
      assessmentId, requirementId: answer.requirement.id,
      maturity: Math.min(answer.maturity, 4),
      evidenceKind: "note" as const,
      evidenceNote: `Seeded for the NZC-080 acceptance run — ${answer.note}.`,
      expectedVersion: assessment.version,
    };
    await setSrsAssessmentItem(pool, itemInput, context(`srs:item:${answer.requirement.id}`, itemInput));
  }

  const finalState = await withTenantRead(pool, ORG, (db) => getSrsAssessment(db, assessmentId));
  const completeInput = { assessmentId, expectedVersion: finalState!.version };
  await completeSrsAssessment(pool, completeInput, context("srs:complete", completeInput));
  log(`  + SRS assessment completed — not a draft, so the portal will show it`);
}

/* ── Cleanup ─────────────────────────────────────────────────────────────────────────── */

async function withdrawAll(pool: Pool, clientId: string): Promise<void> {
  const strategies = (await withTenantRead(pool, ORG, (db) => listClientStrategies(db, clientId)))
    .filter((entry) => entry.active && (entry.notes ?? "").includes("NZC-080 portal acceptance"));
  log(`Withdrawing ${strategies.length} seeded strategies (deactivate, never delete).\n`);
  for (const strategy of strategies) {
    const input = { clientStrategyId: strategy.id, expectedVersion: strategy.version, reason: "Acceptance run complete — seeded strategy withdrawn." };
    await removeClientStrategy(pool, input, context(`cleanup:${strategy.id}`, input, input.reason));
    log(`  - ${strategy.id}`);
  }
  log("\nThe completed SRS assessment is left in place: assessments are a dated record, and");
  log("withdrawing one would misrepresent the client's history rather than tidy it up.\n");
}

function summary(clientName: string, reserved: Record<string, SrsRequirement>): void {
  log(`\n─── Seeded. What to expect in the portal for ${clientName} ───\n`);
  for (const strategyCase of STRATEGY_CASES) log(`  ${strategyCase.id.padEnd(18)} ${strategyCase.proves}`);
  log("");
  log(`  gap addressed      ${reserved.addressed!.code} — lists the live strategy (readiness #5)`);
  log(`  gap withdrawn-only ${reserved.withdrawn!.code} — must read "no strategy aligned yet" (readiness #6)`);
  log(`  gap out-of-report  ${reserved.outOfReport!.code} — must read "no strategy aligned yet" (readiness #7)`);
  log(`  gap no strategy    ${reserved.noStrategy!.code} — must read "no strategy aligned yet" (readiness #8)`);
  log("");
  log("  Re-run any time: creations replay, and the target dates are refreshed back into their");
  log("  due-state buckets. Use --withdraw-all to take the seeded strategies off the plan.\n");
}

main().catch((error) => {
  process.stderr.write(`\nseed-portal-acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
