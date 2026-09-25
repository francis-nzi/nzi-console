import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  AuthorizationError, CommandValidationError, createReviewedCrpSnapshot, listScopeRows, setClientFactorAlias,
} from "../src/index";

/**
 * What this client calls this factor, end to end (NZC-109).
 *
 * The arithmetic of precedence is proved in `@nzi/contracts/tests/reportLabelResolution.test.ts`.
 * What is proved here is that the name actually reaches the two places it has to: the live screen,
 * resolved on every read, and the issued snapshot, resolved once and frozen — and that it never
 * touches the measurement on its way.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";
const CLIENT = "client-a";
const OTHER_CLIENT = "client-b";
const JOB = "job-a";
const OTHER_JOB = "job-b";
const ACTOR = "consultant-a";
const FACTOR_LABEL = "Diesel — LGV";

const context = (key: string) => ({
  organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
  idempotencyKey: key, correlationId: `corr-${key}`,
  grant: commandGrantForRole("admin", ORG, ACTOR),
});

describe("a client's own name for a factor (NZC-109)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let pool: pg.Pool;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("factoralias"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,'admin','active')`,
      [ORG, ACTOR]);
    for (const [clientId, name] of [[CLIENT, "Client A"], [OTHER_CLIENT, "Client B"]]) {
      await db.query(
        `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$3,'active')`,
        [ORG, clientId, name]);
    }
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'ds-1','Synthetic GB','2025.1','2025-01-01','2025-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'ds-1','f-diesel',$2,'litres',2.5,ARRAY['1'])`, [ORG, FACTOR_LABEL]);
    for (const [jobId, clientId, sequence] of [[JOB, CLIENT, 1], [OTHER_JOB, OTHER_CLIENT, 2]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Review & QA',2025,'2025-01-01','2025-12-31')`, [ORG, jobId, clientId, sequence]);
      await db.query(
        `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
         VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, jobId]);
      await db.query(
        `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
         VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, jobId, ACTOR]);
    }

    // One approved row per client, each named after the factor — nobody has renamed a row.
    for (const [rowId, jobId] of [["row-a", JOB], ["row-b", OTHER_JOB]] as const) {
      await db.query(
        `INSERT INTO nzi_console.job_scope_rows
           (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,
            quantity,unit,calculated_tco2e,quality_tier,review_status,reviewed_by,reviewed_row_version,
            reviewed_at,dataset_id,factor_id,factor_label,factor_version,enabled,version)
         VALUES ($1,$2,$3,'1',$4,$4,'Scope 1','Direct',
                 1000,'litres',2.5,'measured','approved',$5,1,now(),'ds-1','f-diesel',$4,'2025.1',true,1)`,
        [ORG, rowId, jobId, FACTOR_LABEL, ACTOR]);
    }
  });

  after(async () => { await db?.end(); await database?.end(); });

  const labelOnScreen = async (jobId: string) => (await listScopeRows(db, jobId))[0]!.reportLabel;

  const measurementOf = async (snapshotId: string) => (await db.query<{ payload_json: { measurements: Array<Record<string, unknown>> } }>(
    `SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id=$1`, [snapshotId])).rows[0]!.payload_json.measurements[0]!;

  it("renames the row on every screen the moment it is set, with no row touched", async () => {
    assert.equal(await labelOnScreen(JOB), FACTOR_LABEL, "before: the factor's own name");

    await setClientFactorAlias(pool, { clientId: CLIENT, factorId: "f-diesel", label: "Fleet fuel" }, context("a-1"));

    assert.equal(await labelOnScreen(JOB), "Fleet fuel");
    // Resolved on read: the row itself is untouched, so there is nothing to migrate and nothing to
    // fall out of step.
    const stored = await db.query<{ report_label: string; source_label: string; version: number }>(
      `SELECT report_label, source_label, version FROM nzi_console.job_scope_rows WHERE scope_row_id='row-a'`);
    assert.equal(stored.rows[0]!.report_label, FACTOR_LABEL);
    assert.equal(stored.rows[0]!.version, 1, "renaming is not an edit to the measurement");
  });

  it("is one client's name and no one else's", async () => {
    // The row in the other client's job carries the same factor and keeps the factor's own name.
    assert.equal(await labelOnScreen(OTHER_JOB), FACTOR_LABEL);
  });

  it("never moves the factor", async () => {
    const row = (await listScopeRows(db, JOB))[0]!;
    assert.equal(row.factorId, "f-diesel");
    assert.equal(row.factorVersion, "2025.1");
    assert.equal(row.factorLabel, FACTOR_LABEL, "the factor is still called what the dataset calls it");
    assert.equal(row.calculatedTco2e, 2.5);
  });

  it("gives way to a name chosen on the row", async () => {
    await db.query(`UPDATE nzi_console.job_scope_rows SET report_label='This site only' WHERE scope_row_id='row-a'`);
    assert.equal(await labelOnScreen(JOB), "This site only", "the narrower decision wins");
    await db.query(`UPDATE nzi_console.job_scope_rows SET report_label=$1 WHERE scope_row_id='row-a'`, [FACTOR_LABEL]);
    assert.equal(await labelOnScreen(JOB), "Fleet fuel", "and the client's name resumes when it is undone");
  });

  it("is frozen into an issued report, which does not reword itself afterwards", async () => {
    const issued = await createReviewedCrpSnapshot(pool, { jobId: JOB, expectedJobVersion: 1 }, context("a-snap"));
    assert.equal((await measurementOf(issued.data.snapshotId)).reportLabel, "Fleet fuel");

    await setClientFactorAlias(pool, { clientId: CLIENT, factorId: "f-diesel", label: "Transport fuel" }, context("a-2"));
    assert.equal(await labelOnScreen(JOB), "Transport fuel", "the live view follows the new name");
    // A published report is evidence a client or auditor holds. It says what it said.
    assert.equal((await measurementOf(issued.data.snapshotId)).reportLabel, "Fleet fuel");
  });

  it("withdraws to the factor's own name, without deleting the record of having been set", async () => {
    await setClientFactorAlias(pool, { clientId: CLIENT, factorId: "f-diesel", label: null }, context("a-3"));
    assert.equal(await labelOnScreen(JOB), FACTOR_LABEL);
    const stored = await db.query<{ label: string; active: boolean }>(
      `SELECT label, active FROM nzi_console.client_factor_aliases WHERE client_id=$1 AND factor_id='f-diesel'`, [CLIENT]);
    assert.equal(stored.rows.length, 1, "the row stays, deactivated — a report issued under it stays explicable");
    assert.equal(stored.rows[0]!.active, false);
    assert.equal(stored.rows[0]!.label, "Transport fuel");
  });

  it("revives the same record when the client is named again", async () => {
    await setClientFactorAlias(pool, { clientId: CLIENT, factorId: "f-diesel", label: "Fleet fuel" }, context("a-4"));
    const stored = await db.query<{ label: string; active: boolean }>(
      `SELECT label, active FROM nzi_console.client_factor_aliases WHERE client_id=$1 AND factor_id='f-diesel'`, [CLIENT]);
    assert.equal(stored.rows.length, 1, "one name per client per factor, not a pile of them");
    assert.equal(stored.rows[0]!.active, true);
    assert.equal(stored.rows[0]!.label, "Fleet fuel");
  });

  it("is audited, as a decision somebody made", async () => {
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM nzi_console.audit_events WHERE entity_type='client_factor_alias' ORDER BY occurred_at`);
    assert.ok(rows.length >= 2, `expected the settings and the withdrawal to be audited, saw ${rows.length}`);
    assert.ok(rows.some((row) => row.action === "client_factor_alias_set"));
  });

  it("refuses a name for a factor that does not exist, and a blank one", async () => {
    // A name attached to nothing would sit in the table looking authoritative and resolve for no row.
    await assert.rejects(() => setClientFactorAlias(pool, {
      clientId: CLIENT, factorId: "f-nothing", label: "Ghost",
    }, context("a-5")), CommandValidationError);
    await assert.rejects(() => setClientFactorAlias(pool, {
      clientId: CLIENT, factorId: "f-diesel", label: "   ",
    }, context("a-7")), CommandValidationError);
  });

  it("refuses a client that is not yours before it looks at anything", async () => {
    // Not a validation failure: the access layer resolves which client a command touches before the
    // handler runs, so an unknown client is refused as out of tenancy rather than as a typo. That
    // ordering is the point — it is the same answer whether the client does not exist or belongs to
    // somebody else, so the command cannot be used to find out which.
    await assert.rejects(() => setClientFactorAlias(pool, {
      clientId: "client-nothing", factorId: "f-diesel", label: "Ghost",
    }, context("a-6")), AuthorizationError);
  });

  it("cannot be deleted, only deactivated", async () => {
    // Asserted two ways, because the first version of this test connected as `nzi_console_app` and
    // caught the *connection* being refused — the runtime roles are NOLOGIN, so the privilege was
    // never exercised at all and the test passed for the wrong reason.
    const { rows } = await db.query<{ granted: boolean }>(
      `SELECT has_table_privilege('nzi_console_app','nzi_console.client_factor_aliases','DELETE') AS granted`);
    assert.equal(rows[0]!.granted, false, "the grant is not there");

    // And the behaviour, by actually becoming that role for one statement.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    await assert.rejects(() => db.query(`DELETE FROM nzi_console.client_factor_aliases`), /permission denied/i);
    await db.query("ROLLBACK");
  });
});
