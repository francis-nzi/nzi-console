import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { withTenantRead } from "../src/postgres";
import type { V7Row } from "../src/v7ClientExtract";
import {
  loadV7Milestones, MILESTONE_RUN_PREFIX, milestoneRiskReport, planV7Milestones, readConsoleClients, readConsoleJobs, resolveCompletedBy,
} from "../src/v7MilestoneLoad";

/**
 * The milestone backfill (docs/LIST_PARITY_DESIGN.md, PR 2): v7's job_plan → job_milestones for imported jobs.
 * Planning is pure and tested without a database; loading runs against a real one, as the application role, one
 * transaction per client — the rulings R3 (re-run semantics), R4 (who completed it) and A2 (dirty data) held to.
 */

const ORG = "ms-org-a";
const OTHER = "ms-org-b";
const TODAY = "2026-09-29";

/** v7's job_plan as the extract writes it: every column present, NULL where v7 has nothing. */
const plan = (...rows: Array<Record<string, string | null>>): V7Row[] => rows.map((row) => ({
  data_collection_due: null, first_draft_due: null, final_report_due: null,
  data_collection_completed_at: null, first_draft_completed_at: null, final_report_completed_at: null,
  data_collection_completed_by: null, first_draft_completed_by: null, final_report_completed_by: null, updated_at: null, ...row,
}));
const BASE = plan(
  { job_id: "100", data_collection_due: "2023-03-01", data_collection_completed_at: "2023-02-27 09:00:00", data_collection_completed_by: "Ada Example",
    first_draft_due: "2023-06-01", first_draft_completed_at: "2023-05-30 16:30:00.25", first_draft_completed_by: "ada@EXAMPLE.test" },
  // The dirty case (A2): "completed by" with no completion. The due date stays; the label goes.
  { job_id: "101", data_collection_due: "2026-09-20", first_draft_due: "2026-11-01", first_draft_completed_by: "Ada Example" },
  { job_id: "103", final_report_due: "2025-01-01", final_report_completed_by: null },
  { job_id: "999", data_collection_due: "2026-10-01" },
);

describe("planning the backfill from job_plan (no database)", () => {
  const planned = planV7Milestones(BASE);

  it("makes one milestone per kind v7 recorded anything for, with its v7 identity", () => {
    const job100 = planned.jobs.find((job) => job.v7JobId === "100")!;
    assert.deepEqual(job100.milestones.map((m) => [m.kind, m.legacyDbId]), [["data_collection", "100:data_collection"], ["first_draft", "100:first_draft"]]);
    assert.equal(job100.milestones[1]!.completedAt, "2023-05-30T16:30:00.250Z", "v7's zone-less timestamp read as UTC (Render's clock)");
  });

  it("drops a 'completed by' with no completion and counts it, keeping the due date (A2)", () => {
    assert.equal(planned.labelsDropped, 1);
    const draft = planned.jobs.find((job) => job.v7JobId === "101")!.milestones.find((m) => m.kind === "first_draft")!;
    assert.deepEqual([draft.dueDate, draft.completedAt, draft.completedByLabel], ["2026-11-01", null, null]);
    assert.equal(draft.legacyValues.completedBy, "Ada Example", "the v7 value is still what a re-run compares");
  });

  it("counts by kind — dated, completed, completed with no due date", () => {
    assert.deepEqual(planned.byKind.data_collection, { dated: 3, completed: 1, undatedCompleted: 0 });
    assert.deepEqual(planned.byKind.first_draft, { dated: 2, completed: 1, undatedCompleted: 0 });
  });

  it("names a row it cannot read, and leaves its job out rather than guessing", () => {
    const bad = planV7Milestones(plan({ job_id: "7", data_collection_due: "2023-02-30" }, { job_id: "8", first_draft_completed_at: "soon" }));
    assert.deepEqual(bad.unreadable, [{ v7JobId: "7", reason: "data_collection due date is not a date" }, { v7JobId: "8", reason: "first_draft completion is not a timestamp" }]);
    assert.deepEqual(bad.jobs, []);
  });
});

describe("who completed it (R4): an exact, unique match, or nobody", () => {
  const members = [
    { userId: "ada", displayName: "Ada Example", email: "ada@example.test" },
    { userId: "twin-1", displayName: "Sam Twin", email: null },
    { userId: "twin-2", displayName: "Sam Twin", email: null },
  ];
  it("matches the display name exactly, and the email ignoring case", () => {
    assert.equal(resolveCompletedBy("Ada Example", members), "ada");
    assert.equal(resolveCompletedBy("ADA@example.TEST", members), "ada");
  });
  it("never guesses: a near-miss, an ambiguous name and nothing all resolve to nobody", () => {
    assert.equal(resolveCompletedBy("ada example", members), null, "a display name is matched exactly");
    assert.equal(resolveCompletedBy("Sam Twin", members), null, "two people share it");
    assert.equal(resolveCompletedBy(null, members), null);
  });
});

describe("the milestone backfill, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const count = async (org: string) => {
    const admin = await database.admin();
    try { return Number((await admin.query(`SELECT count(*) FROM nzi_console.job_milestones WHERE organisation_id = $1`, [org])).rows[0].count); }
    finally { await admin.end(); }
  };
  const row = async (jobId: string, kind: string) => {
    const admin = await database.admin();
    try { return (await admin.query(`SELECT * FROM nzi_console.job_milestones WHERE organisation_id = $1 AND job_id = $2 AND kind = $3`, [ORG, jobId, kind])).rows[0]; }
    finally { await admin.end(); }
  };

  before(async () => {
    database = (await createDisposableDatabase("milestoneload"))!;
    const db = await database.admin();
    let sequence = 1;
    try {
      for (const org of [ORG, OTHER]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES ($1, 'ada', 'consultant', 'active', 'Ada Example', 'ada@example.test')`, [org]);
      }
      const client = (org: string, id: string, legacy: string) => db.query(
        `INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, source_system, legacy_db_id) VALUES ($1, $2, $2, 'active', 'nzi-pro-v7', $3)`, [org, id, legacy]);
      const job = (org: string, id: string, clientId: string, legacy: string | null, status: string) => db.query(
        `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, source_system, legacy_db_id)
         VALUES ($1, $2, $3, $4, 'crp', $2, $5, 'Setup', $6, $7)`, [org, id, clientId, sequence++, status, legacy ? "nzi-pro-v7" : null, legacy]);
      await client(ORG, "c1", "1"); await client(ORG, "c2", "2"); await client(ORG, "c3", "3");
      await job(ORG, "j100", "c1", "100", "complete");
      await job(ORG, "j101", "c1", "101", "open");
      await job(ORG, "j103", "c2", "103", "cancelled");
      await job(ORG, "j-local", "c2", null, "open");
      // Another organisation holding the very same v7 ids: the backfill into ORG must never reach it.
      await client(OTHER, "o1", "1");
      await job(OTHER, "o100", "o1", "100", "open");
    } finally {
      await db.end();
    }
  });
  after(async () => { await database?.end(); });

  it("a dry run exercises every write and keeps none", async () => {
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(BASE), { commit: false });
    assert.deepEqual([outcome.committed, outcome.inserted, outcome.updated], [false, 5, 0]);
    assert.equal(await count(ORG), 0);
  });

  it("commits: provenance on every row, the label as v7 wrote it, the user only on a unique match, one audit event per client", async () => {
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(BASE), { commit: true, runId: `${MILESTONE_RUN_PREFIX}first` });
    assert.deepEqual([outcome.inserted, outcome.updated, outcome.unchanged, outcome.conflicts.length], [5, 0, 0, 0]);
    assert.deepEqual(outcome.unmatchedV7JobIds, ["999"], "a job not in the console is reported, never created");
    assert.deepEqual(outcome.completedBy, { labelled: 2, distinct: 2, matched: 2 }, "counts only — never the names");
    const collected = await row("j100", "data_collection");
    assert.equal(collected.source_system, "nzi-pro-v7");
    assert.equal(collected.legacy_db_id, "100:data_collection");
    assert.equal(collected.updated_by, `${MILESTONE_RUN_PREFIX}first`);
    assert.deepEqual([collected.completed_by_label, collected.completed_by_user_id], ["Ada Example", "ada"]);
    const draft = await row("j101", "first_draft");
    assert.deepEqual([draft.completed_at, draft.completed_by_label], [null, null], "A2: the label with no completion was dropped");
    const admin = await database.admin();
    try {
      const audits = (await admin.query(`SELECT client_id, action FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'milestones.imported' ORDER BY client_id`, [ORG])).rows;
      assert.deepEqual(audits, [{ client_id: "c1", action: "milestones.imported" }, { client_id: "c2", action: "milestones.imported" }]);
    } finally { await admin.end(); }
  });

  it("never touches another organisation holding the same v7 ids", async () => {
    assert.equal(await count(OTHER), 0);
  });

  it("is idempotent: the same extract again writes nothing", async () => {
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(BASE), { commit: true });
    assert.deepEqual([outcome.inserted, outcome.updated, outcome.unchanged, outcome.conflicts.length], [0, 0, 5, 0]);
  });

  it("R3: v7 wins where the console has not touched the row", async () => {
    const changed = plan(...BASE.map((r) => r.job_id === "101" ? { ...r, data_collection_completed_at: "2026-09-25 10:00:00", data_collection_completed_by: "Ada Example" } : r) as Array<Record<string, string | null>>);
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(changed), { commit: true, runId: `${MILESTONE_RUN_PREFIX}second` });
    assert.deepEqual([outcome.inserted, outcome.updated, outcome.conflicts.length], [0, 1, 0]);
    const updated = await row("j101", "data_collection");
    assert.deepEqual([updated.version, updated.updated_by, updated.completed_by_user_id], [2, `${MILESTONE_RUN_PREFIX}second`, "ada"]);
    assert.equal(updated.legacy_values.completedAt, "2026-09-25 10:00:00");
  });

  it("R3: a console edit stands while v7 is unchanged", async () => {
    const admin = await database.admin();
    try { await admin.query(`UPDATE nzi_console.job_milestones SET due_date = '2026-12-01', updated_by = 'user:ada' WHERE organisation_id = $1 AND job_id = 'j101' AND kind = 'first_draft'`, [ORG]); }
    finally { await admin.end(); }
    const current = plan(...BASE.map((r) => r.job_id === "101" ? { ...r, data_collection_completed_at: "2026-09-25 10:00:00", data_collection_completed_by: "Ada Example" } : r) as Array<Record<string, string | null>>);
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(current), { commit: true });
    assert.deepEqual([outcome.updated, outcome.conflicts.length], [0, 0]);
    assert.equal((await row("j101", "first_draft")).updated_by, "user:ada");
  });

  it("R3: changed on both sides refuses the whole job, by job and kind — and the other jobs go ahead", async () => {
    const both = plan(...BASE.map((r) => r.job_id === "101"
      ? { ...r, data_collection_completed_at: null, data_collection_completed_by: null, first_draft_due: "2026-11-15" }
      : r.job_id === "100" ? { ...r, final_report_due: "2023-09-01" } : r) as Array<Record<string, string | null>>);
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(both), { commit: true });
    assert.deepEqual(outcome.conflicts.map((c) => [c.jobNumber, c.kind]), [["J000002", "first_draft"]]);
    assert.match(outcome.conflicts[0]!.reason, /changed in v7 since the last load, and edited in the console since/);
    assert.equal((await row("j101", "data_collection")).legacy_values.completedAt, "2026-09-25 10:00:00", "nothing of the refused job was written");
    assert.equal((await row("j100", "final_report")).due_date instanceof Date, true, "job 100's new milestone was");
  });

  it("R3: a milestone made in the console, which v7 also records, is refused and reported", async () => {
    const admin = await database.admin();
    try { await admin.query(`INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, updated_by, due_source) VALUES ($1, 'j103', 'data_collection', '2026-10-10', 'user:ada', 'manual')`, [ORG]); }
    finally { await admin.end(); }
    const more = plan(...BASE.map((r) => r.job_id === "103" ? { ...r, data_collection_due: "2026-10-12" } : r) as Array<Record<string, string | null>>);
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(more), { commit: false });
    assert.ok(outcome.conflicts.some((c) => c.jobNumber === "J000003" && c.kind === "data_collection" && /made in the console/.test(c.reason)));
  });

  it("refuses a run id that would not be recognised as a backfill's on the next run", async () => {
    await assert.rejects(loadV7Milestones(database.pool, ORG, planV7Milestones(BASE), { commit: false, runId: "whatever" }), /must start v7-milestones-/);
  });

  it("reports Risk under both job sets, and every client that differs from v7's own label, with the job and milestone behind it", async () => {
    const { clients, jobs } = await withTenantRead(database.pool, ORG, async (db) => ({ clients: await readConsoleClients(db), jobs: await readConsoleJobs(db) }));
    const parity = [
      { client_db_id: "1", operating_day: TODAY, v7_milestone_status: "red" },
      { client_db_id: "2", operating_day: TODAY, v7_milestone_status: "red" },
      { client_db_id: "3", operating_day: TODAY, v7_milestone_status: "green" },
      { client_db_id: "77", operating_day: TODAY, v7_milestone_status: "green" },
    ];
    const report = milestoneRiskReport(planV7Milestones(BASE), clients, jobs, parity, TODAY);
    assert.deepEqual(report.jobs, { Overdue: 2, Due: 0, Healthy: 1, "Not set": 0 }, "101 and 103 overdue; 100 all done");
    assert.deepEqual(report.clients.all, { Overdue: 2, Due: 0, Healthy: 0, "Not set": 1 });
    assert.deepEqual(report.clients["exclude-cancelled"], { Overdue: 1, Due: 0, Healthy: 0, "Not set": 2 });
    assert.equal(report.parityUnmatched, 1);
    // (a) differs only where the console says Not set and v7 Healthy — the ruled difference.
    assert.deepEqual(report.differences.all.map((d) => [d.clientId, d.console, d.v7]), [["c3", "Not set", "Healthy"]]);
    // (b) also differs where a cancelled job carried v7's label — named, with its milestone.
    const c2 = report.differences["exclude-cancelled"].find((d) => d.clientId === "c2")!;
    assert.deepEqual([c2.console, c2.v7], ["Not set", "Overdue"]);
    assert.deepEqual(c2.reasons, ["J000003 (cancelled, not counted under exclude-cancelled): final_report due 2025-01-01, unfinished → Overdue"]);
  });
});
