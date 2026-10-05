import { randomUUID } from "node:crypto";
import { commandGrantForRole, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import { CommandValidationError, updateClientInTransaction } from "./postgresCommands";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { listAllClients } from "./readModels";

/**
 * The job-derived baseline (kickoff `BASELINE-derive-build-kickoff.md`, ruled off `BASELINE-derive-crosscheck.md`).
 * For each client with **no baseline in force**, the benchmark is taken from one of its own v7 jobs — the period, and
 * Scope 1/2/3 and the total summed from that job's migrated rows — and written through **client.update**, the existing
 * audited re-baseline path, as the Re-baseline drawer writes it: the whole record as read, with the baseline on top.
 *
 * **Candidate job:** imported from v7, not cancelled (not archived in v7), with ≥ 1 enabled scope row and a total > 0.
 * **Selection (ruled):** (1) the job whose period start is the client's stated benchmark period start, where the record
 * states one; else (2) the earliest complete period (start and end); else (3) the most complete (most non-zero scopes);
 * a remaining tie takes the lowest job number. `is_benchmark` is not in the extract and is not an input — a cross-check.
 * **Held, never derived:** a client whose stated benchmark period no candidate matches — the record names a period we
 * hold no figures for, so substituting another would contradict it. Listed for Francis's manual pass.
 * **Figures:** Σ COALESCE(override_tco2e, calculated_tco2e) over the job's enabled rows — the v7 port that reproduced
 * v7's published totals at import. A scope with no rows is left unset (not measured), never 0; the total is the sum.
 *
 * **Governance:** each write is client.update — versioned (`expectedVersion`), tenant-scoped under forced RLS, one audit
 * event, the outbox, and for a client already holding a baseline field (its stated period) the governed re-baseline
 * (`baseline.rebaseline`, the `client_rebaselined` event, a `baseline_change_events` row). The reason is the provenance:
 * "policy: job-derived baseline, <rule step> (job <number>, id <job id>)". One transaction for the run, a savepoint per client so a
 * refusal is reported and the rest go on; a dry run is the whole run, rolled back.
 */

export const BASELINE_RUN_PREFIX = "baseline-derive-";
export const BASELINE_ACTOR = "policy:job-derived-baseline";
export type RuleStep = "only candidate" | "stated benchmark period" | "earliest complete period" | "most complete";

export type Candidate = {
  jobId: string; jobNumber: string; periodStart: string | null; periodEnd: string | null;
  scope1: number | null; scope2: number | null; scope3: number | null; total: number;
};
export type PlannedBaseline = {
  clientId: string; clientName: string; ruleStep: RuleStep; job: Candidate; candidates: number;
  statedStart: string | null; netZeroYear: number;
};
export type BaselinePlan = {
  derive: PlannedBaseline[];
  /** Stated benchmark period, matched by no candidate — for Francis's manual pass. */
  held: Array<{ clientId: string; clientName: string; statedStart: string; candidates: number }>;
  /** Candidates with rows but no usable total, so nothing to derive. */
  noUsableTotal: Array<{ clientId: string; clientName: string }>;
  population: { noBaselineInForce: number; withCandidate: number };
};

const scopesOf = (job: Candidate) => [job.scope1, job.scope2, job.scope3].filter((value) => value !== null && value !== 0).length;
const complete = (job: Candidate) => job.periodStart !== null && job.periodEnd !== null;
const byJobNumber = (a: Candidate, b: Candidate) => a.jobNumber.localeCompare(b.jobNumber);

/** The ruled precedence over one client's usable candidates (pure). */
export function chooseJob(candidates: readonly Candidate[], statedStart: string | null): { job: Candidate; step: RuleStep } | { held: true } {
  if (statedStart !== null) {
    const stated = candidates.filter((job) => job.periodStart === statedStart);
    if (stated.length === 0) return { held: true };
    if (stated.length === 1) return { job: stated[0]!, step: "stated benchmark period" };
    // Two jobs on the stated period: the more complete; then the lower number.
    const best = Math.max(...stated.map(scopesOf));
    return { job: [...stated].filter((job) => scopesOf(job) === best).sort(byJobNumber)[0]!, step: "most complete" };
  }
  if (candidates.length === 1) return { job: candidates[0]!, step: "only candidate" };
  const periods = candidates.filter(complete);
  if (periods.length > 0) {
    const earliest = periods.map((job) => job.periodStart!).sort()[0]!;
    const first = periods.filter((job) => job.periodStart === earliest);
    if (first.length === 1) return { job: first[0]!, step: "earliest complete period" };
    const best = Math.max(...first.map(scopesOf));
    return { job: [...first].filter((job) => scopesOf(job) === best).sort(byJobNumber)[0]!, step: "most complete" };
  }
  const best = Math.max(...candidates.map(scopesOf));
  return { job: [...candidates].filter((job) => scopesOf(job) === best).sort(byJobNumber)[0]!, step: "most complete" };
}

/** v7's year is the period's end year; the console names a baseline by its start year (benchmarkFromClientRecord). */
export const consoleFyLabel = (periodStart: string) => `FY${periodStart.slice(2, 4)}`;

export async function planBaselineDerive(db: Queryable, organisationId: string): Promise<BaselinePlan> {
  const { rows } = await db.query<{
    client_id: string; name: string; stated: string | null; nz_year: number; job_id: string | null; job_number: string | null;
    pstart: string | null; pend: string | null; s1: string | null; s2: string | null; s3: string | null; total: string | null;
  }>(
    `WITH pop AS (
       SELECT c.client_id, c.name, c.baseline_period_start::text AS stated, COALESCE(c.net_zero_target_year, 2050) AS nz_year
         FROM nzi_console.clients c
        WHERE c.organisation_id = $1
          AND NOT (c.baseline_period_start IS NOT NULL AND (c.baseline_total_tco2e IS NOT NULL OR c.baseline_scope1_tco2e IS NOT NULL
                   OR c.baseline_scope2_tco2e IS NOT NULL OR c.baseline_scope3_tco2e IS NOT NULL))
     )
     SELECT p.client_id, p.name, p.stated, p.nz_year, j.job_id, j.job_number,
            j.reporting_period_start::text AS pstart, j.reporting_period_end::text AS pend,
            (sum(COALESCE(r.override_tco2e, r.calculated_tco2e, 0)) FILTER (WHERE split_part(r.scope, '.', 1) = '1'))::text AS s1,
            (sum(COALESCE(r.override_tco2e, r.calculated_tco2e, 0)) FILTER (WHERE split_part(r.scope, '.', 1) = '2'))::text AS s2,
            (sum(COALESCE(r.override_tco2e, r.calculated_tco2e, 0)) FILTER (WHERE split_part(r.scope, '.', 1) = '3'))::text AS s3,
            sum(COALESCE(r.override_tco2e, r.calculated_tco2e, 0))::text AS total
       FROM pop p
       LEFT JOIN nzi_console.jobs j ON (j.organisation_id, j.client_id) = ($1, p.client_id) AND j.source_system = 'nzi-pro-v7' AND j.status::text <> 'cancelled'
            AND EXISTS (SELECT 1 FROM nzi_console.job_scope_rows x WHERE (x.organisation_id, x.job_id) = (j.organisation_id, j.job_id) AND x.enabled)
       LEFT JOIN nzi_console.job_scope_rows r ON (r.organisation_id, r.job_id) = (j.organisation_id, j.job_id) AND r.enabled
      GROUP BY p.client_id, p.name, p.stated, p.nz_year, j.job_id, j.job_number, j.reporting_period_start, j.reporting_period_end
      ORDER BY p.client_id, j.job_number`, [organisationId]);
  const byClient = new Map<string, { name: string; stated: string | null; nzYear: number; jobs: Candidate[]; anyJob: boolean }>();
  for (const row of rows) {
    const entry = byClient.get(row.client_id) ?? { name: row.name, stated: row.stated, nzYear: row.nz_year, jobs: [], anyJob: false };
    byClient.set(row.client_id, entry);
    if (row.job_id === null) continue;
    entry.anyJob = true;
    const total = Number(row.total ?? 0);
    if (!(total > 0)) continue;
    const figure = (value: string | null) => value === null ? null : Number(value);
    entry.jobs.push({ jobId: row.job_id, jobNumber: row.job_number!, periodStart: row.pstart, periodEnd: row.pend, scope1: figure(row.s1), scope2: figure(row.s2), scope3: figure(row.s3), total });
  }
  const plan: BaselinePlan = { derive: [], held: [], noUsableTotal: [], population: { noBaselineInForce: byClient.size, withCandidate: 0 } };
  for (const [clientId, entry] of byClient) {
    if (entry.anyJob && entry.jobs.length === 0) { plan.noUsableTotal.push({ clientId, clientName: entry.name }); continue; }
    if (entry.jobs.length === 0) continue;
    plan.population.withCandidate += 1;
    const choice = chooseJob(entry.jobs, entry.stated);
    if ("held" in choice) { plan.held.push({ clientId, clientName: entry.name, statedStart: entry.stated!, candidates: entry.jobs.length }); continue; }
    plan.derive.push({ clientId, clientName: entry.name, ruleStep: choice.step, job: choice.job, candidates: entry.jobs.length, statedStart: entry.stated, netZeroYear: entry.nzYear });
  }
  return plan;
}

// ── The load ──────────────────────────────────────────────────────────────────────────────────────────────────

export type DerivedOutcome = PlannedBaseline & {
  result: "written" | "refused";
  /** The governed re-baseline (the record already held a baseline field — its stated period) vs an initial baseline. */
  governed: boolean;
  version: number | null;
  /** Columns the save changed other than the baseline and its bookkeeping — expected to be none. */
  otherChanges: string[];
  /**
   * Columns the save took from NULL to "" — client.update writes the legacy single-contact columns as "" when empty,
   * as every drawer save does. Empty either way; reported apart so that `otherChanges` stays strict.
   */
  emptyNormalised: string[];
  refusal: string | null;
  afterBenchmarkCollision: boolean;
};
export type BaselineOutcome = { committed: boolean; runId: string; plan: BaselinePlan; results: DerivedOutcome[] };

class DryRunRollback extends Error {}
const BOOKKEEPING = new Set(["version", "updated_at", "baseline_period_start", "baseline_period_end", "baseline_total_tco2e",
  "baseline_scope1_tco2e", "baseline_scope2_tco2e", "baseline_scope3_tco2e"]);

export async function loadBaselineDerive(pool: PoolLike, organisationId: string, options: { commit: boolean; runId?: string }): Promise<BaselineOutcome> {
  const runId = options.runId ?? `${BASELINE_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(BASELINE_RUN_PREFIX)) throw new Error(`A baseline run id must start ${BASELINE_RUN_PREFIX}.`);
  let outcome: BaselineOutcome | null = null;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const plan = await planBaselineDerive(db, organisationId);
      const results: DerivedOutcome[] = [];
      for (const planned of plan.derive) {
        const result: DerivedOutcome = { ...planned, result: "refused", governed: false, version: null, otherChanges: [], emptyNormalised: [], refusal: null,
          afterBenchmarkCollision: Number(planned.job.periodStart?.slice(0, 4) ?? 0) >= planned.netZeroYear };
        await db.query("SAVEPOINT baseline_client");
        try {
          const [client] = await listAllClients(db, planned.clientId);
          if (!client) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "Client was not found." }]);
          const before = (await db.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(c) AS row FROM nzi_console.clients c WHERE organisation_id = $1 AND client_id = $2`, [organisationId, planned.clientId])).rows[0]!.row;
          result.governed = [before.baseline_period_start, before.baseline_period_end, before.baseline_total_tco2e, before.baseline_scope1_tco2e, before.baseline_scope2_tco2e, before.baseline_scope3_tco2e].some((value) => value !== null);
          // Exactly what the Re-baseline drawer sends: the whole record as read, with the baseline on top.
          const input = {
            clientId: planned.clientId, expectedVersion: client.version, name: client.name, status: client.status, sector: client.sector,
            location: client.location, owner: client.owner, ...client.profile,
            baselinePeriodStart: planned.job.periodStart, baselinePeriodEnd: planned.job.periodEnd,
            baselineScope1Tco2e: planned.job.scope1, baselineScope2Tco2e: planned.job.scope2, baselineScope3Tco2e: planned.job.scope3,
            baselineTotalTco2e: planned.job.total,
          } as CommandInputMap["client.update"];
          const context: CommandContext = {
            organisationId, actorId: BASELINE_ACTOR, principal: "system", idempotencyKey: `${runId}:${planned.clientId}`, correlationId: runId,
            reason: `policy: job-derived baseline, ${planned.ruleStep} (job ${planned.job.jobNumber}, id ${planned.job.jobId})`,
            grant: commandGrantForRole("admin", organisationId, BASELINE_ACTOR),
          };
          const saved = await updateClientInTransaction(db, input, context);
          const after = (await db.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(c) AS row FROM nzi_console.clients c WHERE organisation_id = $1 AND client_id = $2`, [organisationId, planned.clientId])).rows[0]!.row;
          const changed = Object.keys(after).filter((key) => !BOOKKEEPING.has(key) && JSON.stringify(after[key]) !== JSON.stringify(before[key])).sort();
          result.emptyNormalised = changed.filter((key) => before[key] === null && after[key] === "");
          result.otherChanges = changed.filter((key) => !result.emptyNormalised.includes(key));
          result.result = "written";
          result.version = saved.data.version;
          await db.query("RELEASE SAVEPOINT baseline_client");
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT baseline_client");
          result.refusal = error instanceof CommandValidationError ? error.issues.map((issue) => `${issue.field} ${issue.code}`).join(", ")
            : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        results.push(result);
      }
      outcome = { committed: options.commit, runId, plan, results };
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome!;
}
