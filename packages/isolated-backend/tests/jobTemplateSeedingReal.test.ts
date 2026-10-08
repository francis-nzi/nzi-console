import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type ReportingTemplateLineInput } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { getJobTemplateSeeding, seedJobFromTemplate } from "../src/jobTemplateSeeding";
import { setClientReportingTemplate } from "../src/clientReportingTemplates";
import { setJobSiteInclusion } from "../src/jobSiteInclusions";
import { createJob, createScopeRow } from "../src/postgresCommands";
import { periodBoundData } from "../src/jobUpdate";
import { withTenantRead } from "../src/index";

/**
 * Phase 3b, template-seeded entry (0162; RULING-phase3-design.md #7–#11), against a real database:
 * - each template line becomes an entry row through the scope-row create itself: no quantity, its category, labels, site
 *   and unit; this year's edition of the same factor id (#8), never last year's; the declared factor where the line has
 *   none; a line the create refuses (no factor anywhere) skipped and counted, never failing the rest (#9);
 * - a Scope 3 line not yet filed is skipped as toFile; an archived or excluded site dropped; a line already on the job
 *   skipped, so a re-seed fills gaps only;
 * - the job records the version that seeded it; nobody seeds a version they were not shown (#7); no template, or no
 *   reporting period, is refused;
 * - the audit and outbox carry counts only (NZC-120); each seeded row has its own scope.row.created trail;
 * - a CRP job created for a client with a template in force is seeded in its own creation;
 * - J1 ignores untouched seeded rows, and a touched one locks the period again (#10).
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-seed";
const BARE_CLIENT = "client-seed-bare";
const JOB = "job-seed";
const ACTOR = "ada-seed";
const here = dirname(fileURLToPath(import.meta.url));

describe("seeding a job's entries from its client's reporting template (Phase 3b, 0162), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let templateVersion = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `seed-${keys}`, correlationId: `corr-seed-${keys}`,
      grant: commandGrantForRole("admin", ORG, ACTOR), ...(reason ? { reason } : {}) };
  };
  const issue = (code: string) => (error: any) => error?.issues?.[0]?.code === code;
  const line = (over: Partial<ReportingTemplateLineInput>): ReportingTemplateLineInput =>
    ({ scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler", reportLabel: null, siteId: null, datasetId: null, factorId: null, unit: "kWh", ...over });
  const rowsOf = async (jobId: string) => (await db.query<{ scope: string; category_code: string | null; source_label: string; site_id: string | null; quantity: string | null; dataset_id: string | null; factor_id: string | null; unit: string | null }>(
    `SELECT scope, category_code, source_label, site_id, quantity, dataset_id, factor_id, unit FROM nzi_console.job_scope_rows WHERE job_id = $1 ORDER BY source_label`, [jobId])).rows;
  const job = async (jobId: string, clientId: string, sequence: number, withConfig = true) => {
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, jobId, clientId, 9000 + sequence]); // clear of the allocator's numbers
    if (withConfig) {
      await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, jobId]);
      await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,'synthetic-gb-2026','automatic','test','system')`, [ORG, jobId]);
    }
  };

  before(async () => {
    database = (await createDisposableDatabase("templateseeding"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    for (const id of [CLIENT, BARE_CLIENT]) await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$2,'active')`, [ORG, id]);
    for (const site of ["site-office", "site-depot", "site-yard"]) {
      await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,client_id,site_id,name,created_by) VALUES ($1,$2,$3,$3,'seed')`, [ORG, CLIENT, site]);
    }
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    // Last year's edition: the same gas factor id, and one factor this year's edition does not carry.
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence,synthetic)
                    VALUES ($1,'synthetic-gb-2025','Synthetic GB activity factors','2025 demo v1','2025-01-01','2025-12-31','GB','active','NZI Console test fixture','Demonstration only',true)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES
                    ($1,'synthetic-gb-2025','gas-demo','Natural gas — 2025 demonstration factor','kWh',0.190000,ARRAY['1']),
                    ($1,'synthetic-gb-2025','gas-2025-only','Gas oil — 2025 only','kWh',0.250000,ARRAY['1'])`, [ORG]);

    await job(JOB, CLIENT, 1);
    // Already on the job by hand: the template's matching line must not duplicate it.
    await createScopeRow(database.pool, { jobId: JOB, scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Kitchen hob", reportLabel: null, siteId: null, quantity: 12,
      unit: "kWh", datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Natural gas — demonstration factor", qualityTier: null }, context());
    // The yard is left out of this job (3a).
    await setJobSiteInclusion(database.pool, { jobId: JOB, siteId: "site-yard", included: false, expectedVersion: 0 }, context("not in this report"));

    const set = await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 0, lines: [
      line({ sourceLabel: "Office boiler", siteId: "site-office", datasetId: "synthetic-gb-2025", factorId: "gas-demo" }),
      line({ sourceLabel: "Depot boiler", siteId: "site-depot", datasetId: "synthetic-gb-2025", factorId: "gas-demo" }),
      line({ sourceLabel: "Yard heater", siteId: "site-yard", datasetId: "synthetic-gb-2025", factorId: "gas-demo" }),
      line({ sourceLabel: "Old boiler", datasetId: "synthetic-gb-2025", factorId: "gas-2025-only" }),
      line({ sourceLabel: "Kitchen hob", datasetId: "synthetic-gb-2026", factorId: "gas-demo" }),
      line({ scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid electricity" }),
      line({ scope: "3", categoryCode: null, sourceLabel: "Something to file", unit: null }),
    ] }, context());
    templateVersion = set.data.version as number;
    // Archived after the template was set: a line may keep citing it, but a new row may not.
    await db.query(`UPDATE nzi_console.client_sites SET archived = true WHERE site_id = 'site-depot'`);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("reads what is in force before seeding: the template version, its lines, and a job not yet seeded", async () => {
    const seeding = await withTenantRead(database.pool, ORG, (reader) => getJobTemplateSeeding(reader, JOB));
    assert.deepEqual(seeding, { templateVersion, lineCount: 7, configured: true, seededTemplateVersion: null, seededAt: null });
  });

  it("refuses a template version the person was not shown", async () => {
    await assert.rejects(() => seedJobFromTemplate(database.pool, { jobId: JOB, expectedTemplateVersion: templateVersion + 1 }, context()),
      (error: any) => error?.name === "VersionConflictError");
  });

  it("seeds each line through the scope-row create, skipping what it cannot take, and records the version", async () => {
    const done = await seedJobFromTemplate(database.pool, { jobId: JOB, expectedTemplateVersion: templateVersion }, context());
    const result = done.data;
    assert.equal(result.templateVersion, templateVersion);
    assert.deepEqual(result.skipped, { duplicate: 1, FACTOR_REQUIRED: 1, toFile: 1 }, JSON.stringify(result));
    assert.equal(result.seeded, 4);
    assert.equal(result.siteDropped, 2, "the archived depot and the excluded yard");

    const rows = await rowsOf(JOB);
    const by = (label: string) => rows.filter((row) => row.source_label === label);
    // This year's edition of the same factor id — never last year's (#8).
    assert.deepEqual(by("Office boiler").map((r) => [r.scope, r.category_code, r.site_id, r.quantity, r.dataset_id, r.factor_id, r.unit]),
      [["1", "1.natural-gas", "site-office", null, "synthetic-gb-2026", "gas-demo", "kWh"]]);
    assert.equal(by("Depot boiler")[0]!.site_id, null, "an archived site is not carried");
    assert.equal(by("Yard heater")[0]!.site_id, null, "a site the job leaves out is not carried");
    assert.equal(by("Old boiler").length, 0, "no factor in this year's editions, none declared: refused by the create, skipped");
    assert.equal(by("Kitchen hob").length, 1, "the row already there is not duplicated");
    // No factor on the line: the category's declared factor fills it in the create (electricity is switched on, 0121).
    const grid = by("Grid electricity")[0]!;
    assert.deepEqual([grid.scope, grid.category_code, grid.quantity, grid.factor_id], ["2", "2.purchased-electricity", null, "uk-ghg-7_400_4000_5_1"]);
    assert.ok(!rows.some((row) => row.source_label === "Something to file"));
    assert.ok(!rows.some((row) => row.dataset_id === "synthetic-gb-2025"), "no row prices this year at last year's edition");
    assert.equal((await db.query(`SELECT 1 FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND dataset_id = 'synthetic-gb-2025'`, [JOB])).rowCount, 0,
      "and no selection of last year's edition was added to make one fit");

    const { rows: [config] } = await db.query<{ seeded_template_version: number; seeded_at: Date | null }>(
      `SELECT seeded_template_version, seeded_at FROM nzi_console.job_emissions_config WHERE job_id = $1`, [JOB]);
    assert.equal(config!.seeded_template_version, templateVersion);
    assert.ok(config!.seeded_at instanceof Date);
  });

  it("records counts only in the audit and the outbox (NZC-120); each seeded row has its own create trail", async () => {
    const { rows: [audit] } = await db.query<{ after_json: Record<string, unknown>; before_json: unknown; correlation_id: string }>(
      `SELECT after_json, before_json, correlation_id FROM nzi_console.audit_events WHERE action = 'job_seeded_from_template' ORDER BY occurred_at DESC LIMIT 1`);
    assert.deepEqual(Object.keys(audit!.after_json).sort(), ["jobId", "seeded", "siteDropped", "skipped", "templateVersion"]);
    assert.doesNotMatch(JSON.stringify(audit!.after_json), /boiler|electricity|kWh|gas-demo/i, "no label, unit or factor in the payload");
    assert.deepEqual(audit!.before_json, { seededTemplateVersion: null });
    const { rows: [outbox] } = await db.query<{ payload_json: unknown }>(`SELECT payload_json FROM nzi_console.transactional_outbox WHERE topic = 'job.seeded_from_template' ORDER BY created_at DESC LIMIT 1`);
    assert.deepEqual(outbox!.payload_json, audit!.after_json);
    // Each seeded row is its own scope.row.create, under the seed's correlation: four rows, four create events — and the
    // two refused lines (no factor; already there) left none behind (their savepoints rolled back).
    const { rows: created } = await db.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM nzi_console.audit_events WHERE entity_type = 'scope_row' AND correlation_id = $1 GROUP BY action`, [audit!.correlation_id]);
    assert.deepEqual(created.map((row) => row.n), [4], JSON.stringify(created));
  });

  it("re-seeds idempotently: every line already there is a duplicate, and nothing is added", async () => {
    const before = (await rowsOf(JOB)).length;
    const again = (await seedJobFromTemplate(database.pool, { jobId: JOB, expectedTemplateVersion: templateVersion }, context())).data;
    assert.equal(again.seeded, 0);
    assert.equal(again.skipped.duplicate, 4 + 1, "the four seeded and the one made by hand");
    assert.equal((await rowsOf(JOB)).length, before);
  });

  it("refuses a client with no template in force, and a job with no reporting period", async () => {
    await job("job-seed-bare", BARE_CLIENT, 2);
    await assert.rejects(() => seedJobFromTemplate(database.pool, { jobId: "job-seed-bare", expectedTemplateVersion: 1 }, context()), issue("NO_TEMPLATE"));
    await job("job-seed-noperiod", CLIENT, 3, false);
    await assert.rejects(() => seedJobFromTemplate(database.pool, { jobId: "job-seed-noperiod", expectedTemplateVersion: templateVersion }, context()), issue("CONFIG_MISSING"));
    assert.equal((await withTenantRead(database.pool, ORG, (reader) => getJobTemplateSeeding(reader, "job-seed-noperiod")))!.configured, false);
  });

  it("J1 ignores untouched seeded rows — the period stays changeable — and a touched one locks it again (#10)", async () => {
    const scopeRowFindings = async (jobId: string) => (await withTenantRead(database.pool, ORG, (reader) => periodBoundData(reader, ORG, jobId)))
      .filter((finding) => finding.table === "job_scope_rows");
    await job("job-seed-j1", CLIENT, 4);
    const seeded = (await seedJobFromTemplate(database.pool, { jobId: "job-seed-j1", expectedTemplateVersion: templateVersion }, context())).data;
    assert.ok(seeded.seeded > 0);
    assert.deepEqual(await scopeRowFindings("job-seed-j1"), [], "only untouched seeded rows: nothing locks the period");
    // Anyone entering a figure makes it data for the period.
    await db.query(`UPDATE nzi_console.job_scope_rows SET quantity = 5 WHERE job_id = 'job-seed-j1' AND source_label = 'Office boiler'`);
    assert.deepEqual((await scopeRowFindings("job-seed-j1")).map((finding) => finding.rows), [1], "a touched seeded row locks the period again");
    // So does a monthly figure, a calculation or an override on another — each on its own.
    await db.query(`UPDATE nzi_console.job_scope_rows SET quantity = NULL WHERE job_id = 'job-seed-j1' AND source_label = 'Office boiler'`);
    for (const [label, change] of [
      ["Office boiler", `monthly_activity_json = '[{"month":"2026-01","quantity":3}]'::jsonb`],
      ["Depot boiler", "calculated_tco2e = 0.1"],
      ["Yard heater", "override_tco2e = 0.2, override_reason = 'metered by the landlord'"],
    ] as const) {
      await db.query(`UPDATE nzi_console.job_scope_rows SET ${change} WHERE job_id = 'job-seed-j1' AND source_label = $1`, [label]);
    }
    assert.deepEqual((await scopeRowFindings("job-seed-j1")).map((finding) => finding.rows), [3]);
  });

  it("seeds a CRP job in its own creation when the client has a template in force", async () => {
    const created = await createJob(database.pool, { clientId: CLIENT, family: "crp", title: "CRP 2026", workflowStage: "Setup", owner: "Ada",
      startDate: "2026-01-01", dueDate: "2027-06-30", reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" } as never, context());
    const jobId = created.data.jobId as string;
    const rows = await rowsOf(jobId);
    assert.deepEqual(rows.map((row) => row.source_label).sort(), ["Depot boiler", "Grid electricity", "Kitchen hob", "Office boiler", "Yard heater"]);
    assert.ok(rows.every((row) => row.quantity === null));
    const { rows: [config] } = await db.query<{ seeded_template_version: number }>(`SELECT seeded_template_version FROM nzi_console.job_emissions_config WHERE job_id = $1`, [jobId]);
    assert.equal(config!.seeded_template_version, templateVersion);
    // And a client without a template gets an empty job, exactly as before.
    const bare = await createJob(database.pool, { clientId: BARE_CLIENT, family: "crp", title: "Bare", workflowStage: "Setup", owner: "Ada",
      startDate: "2026-01-01", dueDate: "2027-06-30", reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" } as never, context());
    assert.equal((await rowsOf(bare.data.jobId as string)).length, 0);
  });
});
