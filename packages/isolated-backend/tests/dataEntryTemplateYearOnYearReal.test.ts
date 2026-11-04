import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type ReportingTemplateLineInput } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { VersionConflictError } from "../src/errors";
import { getClientReportingTemplate } from "../src/clientReportingTemplateRecords";
import { initialiseClientReportingTemplateFromJob, setClientReportingTemplate } from "../src/clientReportingTemplates";
import { createJob, createScopeRow } from "../src/postgresCommands";

/**
 * A client's data entry template, maintained year on year (the "Reporting template" card, renamed): the whole path, against a real database.
 *
 *   initialise from a job (v1) -> reopen it -> amend (edit one row, remove one, add one) -> save the next version (v2, v1 kept)
 *   -> a NEW CRP job seeds from the amended set -> amend again (v3) -> the next job seeds from that.
 *
 * It drives the same read the editor opens from (`getClientReportingTemplate`) and saves the same payload the editor sends (the lines it
 * was shown, with the amendments, and the version it was shown). No master-template import is involved anywhere on this path.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-yoy";
const SOURCE_JOB = "job-yoy-source";
const ACTOR = "ada-yoy";
const here = dirname(fileURLToPath(import.meta.url));

describe("the client's data entry template, edited in place and carried into each new job", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `yoy-${keys}`, correlationId: `corr-yoy-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  /** What the editor opens: the template in force, as the card's read model holds it. */
  const reopen = async () => {
    const template = await getClientReportingTemplate(db, CLIENT);
    assert.ok(template.current, "a template is in force");
    return template;
  };
  /** The editor's lines, exactly as its form state holds them (the read model's lines without their ids). */
  const editorLines = (template: Awaited<ReturnType<typeof reopen>>): ReportingTemplateLineInput[] => template.current!.lines.map((line) => ({
    scope: line.scope, categoryCode: line.categoryCode, sourceLabel: line.sourceLabel, reportLabel: line.reportLabel,
    siteId: line.siteId, datasetId: line.datasetId, factorId: line.factorId, unit: line.unit,
  }));
  const labelsOfVersion = async (version: number) => (await db.query<{ source_label: string }>(
    `SELECT source_label FROM nzi_console.client_reporting_template_lines WHERE client_id = $1 AND version = $2 ORDER BY source_label`, [CLIENT, version])).rows.map((row) => row.source_label);
  const newJob = async (title: string) => {
    const created = await createJob(database.pool, { clientId: CLIENT, family: "crp", title, workflowStage: "Setup", owner: "Ada",
      startDate: "2026-01-01", dueDate: "2027-06-30", reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" } as never, context());
    const jobId = created.data.jobId as string;
    const rows = (await db.query<{ source_label: string; quantity: string | null }>(`SELECT source_label, quantity FROM nzi_console.job_scope_rows WHERE job_id = $1 ORDER BY source_label`, [jobId])).rows;
    const seeded = (await db.query<{ seeded_template_version: number | null }>(`SELECT seeded_template_version FROM nzi_console.job_emissions_config WHERE job_id = $1`, [jobId])).rows[0]?.seeded_template_version ?? null;
    return { jobId, labels: rows.map((row) => row.source_label), quantities: rows.map((row) => row.quantity), seeded };
  };

  before(async () => {
    database = (await createDisposableDatabase("yoytemplate"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$2,'active')`, [ORG, CLIENT]);
    for (const site of ["site-office", "site-depot"]) await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,client_id,site_id,name,created_by) VALUES ($1,$2,$3,$3,'seed')`, [ORG, CLIENT, site]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    // The job the template is first initialised from: two gas entries, one per site.
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,9100,'crp','CRP 2025','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, SOURCE_JOB, CLIENT]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, SOURCE_JOB]);
    await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,'synthetic-gb-2026','automatic','test','system')`, [ORG, SOURCE_JOB]);
    for (const [label, site] of [["Office boiler", "site-office"], ["Depot boiler", "site-depot"]] as const) {
      await createScopeRow(database.pool, { jobId: SOURCE_JOB, scope: "1", categoryCode: "1.natural-gas", sourceLabel: label, reportLabel: null, siteId: site, quantity: 1000, unit: "kWh",
        datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Natural gas — demonstration factor", qualityTier: null }, context());
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("opens an initialised template, amends it (edit, remove, add) and saves the next version - the one before stays in the record", async () => {
    const v1 = await initialiseClientReportingTemplateFromJob(database.pool, { clientId: CLIENT, jobId: SOURCE_JOB, expectedVersion: 0 }, context());
    assert.equal(v1.data.version, 1);
    assert.deepEqual(await labelsOfVersion(1), ["Depot boiler", "Office boiler"]);

    // Reopen it, as the card's "Edit lines" does, and amend what it shows.
    const opened = await reopen();
    assert.equal(opened.latestVersion, 1);
    const amended = editorLines(opened)
      .filter((l) => l.sourceLabel !== "Depot boiler")                                              // remove a row
      .map((l) => l.sourceLabel === "Office boiler" ? { ...l, sourceLabel: "Head office boiler", reportLabel: "Boiler (head office)" } : l); // edit a row
    amended.push({ scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid electricity", reportLabel: null, siteId: null, datasetId: null, factorId: null, unit: "kWh" }); // add a row
    const v2 = await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: opened.latestVersion, lines: amended }, context());

    assert.equal(v2.data.version, 2);
    assert.deepEqual(await labelsOfVersion(2), ["Grid electricity", "Head office boiler"]);
    assert.deepEqual(await labelsOfVersion(1), ["Depot boiler", "Office boiler"], "version 1 is kept, untouched");
    assert.deepEqual((await db.query(`SELECT version, active, origin FROM nzi_console.client_reporting_templates WHERE client_id = $1 ORDER BY version`, [CLIENT])).rows,
      [{ version: 1, active: true, origin: "job" }, { version: 2, active: true, origin: "manual" }], "both versions are in the record");
    // What the card now shows is the amended set, with the factor and site the edited row kept.
    const now = await reopen();
    assert.equal(now.latestVersion, 2);
    const head = now.current!.lines.find((l) => l.sourceLabel === "Head office boiler")!;
    assert.deepEqual([head.reportLabel, head.siteId, head.factorId, head.datasetId], ["Boiler (head office)", "site-office", "gas-demo", "synthetic-gb-2026"]);
    // A second editor still holding version 1 is told the record moved - never a raw error.
    await assert.rejects(setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 1, lines: amended }, context()), VersionConflictError);
  });

  it("a newly created CRP job seeds from the amended version - the edited and added rows in, the removed row out, no quantities", async () => {
    const job = await newJob("CRP 2026");
    assert.deepEqual(job.labels, ["Grid electricity", "Head office boiler"]);
    assert.ok(!job.labels.includes("Office boiler") && !job.labels.includes("Depot boiler"), "neither the old label nor the removed row");
    assert.ok(job.quantities.every((q) => q === null), "a template carries shape, never figures");
    assert.equal(job.seeded, 2, "the job records the template version that seeded it");
  });

  it("amend again next year: the next job seeds from the newest version, and the earlier job keeps what it was seeded with", async () => {
    const earlier = (await db.query<{ job_id: string }>(`SELECT job_id FROM nzi_console.jobs WHERE title = 'CRP 2026'`)).rows[0]!.job_id;
    const opened = await reopen();
    const v3 = await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: opened.latestVersion,
      lines: editorLines(opened).filter((l) => l.sourceLabel !== "Grid electricity") }, context());
    assert.equal(v3.data.version, 3);
    const next = await newJob("CRP 2027");
    assert.deepEqual(next.labels, ["Head office boiler"]);
    assert.equal(next.seeded, 3);
    assert.deepEqual((await db.query<{ source_label: string }>(`SELECT source_label FROM nzi_console.job_scope_rows WHERE job_id = $1 ORDER BY source_label`, [earlier])).rows.map((r) => r.source_label),
      ["Grid electricity", "Head office boiler"], "last year's job is not rewritten by this year's template");
    assert.deepEqual(await labelsOfVersion(1), ["Depot boiler", "Office boiler"], "and the first version is still there");
  });
});
