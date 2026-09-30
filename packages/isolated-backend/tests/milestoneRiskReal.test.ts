import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { clientListSpec, defaultListQuery, jobListSpec, RISK_LEVELS, type ClientListQuery, type JobListQuery, type RiskLevel } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listClients, listJobs } from "../src/listReads";
import { clientRiskRankSql, riskLabelSql, riskOf, type RiskMilestone } from "../src/milestoneRisk";
import { withTenantRead, withTenantWrite } from "../src/postgres";

/**
 * Milestone Risk against a real database (docs/LIST_PARITY_DESIGN.md, PR 2): the rule at every boundary, in SQL and in
 * TypeScript over the same rows; the client roll-up; tenant isolation on `job_milestones` and its facet; and Risk in
 * the shared lists. The operating day is fixed and passed in, as the routes pass `todayInLondon()`.
 */

const ORG_A = "risk-org-a";
const ORG_B = "risk-org-b";
const TODAY = "2026-09-29";
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

/** The ruled boundary table: due relative to the operating day, unfinished and completed. */
const BOUNDARIES: Array<[number, RiskLevel, RiskLevel]> = [
  [-2, "Overdue", "Healthy"], [-1, "Due", "Healthy"], [0, "Due", "Healthy"], [7, "Due", "Healthy"], [8, "Healthy", "Healthy"],
];

const jobQuery = (change: Partial<JobListQuery> = {}): JobListQuery => ({ ...defaultListQuery(jobListSpec), pageSize: 200, ...change });
const clientQuery = (change: Partial<ClientListQuery> = {}): ClientListQuery => ({ ...defaultListQuery(clientListSpec), pageSize: 200, ...change });

describe("milestone Risk, read from the database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const jobsIn = (org: string, query: JobListQuery, today = TODAY) => withTenantRead(database.pool, org, (db) => listJobs(db, query, { today }));
  const clientsIn = (org: string, query: ClientListQuery) => withTenantRead(database.pool, org, (db) => listClients(db, query, { today: TODAY }));
  const riskByJob = async (org: string, query: JobListQuery, today = TODAY) =>
    Object.fromEntries((await jobsIn(org, query, today)).rows.map((row) => [row.id, row.risk]));

  before(async () => {
    database = (await createDisposableDatabase("milestonerisk"))!;
    const db = await database.admin();
    let sequence = 1;
    const client = (org: string, id: string, name: string) =>
      db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, $3, 'active')`, [org, id, name]);
    const job = (org: string, id: string, clientId: string, status = "open") =>
      db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, due_date)
        VALUES ($1, $2, $3, $4, 'crp', $2, $5, 'Setup', '2030-01-01')`, [org, id, clientId, sequence++, status]);
    const milestone = (org: string, jobId: string, kind: string, due: string | null, completed: boolean) =>
      db.query(`INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, completed_at, updated_by, due_source)
        VALUES ($1, $2, $3, $4::date, CASE WHEN $5 THEN now() END, 'seed', 'manual')`, [org, jobId, kind, due, completed]);
    try {
      for (const org of [ORG_A, ORG_B]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
      }
      // The boundary table: one job per case.
      await client(ORG_A, "a-bound", "Boundary Ltd");
      for (const [offset] of BOUNDARIES) {
        for (const done of [false, true]) {
          const id = `b${offset}${done ? "c" : "u"}`;
          await job(ORG_A, id, "a-bound");
          await milestone(ORG_A, id, "data_collection", addDays(TODAY, offset), done);
        }
      }
      await job(ORG_A, "b-undated", "a-bound"); await milestone(ORG_A, "b-undated", "final_report", null, true);
      await job(ORG_A, "b-none", "a-bound");
      await job(ORG_A, "b-worst", "a-bound");
      await milestone(ORG_A, "b-worst", "data_collection", addDays(TODAY, -5), false);
      await milestone(ORG_A, "b-worst", "first_draft", addDays(TODAY, 20), false);
      // The client roll-up.
      await client(ORG_A, "a-cancel", "Cancelled Overdue Ltd");
      await job(ORG_A, "c-open", "a-cancel"); await milestone(ORG_A, "c-open", "data_collection", addDays(TODAY, 30), false);
      await job(ORG_A, "c-cancelled", "a-cancel", "cancelled"); await milestone(ORG_A, "c-cancelled", "final_report", addDays(TODAY, -10), false);
      await client(ORG_A, "a-mix", "Healthy And Unset Ltd");
      await job(ORG_A, "m-healthy", "a-mix"); await milestone(ORG_A, "m-healthy", "first_draft", addDays(TODAY, 30), false);
      await job(ORG_A, "m-none", "a-mix");
      await client(ORG_A, "a-notset", "Nothing Dated Ltd");
      await job(ORG_A, "n-1", "a-notset"); await job(ORG_A, "n-2", "a-notset");
      await client(ORG_A, "a-empty", "No Jobs Ltd");
      // Org B: one Overdue job, whose client and milestone org A must never see or touch.
      await client(ORG_B, "b-secret", "Secret Overdue Ltd");
      await job(ORG_B, "x-overdue", "b-secret"); await milestone(ORG_B, "x-overdue", "data_collection", addDays(TODAY, -3), false);
    } finally {
      await db.end();
    }
  });

  after(async () => { await database?.end(); });

  describe("the rule", () => {
    it("holds at every boundary — −2, −1, 0, +7, +8 — unfinished and completed", async () => {
      const risk = await riskByJob(ORG_A, jobQuery({ filters: { client: ["a-bound"] } }));
      for (const [offset, unfinished, completed] of BOUNDARIES) {
        assert.equal(risk[`b${offset}u`], unfinished, `due ${offset} days, unfinished`);
        assert.equal(risk[`b${offset}c`], completed, `due ${offset} days, completed`);
      }
    });

    it("reads Not set for a job with no dated milestone, rows or none", async () => {
      const risk = await riskByJob(ORG_A, jobQuery({ filters: { client: ["a-bound"] } }));
      assert.equal(risk["b-undated"], "Not set", "a completion with no due date is ignored, as v7 ignores it");
      assert.equal(risk["b-none"], "Not set");
    });

    it("takes the worst of a job's milestones", async () => {
      assert.equal((await riskByJob(ORG_A, jobQuery({ filters: { client: ["a-bound"] } })))["b-worst"], "Overdue");
    });

    it("agrees with the TypeScript rule on every job — the SQL and riskOf cannot drift", async () => {
      const admin = await database.admin();
      try {
        const { rows } = await admin.query<{ job_id: string; due_date: Date | null; completed_at: Date | null }>(
          `SELECT j.job_id, m.due_date, m.completed_at FROM nzi_console.jobs j
             LEFT JOIN nzi_console.job_milestones m ON (m.organisation_id, m.job_id) = (j.organisation_id, j.job_id) WHERE j.organisation_id = $1`, [ORG_A]);
        const byJob = new Map<string, RiskMilestone[]>();
        for (const row of rows) {
          const list = byJob.get(row.job_id) ?? [];
          if (row.due_date !== null || row.completed_at !== null) {
            list.push({ dueDate: row.due_date === null ? null : `${row.due_date.getFullYear()}-${String(row.due_date.getMonth() + 1).padStart(2, "0")}-${String(row.due_date.getDate()).padStart(2, "0")}`, completedAt: row.completed_at?.toISOString() ?? null });
          }
          byJob.set(row.job_id, list);
        }
        for (const day of [TODAY, addDays(TODAY, 1), addDays(TODAY, -9)]) {
          const sql = await riskByJob(ORG_A, jobQuery({ filters: { status: ["all"] } }), day);
          for (const [jobId, milestones] of byJob) assert.equal(sql[jobId], riskOf(milestones, day), `${jobId} on ${day}`);
        }
      } finally {
        await admin.end();
      }
    });

    it("is judged on the operating day it is given: a day later, due-yesterday becomes Overdue", async () => {
      assert.equal((await riskByJob(ORG_A, jobQuery({ filters: { client: ["a-bound"] } }), addDays(TODAY, 1)))["b-1u"], "Overdue");
    });

    it("never reads the job's End date", async () => {
      const before = await riskByJob(ORG_A, jobQuery({ filters: { client: ["a-bound"] } }));
      const admin = await database.admin();
      try {
        await admin.query(`UPDATE nzi_console.jobs SET due_date = '1990-01-01' WHERE organisation_id = $1 AND client_id = 'a-bound'`, [ORG_A]);
        assert.deepEqual(await riskByJob(ORG_A, jobQuery({ filters: { client: ["a-bound"] } })), before);
        await admin.query(`UPDATE nzi_console.jobs SET due_date = NULL WHERE organisation_id = $1 AND client_id = 'a-bound'`, [ORG_A]);
        assert.deepEqual(await riskByJob(ORG_A, jobQuery({ filters: { client: ["a-bound"] } })), before);
      } finally {
        await admin.query(`UPDATE nzi_console.jobs SET due_date = '2030-01-01' WHERE organisation_id = $1 AND client_id = 'a-bound'`, [ORG_A]);
        await admin.end();
      }
    });
  });

  describe("a client's Risk", () => {
    const clientRisk = async (name: string) => (await clientsIn(ORG_A, clientQuery({ search: name }))).rows[0]!.risk;

    it("is the worst of its jobs", async () => {
      assert.equal(await clientRisk("Boundary"), "Overdue");
    });

    it("leaves cancelled jobs out under the provisional ruling (R1 b), and counts them under (a)", async () => {
      assert.equal(await clientRisk("Cancelled Overdue"), "Healthy", "(b): the cancelled job's overdue report does not count");
      const all = await withTenantRead(database.pool, ORG_A, async (db) => (await db.query<{ risk: string }>(
        `SELECT ${riskLabelSql(clientRiskRankSql("c", "$1::date", "all"))} AS risk FROM nzi_console.clients c WHERE c.client_id = 'a-cancel'`, [TODAY])).rows[0]!.risk);
      assert.equal(all, "Overdue", "(a): every job counts, as v7's does");
    });

    it("ranks Not set below Healthy (R5): Healthy and unset jobs make a Healthy client", async () => {
      assert.equal(await clientRisk("Healthy And Unset"), "Healthy");
    });

    it("is Not set when no job has a dated milestone, or there are no jobs", async () => {
      assert.equal(await clientRisk("Nothing Dated"), "Not set");
      assert.equal(await clientRisk("No Jobs"), "Not set");
    });
  });

  describe("tenant isolation on job_milestones", () => {
    it("has row-level security forced, with the tenant policy", async () => {
      const admin = await database.admin();
      try {
        const { rows: [flags] } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'nzi_console.job_milestones'::regclass`);
        assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
        const { rows } = await admin.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'nzi_console' AND tablename = 'job_milestones'`);
        assert.deepEqual(rows.map((row) => row.policyname), ["tenant_isolation"]);
      } finally {
        await admin.end();
      }
    });

    it("never reads or updates another organisation's milestone, even by its key", async () => {
      await withTenantRead(database.pool, ORG_A, async (db) => {
        assert.deepEqual((await db.query(`SELECT * FROM nzi_console.job_milestones WHERE job_id = 'x-overdue'`)).rows, []);
      });
      const updated = await withTenantWrite(database.pool, ORG_A, async (db) =>
        (await db.query(`UPDATE nzi_console.job_milestones SET due_date = NULL WHERE organisation_id = $1 AND job_id = 'x-overdue' RETURNING job_id`, [ORG_B])).rows);
      assert.deepEqual(updated, []);
    });

    it("refuses writing a milestone into another organisation", async () => {
      await assert.rejects(withTenantWrite(database.pool, ORG_A, (db) => db.query(
        `INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, updated_by, due_source) VALUES ($1, 'x-overdue', 'first_draft', '2026-10-01', 't', 'manual')`, [ORG_B])),
        /row-level security/);
    });

    it("grants no DELETE — a milestone is cleared, not removed", async () => {
      await assert.rejects(withTenantWrite(database.pool, ORG_A, (db) => db.query(`DELETE FROM nzi_console.job_milestones WHERE job_id = 'b-worst'`)), /permission denied/);
    });

    it("counts the Risk facet over the organisation's own jobs only, and a Risk filter never crosses", async () => {
      const page = await jobsIn(ORG_A, jobQuery());
      const overdue = page.filterOptions.risk.find((option) => option.value === "Overdue")!.count;
      assert.equal(overdue, page.rows.filter((row) => row.risk === "Overdue").length, "A's own Overdue jobs, and not B's");
      const filtered = await jobsIn(ORG_A, jobQuery({ filters: { risk: ["Overdue"] } }));
      assert.ok(!filtered.rows.some((row) => row.id === "x-overdue"));
      assert.equal((await jobsIn(ORG_B, jobQuery({ filters: { risk: ["Overdue"] } }))).rows.map((row) => row.id).join(), "x-overdue");
      const clients = await clientsIn(ORG_A, clientQuery({ filters: { risk: ["Overdue"] } }));
      assert.ok(!clients.rows.some((row) => row.name.includes("Secret")));
    });
  });

  describe("Risk in the lists", () => {
    it("offers all four levels, in severity order, with zero counts where there are none", async () => {
      const { filterOptions } = await jobsIn(ORG_A, jobQuery({ filters: { client: ["a-notset"] } }));
      assert.deepEqual(filterOptions.risk.map((option) => option.value), [...RISK_LEVELS]);
      assert.deepEqual(filterOptions.risk.map((option) => option.count), [0, 0, 0, 2]);
    });

    it("filters by each level, Not set included", async () => {
      for (const level of RISK_LEVELS) {
        const page = await jobsIn(ORG_A, jobQuery({ filters: { risk: [level], status: ["all"] } }));
        assert.ok(page.rows.length > 0, level);
        assert.ok(page.rows.every((row) => row.risk === level), level);
      }
      assert.deepEqual((await clientsIn(ORG_A, clientQuery({ filters: { risk: ["Not set"] } }))).rows.map((row) => row.name).sort(), ["No Jobs Ltd", "Nothing Dated Ltd"]);
    });

    it("sorts by severity — Overdue first ascending, Not set first descending — not by the alphabet", async () => {
      const ascending = (await jobsIn(ORG_A, jobQuery({ sort: { key: "risk", dir: "asc" } }))).rows.map((row) => row.risk);
      assert.equal(ascending[0], "Overdue");
      assert.equal(ascending.at(-1), "Not set");
      assert.deepEqual(ascending, [...ascending].sort((a, b) => RISK_LEVELS.indexOf(a) - RISK_LEVELS.indexOf(b)));
      const descending = (await clientsIn(ORG_A, clientQuery({ sort: { key: "risk", dir: "desc" } }))).rows.map((row) => row.risk);
      assert.equal(descending[0], "Not set");
    });

    it("counts Overdue in the summaries, over the filtered set", async () => {
      assert.equal((await clientsIn(ORG_A, clientQuery())).summary.overdue, 1, "Boundary Ltd; the cancelled job's client is not Overdue under (b)");
      const jobs = await jobsIn(ORG_A, jobQuery());
      assert.equal(jobs.summary.overdue, jobs.rows.filter((row) => row.risk === "Overdue").length);
    });
  });
});
