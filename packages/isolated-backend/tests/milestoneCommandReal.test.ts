import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, londonDayOf, todayInLondon, type CommandContext, type CommandInputMap, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticHeaders, syntheticRows } from "./support/v7SyntheticExtract";
import { anchorOf, completeMilestone, planReschedule, readJobMilestones, reopenMilestone, rescheduleMilestones, setMilestone } from "../src/milestoneCommands";
import { createJob } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { planV7ClientImport } from "../src/v7ClientImport";
import { loadV7ClientPlan } from "../src/v7ClientLoad";
import { loadV7Milestones, planV7Milestones } from "../src/v7MilestoneLoad";

/**
 * PR 3 — the milestone command, against a real database: generation at job.create (explicit → job type's → default,
 * active only, included items only, the later anchor), set / complete (back-dating, fix 2) / reopen / reschedule
 * (template rows only, uncompleted only; apply-a-template; a dropped kind cleared but kept — M3, fix 1), 0140's
 * shapes, audit, idempotency, version conflicts, access, Risk after each command — and the PR 2 backfill's R3 re-run
 * refusing a job completed here.
 */
type Issue = { field: string; code: string };
const issue = (field: string, code?: string) => (error: { issues?: Issue[] }) =>
  error.issues?.some((item) => item.field === field && (code === undefined || item.code === code)) === true;
const addDays = (day: string, days: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }; // date-helper-exempt: test arithmetic on a plain date at noon UTC

describe("the anchor and the reschedule plan (no database)", () => {
  it("anchors on the later of the start and the reporting-period start, or the start alone", () => {
    assert.deepEqual(anchorOf("2026-10-01", "2026-09-01"), { anchor: "2026-10-01", from: "start_date" });
    assert.deepEqual(anchorOf("2026-10-01", "2026-11-01"), { anchor: "2026-11-01", from: "reporting_period_start" });
    assert.deepEqual(anchorOf("2026-10-01", null), { anchor: "2026-10-01", from: "start_date" });
  });
  it("moves only uncompleted template rows, generates missing kinds, clears a kind the template drops, keeps the rest", () => {
    const rows = new Map<"data_collection" | "first_draft" | "final_report", { due_date: string | null; completed_at: string | null; due_source: "template" | "manual" | "import" }>([
      ["data_collection", { due_date: "2026-01-01", completed_at: null, due_source: "template" }],
      ["first_draft", { due_date: "2026-02-01", completed_at: null, due_source: "manual" }],
      ["final_report", { due_date: "2026-03-01", completed_at: null, due_source: "template" }],
    ]);
    const template = { templateId: "t", name: "T", version: 1, active: true, items: [{ kind: "data_collection" as const, label: "DC", daysOffset: 5, included: true }] };
    assert.deepEqual(planReschedule(rows, template, { anchor: "2026-10-01", from: "start_date" }).map((step) => [step.kind, step.action, step.to]),
      [["data_collection", "move", "2026-10-06"], ["first_draft", "keep", "2026-02-01"], ["final_report", "clear", null]]);
  });
});

describe("the milestone command, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "mc-org-a";
  const OTHER = "mc-org-b";
  let database: DisposableDatabase;
  let keys = 0;
  const context = (org = ORG, role: StaffRole = "admin", reason?: string, idempotencyKey?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: `${role}-${org}`, principal: "staff", idempotencyKey: idempotencyKey ?? `mc-${keys}`, correlationId: `corr-mc-${keys}`,
      ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, `${role}-${org}`) };
  };
  const admin = async <T>(work: (db: import("pg").Client) => Promise<T>) => { const db = await database.admin(); try { return await work(db); } finally { await db.end(); } };
  const q = (sql: string, params: unknown[] = []) => admin(async (db) => (await db.query(sql, params)).rows);
  const view = (jobId: string, org = ORG) => withTenantRead(database.pool, org, (db) => readJobMilestones(db, jobId));
  const rowsOf = (jobId: string) => q(`SELECT kind, due_date::text AS due, due_source, template_id, due_basis, completed_at, version FROM nzi_console.job_milestones WHERE job_id = $1 ORDER BY kind`, [jobId]);
  const baseJob = (change: Partial<CommandInputMap["job.create"]> = {}): CommandInputMap["job.create"] => ({
    clientId: "c1", family: "crp", title: "A job", workflowStage: "Setup", owner: "Ada", startDate: "2026-10-01", dueDate: "2027-03-31",
    reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31", ...change,
  });
  const newJob = async (change: Partial<CommandInputMap["job.create"]> = {}, org = ORG) => (await createJob(database.pool, baseJob(change), context(org))).data;

  before(async () => {
    database = (await createDisposableDatabase("milestonecommand"))!;
    await admin(async (db) => {
      for (const org of [ORG, OTHER]) {
        await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
        await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
        for (const role of ["admin", "consultant", "finance"]) {
          await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $4)`, [org, `${role}-${org}`, role, `${role} person`]);
        }
        await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Alpha', 'active')`, [org]);
        const template = async (id: string, name: string, isDefault: boolean, items: Array<[string, string, number, boolean]>) => {
          await db.query(`INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, is_default, created_by, updated_by) VALUES ($1, $2, $3, $4, 's', 's')`, [org, id, name, isDefault]);
          for (const [kind, label, offset, included] of items) {
            await db.query(`INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, included, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, 's', 's')`, [org, id, kind, label, offset, included]);
          }
        };
        await template("mt:default", "Standard", true, [["data_collection", "Data in", 45, true], ["first_draft", "Draft", 60, true], ["final_report", "Final", 90, true]]);
        await template("mt:a", "Type A", false, [["data_collection", "Data A", 10, true], ["first_draft", "Draft A", 20, false], ["final_report", "Final A", 30, true]]);
        await template("mt:b", "Only DC", false, [["data_collection", "Kick-off", 3, true]]);
        await template("mt:gone", "Retired", false, [["final_report", "Old", 5, true]]);
        await db.query(`INSERT INTO nzi_console.job_types (organisation_id, job_type_id, name, family, milestone_template_id, created_by, updated_by) VALUES
          ($1, 'jt:a', 'Type A job', 'crp', 'mt:a', 's', 's'), ($1, 'jt:gone', 'Gone template job', 'crp', 'mt:gone', 's', 's'), ($1, 'jt:training', 'Course', 'training', NULL, 's', 's')`, [org]);
        await db.query(`INSERT INTO nzi_console.job_types (organisation_id, job_type_id, name, family, active, created_by, updated_by) VALUES ($1, 'jt:off', 'Off', 'crp', false, 's', 's')`, [org]);
        await db.query(`UPDATE nzi_console.milestone_templates SET active = false WHERE organisation_id = $1 AND template_id = 'mt:gone'`, [org]);
      }
    });
  });
  after(async () => { await database?.end(); });

  describe("generation at job.create", () => {
    it("takes the job type's template, only its included items, anchored on the later date, with the basis recorded", async () => {
      const job = await newJob({ jobTypeId: "jt:a" });
      assert.deepEqual([job.jobTypeId, job.milestoneTemplateId], ["jt:a", "mt:a"]);
      const rows = await rowsOf(job.jobId);
      assert.deepEqual(rows.map((row) => [row.kind, row.due, row.due_source, row.template_id]), [["data_collection", "2026-10-11", "template", "mt:a"], ["final_report", "2026-10-31", "template", "mt:a"]], "first draft is excluded");
      assert.deepEqual(rows[0].due_basis, { templateId: "mt:a", templateVersion: 1, itemLabel: "Data A", anchor: "2026-10-01", anchorFrom: "start_date", daysOffset: 10 });
      assert.equal((await q(`SELECT milestone_template_id FROM nzi_console.jobs WHERE job_id = $1`, [job.jobId]))[0].milestone_template_id, "mt:a", "M8: recorded on the job");
    });
    it("takes a per-job override, the default, or explicitly none", async () => {
      assert.deepEqual((await rowsOf((await newJob({ jobTypeId: "jt:a", milestoneTemplateId: "mt:b" })).jobId)).map((row) => [row.kind, row.due]), [["data_collection", "2026-10-04"]]);
      const none = await newJob({ milestoneTemplateId: null });
      assert.deepEqual([none.milestoneTemplateId, (await rowsOf(none.jobId)).length, (await view(none.jobId))!.risk], [null, 0, "Not set"]);
    });
    it("uses the default when nothing else is named — 45 / 60 / 90 days after the start", async () => {
      const job = await newJob();
      assert.equal(job.milestoneTemplateId, "mt:default");
      assert.deepEqual((await rowsOf(job.jobId)).map((row) => [row.kind, row.due]), [["data_collection", "2026-11-15"], ["final_report", "2026-12-30"], ["first_draft", "2026-11-30"]]);
    });
    it("anchors on the reporting-period start when it is later, and on the start for a family with no period", async () => {
      const later = await newJob({ startDate: "2026-10-01", reportingPeriodStart: "2026-11-01", reportingPeriodEnd: "2027-10-31" });
      assert.deepEqual((await rowsOf(later.jobId))[0].due_basis.anchorFrom, "reporting_period_start");
      const course = await newJob({ family: "training", jobTypeId: "jt:training", workflowStage: "Course setup", reportingPeriodStart: null, reportingPeriodEnd: null, milestoneTemplateId: "mt:b" });
      assert.deepEqual((await rowsOf(course.jobId)).map((row) => [row.due, row.due_basis.anchorFrom]), [["2026-10-04", "start_date"]]);
    });
    it("generates nothing from an inactive job-type template, refuses an inactive explicit template, an inactive type, and another family's type", async () => {
      const gone = await newJob({ jobTypeId: "jt:gone" });
      assert.deepEqual([gone.milestoneTemplateId, (await rowsOf(gone.jobId)).length], [null, 0]);
      await assert.rejects(createJob(database.pool, baseJob({ milestoneTemplateId: "mt:gone" }), context()), issue("milestoneTemplateId", "INACTIVE"));
      await assert.rejects(createJob(database.pool, baseJob({ jobTypeId: "jt:off" }), context()), issue("jobTypeId", "INACTIVE"));
      await assert.rejects(createJob(database.pool, baseJob({ jobTypeId: "jt:training" }), context()), issue("jobTypeId", "FAMILY_MISMATCH"));
    });
    it("records the generated milestones in the job.create audit", async () => {
      const made = await createJob(database.pool, baseJob({ jobTypeId: "jt:a" }), context());
      const audit = (await q(`SELECT after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [made.auditEventId]))[0];
      assert.deepEqual(audit.after_json.milestones.map((m: { kind: string; source: string }) => [m.kind, m.source]), [["data_collection", "template"], ["final_report", "template"]]);
    });
  });

  describe("set, complete, reopen", () => {
    it("set turns a template date manual (basis gone), adds a missing kind, clears — and is refused on a completed milestone", async () => {
      const job = await newJob({ jobTypeId: "jt:a" });
      const [dc] = await rowsOf(job.jobId);
      const set = await setMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", dueDate: "2026-10-20", expectedVersion: dc.version }, context(ORG, "consultant"));
      const after = (await rowsOf(job.jobId))[0];
      assert.deepEqual([after.due, after.due_source, after.template_id, after.due_basis, after.version], ["2026-10-20", "manual", null, null, 2]);
      const audit = (await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [set.auditEventId]))[0];
      assert.deepEqual([audit.before_json.source, audit.before_json.dueDate], ["template", "2026-10-11"]);
      await setMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", dueDate: "2026-10-25" }, context());
      await setMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", dueDate: null, expectedVersion: 1 }, context());
      const cleared = (await rowsOf(job.jobId)).find((row) => row.kind === "first_draft");
      assert.deepEqual([cleared.due, cleared.due_source, cleared.completed_at, cleared.version], [null, "manual", null, 2], "cleared, kept (M2)");
      await assert.rejects(setMilestone(database.pool, { jobId: job.jobId, kind: "final_report", dueDate: "2026-11-01" }, context()), issue("expectedVersion", "REQUIRED"));
      await assert.rejects(setMilestone(database.pool, { jobId: job.jobId, kind: "final_report", dueDate: "2026-11-01", expectedVersion: 9 }, context()), /version|changed/i);
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "final_report", expectedVersion: 1 }, context());
      await assert.rejects(setMilestone(database.pool, { jobId: job.jobId, kind: "final_report", dueDate: "2026-11-01", expectedVersion: 2 }, context()), issue("kind", "COMPLETED"));
    });

    it("complete: omitted is now; today is now; a past day is that London day (fix 2); a future day is refused", async () => {
      const job = await newJob();
      const today = todayInLondon();
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", expectedVersion: 1 }, context());
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", completedAt: today, expectedVersion: 1 }, context());
      // A summer day: its London midnight is 23:00 UTC the day before — it must read back as the day chosen.
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "final_report", completedAt: "2026-06-15", expectedVersion: 1 }, context());
      const milestones = (await view(job.jobId))!.milestones;
      const byKind = Object.fromEntries(milestones.map((m) => [m.kind, m])) as Record<(typeof milestones)[number]["kind"], (typeof milestones)[number]>;
      assert.equal(byKind.data_collection.completedOn, today);
      assert.ok(Date.now() - Date.parse(byKind.first_draft.completedAt!) < 60_000, "today's date is the real moment, not a midnight");
      assert.equal(byKind.final_report.completedAt, "2026-06-14T23:00:00.000Z");
      assert.equal(byKind.final_report.completedOn, "2026-06-15", "a back-dated completion reads back as exactly that London day");
      assert.equal(londonDayOf(byKind.final_report.completedAt!), "2026-06-15");
      assert.deepEqual([byKind.final_report.completedByUserId, byKind.final_report.completedByLabel], [`admin-${ORG}`, "admin person"]);
      const other = await newJob();
      await assert.rejects(completeMilestone(database.pool, { jobId: other.jobId, kind: "data_collection", completedAt: addDays(today, 1), expectedVersion: 1 }, context()), issue("completedAt", "FUTURE"));
      await assert.rejects(completeMilestone(database.pool, { jobId: other.jobId, kind: "data_collection", completedAt: "2026-02-30", expectedVersion: 1 }, context()), issue("completedAt", "INVALID"));
    });

    it("complete is a no-op on a completed milestone, even with another date — the row is not written", async () => {
      const job = await newJob();
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", completedAt: "2026-06-15", expectedVersion: 1 }, context());
      const before = (await rowsOf(job.jobId)).find((row) => row.kind === "data_collection");
      const again = await completeMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", completedAt: "2026-07-01" }, context());
      assert.equal(again.data.changed, false);
      assert.deepEqual((await rowsOf(job.jobId)).find((row) => row.kind === "data_collection"), before, "same completion, same version");
      const audit = (await q(`SELECT after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [again.auditEventId]))[0];
      assert.equal(audit.after_json.changed, false, "the audit records that nothing changed");
    });

    it("complete records an undated completion as a manual row; reopen needs a reason and clears it", async () => {
      const job = await newJob({ milestoneTemplateId: null });
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "first_draft" }, context());
      const [row] = await rowsOf(job.jobId);
      assert.deepEqual([row.due, row.due_source, !!row.completed_at], [null, "manual", true]);
      await assert.rejects(reopenMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", expectedVersion: 1 }, context()), issue("reason"));
      const reopened = await reopenMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", expectedVersion: 1 }, context(ORG, "admin", "Ticked by mistake"));
      assert.equal((await q(`SELECT reason FROM nzi_console.audit_events WHERE audit_event_id = $1`, [reopened.auditEventId]))[0].reason, "Ticked by mistake");
      const [cleared] = await rowsOf(job.jobId);
      assert.deepEqual([cleared.due, cleared.completed_at, cleared.due_source], [null, null, "manual"], "an empty manual row is allowed (M2)");
      await assert.rejects(reopenMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", expectedVersion: 2 }, context(ORG, "admin", "Again")), issue("kind", "NOT_COMPLETED"));
    });

    it("replays an idempotent retry instead of writing twice", async () => {
      const job = await newJob({ milestoneTemplateId: null });
      const first = await setMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", dueDate: "2026-12-01" }, context(ORG, "admin", undefined, "mc-same"));
      const again = await setMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", dueDate: "2026-12-01" }, context(ORG, "admin", undefined, "mc-same"));
      assert.deepEqual([again.replayed, again.auditEventId], [true, first.auditEventId]);
      assert.equal((await rowsOf(job.jobId))[0].version, 1);
    });
  });

  describe("reschedule", () => {
    it("moves only uncompleted template rows; manual, completed and imported rows stay; a dropped kind is cleared but kept (M3)", async () => {
      const job = await newJob();
      const rows = Object.fromEntries((await rowsOf(job.jobId)).map((row) => [row.kind, row]));
      await setMilestone(database.pool, { jobId: job.jobId, kind: "first_draft", dueDate: "2026-12-05", expectedVersion: rows.first_draft.version }, context());
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "final_report", expectedVersion: rows.final_report.version }, context());
      const { jobVersion } = (await view(job.jobId))!;
      const moved = await rescheduleMilestones(database.pool, { jobId: job.jobId, milestoneTemplateId: "mt:b", expectedVersion: jobVersion }, context());
      assert.deepEqual(moved.data.preview.map((step) => [step.kind, step.action]), [["data_collection", "move"], ["first_draft", "keep"], ["final_report", "keep"]]);
      const after = Object.fromEntries((await rowsOf(job.jobId)).map((row) => [row.kind, row]));
      assert.deepEqual([after.data_collection.due, after.data_collection.template_id, after.data_collection.due_basis.itemLabel], ["2026-10-04", "mt:b", "Kick-off"]);
      assert.deepEqual([after.first_draft.due, after.first_draft.due_source], ["2026-12-05", "manual"]);
      assert.ok(after.final_report.completed_at);
      assert.equal((await q(`SELECT milestone_template_id FROM nzi_console.jobs WHERE job_id = $1`, [job.jobId]))[0].milestone_template_id, "mt:b");

      const dropped = await newJob();
      const v = (await view(dropped.jobId))!.jobVersion;
      await rescheduleMilestones(database.pool, { jobId: dropped.jobId, milestoneTemplateId: "mt:b", expectedVersion: v }, context());
      const fr = (await rowsOf(dropped.jobId)).find((row) => row.kind === "final_report");
      assert.deepEqual([fr.due, fr.due_source, fr.template_id, fr.due_basis], [null, "template", "mt:b", null], "fix 1: the template's empty slot — not manual");
    });

    it("applies a template to a job with none (Q7's per-job path), refuses an inactive template and a stale job version", async () => {
      const job = await newJob({ milestoneTemplateId: null });
      const v = (await view(job.jobId))!.jobVersion;
      await assert.rejects(rescheduleMilestones(database.pool, { jobId: job.jobId, milestoneTemplateId: "mt:gone", expectedVersion: v }, context()), issue("milestoneTemplateId", "INACTIVE"));
      await assert.rejects(rescheduleMilestones(database.pool, { jobId: job.jobId, milestoneTemplateId: "mt:a", expectedVersion: v + 5 }, context()), /version|changed/i);
      const applied = await rescheduleMilestones(database.pool, { jobId: job.jobId, milestoneTemplateId: "mt:a", expectedVersion: v }, context());
      assert.deepEqual(applied.data.preview.filter((step) => step.action === "generate").map((step) => step.kind), ["data_collection", "final_report"]);
      assert.equal((await rowsOf(job.jobId)).length, 2);
    });

    it("never moves an imported row", async () => {
      const job = await newJob({ milestoneTemplateId: null });
      await admin((db) => db.query(`INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, due_source, source_system, legacy_db_id, legacy_values, updated_by)
        VALUES ($1, $2, 'data_collection', '2025-01-01', 'import', 'nzi-pro-v7', 'x:dc', '{}'::jsonb, 'v7-milestones-x')`, [ORG, job.jobId]));
      const v = (await view(job.jobId))!.jobVersion;
      const done = await rescheduleMilestones(database.pool, { jobId: job.jobId, milestoneTemplateId: "mt:default", expectedVersion: v }, context());
      assert.deepEqual(done.data.preview.map((step) => [step.kind, step.action]), [["data_collection", "keep"], ["first_draft", "generate"], ["final_report", "generate"]]);
      assert.equal((await rowsOf(job.jobId)).find((row) => row.kind === "data_collection").due, "2025-01-01");
    });
  });

  describe("access, tenancy, Risk and 0140", () => {
    it("is job.manage — a role without it is refused — and never reaches another organisation's job", async () => {
      const job = await newJob();
      await assert.rejects(setMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", dueDate: "2026-12-01", expectedVersion: 1 }, context(ORG, "finance")), /job\.manage|permission|capabilit|scope/i);
      const theirs = await newJob({}, OTHER);
      await assert.rejects(setMilestone(database.pool, { jobId: theirs.jobId, kind: "data_collection", dueDate: "2026-12-01", expectedVersion: 1 }, context()), /not in your organisation/i);
      assert.equal(await view(theirs.jobId, ORG), null, "another organisation's job is not read");
    });

    it("reads Risk from the same rule after each command", async () => {
      const job = await newJob({ milestoneTemplateId: null });
      assert.equal((await view(job.jobId))!.risk, "Not set");
      const today = todayInLondon();
      await setMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", dueDate: addDays(today, -5) }, context());
      assert.equal((await view(job.jobId))!.risk, "Overdue");
      await completeMilestone(database.pool, { jobId: job.jobId, kind: "data_collection", expectedVersion: 1 }, context());
      assert.equal((await view(job.jobId))!.risk, "Healthy", "a completed milestone counts as neither Overdue nor Due (PR 2's rule)");
      await setMilestone(database.pool, { jobId: job.jobId, kind: "final_report", dueDate: addDays(today, 3) }, context());
      assert.equal((await view(job.jobId))!.risk, "Due");
    });

    it("holds 0140's shapes: a source, a template id exactly on template rows, a basis exactly on dated template rows; no DELETE", async () => {
      const job = await newJob({ milestoneTemplateId: null });
      const insert = (columns: string, values: string) => withTenantWrite(database.pool, ORG, (db) => db.query(`INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, updated_by, ${columns}) VALUES ($1, $2, 'data_collection', 't', ${values})`, [ORG, job.jobId]));
      await assert.rejects(insert("due_source", "'guess'"), /due_source_check/);
      await assert.rejects(insert("due_source, due_date, due_basis", "'template', '2026-01-01', '{}'"), /template_id_shape/);
      await assert.rejects(insert("due_source, due_date, template_id", "'template', '2026-01-01', 'mt:a'"), /due_basis_shape/);
      await assert.rejects(insert("due_source, due_date, template_id", "'manual', '2026-01-01', 'mt:a'"), /template_id_shape/);
      await assert.rejects(insert("due_source, due_date, due_basis", "'manual', '2026-01-01', '{}'"), /due_basis_shape/);
      await assert.rejects(insert("due_source", "'import'"), /records_something/, "an imported row still records something");
      await insert("due_source, template_id", "'template', 'mt:a'"); // a cleared template slot: allowed (fix 1 with M2)
      await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.job_milestones WHERE job_id = $1`, [job.jobId])), /permission denied/);
    });
  });
});

describe("the PR 2 backfill's R3 re-run, after PR 3", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "net-zero-international";
  let database: DisposableDatabase;
  const extractWith = (mutate?: (rows: ReturnType<typeof syntheticRows>) => void) => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };
  before(async () => {
    database = (await createDisposableDatabase("milestonecommandr3"))!;
    const db = await database.admin();
    try { await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada')`, [ORG]); } finally { await db.end(); }
    await loadV7ClientPlan(database.pool, planV7ClientImport({ extract: syntheticExtract(), headers: syntheticHeaders(), extractSha256: "s" }), { commit: true, runId: "clients-1" });
    await loadV7Milestones(database.pool, ORG, planV7Milestones(syntheticExtract().job_plan), { commit: true });
  });
  after(async () => { await database?.end(); });

  it("refuses a job whose milestone was completed here, and writes the import as due_source 'import'", async () => {
    const q = async (sql: string, params: unknown[]) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
    assert.ok((await q(`SELECT due_source FROM nzi_console.job_milestones WHERE organisation_id = $1`, [ORG])).every((row) => row.due_source === "import"));
    const dc = (await q(`SELECT version FROM nzi_console.job_milestones WHERE job_id = 'v7-job-101' AND kind = 'data_collection'`, []))[0];
    const grant = commandGrantForRole("admin", ORG, "ada");
    await completeMilestone(database.pool, { jobId: "v7-job-101", kind: "data_collection", completedAt: "2026-09-01", expectedVersion: dc.version },
      { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: "r3-1", correlationId: "r3-1", grant });
    // v7 moves job 101's first draft and job 103's final report: 101 was edited here, 103 was not.
    const changed = extractWith((rows) => {
      rows.job_plan.find((row) => row.job_id === "101")!.data_collection_due = "2026-09-25";
      rows.job_plan.find((row) => row.job_id === "103")!.final_report_due = "2025-02-01";
    });
    const outcome = await loadV7Milestones(database.pool, ORG, planV7Milestones(changed.job_plan), { commit: true });
    assert.ok(outcome.conflicts.some((conflict) => conflict.jobNumber === "J000613" && conflict.kind === "data_collection"), "the job completed here is refused");
    assert.equal((await q(`SELECT due_date::text AS d FROM nzi_console.job_milestones WHERE job_id = 'v7-job-103' AND kind = 'final_report'`, []))[0].d, "2025-02-01", "an untouched job takes v7's change");
    assert.ok((await q(`SELECT completed_at FROM nzi_console.job_milestones WHERE job_id = 'v7-job-101' AND kind = 'data_collection'`, []))[0].completed_at, "the completion made here stands");
  });
});
