import { randomUUID } from "node:crypto";
import { utcDay, type MilestoneKind } from "@nzi/contracts";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM } from "./v7ClientImport";
import type { V7Row } from "./v7ClientExtract";

/**
 * Link each imported job to its job type and milestone template, and prove the template mapping on real jobs (admin
 * Phase C5, `load:v7-job-links`; ruled plan `admin-phaseC-plan.md` §4.3).
 *
 * **The links** — the A4 pattern, for jobs. v7's `jobs.job_type_id` and `jobs.milestone_template_id` → the console's
 * `job_types` / `milestone_templates` that carry that v7 id (C4). **Exact by v7 id, never guessed; fill-NULL-only**: a
 * link already set is left, and one that differs is a reported conflict, not an overwrite. Each changed job is
 * version-bumped (an open edit form then conflicts) and gets one audit event carrying the run. Neither column is in
 * the client loader's compare set, so its re-run stays "already loaded and identical".
 *
 * **The milestone parity check** — for every imported job with a template and `override_dates = false`, the due dates
 * the console would generate (PR 3's rule: anchor = the later of the start date and the reporting-period start, plus
 * each included item's offset, by kind) against the dates the PR 2 backfill imported from v7's `job_plan`. Agreement by
 * kind proves the first-three → DC / FD / FR mapping before PR 3 generates anything with it. Frozen plans, jobs with
 * no template, no anchor or no plan are counted, not compared.
 *
 * It generates no milestones and changes no `job_milestones` row. One transaction; a dry run is it, rolled back.
 */

export const JOB_LINK_RUN_PREFIX = "v7-job-links-";
export type JobLinkField = "jobType" | "milestoneTemplate";
const LINK_COLUMN: Record<JobLinkField, string> = { jobType: "job_type_id", milestoneTemplate: "milestone_template_id" };

const text = (value: string | null | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : null; };
const flag = (value: string | null | undefined): boolean | null => {
  const v = value?.trim().toLowerCase();
  return v === "t" || v === "true" || v === "1" ? true : v === "f" || v === "false" || v === "0" ? false : null;
};
/** v7's date or timestamp as its calendar day. */
const day = (value: string | null | undefined): string | null => { const raw = text(value); return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null; };
const addDays = (isoDay: string, days: number): string => {
  const [y, m, d] = isoDay.split("-").map(Number) as [number, number, number];
  return utcDay(new Date(Date.UTC(y, m - 1, d + days)));
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// ── The plan (pure) ────────────────────────────────────────────────────────────────────────────────────────────

export type ConsoleJob = {
  jobId: string; legacyDbId: string; jobNumber: string; version: number; startDate: string | null; periodStart: string | null;
  link: Record<JobLinkField, string | null>;
};
export type ConsoleTemplate = { templateId: string; legacyDbId: string | null; name: string; items: Array<{ kind: MilestoneKind; daysOffset: number; included: boolean }> };
export type ImportedMilestone = { jobId: string; kind: MilestoneKind; dueDate: string | null };

export type LinkTally = { filled: number; alreadyLinked: number; conflicts: number; blank: number; notLoaded: number };
export type ParityOutcome = {
  compared: number; frozen: number; noTemplate: number; templateNotLoaded: number; noAnchor: number; noPlan: number;
  byKind: Record<MilestoneKind, { agree: number; differ: number; v7Undated: number }>;
  byTemplate: Array<{ template: string; jobs: number; agree: number; differ: number }>;
  /** The first differences, for a person to read: job number, kind, generated, imported, days apart. */
  differences: Array<{ jobNumber: string; template: string; kind: MilestoneKind; generated: string; imported: string; days: number }>;
  differenceCount: number;
};
export type JobLinkPlan = {
  changes: Array<{ jobId: string; version: number; fills: Partial<Record<JobLinkField, string>> }>;
  tally: Record<JobLinkField, LinkTally>;
  conflicts: Array<{ jobNumber: string; field: JobLinkField; current: string; v7: string }>;
  /** v7 ids the console does not carry (a type or template C4 left out). */
  notLoaded: Record<JobLinkField, Array<{ legacyId: string; jobs: number }>>;
  /** v7 jobs in the extract the console does not have (the client import excluded them). */
  v7JobsNotInConsole: number;
  parity: ParityOutcome;
};

export function planJobLinks(input: {
  v7Jobs: readonly V7Row[]; v7Plans: readonly V7Row[]; consoleJobs: readonly ConsoleJob[];
  jobTypeByLegacy: ReadonlyMap<string, string>; templates: readonly ConsoleTemplate[]; imported: readonly ImportedMilestone[];
}): JobLinkPlan {
  const templateByLegacy = new Map(input.templates.filter((template) => template.legacyDbId).map((template) => [template.legacyDbId!, template]));
  const consoleByLegacy = new Map(input.consoleJobs.map((job) => [job.legacyDbId, job]));
  const planByJob = new Map(input.v7Plans.map((row) => [text(row.job_id) ?? "", row]));
  const importedByJob = new Map<string, Map<MilestoneKind, string | null>>();
  for (const row of input.imported) importedByJob.set(row.jobId, (importedByJob.get(row.jobId) ?? new Map()).set(row.kind, row.dueDate));

  const zeroTally = (): LinkTally => ({ filled: 0, alreadyLinked: 0, conflicts: 0, blank: 0, notLoaded: 0 });
  const plan: JobLinkPlan = {
    changes: [], tally: { jobType: zeroTally(), milestoneTemplate: zeroTally() }, conflicts: [], notLoaded: { jobType: [], milestoneTemplate: [] }, v7JobsNotInConsole: 0,
    parity: { compared: 0, frozen: 0, noTemplate: 0, templateNotLoaded: 0, noAnchor: 0, noPlan: 0,
      byKind: { data_collection: { agree: 0, differ: 0, v7Undated: 0 }, first_draft: { agree: 0, differ: 0, v7Undated: 0 }, final_report: { agree: 0, differ: 0, v7Undated: 0 } },
      byTemplate: [], differences: [], differenceCount: 0 },
  };
  const notLoaded: Record<JobLinkField, Map<string, number>> = { jobType: new Map(), milestoneTemplate: new Map() };
  const byTemplate = new Map<string, { jobs: number; agree: number; differ: number }>();

  for (const v7 of [...input.v7Jobs].sort((a, b) => Number(a.job_id) - Number(b.job_id))) {
    const job = consoleByLegacy.get(text(v7.job_id) ?? "");
    if (!job) { plan.v7JobsNotInConsole += 1; continue; }

    // ── Links: exact by v7 id, fill-NULL-only ──
    const fills: Partial<Record<JobLinkField, string>> = {};
    const wanted: Record<JobLinkField, { legacy: string | null; target: string | null }> = {
      jobType: { legacy: text(v7.job_type_id), target: null },
      milestoneTemplate: { legacy: text(v7.milestone_template_id), target: null },
    };
    wanted.jobType.target = wanted.jobType.legacy ? input.jobTypeByLegacy.get(wanted.jobType.legacy) ?? null : null;
    wanted.milestoneTemplate.target = wanted.milestoneTemplate.legacy ? templateByLegacy.get(wanted.milestoneTemplate.legacy)?.templateId ?? null : null;
    for (const field of ["jobType", "milestoneTemplate"] as const) {
      const tally = plan.tally[field];
      const { legacy, target } = wanted[field];
      const current = job.link[field];
      if (!legacy) { if (current) tally.alreadyLinked += 1; else tally.blank += 1; continue; }
      if (!target) { tally.notLoaded += 1; notLoaded[field].set(legacy, (notLoaded[field].get(legacy) ?? 0) + 1); continue; }
      if (current === target) { tally.alreadyLinked += 1; continue; }
      if (current) { tally.conflicts += 1; plan.conflicts.push({ jobNumber: job.jobNumber, field, current, v7: target }); continue; }
      fills[field] = target;
      tally.filled += 1;
    }
    if (Object.keys(fills).length) plan.changes.push({ jobId: job.jobId, version: job.version, fills });

    // ── Parity: what PR 3 would generate, against what v7 dated ──
    const v7Plan = planByJob.get(text(v7.job_id) ?? "");
    const templateLegacy = wanted.milestoneTemplate.legacy;
    if (v7Plan && flag(v7Plan.override_dates) === true) { plan.parity.frozen += 1; continue; }
    if (!templateLegacy) { plan.parity.noTemplate += 1; continue; }
    const template = templateByLegacy.get(templateLegacy);
    if (!template) { plan.parity.templateNotLoaded += 1; continue; }
    const anchor = [day(v7.start_date) ?? job.startDate, day(v7.reporting_period_start) ?? job.periodStart].filter((value): value is string => !!value).sort().at(-1);
    if (!anchor) { plan.parity.noAnchor += 1; continue; }
    if (!v7Plan) { plan.parity.noPlan += 1; continue; }
    plan.parity.compared += 1;
    const stats = byTemplate.get(template.name) ?? { jobs: 0, agree: 0, differ: 0 };
    stats.jobs += 1;
    const imported = importedByJob.get(job.jobId);
    for (const item of template.items.filter((candidate) => candidate.included)) {
      const kindStats = plan.parity.byKind[item.kind];
      const importedDue = imported?.get(item.kind) ?? null;
      if (!importedDue) { kindStats.v7Undated += 1; continue; }
      const generated = addDays(anchor, item.daysOffset);
      if (generated === importedDue) { kindStats.agree += 1; stats.agree += 1; continue; }
      kindStats.differ += 1; stats.differ += 1;
      plan.parity.differenceCount += 1;
      if (plan.parity.differences.length < 25) {
        plan.parity.differences.push({ jobNumber: job.jobNumber, template: template.name, kind: item.kind, generated, imported: importedDue, days: daysBetween(generated, importedDue) });
      }
    }
    byTemplate.set(template.name, stats);
  }
  for (const field of ["jobType", "milestoneTemplate"] as const) {
    plan.notLoaded[field] = [...notLoaded[field]].map(([legacyId, jobs]) => ({ legacyId, jobs })).sort((a, b) => b.jobs - a.jobs);
  }
  plan.parity.byTemplate = [...byTemplate].map(([template, stats]) => ({ template, ...stats })).sort((a, b) => b.jobs - a.jobs);
  return plan;
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────────────────────

class DryRunRollback extends Error {}
export type JobLinkOutcome = JobLinkPlan & { committed: boolean; runId: string; jobsInScope: number; jobsChanged: number };

export async function loadV7JobLinks(pool: PoolLike, organisationId: string, extract: { jobs: readonly V7Row[]; job_plan: readonly V7Row[] },
  options: { commit: boolean; runId?: string }): Promise<JobLinkOutcome> {
  const runId = options.runId ?? `${JOB_LINK_RUN_PREFIX}${randomUUID()}`;
  let outcome: JobLinkOutcome | null = null;
  try {
    await withTenantWrite(pool, organisationId, async (db) => {
      outcome = await linkJobs(db, organisationId, extract, runId, options.commit);
      if (!options.commit) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return outcome!;
}

async function linkJobs(db: Queryable, org: string, extract: { jobs: readonly V7Row[]; job_plan: readonly V7Row[] }, runId: string, commit: boolean): Promise<JobLinkOutcome> {
  const jobs = (await db.query<{ job_id: string; legacy_db_id: string; job_number: string; version: number; start_date: string | null; period_start: string | null; job_type_id: string | null; milestone_template_id: string | null }>(
    `SELECT job_id, legacy_db_id, job_number, version, start_date::text AS start_date, reporting_period_start::text AS period_start, job_type_id, milestone_template_id
       FROM nzi_console.jobs WHERE organisation_id = $1 AND source_system = $2 ORDER BY job_id FOR UPDATE`, [org, SOURCE_SYSTEM])).rows;
  const types = (await db.query<{ job_type_id: string; legacy_db_id: string }>(
    `SELECT job_type_id, legacy_db_id FROM nzi_console.job_types WHERE organisation_id = $1 AND source_system = $2`, [org, SOURCE_SYSTEM])).rows;
  const templates = (await db.query<{ template_id: string; legacy_db_id: string | null; name: string; items: ConsoleTemplate["items"] }>(
    `SELECT t.template_id, t.legacy_db_id, t.name,
            coalesce((SELECT json_agg(json_build_object('kind', i.kind, 'daysOffset', i.days_offset, 'included', i.included))
                        FROM nzi_console.milestone_template_items i WHERE (i.organisation_id, i.template_id) = (t.organisation_id, t.template_id)), '[]'::json) AS items
       FROM nzi_console.milestone_templates t WHERE t.organisation_id = $1`, [org])).rows;
  const imported = (await db.query<{ job_id: string; kind: MilestoneKind; due_date: string | null }>(
    `SELECT m.job_id, m.kind, m.due_date::text AS due_date FROM nzi_console.job_milestones m
       JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (m.organisation_id, m.job_id)
      WHERE m.organisation_id = $1 AND j.source_system = $2`, [org, SOURCE_SYSTEM])).rows;

  const plan = planJobLinks({
    v7Jobs: extract.jobs, v7Plans: extract.job_plan,
    consoleJobs: jobs.map((row) => ({ jobId: row.job_id, legacyDbId: row.legacy_db_id, jobNumber: row.job_number, version: row.version, startDate: row.start_date, periodStart: row.period_start,
      link: { jobType: row.job_type_id, milestoneTemplate: row.milestone_template_id } })),
    jobTypeByLegacy: new Map(types.map((row) => [row.legacy_db_id, row.job_type_id])),
    templates: templates.map((row) => ({ templateId: row.template_id, legacyDbId: row.legacy_db_id, name: row.name, items: row.items })),
    imported: imported.map((row) => ({ jobId: row.job_id, kind: row.kind, dueDate: row.due_date })),
  });

  for (const change of plan.changes) {
    const fields = Object.keys(change.fills) as JobLinkField[];
    // Fill-NULL-only again at the row: the version guard and IS NULL make a concurrent edit a failed run, never an overwrite.
    const sets = fields.map((field, index) => `${LINK_COLUMN[field]} = $${index + 4}`).join(", ");
    const guards = fields.map((field) => `${LINK_COLUMN[field]} IS NULL`).join(" AND ");
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.jobs SET ${sets}, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND job_id = $2 AND version = $3 AND ${guards} RETURNING version`,
      [org, change.jobId, change.version, ...fields.map((field) => change.fills[field])]);
    if (!saved) throw new Error(`job ${change.jobId} changed while the run held it; nothing was written.`);
    const before = Object.fromEntries(fields.map((field) => [LINK_COLUMN[field], null]));
    const after = Object.fromEntries(fields.map((field) => [LINK_COLUMN[field], change.fills[field]]));
    await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id, audit_event_id, actor_id, principal_type, action, entity_type, entity_id, correlation_id, reason, before_json, after_json, client_id)
       SELECT $1, $2, $3, 'system', 'job.links.backfilled', 'job', $4, $5, $6, $7::jsonb, $8::jsonb, j.client_id FROM nzi_console.jobs j WHERE j.organisation_id = $1 AND j.job_id = $4`,
      [org, randomUUID(), IMPORT_ACTOR, change.jobId, runId, "Job links filled from v7 by exact id (admin C5)",
        JSON.stringify({ ...before, version: change.version }), JSON.stringify({ ...after, version: saved.version, run: runId, sourceSystem: SOURCE_SYSTEM })]);
  }
  return { ...plan, committed: commit, runId, jobsInScope: jobs.length, jobsChanged: plan.changes.length };
}
