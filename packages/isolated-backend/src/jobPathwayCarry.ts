// Addendum A (ruled 25 Nov 2026) — one baseline, on the client. Values entered on a job's own "Reduction pathway target"
// (`job_emissions_targets`, now read-only history) are carried onto the client record, and listed for review where they
// conflict. Through the existing commands only: client.update (the baseline's total, on a client whose baseline year for
// that year is set but pending) and client.targets.set (the near-term and net-zero milestones). One transaction for the run,
// a savepoint per client; a dry run is the whole run, rolled back.
//
// Never invented: a job target names a baseline *year* and a total, not a period or a scope split, so a client with no
// baseline period gets nothing carried — it is listed. A net-zero year with no percentage takes NZI's methodology minimum
// (Decision 2, 90%), and the report says so.
import { randomUUID } from "node:crypto";
import { commandGrantForRole, NET_ZERO_DEFAULT, type CommandContext, type CommandInputMap } from "@nzi/contracts";
import { getBaselineYearState, getBenchmarkInForce, getClientTargets } from "./clientTargetRecords";
import { setClientTargetsInTransaction } from "./clientTargets";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, updateClientInTransaction } from "./postgresCommands";
import { listAllClients } from "./readModels";

export const PATHWAY_CARRY_RUN_PREFIX = "pathway-carry-";
export const PATHWAY_CARRY_ACTOR = "policy:job-pathway-carry";

type JobTarget = { jobId: string; jobNumber: string; clientId: string; clientName: string; baselineYear: number; baselineTco2e: number; interimYear: number; interimPct: number; netZeroYear: number };
export type CarryItem = { what: "baseline total" | "near-term" | "net zero"; value: string; from: string };
export type CarryConflict = { clientId: string; clientName: string; what: string; client: string; jobs: string };
export type CarryOutcome = {
  committed: boolean; runId: string;
  carried: Array<{ clientId: string; clientName: string; items: CarryItem[]; defaultedNetZeroPct: boolean }>;
  agreed: Array<{ clientId: string; clientName: string; what: string }>;
  conflicts: CarryConflict[];
  refused: Array<{ clientId: string; clientName: string; reason: string }>;
};

class DryRunRollback extends Error {}
const same = (a: number, b: number) => Math.abs(a - b) <= 0.0005;
const distinct = <T>(values: T[], key: (value: T) => string) => [...new Map(values.map((value) => [key(value), value])).values()];

async function jobTargets(db: Queryable, organisationId: string): Promise<JobTarget[]> {
  const { rows } = await db.query<{ job_id: string; job_number: string; client_id: string; client_name: string; baseline_year: number; baseline_tco2e: string; interim_year: number; interim_reduction_percent: string; net_zero_year: number }>(
    `SELECT t.job_id, j.job_number, j.client_id, c.name AS client_name, t.baseline_year, t.baseline_tco2e::text, t.interim_year, t.interim_reduction_percent::text, t.net_zero_year
       FROM nzi_console.job_emissions_targets t
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.job_id)
       JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE t.organisation_id = $1 AND j.status <> 'cancelled' ORDER BY c.name, j.job_number`, [organisationId]);
  return rows.map((row) => ({ jobId: row.job_id, jobNumber: row.job_number, clientId: row.client_id, clientName: row.client_name, baselineYear: row.baseline_year,
    baselineTco2e: Number(row.baseline_tco2e), interimYear: row.interim_year, interimPct: Number(row.interim_reduction_percent), netZeroYear: row.net_zero_year }));
}

export async function carryJobPathwayTargets(pool: PoolLike, organisationId: string, options: { commit: boolean; runId?: string }): Promise<CarryOutcome> {
  const runId = options.runId ?? `${PATHWAY_CARRY_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(PATHWAY_CARRY_RUN_PREFIX)) throw new Error(`A carry run id must start ${PATHWAY_CARRY_RUN_PREFIX}.`);
  const outcome: CarryOutcome = { committed: options.commit, runId, carried: [], agreed: [], conflicts: [], refused: [] };
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const all = await jobTargets(db, organisationId);
      const byClient = new Map<string, JobTarget[]>();
      for (const target of all) byClient.set(target.clientId, [...(byClient.get(target.clientId) ?? []), target]);
      for (const [clientId, targets] of byClient) {
        const clientName = targets[0]!.clientName;
        const jobs = (list: JobTarget[]) => list.map((t) => t.jobNumber).join(", ");
        const conflict = (what: string, client: string, list: JobTarget[]) => outcome.conflicts.push({ clientId, clientName, what, client, jobs: jobs(list) });
        const context = (step: string): CommandContext => ({
          organisationId, actorId: PATHWAY_CARRY_ACTOR, principal: "system", idempotencyKey: `${runId}:${clientId}:${step}`, correlationId: runId,
          reason: `Addendum A: carried from the job pathway target (${jobs(targets)}) onto the client`, grant: commandGrantForRole("admin", organisationId, PATHWAY_CARRY_ACTOR),
        });
        await db.query("SAVEPOINT pathway_client");
        try {
          const items: CarryItem[] = [];
          let defaultedNetZeroPct = false;
          // ── The baseline: one year and total across the client's jobs, against the client's own.
          const baselines = distinct(targets, (t) => `${t.baselineYear}:${t.baselineTco2e}`);
          const year = await getBaselineYearState(db, clientId);
          const inForce = await getBenchmarkInForce(db, clientId);
          if (baselines.length > 1) conflict("baseline", year ? `${year.year}${inForce ? ` · ${inForce.totalTco2e} tCO₂e` : " · figures pending"}` : "none", targets);
          else {
            const job = baselines[0]!;
            if (!year) conflict("baseline", "no baseline year on the client (a job target names a year, not a period)", targets);
            else if (year.year !== job.baselineYear) conflict("baseline year", String(year.year), targets);
            else if (inForce) { if (same(inForce.totalTco2e, job.baselineTco2e)) outcome.agreed.push({ clientId, clientName, what: "baseline" }); else conflict("baseline total", `${inForce.totalTco2e} tCO₂e`, targets); }
            else {
              // The client's baseline year is that year, its figures pending: the job's total fills it (no scope split is invented).
              const [client] = await listAllClients(db, clientId);
              if (!client) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "Client was not found." }]);
              await updateClientInTransaction(db, {
                clientId, expectedVersion: client.version, name: client.name, status: client.status, sector: client.sector, location: client.location, owner: client.owner,
                ...client.profile, baselineTotalTco2e: job.baselineTco2e,
              } as CommandInputMap["client.update"], context("baseline"));
              items.push({ what: "baseline total", value: `${job.baselineYear} · ${job.baselineTco2e} tCO₂e`, from: jobs(targets) });
            }
          }
          // ── The milestones: near-term from the interim, net zero from its year.
          const interims = distinct(targets, (t) => `${t.interimYear}:${t.interimPct}`);
          const netZeros = distinct(targets, (t) => String(t.netZeroYear));
          const benchmarkNow = await getBenchmarkInForce(db, clientId);
          const current = await getClientTargets(db, clientId, { benchmarkInForce: benchmarkNow, actuals: [], baselineYear: await getBaselineYearState(db, clientId) });
          const model = current.model;
          let nearTerm = model?.nearTerm ?? null, netZero = model?.netZero ?? null, changed = false;
          if (interims.length > 1) conflict("near-term", nearTerm ? `${nearTerm.year} · −${nearTerm.pct}%` : "none", targets);
          else if (!nearTerm) { nearTerm = { year: interims[0]!.interimYear, pct: interims[0]!.interimPct }; changed = true; items.push({ what: "near-term", value: `${nearTerm.year} · −${nearTerm.pct}%`, from: jobs(targets) }); }
          else if (nearTerm.year === interims[0]!.interimYear && same(nearTerm.pct, interims[0]!.interimPct)) outcome.agreed.push({ clientId, clientName, what: "near-term" });
          else conflict("near-term", `${nearTerm.year} · −${nearTerm.pct}%`, targets);
          if (netZeros.length > 1) conflict("net zero", netZero ? String(netZero.year) : "none", targets);
          else if (!netZero) { netZero = { year: netZeros[0]!.netZeroYear, pct: NET_ZERO_DEFAULT.pct }; changed = true; defaultedNetZeroPct = true; items.push({ what: "net zero", value: `${netZero.year} · −${netZero.pct}% (methodology minimum)`, from: jobs(targets) }); }
          else if (netZero.year === netZeros[0]!.netZeroYear) outcome.agreed.push({ clientId, clientName, what: "net zero" });
          else conflict("net zero", String(netZero.year), targets);
          if (changed) {
            if (!current.baselineYear && !benchmarkNow) {
              conflict("targets", "no baseline year on the client, so no target can be set against it", targets);
            } else {
              await setClientTargetsInTransaction(db, {
                clientId, expectedVersion: current.version,
                nearTerm: nearTerm ?? { year: null, pct: null }, netZero: netZero ?? { year: null, pct: null },
                scope1: model?.scopes["1"] ?? { year: null, pct: null }, scope2: model?.scopes["2"] ?? { year: null, pct: null }, scope3: model?.scopes["3"] ?? { year: null, pct: null },
              } as CommandInputMap["client.targets.set"], context("targets"));
            }
          }
          if (items.length) outcome.carried.push({ clientId, clientName, items, defaultedNetZeroPct });
          await db.query("RELEASE SAVEPOINT pathway_client");
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT pathway_client");
          if (!(error instanceof CommandValidationError)) throw error;
          outcome.refused.push({ clientId, clientName, reason: error.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ") });
        }
      }
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome;
}
