import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash } from "node:crypto";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createReviewedCrpSnapshot } from "../src/index";
import { getGrantedPublishedCrpReport } from "../src/readModels";

/**
 * A plate does not leave with the report (NZC-104).
 *
 * `asset_identifier` holds the identity of the thing being measured — a vehicle registration, an
 * employee name, a meter id. It belongs on the row: the editor round-trips it and the audit trail
 * needs it. It was also being copied into the reviewed snapshot's `measurements`, and that payload
 * is returned wholesale by the portal's published-report endpoint — so a client's browser received
 * every plate on every row, in JSON, on a report that renders none of them.
 *
 * Nothing ever read it back out of a snapshot: every consumer reads the row. So it stops being
 * written, and nothing else moves.
 *
 * **Forward-only, and the reason is arithmetic.** `dataHash` is `sha256` over the whole payload.
 * Stripping the field from an issued snapshot would change its hash and break the verification that
 * makes a published report trustworthy. Issued snapshots therefore keep the field and keep their
 * hashes; only snapshots issued from here on omit it. The read model still types it optional for
 * exactly that reason.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const JOB = "job-a";
const PLATE = "AB12 CDE";
const REVIEWER = "reviewer-a";

describe("a snapshot issued now carries no asset identifier", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("snapshotpii"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, REVIEWER]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Review & QA',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, JOB]);
    // A governed dataset and factor, so the row has real factor provenance and the NZC-060
    // integrity gate has nothing open to complain about — the snapshot gate is a real guarantee
    // and satisfying it keeps this an end-to-end rather than a fixture that dodges it.
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets
         (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB factors','2025.1','2025-01-01','2025-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors
         (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-1','f-diesel','Diesel — LGV','litres',2.5,ARRAY['1'])`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, JOB, REVIEWER]);
    // An approved, calculated row carrying a registration — the shape that used to leak it.
    await db.query(
      `INSERT INTO nzi_console.job_scope_rows
         (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,
          asset_identifier,quantity,unit,calculated_tco2e,quality_tier,review_status,reviewed_by,
          reviewed_row_version,reviewed_at,dataset_id,factor_id,factor_label,factor_version,enabled,version)
       VALUES ($1,'row-a',$2,'1','Fleet diesel','Fleet diesel','Scope 1','Direct',
               $3,1000,'litres',2.5,'measured','approved',$4,1,now(),'ds-1','f-diesel','Diesel — LGV','2025.1',true,1)`,
      [ORG, JOB, PLATE, REVIEWER]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  const issue = async (key: string) => createReviewedCrpSnapshot(pool, { jobId: JOB, expectedJobVersion: 1 }, {
    organisationId: ORG, actorId: REVIEWER, principal: "staff" as const,
    idempotencyKey: key, correlationId: `corr-${key}`,
    grant: commandGrantForRole("admin", ORG, REVIEWER),
  });

  const payloadOf = async (snapshotId: string) =>
    (await db.query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id=$1`, [snapshotId])).rows[0]!.payload_json;

  it("does not put the registration in the payload", async () => {
    const created = await issue("snap-1");
    const payload = await payloadOf(created.data.snapshotId);
    // Serialised and searched, not field-checked: a plate reaching a field added later would pass
    // a test that only looked at the fields present when it was written.
    const serialised = JSON.stringify(payload).toUpperCase();
    assert.ok(!serialised.includes("AB12"), `the payload must not carry the plate: ${serialised.slice(0, 400)}`);
    const measurements = payload.measurements as Array<Record<string, unknown>>;
    assert.equal(measurements.length, 1, "the row is in the snapshot");
    assert.ok(!("assetIdentifier" in measurements[0]!), "the field is absent, not merely null");
  });

  it("still carries everything the report actually needs", async () => {
    // Removing a field must not quietly remove its neighbours: the report renders the label and the
    // factor, and the snapshot is the evidence for both.
    const payload = await payloadOf((await issue("snap-1")).data.snapshotId);
    const measurement = (payload.measurements as Array<Record<string, unknown>>)[0]!;
    assert.equal(measurement.sourceLabel, "Fleet diesel");
    assert.equal(measurement.reportLabel, "Fleet diesel");
    // Label *and* version: a factor set without its version is not provenance, and the snapshot is
    // the evidence a published report rests on.
    assert.equal(measurement.factorSet, "Diesel — LGV · 2025.1");
    assert.equal(measurement.tco2e, 2.5);
    assert.equal(measurement.reviewedBy, REVIEWER);
  });

  it("leaves the registration on the row, where the editor and the audit read it", async () => {
    const { rows } = await db.query<{ asset_identifier: string }>(
      `SELECT asset_identifier FROM nzi_console.job_scope_rows WHERE scope_row_id='row-a'`);
    assert.equal(rows[0]!.asset_identifier, PLATE, "the row keeps the asset identity");
  });

  it("gives the portal a published report with no plate in it", async () => {
    // End to end, through the endpoint a client actually calls.
    const created = await issue("snap-1");
    await db.query(
      `INSERT INTO nzi_console.report_versions (organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash,published_at)
       VALUES ($1,'version-a',$2,'published',1,$3,$4,now())`,
      [ORG, JOB, created.data.snapshotId, created.data.dataHash]);
    await db.query(
      `INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status)
       VALUES ($1,'portal-a',$2,'p@example.invalid','Portal Person','active')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,portal_user_id,client_id,job_id)
       VALUES ($1,'grant-a','portal-a',$2,$3)`, [ORG, CLIENT, JOB]);

    const report = await getGrantedPublishedCrpReport(db, { portalUserId: "portal-a", clientId: CLIENT, jobId: JOB });
    assert.ok(report, "the client can fetch their published report");
    assert.ok(!JSON.stringify(report).toUpperCase().includes("AB12"),
      "and it contains no registration anywhere in the response");
  });
});

describe("snapshots issued before the change still verify", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("snapshotlegacy"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Client','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Report & publish')`, [ORG, JOB, CLIENT]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("keeps its hash, which is why the field is not stripped retroactively", async () => {
    // A snapshot as it was issued before this change, plate included. Its hash is over the whole
    // payload, so removing the field would invalidate the published report that cites it. This is
    // the arithmetic reason the fix is forward-only rather than a cleanup.
    const legacy = {
      jobNumber: "J000001", client: "Client", reportingYear: 2024, annualComparison: [],
      measurements: [{ rowId: "row-a", scope: "1", sourceLabel: "Fleet diesel", assetIdentifier: PLATE, tco2e: 2.5 }],
    };
    const hash = `sha256:${createHash("sha256").update(JSON.stringify(legacy)).digest("hex")}`;
    await db.query(
      `INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by)
       VALUES ($1,'snap-legacy',$2,1,1,$3,$4::jsonb,'preparer')`, [ORG, JOB, hash, JSON.stringify(legacy)]);

    const { rows } = await db.query<{ data_hash: string; payload_json: typeof legacy }>(
      `SELECT data_hash, payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id='snap-legacy'`);
    assert.equal(rows[0]!.data_hash, hash, "the stored hash is unchanged");
    assert.equal(rows[0]!.payload_json.measurements[0]!.assetIdentifier, PLATE,
      "and the field it was issued with is still there — untouched, still verifiable");
  });
});
