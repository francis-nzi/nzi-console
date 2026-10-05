import { randomUUID } from "node:crypto";
import { commandGrantForRole, NET_ZERO_DEFAULT, type CommandContext, type CommandInputMap, type TargetMilestoneFields } from "@nzi/contracts";
import { getBenchmarkInForce, TARGET_COLUMNS, type TargetRow } from "./clientTargetRecords";
import { setClientTargetsInTransaction } from "./clientTargets";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";

/**
 * The one-time net-zero target fill (NET-ZERO follow-ups, Part B; `NET-ZERO-followups-kickoff.md`). Each active client with
 * no net-zero target in `client_targets` gets one through **client.targets.set**, the governed path the Baseline &
 * targets card writes: a new version, stamped with the benchmark in force, one audit event, the outbox, forced RLS.
 *
 * **What it fills:** the year from the client record's `net_zero_target_year` where set (a real, earlier commitment is
 * kept), else 2050; the reduction 90% (`NET_ZERO_DEFAULT` — the NZI methodology minimum).
 * **Fill-blank-only:** a client whose latest version holds a net-zero target is never touched. A client's other targets
 * (near-term, per scope) are carried forward from its latest version — the command writes a whole version.
 * **Left out, by class, never silently:** not active; no baseline in force (the command would refuse BASELINE_REQUIRED —
 * a target is a reduction against a baseline). Any refusal by the command itself is reported with its code.
 *
 * Every write is checked inside the transaction against what the verify step counts: the client's latest version now
 * holds exactly the intended net-zero pair, and its other targets are unchanged. A miss is reported per client.
 * One transaction for the run, a savepoint per client; a dry run is the whole run, rolled back.
 */

export const NET_ZERO_RUN_PREFIX = "net-zero-fill-";
export const NET_ZERO_ACTOR = "policy:net-zero-minimum";
export const NET_ZERO_REASON = "policy: net-zero minimum 90% reduction by 2050 (year preserved from client record where set).";

export type YearSource = "client record" | "default 2050";
export type PlannedFill = {
  clientId: string; clientName: string; year: number; pct: number; yearSource: YearSource;
  benchmarkYear: number; expectedVersion: number; carried: string[];
};
export type NetZeroPlan = {
  fill: PlannedFill[];
  /** A net-zero target is held already — never replaced. */
  held: number;
  /** No net-zero target, but not active. */
  notActive: Array<{ clientId: string; clientName: string; status: string }>;
  /** Active, no net-zero target, no baseline in force — client.targets.set would refuse BASELINE_REQUIRED. */
  noBaseline: Array<{ clientId: string; clientName: string }>;
  population: { clients: number };
};
export type FillOutcome = PlannedFill & {
  result: "written" | "refused";
  version: number | null;
  refusal: string | null;
  /** The post-condition the verify counts, checked in the transaction — expected empty. */
  postConditionMisses: string[];
};
export type NetZeroOutcome = { committed: boolean; runId: string; plan: NetZeroPlan; results: FillOutcome[] };

type ClientRow = { client_id: string; name: string; status: string; record_year: number | null };
type LatestRow = TargetRow & { client_id: string };

const pair = (year: number | null, pct: string | null): TargetMilestoneFields => ({ year, pct: pct === null ? null : Number(pct) });
const OTHER_MILESTONES = ["near_term", "scope1", "scope2", "scope3"] as const;

async function latestTargets(db: Queryable, organisationId: string, clientId?: string): Promise<Map<string, LatestRow>> {
  const { rows } = await db.query<LatestRow>(
    `SELECT DISTINCT ON (client_id) client_id, ${TARGET_COLUMNS} FROM nzi_console.client_targets
      WHERE organisation_id = $1 AND ($2::text IS NULL OR client_id = $2) ORDER BY client_id, version DESC`, [organisationId, clientId ?? null]);
  return new Map(rows.map((row) => [row.client_id, row]));
}

export async function planNetZeroFill(db: Queryable, organisationId: string): Promise<NetZeroPlan> {
  const clients = (await db.query<ClientRow>(
    `SELECT client_id, name, status::text AS status, net_zero_target_year AS record_year FROM nzi_console.clients WHERE organisation_id = $1 ORDER BY client_id`,
    [organisationId])).rows;
  const latest = await latestTargets(db, organisationId);
  const plan: NetZeroPlan = { fill: [], held: 0, notActive: [], noBaseline: [], population: { clients: clients.length } };
  for (const client of clients) {
    const previous = latest.get(client.client_id) ?? null;
    if (previous?.net_zero_year != null) { plan.held += 1; continue; }
    if (client.status !== "active") { plan.notActive.push({ clientId: client.client_id, clientName: client.name, status: client.status }); continue; }
    const benchmark = await getBenchmarkInForce(db, client.client_id);
    if (!benchmark) { plan.noBaseline.push({ clientId: client.client_id, clientName: client.name }); continue; }
    const fromRecord = client.record_year !== null;
    plan.fill.push({
      clientId: client.client_id, clientName: client.name,
      year: fromRecord ? client.record_year! : NET_ZERO_DEFAULT.year, pct: NET_ZERO_DEFAULT.pct,
      yearSource: fromRecord ? "client record" : "default 2050",
      benchmarkYear: benchmark.year, expectedVersion: previous?.version ?? 0,
      carried: previous ? OTHER_MILESTONES.filter((m) => previous[`${m}_year`] !== null) : [],
    });
  }
  return plan;
}

class DryRunRollback extends Error {}

export async function loadNetZeroFill(pool: PoolLike, organisationId: string, options: { commit: boolean; runId?: string }): Promise<NetZeroOutcome> {
  const runId = options.runId ?? `${NET_ZERO_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(NET_ZERO_RUN_PREFIX)) throw new Error(`A net-zero fill run id must start ${NET_ZERO_RUN_PREFIX}.`);
  let outcome: NetZeroOutcome | null = null;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      const plan = await planNetZeroFill(db, organisationId);
      const results: FillOutcome[] = [];
      for (const planned of plan.fill) {
        const result: FillOutcome = { ...planned, result: "refused", version: null, refusal: null, postConditionMisses: [] };
        await db.query("SAVEPOINT net_zero_client");
        try {
          const previous = (await latestTargets(db, organisationId, planned.clientId)).get(planned.clientId) ?? null;
          const input: CommandInputMap["client.targets.set"] = {
            clientId: planned.clientId, expectedVersion: planned.expectedVersion,
            nearTerm: previous ? pair(previous.near_term_year, previous.near_term_pct) : { year: null, pct: null },
            netZero: { year: planned.year, pct: planned.pct },
            scope1: previous ? pair(previous.scope1_year, previous.scope1_pct) : { year: null, pct: null },
            scope2: previous ? pair(previous.scope2_year, previous.scope2_pct) : { year: null, pct: null },
            scope3: previous ? pair(previous.scope3_year, previous.scope3_pct) : { year: null, pct: null },
          };
          const context: CommandContext = {
            organisationId, actorId: NET_ZERO_ACTOR, principal: "system", idempotencyKey: `${runId}:${planned.clientId}`, correlationId: runId,
            reason: NET_ZERO_REASON, grant: commandGrantForRole("admin", organisationId, NET_ZERO_ACTOR),
          };
          const saved = await setClientTargetsInTransaction(db, input, context);
          result.result = "written";
          result.version = saved.data.version;
          const now = (await latestTargets(db, organisationId, planned.clientId)).get(planned.clientId);
          if (!now || now.version !== planned.expectedVersion + 1) result.postConditionMisses.push("version");
          if (now?.net_zero_year !== planned.year || Number(now?.net_zero_pct) !== planned.pct) result.postConditionMisses.push("net_zero");
          for (const m of OTHER_MILESTONES) {
            const before = previous ? [previous[`${m}_year`], previous[`${m}_pct`] === null ? null : Number(previous[`${m}_pct`])] : [null, null];
            const after = now ? [now[`${m}_year`], now[`${m}_pct`] === null ? null : Number(now[`${m}_pct`])] : [null, null];
            if (JSON.stringify(before) !== JSON.stringify(after)) result.postConditionMisses.push(m);
          }
          await db.query("RELEASE SAVEPOINT net_zero_client");
        } catch (error) {
          await db.query("ROLLBACK TO SAVEPOINT net_zero_client");
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
