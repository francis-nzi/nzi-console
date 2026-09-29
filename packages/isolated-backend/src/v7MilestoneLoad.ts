import { randomUUID } from "node:crypto";
import { RISK_LEVELS, type RiskLevel } from "@nzi/contracts";
import { withTenantRead, withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { clientRiskIncludesJob, milestoneRisk, riskOf, worstRisk, type ClientRiskJobSet, type RiskMilestone } from "./milestoneRisk";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row } from "./v7ClientExtract";

/**
 * The milestone backfill (docs/LIST_PARITY_DESIGN.md, PR 2): v7's `job_plan` → `job_milestones`, for jobs already
 * imported.
 *
 * **Not a re-run of the client load.** That load treats imported history as immutable and refuses a client whose v7
 * data changed since — and live v7 has moved on — so this is its own step, reading only `job_plan` (ruled R2).
 *
 * **Tenant-scoped, one transaction per client, a dry run is the load rolled back** — exactly as the client load.
 *
 * **Re-run semantics for an operational table (ruled R3).** Each row remembers the v7 values it was last loaded with
 * (`legacy_values`). On a re-run, per job and kind:
 * - v7 unchanged since the last load → left alone (whatever the console did since);
 * - v7 changed, and the row is still as a backfill wrote it (`updated_by` is an import run) → v7 wins, the row updates;
 * - v7 changed **and** the console changed it → that job is refused and reported by job and kind, never silently;
 * - a row made in the console (no v7 identity) where v7 now records the same kind → refused and reported, likewise.
 * Nothing is deleted.
 *
 * **Dirty v7 data (ruled A2).** v7 does not enforce that "completed by" comes with a completion. A kind with a label but
 * no `completed_at` keeps its due date, loses the label, and is counted — the table's CHECK is never what stops a load.
 *
 * **Who completed it (ruled R4).** The label is kept verbatim. The user id is set only on an exact, unique match to a
 * membership (display name exactly, or email ignoring case); otherwise NULL. The report gives counts, never values.
 */

export const MILESTONE_KINDS = ["data_collection", "first_draft", "final_report"] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];
export const MILESTONE_RUN_PREFIX = "v7-milestones-";

/** The v7 values of one kind, as extracted — what `legacy_values` holds and what a re-run compares. */
export type LegacyMilestoneValues = { due: string | null; completedAt: string | null; completedBy: string | null };

export type PlannedMilestone = {
  kind: MilestoneKind; legacyDbId: string;
  dueDate: string | null; completedAt: string | null; completedByLabel: string | null;
  legacyValues: LegacyMilestoneValues;
};
export type PlannedJobMilestones = { v7JobId: string; milestones: PlannedMilestone[] };

export type MilestonePlan = {
  jobs: PlannedJobMilestones[];
  /** A `job_plan` row the plan could not read (an unparseable date) — its job is left out, and named. */
  unreadable: Array<{ v7JobId: string; reason: string }>;
  labelsDropped: number;
  byKind: Record<MilestoneKind, { dated: number; completed: number; undatedCompleted: number }>;
};

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?))?$/;

function day(value: string): string | null {
  const match = DAY.exec(value);
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.getUTCFullYear() === Number(match[1]) && parsed.getUTCMonth() === Number(match[2]) - 1 && parsed.getUTCDate() === Number(match[3]) ? value : null;
}
/** v7's `timestamp` has no zone; it was written on Render's clock, which is UTC. The rule only asks whether it is set. */
function instant(value: string): string | null {
  const match = INSTANT.exec(value);
  if (!match || day(match[1]!) === null) return null;
  const parsed = new Date(`${match[1]}T${match[2] ?? "00:00:00"}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Read `job_plan` rows into milestones. Pure: no database. */
export function planV7Milestones(rows: readonly V7Row[]): MilestonePlan {
  const plan: MilestonePlan = {
    jobs: [], unreadable: [], labelsDropped: 0,
    byKind: Object.fromEntries(MILESTONE_KINDS.map((kind) => [kind, { dated: 0, completed: 0, undatedCompleted: 0 }])) as MilestonePlan["byKind"],
  };
  for (const row of rows) {
    const v7JobId = text(row.job_id);
    if (!v7JobId) { plan.unreadable.push({ v7JobId: "(blank)", reason: "a job_plan row with no job_id" }); continue; }
    const milestones: PlannedMilestone[] = [];
    let unreadable: string | null = null;
    for (const kind of MILESTONE_KINDS) {
      const legacyValues: LegacyMilestoneValues = {
        due: text(row[`${kind}_due`]), completedAt: text(row[`${kind}_completed_at`]), completedBy: text(row[`${kind}_completed_by`]),
      };
      const dueDate = legacyValues.due === null ? null : day(legacyValues.due);
      const completedAt = legacyValues.completedAt === null ? null : instant(legacyValues.completedAt);
      if (legacyValues.due !== null && dueDate === null) { unreadable = `${kind} due date is not a date`; break; }
      if (legacyValues.completedAt !== null && completedAt === null) { unreadable = `${kind} completion is not a timestamp`; break; }
      let completedByLabel = legacyValues.completedBy;
      if (completedByLabel !== null && completedAt === null) { completedByLabel = null; plan.labelsDropped += 1; }
      if (dueDate === null && completedAt === null) continue;
      if (dueDate !== null) plan.byKind[kind].dated += 1;
      if (completedAt !== null) plan.byKind[kind][dueDate === null ? "undatedCompleted" : "completed"] += 1;
      milestones.push({ kind, legacyDbId: `${v7JobId}:${kind}`, dueDate, completedAt, completedByLabel, legacyValues });
    }
    if (unreadable) { plan.unreadable.push({ v7JobId, reason: unreadable }); continue; }
    plan.jobs.push({ v7JobId, milestones });
  }
  return plan;
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type ConsoleClient = { clientId: string; legacyId: string };
export type ConsoleJob = { jobId: string; v7JobId: string; clientId: string; jobNumber: string; status: string; clientLegacyId: string | null };
type Member = { userId: string; displayName: string | null; email: string | null };

export type MilestoneConflict = { jobNumber: string; kind: MilestoneKind; reason: string };
export type MilestoneLoadOutcome = {
  committed: boolean; runId: string;
  inserted: number; updated: number; unchanged: number;
  /** Jobs refused under R3 — every kind that conflicted, by job number. Nothing of such a job was written. */
  conflicts: MilestoneConflict[];
  /** `job_plan` rows whose job is not in the console (added in v7 since the first extract, most often). */
  unmatchedV7JobIds: string[];
  /** Clients whose transaction failed outright (not an R3 refusal) — nothing of each was written. */
  failedClients: Array<{ clientId: string; reason: string }>;
  completedBy: { labelled: number; distinct: number; matched: number };
};
export type MilestoneLoadOptions = { commit: boolean; runId?: string };

class DryRunRollback extends Error {}
const same = (a: LegacyMilestoneValues | null, b: LegacyMilestoneValues): boolean =>
  a !== null && a.due === b.due && a.completedAt === b.completedAt && a.completedBy === b.completedBy;
const NOTHING: LegacyMilestoneValues = { due: null, completedAt: null, completedBy: null };

/** R4: exactly one membership, by display name exactly or by email ignoring case — or nobody. */
export function resolveCompletedBy(label: string | null, members: readonly Member[]): string | null {
  if (label === null) return null;
  const wanted = label.trim();
  const matches = members.filter((member) => member.displayName?.trim() === wanted || (member.email !== null && member.email.trim().toLowerCase() === wanted.toLowerCase()));
  return matches.length === 1 ? matches[0]!.userId : null;
}

export async function readConsoleJobs(db: Queryable): Promise<ConsoleJob[]> {
  const { rows } = await db.query<{ job_id: string; legacy_db_id: string; client_id: string; job_number: string; status: string; client_legacy_id: string | null }>(
    `SELECT j.job_id, j.legacy_db_id, j.client_id, j.job_number, j.status::text AS status, c.legacy_db_id AS client_legacy_id
       FROM nzi_console.jobs j JOIN nzi_console.clients c ON (c.organisation_id, c.client_id) = (j.organisation_id, j.client_id)
      WHERE j.source_system = $1`, [SOURCE_SYSTEM]);
  return rows.map((row) => ({ jobId: row.job_id, v7JobId: row.legacy_db_id, clientId: row.client_id, jobNumber: row.job_number, status: row.status, clientLegacyId: row.client_legacy_id }));
}

export async function readConsoleClients(db: Queryable): Promise<ConsoleClient[]> {
  const { rows } = await db.query<{ client_id: string; legacy_db_id: string }>(
    `SELECT client_id, legacy_db_id FROM nzi_console.clients WHERE source_system = $1`, [SOURCE_SYSTEM]);
  return rows.map((row) => ({ clientId: row.client_id, legacyId: row.legacy_db_id }));
}

export async function loadV7Milestones(pool: PoolLike, organisationId: string, plan: MilestonePlan, options: MilestoneLoadOptions): Promise<MilestoneLoadOutcome> {
  const runId = options.runId ?? `${MILESTONE_RUN_PREFIX}${randomUUID()}`;
  if (!runId.startsWith(MILESTONE_RUN_PREFIX)) throw new Error(`A milestone run id must start ${MILESTONE_RUN_PREFIX} — it is how a re-run knows a row is still as a backfill wrote it.`);
  const outcome: MilestoneLoadOutcome = {
    committed: options.commit, runId, inserted: 0, updated: 0, unchanged: 0, conflicts: [], unmatchedV7JobIds: [], failedClients: [],
    completedBy: { labelled: 0, distinct: 0, matched: 0 },
  };

  const { jobs, members } = await withTenantRead(pool, organisationId, async (db) => ({
    jobs: await readConsoleJobs(db),
    members: (await db.query<{ user_id: string; display_name: string | null; email: string | null }>(
      `SELECT user_id, display_name, email FROM nzi_console.memberships`)).rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, email: row.email })),
  }));
  const byV7Id = new Map(jobs.map((job) => [job.v7JobId, job]));

  const labels = new Set<string>();
  const perClient = new Map<string, Array<{ job: ConsoleJob; planned: PlannedJobMilestones }>>();
  for (const planned of plan.jobs) {
    const job = byV7Id.get(planned.v7JobId);
    if (!job) { outcome.unmatchedV7JobIds.push(planned.v7JobId); continue; }
    for (const milestone of planned.milestones) {
      if (milestone.completedByLabel === null) continue;
      outcome.completedBy.labelled += 1;
      labels.add(milestone.completedByLabel);
      if (resolveCompletedBy(milestone.completedByLabel, members) !== null) outcome.completedBy.matched += 1;
    }
    perClient.set(job.clientId, [...(perClient.get(job.clientId) ?? []), { job, planned }]);
  }
  outcome.completedBy.distinct = labels.size;

  for (const [clientId, entries] of perClient) {
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    const conflicts: MilestoneConflict[] = [];
    try {
      await withTenantWrite(pool, organisationId, async (db) => {
        for (const { job, planned } of entries) {
          const found = await loadJob(db, organisationId, job, planned, members, runId, counts);
          conflicts.push(...found);
        }
        if (counts.inserted + counts.updated > 0) await audit(db, organisationId, runId, clientId, { ...counts, refusedJobs: new Set(conflicts.map((c) => c.jobNumber)).size });
        if (!options.commit) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) {
        outcome.failedClients.push({ clientId, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    outcome.inserted += counts.inserted; outcome.updated += counts.updated; outcome.unchanged += counts.unchanged;
    outcome.conflicts.push(...conflicts);
  }
  return outcome;
}

type StoredMilestone = { kind: MilestoneKind; source_system: string | null; legacy_values: LegacyMilestoneValues | null; updated_by: string };

/** One job: decide every kind first; write only if none conflicts, so a refused job is refused whole. */
async function loadJob(db: Queryable, org: string, job: ConsoleJob, planned: PlannedJobMilestones, members: readonly Member[],
  runId: string, counts: { inserted: number; updated: number; unchanged: number }): Promise<MilestoneConflict[]> {
  const { rows } = await db.query<StoredMilestone>(
    `SELECT kind, source_system, legacy_values, updated_by FROM nzi_console.job_milestones WHERE organisation_id = $1 AND job_id = $2`, [org, job.jobId]);
  const stored = new Map(rows.map((row) => [row.kind, row]));
  const writes: Array<{ action: "insert" | "update"; milestone: PlannedMilestone }> = [];
  const conflicts: MilestoneConflict[] = [];
  let unchanged = 0;

  for (const kind of MILESTONE_KINDS) {
    const milestone = planned.milestones.find((candidate) => candidate.kind === kind);
    const current = milestone?.legacyValues ?? NOTHING;
    const row = stored.get(kind);
    if (!row) { if (milestone) writes.push({ action: "insert", milestone }); continue; }
    if (row.source_system === null) {
      // Made in the console. v7 recording the same kind is two sources for one milestone: a person decides.
      if (milestone) conflicts.push({ jobNumber: job.jobNumber, kind, reason: "made in the console, and v7 also records it" });
      continue;
    }
    if (same(row.legacy_values, current)) { unchanged += 1; continue; }
    if (row.updated_by.startsWith(MILESTONE_RUN_PREFIX)) {
      writes.push({ action: "update", milestone: milestone ?? { kind, legacyDbId: `${planned.v7JobId}:${kind}`, dueDate: null, completedAt: null, completedByLabel: null, legacyValues: NOTHING } });
    } else {
      conflicts.push({ jobNumber: job.jobNumber, kind, reason: "changed in v7 since the last load, and edited in the console since" });
    }
  }
  if (conflicts.length > 0) return conflicts;

  for (const { action, milestone } of writes) {
    const values = [org, job.jobId, milestone.kind, milestone.dueDate, milestone.completedAt,
      resolveCompletedBy(milestone.completedByLabel, members), milestone.completedByLabel, JSON.stringify(milestone.legacyValues), runId];
    if (action === "insert") {
      await db.query(
        `INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, completed_at, completed_by_user_id, completed_by_label,
           source_system, legacy_db_id, legacy_values, updated_by)
         VALUES ($1, $2, $3, $4::date, $5::timestamptz, $6, $7, $10, $11, $8::jsonb, $9)`,
        [...values, SOURCE_SYSTEM, milestone.legacyDbId]);
      counts.inserted += 1;
    } else {
      await db.query(
        `UPDATE nzi_console.job_milestones SET due_date = $4::date, completed_at = $5::timestamptz, completed_by_user_id = $6, completed_by_label = $7,
           legacy_values = $8::jsonb, updated_by = $9, updated_at = now(), version = version + 1
         WHERE organisation_id = $1 AND job_id = $2 AND kind = $3`, values);
      counts.updated += 1;
    }
  }
  counts.unchanged += unchanged;
  return [];
}

async function audit(db: Queryable, org: string, runId: string, clientId: string, counts: Record<string, number>): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,after_json,client_id)
     VALUES ($1,$2,$3,'system','milestones.imported','client',$4,$5,$6,$7::jsonb,$4)`,
    [org, randomUUID(), IMPORT_ACTOR, clientId, runId, "Milestones backfilled from NZ Insights Pro v7 job_plan (PR 2)",
      JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, ...counts })]);
}

// ── The dry-run report: Risk under both job sets, and parity with v7's own labels ────────────────────────────────

const V7_LABEL: Record<string, RiskLevel> = { red: "Overdue", amber: "Due", green: "Healthy" };

export type RiskReport = {
  operatingDay: string;
  jobs: Record<RiskLevel, number>;
  clients: Record<ClientRiskJobSet, Record<RiskLevel, number>>;
  /** Clients where the console's label under a job set is not v7's, each with the jobs and milestones behind it. */
  differences: Record<ClientRiskJobSet, Array<{ clientId: string; console: RiskLevel; v7: RiskLevel; reasons: string[] }>>;
  /** Clients in v7's parity file with no imported counterpart. */
  parityUnmatched: number;
};

const tally = (): Record<RiskLevel, number> => Object.fromEntries(RISK_LEVELS.map((level) => [level, 0])) as Record<RiskLevel, number>;

/**
 * Risk for every imported job and client, from the plan (not the database) on the extract's operating day, and each
 * client compared with v7's own label. Pure, so the dry run reports it without writing, and a test can pin it.
 */
export function milestoneRiskReport(plan: MilestonePlan, consoleClients: readonly ConsoleClient[], consoleJobs: readonly ConsoleJob[], parity: readonly V7Row[] | null, operatingDay: string): RiskReport {
  const milestonesByV7Job = new Map(plan.jobs.map((job) => [job.v7JobId, job.milestones]));
  const jobRisk = new Map<string, RiskLevel>();
  const report: RiskReport = {
    operatingDay, jobs: tally(), clients: { all: tally(), "exclude-cancelled": tally() },
    differences: { all: [], "exclude-cancelled": [] }, parityUnmatched: 0,
  };
  for (const job of consoleJobs) {
    const risk = riskOf((milestonesByV7Job.get(job.v7JobId) ?? []) as RiskMilestone[], operatingDay);
    jobRisk.set(job.jobId, risk);
    report.jobs[risk] += 1;
  }
  const jobsByClient = new Map<string, ConsoleJob[]>();
  for (const job of consoleJobs) jobsByClient.set(job.clientId, [...(jobsByClient.get(job.clientId) ?? []), job]);
  const clientRisk = (clientJobs: readonly ConsoleJob[], jobSet: ClientRiskJobSet) =>
    worstRisk(clientJobs.filter((job) => clientRiskIncludesJob(job.status, jobSet)).map((job) => jobRisk.get(job.jobId)!));
  // Every imported client, jobs or none: a client with no job is Not set, and v7 shows it as Healthy.
  const clientByLegacy = new Map<string, { clientId: string; jobs: ConsoleJob[] }>();
  for (const client of consoleClients) {
    const clientJobs = jobsByClient.get(client.clientId) ?? [];
    for (const jobSet of ["all", "exclude-cancelled"] as const) report.clients[jobSet][clientRisk(clientJobs, jobSet)] += 1;
    clientByLegacy.set(client.legacyId, { clientId: client.clientId, jobs: clientJobs });
  }
  for (const row of parity ?? []) {
    const v7 = V7_LABEL[text(row.v7_milestone_status) ?? ""] ?? "Healthy";
    const client = clientByLegacy.get(text(row.client_db_id) ?? "");
    if (!client) { report.parityUnmatched += 1; continue; }
    for (const jobSet of ["all", "exclude-cancelled"] as const) {
      const consoleRisk = clientRisk(client.jobs, jobSet);
      if (consoleRisk === v7) continue;
      report.differences[jobSet].push({ clientId: client.clientId, console: consoleRisk, v7, reasons: explain(client.jobs, jobSet, consoleRisk, v7) });
    }
  }
  return report;

  /** Which job and which milestone make the two differ. */
  function explain(clientJobs: readonly ConsoleJob[], jobSet: ClientRiskJobSet, consoleRisk: RiskLevel, v7: RiskLevel): string[] {
    const reasons: string[] = [];
    if (consoleRisk === "Not set" && v7 === "Healthy") return ["no dated milestone on any counted job — v7 shows that as Healthy; the console says Not set (ruled)"];
    for (const job of clientJobs) {
      const excluded = !clientRiskIncludesJob(job.status, jobSet);
      for (const milestone of milestonesByV7Job.get(job.v7JobId) ?? []) {
        const level = milestoneRisk(milestone, operatingDay);
        if (level === v7 && excluded) reasons.push(`${job.jobNumber} (${job.status}, not counted under ${jobSet}): ${milestone.kind} due ${milestone.dueDate}, ${milestone.completedAt ? "completed" : "unfinished"} → ${level}`);
      }
    }
    if (reasons.length === 0) reasons.push("v7 counts a job that is not in the console (added in v7 since the first extract, or out of scope)");
    return reasons;
  }
}
