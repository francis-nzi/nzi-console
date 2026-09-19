import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  createEmissionSource, createEmissionSourceGroup, syncEmissionSourceGroupToScope, syncEmissionSourceToScope,
  updateEmissionSourceActivity,
} from "../src/index";

/**
 * A name a consultant chose is not taken back off by a background sync (NZC-108).
 *
 * **Assert-correct, not pin-current.** Every assertion here was red before the fix: a scope row
 * generated from an emission source had its `report_label` overwritten with the source label on
 * every sync, and a sync runs on every edit to the source behind it. A consultant who renamed a row
 * for the client's report lost that name the next time anyone touched the source — silently, with
 * no error and nothing in the audit trail to say the label had been replaced.
 *
 * The other half of the guarantee matters as much: a row nobody has renamed must still follow its
 * source. Freezing every label at creation would trade silent loss for silent staleness, where a
 * renamed source keeps printing its old name in a client's report. The fix distinguishes the two by
 * asking whether the label still equals the source label — they are equal exactly while nobody has
 * intervened — so an automatic name keeps tracking and a chosen one is left alone.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const JOB = "job-a";
const ACTOR = "consultant-a";

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", ORG, ACTOR),
});

const source = (over: Record<string, unknown> = {}) => ({
  jobId: JOB, groupId: null, scope: "1", sourceType: "asset" as const, sourceSubtype: null,
  siteId: null, sourceName: "Site boiler", assetIdentifier: null, purchasedGoodsCategoryId: null,
  datasetId: "ds-1", factorId: "f-diesel", factorSource: "dataset" as const, clientFactorId: null,
  quantity: 1200, unit: "litres", applyPct: 100, dataSource: "Meter read",
  dataConfidence: "H" as const, monthlyActivity: [], detail: { kind: "asset" as const },
  notes: null, ...over,
});

describe("a chosen report label survives a sync (NZC-108)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("labelclobber"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2025-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-1','f-diesel','Diesel — LGV','litres',2.5,ARRAY['1'])`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, JOB, ACTOR]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  const labelsOf = async (rowId: string) => (await db.query<{ source_label: string; report_label: string }>(
    `SELECT source_label, report_label FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;

  const rename = (rowId: string, label: string) => db.query(
    `UPDATE nzi_console.job_scope_rows SET report_label=$2 WHERE scope_row_id=$1`, [rowId, label]);

  const versionOf = async (sourceId: string) => (await db.query<{ version: number }>(
    `SELECT version FROM nzi_console.job_emission_sources WHERE source_id=$1`, [sourceId])).rows[0]!.version;

  it("keeps the consultant's name when the source behind the row is synced again", async () => {
    const made = await createEmissionSource(pool, source({ sourceName: "Site boiler" }), context("c-1"));
    const synced = await syncEmissionSourceToScope(pool, { jobId: JOB, sourceId: made.data.sourceId }, context("c-2"));
    assert.equal((await labelsOf(synced.data.rowId)).report_label, "Site boiler", "a new row is named after its source");

    await rename(synced.data.rowId, "Heating — main site");
    await syncEmissionSourceToScope(pool, { jobId: JOB, sourceId: made.data.sourceId }, context("c-3"));

    const after = await labelsOf(synced.data.rowId);
    assert.equal(after.report_label, "Heating — main site", "the name the client's report uses is the consultant's");
    assert.equal(after.source_label, "Site boiler", "and the source is still called what it is called");
  });

  it("keeps it through an ordinary edit to the source, which is how the loss actually happened", async () => {
    // Nobody syncs deliberately. A consultant edits the activity figure, the row re-syncs behind
    // them, and the label was gone — which is why this was invisible.
    const made = await createEmissionSource(pool, source({ sourceName: "Forklift diesel" }), context("c-4"));
    const synced = await syncEmissionSourceToScope(pool, { jobId: JOB, sourceId: made.data.sourceId }, context("c-5"));
    await rename(synced.data.rowId, "Site plant");

    await updateEmissionSourceActivity(pool, {
      jobId: JOB, sourceId: made.data.sourceId, expectedVersion: await versionOf(made.data.sourceId),
      quantity: 1500, unit: "litres", applyPct: 100, dataConfidence: "H", monthlyActivity: [], notes: null,
    }, context("c-6"));
    await syncEmissionSourceToScope(pool, { jobId: JOB, sourceId: made.data.sourceId }, context("c-7"));

    assert.equal((await labelsOf(synced.data.rowId)).report_label, "Site plant");
  });

  it("still follows the source when nobody has renamed the row", async () => {
    // The other half. An automatic label is not frozen by this fix — a renamed source must not keep
    // printing its old name in a client's report.
    const made = await createEmissionSource(pool, source({ sourceName: "Old name" }), context("c-8"));
    const synced = await syncEmissionSourceToScope(pool, { jobId: JOB, sourceId: made.data.sourceId }, context("c-9"));
    assert.equal((await labelsOf(synced.data.rowId)).report_label, "Old name");

    await db.query(
      `UPDATE nzi_console.job_emission_sources SET source_name='New name' WHERE source_id=$1`, [made.data.sourceId]);
    await syncEmissionSourceToScope(pool, { jobId: JOB, sourceId: made.data.sourceId }, context("c-10"));

    const after = await labelsOf(synced.data.rowId);
    assert.equal(after.source_label, "New name");
    assert.equal(after.report_label, "New name", "an untouched label keeps tracking its source");
  });

  it("keeps a chosen name on a group roll-up row too", async () => {
    // The second clobber site. A roll-up row is regenerated from its group on every reaggregation,
    // and was renamed back to the group's name each time.
    const group = await createEmissionSourceGroup(pool, {
      jobId: JOB, name: "Fleet", datasetId: "ds-1", factorId: "f-diesel", factorLabel: "Diesel — LGV", unit: "litres",
    }, context("g-1"));
    const groupId = group.data.groupId;
    await createEmissionSource(pool, source({ sourceName: "Van 1", groupId }), context("g-2"));
    const rolled = await syncEmissionSourceGroupToScope(pool, { jobId: JOB, groupId }, context("g-3"));
    const rowId = rolled.data.rowId!;
    assert.equal((await labelsOf(rowId)).report_label, "Fleet");

    await rename(rowId, "Company vehicles");
    await createEmissionSource(pool, source({ sourceName: "Van 2", groupId }), context("g-4"));
    await syncEmissionSourceGroupToScope(pool, { jobId: JOB, groupId }, context("g-5"));

    assert.equal((await labelsOf(rowId)).report_label, "Company vehicles",
      "reaggregating the group does not rename the row back");
  });
});
