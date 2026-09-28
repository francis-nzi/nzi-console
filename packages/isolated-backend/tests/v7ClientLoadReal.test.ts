import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { openLegacyReport } from "../src/legacyReportSeal";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { migratedRecordProblems, planV7ClientImport, type ClientImportPlan } from "../src/v7ClientImport";
import { loadV7ClientPlan, V7ClientLoadRefused } from "../src/v7ClientLoad";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { JOB_100_PUBLISHED, SENTINELS, syntheticExtract, syntheticHeaders, syntheticRows } from "./support/v7SyntheticExtract";

/**
 * The v7 client-and-job load against a real database (docs/CLIENT_JOB_IMPORT_DESIGN.md §8), on the synthetic extract:
 * a dry run that is the load rolled back; one transaction per client; reconcile-by-reading on a re-run; a changed or
 * edited record refusing its client alone; a job-number clash refusing its client (decision 1a); and the depth test run
 * over what the table actually holds.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
type Rows = ReturnType<typeof syntheticRows>;
const plan = (mutate?: (rows: Rows) => void): ClientImportPlan => {
  const rows = syntheticRows();
  mutate?.(rows);
  return planV7ClientImport({ extract: syntheticExtract(rows), headers: syntheticHeaders(), extractSha256: "synthetic-sha" });
};

describe("loading v7 clients and jobs", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const count = async (table: string, where = "source_system='nzi-pro-v7'") =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.${table} WHERE ${where}`)).rows[0]!.n;

  before(async () => {
    database = (await createDisposableDatabase("v7clientload"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("refuses a plan that carries a refusal, writing nothing", async () => {
    await assert.rejects(loadV7ClientPlan(database.pool, plan((rows) => { rows.jobs[0]!.job_number = "612"; }), { commit: true }), V7ClientLoadRefused);
    assert.equal(await count("clients"), 0);
  });

  it("dry-runs the whole load and keeps nothing", async () => {
    const outcome = await loadV7ClientPlan(database.pool, plan(), { commit: false });
    assert.deepEqual(outcome.clients.map((client) => client.state), ["loaded", "loaded"], "every constraint and trigger was exercised");
    assert.equal(outcome.clients[0]!.inserted.rows, 11, "jobs 100 and 106");
    for (const table of ["clients", "client_sites", "client_contacts", "jobs", "job_scope_rows", "legacy_report_versions"]) {
      assert.equal(await count(table), 0, `${table} kept a row from a dry run`);
    }
    assert.equal(await count("audit_events", "actor_id='import:nzi-pro-v7'"), 0);
  });

  it("loads in foreign-key order, one transaction per client, and moves the counter past v7's numbers", async () => {
    const outcome = await loadV7ClientPlan(database.pool, plan(), { commit: true, runId: "run-1" });
    assert.deepEqual(outcome.clients.map((client) => [client.clientId, client.state]), [["v7-client-1", "loaded"], ["v7-client-2", "loaded"]]);
    assert.deepEqual(
      [await count("clients"), await count("client_sites"), await count("client_contacts"), await count("jobs"), await count("job_scope_rows"), await count("legacy_report_versions")],
      [2, 3, 3, 6, 11, 4]);
    assert.ok(outcome.counterAt! >= 617, `the counter stands at ${outcome.counterAt}, behind v7's J000617`);
    const job = await db.query(`SELECT job_number, job_family, status, workflow_stage, legacy_job_number FROM nzi_console.jobs WHERE job_id='v7-job-100'`);
    assert.deepEqual(job.rows, [{ job_number: "J000612", job_family: "crp", status: "complete", workflow_stage: "Completed", legacy_job_number: "J000612" }]);
    const config = await db.query(`SELECT reporting_from::text AS f, reporting_to::text AS t FROM nzi_console.job_emissions_config WHERE job_id='v7-job-100'`);
    assert.deepEqual(config.rows, [{ f: "2023-01-01", t: "2023-12-31" }]);
    const target = await db.query(`SELECT benchmark_year, scope1_year, scope1_pct::float AS pct FROM nzi_console.client_targets WHERE client_id='v7-client-1' AND version=1`);
    assert.deepEqual(target.rows, [{ benchmark_year: 2019, scope1_year: 2030, pct: 50 }]);
  });

  it("stores v7's reported figures, which total to the published snapshot", async () => {
    const { rows } = await db.query<{ scope: string; t: number }>(
      `SELECT scope, round(sum(round(calculated_tco2e, 2)), 2)::float AS t FROM nzi_console.job_scope_rows
        WHERE job_id='v7-job-100' AND enabled GROUP BY scope ORDER BY scope`);
    assert.deepEqual(rows, [{ scope: "1", t: JOB_100_PUBLISHED["Scope 1"] }, { scope: "2", t: JOB_100_PUBLISHED["Scope 2"] }, { scope: "3", t: JOB_100_PUBLISHED["Scope 3"] }]);
    await assert.rejects(db.query(`UPDATE nzi_console.job_scope_rows SET calculated_tco2e=0 WHERE scope_row_id='v7-row-1000'`), /migrated/,
      "a migrated row is immutable (0133)");
  });

  it("seals every contact and every report, and registers no report as a subject", async () => {
    const contacts = await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_contacts WHERE source_system='nzi-pro-v7' AND full_name_sealed IS NOT NULL`);
    assert.equal(contacts.rows[0]!.n, 3);
    const emailed = await db.query(`SELECT email_sealed IS NOT NULL AND email_bidx IS NOT NULL AS ok FROM nzi_console.client_contacts WHERE contact_id='v7-contact-21'`);
    assert.deepEqual(emailed.rows, [{ ok: true }]);
    const versions = await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_contact_versions WHERE contact_id LIKE 'v7-contact-%'`);
    assert.equal(versions.rows[0]!.n, 3, "each contact's first version recorded, as a console-created contact's is");

    const report = (await db.query(`SELECT payload_sealed, payload_sha256, particulars_sealed, content_key_wrapped, is_portal_version, legacy_status
      FROM nzi_console.legacy_report_versions WHERE legacy_report_id='v7-report-7001'`)).rows[0]!;
    const opened = openLegacyReport(report, resolveSealingKeys().masterKey);
    assert.equal(JSON.parse(opened.payloadText!).scope_totals.Total, 21.08);
    assert.equal(opened.particulars?.approvedByEmail, "bo@example.invalid");
    assert.deepEqual([report.is_portal_version, report.legacy_status], [true, "final"]);
    const raw = await db.query<{ text: string }>(`SELECT string_agg(to_jsonb(v)::text, '') AS text FROM nzi_console.legacy_report_versions v`);
    assert.doesNotMatch(raw.rows[0]!.text, /Ada Example|bo@example|ZZSENTINEL/, "a name reached the report table in the clear");
    assert.equal(await count("data_subject_links", "source_table='legacy_report_versions'"), 0);
  });

  it("holds every stored migrated_record to its closed shape, at every depth, with no sentinel anywhere", async () => {
    const { rows } = await db.query<{ id: string; record: unknown; provenance: unknown; lineage: unknown }>(
      `SELECT scope_row_id AS id, migrated_record AS record, provenance_json AS provenance, lineage_json AS lineage
         FROM nzi_console.job_scope_rows WHERE origin='migrated'`);
    assert.equal(rows.length, 11);
    for (const row of rows) {
      assert.deepEqual(migratedRecordProblems(row.record), [], row.id);
      const stored = JSON.stringify([row.record, row.provenance, row.lineage]);
      for (const sentinel of SENTINELS) assert.ok(!stored.includes(sentinel), `${row.id} carries "${sentinel}"`);
    }
  });

  it("audits the load as one act per client and per job, naming the run and the extract, with no personal data", async () => {
    const { rows } = await db.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM nzi_console.audit_events WHERE actor_id='import:nzi-pro-v7' GROUP BY action ORDER BY action`);
    assert.deepEqual(rows, [{ action: "client.imported", n: 2 }, { action: "job.imported", n: 6 }]);
    const payloads = await db.query<{ text: string }>(`SELECT string_agg(after_json::text, '') AS text FROM nzi_console.audit_events WHERE actor_id='import:nzi-pro-v7'`);
    assert.match(payloads.rows[0]!.text, /synthetic-sha/);
    assert.doesNotMatch(payloads.rows[0]!.text, /Ada|Example|ZZSENTINEL|@/);
  });

  it("re-runs as a no-op: every record found identical, nothing written", async () => {
    const events = await count("audit_events", "actor_id='import:nzi-pro-v7'");
    const outcome = await loadV7ClientPlan(database.pool, plan(), { commit: true, runId: "run-2" });
    assert.deepEqual(outcome.clients.map((client) => client.state), ["unchanged", "unchanged"]);
    assert.equal(outcome.clients[0]!.unchanged.rows, 11);
    assert.equal(outcome.counterAt, null, "no job inserted, so the counter is not touched");
    assert.equal(await count("audit_events", "actor_id='import:nzi-pro-v7'"), events);
  });

  it("refuses a client whose v7 history changed after migration, and loads the others", async () => {
    const outcome = await loadV7ClientPlan(database.pool, plan((rows) => {
      rows.job_scope_rows[0]!.qty = "20000";
      rows.clients[1]!.website = "https://beta.example.invalid"; // client 2's master record changed too…
    }), { commit: true, runId: "run-3" });
    assert.equal(outcome.clients[0]!.state, "refused");
    assert.match(outcome.clients[0]!.refusal!, /row v7-row-1000 of J000612 is already loaded and differs in quantity, calculated_tco2e, provenance_json, lineage_json, migrated_record/);
    assert.equal(outcome.clients[1]!.state, "refused", "…and is refused on its own account, not because of client 1");
    const kept = await db.query(`SELECT quantity::float AS q FROM nzi_console.job_scope_rows WHERE scope_row_id='v7-row-1000'`);
    assert.deepEqual(kept.rows, [{ q: 10000 }]);
  });

  it("refuses a client edited here since the load, naming the column", async () => {
    await db.query(`UPDATE nzi_console.clients SET name='Alpha (renamed here)' WHERE client_id='v7-client-1'`);
    const outcome = await loadV7ClientPlan(database.pool, plan(), { commit: true, runId: "run-4" });
    assert.match(outcome.clients[0]!.refusal!, /client v7-client-1 is already loaded and differs in name/);
    assert.equal(outcome.clients[1]!.state, "unchanged");
    await db.query(`UPDATE nzi_console.clients SET name='Synthetic Alpha Ltd' WHERE client_id='v7-client-1'`);
  });

  it("refuses a client whose job number another organisation already holds, leaving none of that client behind", async () => {
    const fresh = (await createDisposableDatabase("v7clientclash"))!;
    const admin = await fresh.admin();
    try {
      await admin.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ('demo-clash', 'Demo') ON CONFLICT DO NOTHING`).catch(async () =>
        admin.query(`INSERT INTO nzi_console.organisations (organisation_id) VALUES ('demo-clash') ON CONFLICT DO NOTHING`));
      await admin.query(`SELECT set_config('app.organisation_id', 'demo-clash', false)`);
      await admin.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ('demo-clash','demo-client','Demo','active')`);
      await admin.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
        VALUES ('demo-clash','demo-job','demo-client',614,'crp','Demo','open','Setup')`);

      const outcome = await loadV7ClientPlan(fresh.pool, plan(), { commit: true, runId: "run-clash" });
      assert.equal(outcome.clients[0]!.state, "loaded");
      assert.equal(outcome.clients[1]!.state, "refused");
      assert.match(outcome.clients[1]!.refusal!, /already held by another job[\s\S]*retire the demo-organisation clash first/);
      await admin.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
      const left = await admin.query(`SELECT count(*)::int AS n FROM nzi_console.clients WHERE client_id='v7-client-2'`);
      assert.equal(left.rows[0]!.n, 0, "one transaction per client: nothing of it was kept");
    } finally {
      await admin.end();
      await fresh.end();
    }
  });
});
