import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticHeaders, syntheticRows } from "./support/v7SyntheticExtract";
import { planV7ClientImport } from "../src/v7ClientImport";
import { loadV7ClientPlan } from "../src/v7ClientLoad";
import { loadV7JobsConfig, planV7JobsConfig } from "../src/v7JobsConfigLoad";
import { JOB_LINK_RUN_PREFIX, loadV7JobLinks, planJobLinks, type ConsoleJob, type ConsoleTemplate } from "../src/v7JobLinkLoad";
import { loadV7Milestones, planV7Milestones } from "../src/v7MilestoneLoad";
import type { V7Row } from "../src/v7ClientExtract";

/**
 * The v7 job-link backfill and the milestone parity check (admin Phase C5): each imported job's type and template
 * linked by exact v7 id, fill-NULL-only, conflicts reported, version bump and one audit event per job; and PR 3's
 * generation (anchor + each included item's offset, by kind) compared with the dates imported from v7 — frozen plans,
 * no template, no anchor and no plan counted, not compared. It changes no milestone.
 */
type Rows = ReturnType<typeof syntheticRows>;
// Job 100 on template 1 (Standard CRP: 14 / 35 / 56), anchored 2024-01-05 (its start; its period starts 2023-01-01):
// v7's plan agrees with the template except the final report, moved by hand three days later. Job 106 on template 1
// with a frozen plan. Job 101 on template 2, with no start date or period — no anchor.
const rows = (): Rows => {
  const r = syntheticRows();
  Object.assign(r.job_plan[0]!, { data_collection_due: "2024-01-19", first_draft_due: "2024-02-09", final_report_due: "2024-03-04", override_dates: "f" });
  r.job_plan.push({ job_id: "106", data_collection_due: "2025-01-01", first_draft_due: null, final_report_due: null,
    data_collection_completed_at: null, first_draft_completed_at: null, final_report_completed_at: null, override_dates: "t" });
  r.jobs.find((job) => job.job_id === "106")!.milestone_template_id = "1";
  r.jobs.find((job) => job.job_id === "101")!.milestone_template_id = "2";
  return r;
};

describe("planning the job links and the parity (no database)", () => {
  const job = (legacy: string, link: Partial<ConsoleJob["link"]> = {}, start: string | null = "2024-01-01"): ConsoleJob =>
    ({ jobId: `j${legacy}`, legacyDbId: legacy, jobNumber: `J${legacy.padStart(6, "0")}`, version: 1, startDate: start, periodStart: null, link: { jobType: null, milestoneTemplate: null, ...link } });
  const template: ConsoleTemplate = { templateId: "mt:a", legacyDbId: "1", name: "A", items: [
    { kind: "data_collection", daysOffset: 10, included: true }, { kind: "first_draft", daysOffset: 20, included: false }, { kind: "final_report", daysOffset: 30, included: true }] };
  const v7 = (id: string, type: string | null, tmpl: string | null, extra: Partial<V7Row> = {}): V7Row => ({ job_id: id, job_type_id: type, milestone_template_id: tmpl, ...extra });

  it("fills only empty links, exactly by v7 id; reports a conflict, a blank, and a v7 id not loaded", () => {
    const plan = planJobLinks({
      v7Jobs: [v7("1", "10", "1"), v7("2", "10", null), v7("3", "99", "1"), v7("4", "10", "1"), v7("5", "10", "1")],
      v7Plans: [], templates: [template], imported: [], jobTypeByLegacy: new Map([["10", "jt:x"]]),
      consoleJobs: [job("1"), job("2"), job("3"), job("4", { jobType: "jt:other" }), job("9")],
    });
    assert.deepEqual(plan.changes.map((change) => [change.jobId, change.fills]), [["j1", { jobType: "jt:x", milestoneTemplate: "mt:a" }], ["j2", { jobType: "jt:x" }], ["j3", { milestoneTemplate: "mt:a" }], ["j4", { milestoneTemplate: "mt:a" }]]);
    assert.deepEqual(plan.conflicts, [{ jobNumber: "J000004", field: "jobType", current: "jt:other", v7: "jt:x" }]);
    assert.deepEqual([plan.tally.milestoneTemplate.blank, plan.tally.jobType.notLoaded, plan.notLoaded.jobType, plan.v7JobsNotInConsole], [1, 1, [{ legacyId: "99", jobs: 1 }], 1]);
  });

  it("generates only included items, anchored on the later of start and period start, and compares by kind", () => {
    const plan = planJobLinks({
      v7Jobs: [v7("1", null, "1", { start_date: "2024-01-01", reporting_period_start: "2024-02-01" })],
      v7Plans: [{ job_id: "1", override_dates: "f" }], templates: [template], jobTypeByLegacy: new Map(), consoleJobs: [job("1")],
      imported: [{ jobId: "j1", kind: "data_collection", dueDate: "2024-02-11" }, { jobId: "j1", kind: "first_draft", dueDate: "2024-02-21" }, { jobId: "j1", kind: "final_report", dueDate: "2024-03-05" }],
    });
    assert.equal(plan.parity.compared, 1);
    assert.deepEqual(plan.parity.byKind.data_collection, { agree: 1, differ: 0, v7Undated: 0 }, "anchor 2024-02-01 + 10");
    assert.deepEqual(plan.parity.byKind.first_draft, { agree: 0, differ: 0, v7Undated: 0 }, "not included — never generated, never compared");
    assert.deepEqual(plan.parity.differences, [{ jobNumber: "J000001", template: "A", kind: "final_report", generated: "2024-03-02", imported: "2024-03-05", days: 3 }]);
  });
});

describe("the job-link backfill and parity, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = [ORG]) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const clientPlan = () => planV7ClientImport({ extract: syntheticExtract(rows()), headers: syntheticHeaders(), extractSha256: "synthetic-sha" });
  const extract = () => { const e = syntheticExtract(rows()); return { jobs: e.jobs, job_plan: e.job_plan }; };

  before(async () => {
    database = (await createDisposableDatabase("joblinks"))!;
    await loadV7ClientPlan(database.pool, clientPlan(), { commit: true, runId: "clients-1" });
    await loadV7Milestones(database.pool, ORG, planV7Milestones(syntheticExtract(rows()).job_plan), { commit: true });
    await loadV7JobsConfig(database.pool, ORG, planV7JobsConfig(syntheticExtract(rows())), { commit: true });
  });
  after(async () => { await database?.end(); });

  it("a dry run reports the links and the parity, and keeps nothing", async () => {
    const outcome = await loadV7JobLinks(database.pool, ORG, extract(), { commit: false });
    assert.equal(outcome.jobsInScope, 6);
    assert.deepEqual([outcome.tally.jobType.filled, outcome.tally.milestoneTemplate.filled, outcome.tally.milestoneTemplate.blank], [6, 3, 3]);
    const p = outcome.parity;
    assert.deepEqual([p.compared, p.frozen, p.noAnchor], [1, 1, 1]);
    assert.deepEqual([p.byKind.data_collection.agree, p.byKind.first_draft.agree, p.byKind.final_report.differ], [1, 1, 1]);
    assert.deepEqual(p.differences, [{ jobNumber: "J000612", template: "Standard CRP", kind: "final_report", generated: "2024-03-01", imported: "2024-03-04", days: 3 }]);
    assert.deepEqual(await q(`SELECT job_id FROM nzi_console.jobs WHERE organisation_id = $1 AND (job_type_id IS NOT NULL OR milestone_template_id IS NOT NULL)`), []);
  });

  it("commits: fills the links, bumps each job's version, one audit event per job — and changes no milestone", async () => {
    const before = await q(`SELECT job_id, kind, due_date::text, version FROM nzi_console.job_milestones WHERE organisation_id = $1 ORDER BY 1, 2`);
    const outcome = await loadV7JobLinks(database.pool, ORG, extract(), { commit: true, runId: `${JOB_LINK_RUN_PREFIX}first` });
    assert.equal(outcome.jobsChanged, 6);
    const job100 = (await q(`SELECT job_type_id, milestone_template_id, version FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = 'v7-job-100'`))[0];
    assert.deepEqual(job100, { job_type_id: "job-type:v7-1", milestone_template_id: "milestone-template:v7-1", version: 2 });
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'job.links.backfilled' AND correlation_id = $2`, [ORG, `${JOB_LINK_RUN_PREFIX}first`]))[0].n, 6);
    assert.deepEqual(await q(`SELECT job_id, kind, due_date::text, version FROM nzi_console.job_milestones WHERE organisation_id = $1 ORDER BY 1, 2`), before);
  });

  it("is idempotent, reports a conflict rather than overwrite, and leaves the client loader's re-run identical", async () => {
    const again = await loadV7JobLinks(database.pool, ORG, extract(), { commit: true });
    assert.deepEqual([again.jobsChanged, again.tally.jobType.alreadyLinked], [0, 6]);
    await q(`UPDATE nzi_console.jobs SET job_type_id = 'job-type:v7-2' WHERE organisation_id = $1 AND job_id = 'v7-job-100'`);
    const refused = await loadV7JobLinks(database.pool, ORG, extract(), { commit: true });
    assert.deepEqual(refused.conflicts, [{ jobNumber: "J000612", field: "jobType", current: "job-type:v7-2", v7: "job-type:v7-1" }]);
    assert.equal((await q(`SELECT job_type_id FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = 'v7-job-100'`))[0].job_type_id, "job-type:v7-2", "not overwritten");
    const reloaded = await loadV7ClientPlan(database.pool, clientPlan(), { commit: true, runId: "clients-2" });
    assert.ok(reloaded.clients.every((client) => client.state === "unchanged" && client.refusal === undefined), "the job links are not in the client loader's compare set");
  });
});
