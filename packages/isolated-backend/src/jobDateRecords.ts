// Addendum B (0238) — reading and recording a job's dates against V7's: the owner of each date and what V7 last said. A leaf
// module (no command imports) so the milestone read, the sync and the command can all use it.
import type { Queryable } from "./postgres";

export type JobDateKey = "start_date" | "reporting_period" | `milestone:${string}`;

type Observation = { observation_no: string; v7_from: string | null; v7_to: string | null };
type Owner = { owner: "console" | "v7"; cause: "edited" | "kept" | "use-v7"; acknowledged_observation_no: string | null };

export async function latestObservation(db: Queryable, org: string, jobId: string, dateKey: string): Promise<Observation | null> {
  return (await db.query<Observation>(
    `SELECT observation_no::text, v7_from::text, v7_to::text FROM nzi_console.job_v7_date_observations
      WHERE organisation_id = $1 AND job_id = $2 AND date_key = $3 ORDER BY observation_no DESC LIMIT 1`, [org, jobId, dateKey])).rows[0] ?? null;
}

export async function currentDateOwner(db: Queryable, org: string, jobId: string, dateKey: string): Promise<Owner | null> {
  return (await db.query<Owner>(
    `SELECT owner, cause, acknowledged_observation_no::text FROM nzi_console.job_date_owners
      WHERE organisation_id = $1 AND job_id = $2 AND date_key = $3 ORDER BY owner_no DESC LIMIT 1`, [org, jobId, dateKey])).rows[0] ?? null;
}

/** Record what V7 says a date is — only when it differs from what V7 last said. */
export async function observeV7Date(db: Queryable, org: string, jobId: string, dateKey: string, from: string | null, to: string | null, runId: string): Promise<void> {
  const last = await latestObservation(db, org, jobId, dateKey);
  if (last && last.v7_from === from && last.v7_to === to) return;
  await db.query(
    `INSERT INTO nzi_console.job_v7_date_observations (organisation_id, job_id, date_key, v7_from, v7_to, run_id) VALUES ($1, $2, $3, $4::date, $5::date, $6)`,
    [org, jobId, dateKey, from, to, runId]);
}

/** One date where the console and V7 disagree, as the job shows it. */
export type JobDateDifference = {
  dateKey: JobDateKey;
  label: string;
  console: { from: string | null; to: string | null };
  v7: { from: string | null; to: string | null };
  observationNo: number;
  /** console = edited here (V7's is held off); v7 = V7's to follow, but the sync could not apply it (an issued job, say). */
  owner: "console" | "v7";
};

const MILESTONE_LABEL = (kind: string) => `${kind.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase())} due`;

/** The job's dates that differ from V7's latest, unless "Keep the console's" already acknowledged that V7 value. */
export async function listJobDateDifferences(db: Queryable, org: string, jobId: string): Promise<JobDateDifference[]> {
  const job = (await db.query<{ start_date: string | null; period_start: string | null; period_end: string | null; source_system: string | null }>(
    `SELECT start_date::text AS start_date, reporting_period_start::text AS period_start, reporting_period_end::text AS period_end, source_system
       FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2`, [org, jobId])).rows[0];
  if (!job || job.source_system === null) return [];
  const milestones = (await db.query<{ kind: string; due_date: string | null }>(
    `SELECT kind, due_date::text AS due_date FROM nzi_console.job_milestones WHERE organisation_id = $1 AND job_id = $2`, [org, jobId])).rows;
  const keys: Array<{ key: JobDateKey; label: string; from: string | null; to: string | null }> = [
    { key: "start_date", label: "Start date", from: job.start_date, to: null },
    { key: "reporting_period", label: "Reporting period", from: job.period_start, to: job.period_end },
    ...milestones.map((m) => ({ key: `milestone:${m.kind}` as JobDateKey, label: MILESTONE_LABEL(m.kind), from: m.due_date, to: null })),
  ];
  const differences: JobDateDifference[] = [];
  for (const entry of keys) {
    const seen = await latestObservation(db, org, jobId, entry.key);
    if (!seen || (seen.v7_from === entry.from && seen.v7_to === entry.to)) continue;
    const owner = await currentDateOwner(db, org, jobId, entry.key);
    if (owner?.cause === "kept" && owner.acknowledged_observation_no === seen.observation_no) continue;
    // A milestone's due date is the console's once edited here (the backfill's own rule: its updated_by is no import run).
    const isMilestone = entry.key.startsWith("milestone:");
    differences.push({ dateKey: entry.key, label: entry.label, console: { from: entry.from, to: entry.to }, v7: { from: seen.v7_from, to: seen.v7_to },
      observationNo: Number(seen.observation_no), owner: owner?.owner === "console" || isMilestone ? "console" : "v7" });
  }
  return differences;
}
