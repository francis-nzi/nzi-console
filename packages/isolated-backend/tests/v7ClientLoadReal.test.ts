import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { openLegacyReport } from "../src/legacyReportSeal";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { migratedRecordProblems, planV7ClientImport, type ClientImportPlan } from "../src/v7ClientImport";
import { loadV7ClientPlan, V7ClientLoadRefused } from "../src/v7ClientLoad";
import { randomUUID } from "node:crypto";
import { withTenantWrite } from "../src/postgres";
import type { PlannedRow } from "../src/v7ClientImport";
import { summariseV7JobForImport } from "../src/v7ImportSummary";
import { resyncV7JobInTransaction, V7_RESYNC_ACTOR } from "../src/v7Resync";
import { mergeV7DuplicateSites, planV7DuplicateSiteMerges, V7_SITE_MERGE_ACTOR, type RuledRowMove } from "../src/v7SiteLinks";
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
      [2, 2, 3, 6, 11, 4]);
    // 0235: V7 site 13 "head office" repeats site 11 "Head Office" and has no entries, so it maps to it; no suffixed site.
    const links = await db.query(`SELECT v7_site_id, site_id, reason FROM nzi_console.v7_site_links ORDER BY link_no`);
    assert.deepEqual(links.rows, [
      { v7_site_id: "11", site_id: "v7-site-11", reason: "import" }, { v7_site_id: "12", site_id: "v7-site-12", reason: "import" },
      { v7_site_id: "13", site_id: "v7-site-11", reason: "name-match" },
    ]);
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

// ── Duplicate sites (0235), appended so the migrations job runs them with this file ──

/**
 * Duplicate sites (SWEEP-v7-duplicate-sites.md, ruled 25 Nov 2026; 0235), against a real database, on the synthetic extract
 * shaped as the 29 Sep import left J000434 and Bryson Tractors:
 *   - "Langtons": V7 sites 69 (no entries) and 70 (entries), the second suffixed " (v7 site 70)";
 *   - "Yard": V7 sites 294 and 295, both with entries, the second suffixed (Bryson's shape: ruled to merge, rows move);
 *   - two nameless V7 sites, one with entries (flagged for naming) and one without (archived).
 */

const CLIENT = "v7-client-1";
const JOB = "v7-job-100";

/** The extract with the four shapes; `names` gives V7's site names (the load first sees stand-ins, then V7's own). */
function rowsWith(names: { 70: string; 295: string; 80: string | null }, mutate?: (rows: Rows) => void): Rows {
  const rows = syntheticRows();
  rows.client_sites.push(
    { site_id: "69", client_db_id: "1", site_name: "Langtons", archived: "f" },
    { site_id: "70", client_db_id: "1", site_name: names[70], archived: "f" },
    { site_id: "294", client_db_id: "1", site_name: "Yard", archived: "f" },
    { site_id: "295", client_db_id: "1", site_name: names[295], archived: "f" },
    { site_id: "80", client_db_id: "1", site_name: names[80], archived: "f" },
    { site_id: "81", client_db_id: "1", site_name: null, archived: "f" },
  );
  const at = (id: string, site: string) => { rows.job_scope_rows.find((row) => row.row_id === id)!.site_id = site; };
  at("1000", "294"); at("1001", "294"); at("1002", "294");
  at("1003", "295"); at("1004", "295");
  at("1006", "70"); at("1007", "70");
  at("1100", "80");
  mutate?.(rows);
  return rows;
}
const planOf = (rows: Rows): ClientImportPlan =>
  planV7ClientImport({ extract: syntheticExtract(rows), headers: syntheticHeaders(), extractSha256: "synthetic-sha" });
const V7_NAMES = { 70: "Langtons", 295: "Yard", 80: null } as const;
const jobRows = (plan: ClientImportPlan, jobId = JOB): PlannedRow[] =>
  plan.clients.flatMap((client) => client.jobs).find((job) => job.jobId === jobId)!.rows;
const BRYSON_SHAPE: RuledRowMove[] = [{ clientId: CLIENT, survivorSiteId: "v7-site-294", duplicateSiteIds: ["v7-site-295"], ruling: "test" }];
const context = { organisationId: ORG, actorId: V7_SITE_MERGE_ACTOR, reason: "the duplicate-site test" };

describe("duplicate v7 sites: merged once, never minted again", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const sites = async () => (await db.query<{ site_id: string; name: string; archived: boolean; merged_into_site_id: string | null; name_needs_review: boolean }>(
    `SELECT site_id, name, archived, merged_into_site_id, name_needs_review FROM nzi_console.client_sites WHERE client_id = $1 ORDER BY site_id`, [CLIENT])).rows;
  const link = async (v7: string) => (await db.query<{ site_id: string }>(
    `SELECT site_id FROM nzi_console.v7_site_links WHERE v7_site_id = $1 ORDER BY link_no DESC LIMIT 1`, [v7])).rows[0]?.site_id;
  const byScope = async () => (await db.query<{ scope: string; t: string; n: number }>(
    `SELECT scope, round(sum(calculated_tco2e) FILTER (WHERE enabled), 6)::text AS t, count(*)::int AS n FROM nzi_console.job_scope_rows
      WHERE job_id = $1 AND superseded_by_row_id IS NULL GROUP BY scope ORDER BY scope`, [JOB])).rows;
  const bySite = async () => (await db.query<{ site_id: string | null; t: string }>(
    `SELECT site_id, round(sum(calculated_tco2e), 6)::text AS t FROM nzi_console.job_scope_rows
      WHERE job_id = $1 AND enabled AND superseded_by_row_id IS NULL GROUP BY site_id ORDER BY site_id NULLS FIRST`, [JOB])).rows;
  let scopeBefore: Awaited<ReturnType<typeof byScope>>;

  before(async () => {
    database = (await createDisposableDatabase("v7sitemerge"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    // The 29 Sep state: each V7 site its own console site, the repeats suffixed. Stand-in names keep the load from matching them;
    // the suffix is then written as the old importer wrote it.
    const outcome = await loadV7ClientPlan(database.pool, planOf(rowsWith({ 70: "Langtons stand-in", 295: "Yard stand-in", 80: null })), { commit: true, runId: "run-sep" });
    assert.deepEqual(outcome.clients.map((client) => client.state), ["loaded", "loaded"]);
    await db.query(`UPDATE nzi_console.client_sites SET name = 'Langtons (v7 site 70)' WHERE site_id = 'v7-site-70'`);
    await db.query(`UPDATE nzi_console.client_sites SET name = 'Yard (v7 site 295)' WHERE site_id = 'v7-site-295'`);
    scopeBefore = await byScope();
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("imports a nameless V7 site with entries flagged for naming, and one with none archived", async () => {
    const all = await sites();
    assert.deepEqual(all.filter((site) => ["v7-site-80", "v7-site-81"].includes(site.site_id)).map((site) => [site.site_id, site.name, site.archived, site.name_needs_review]), [
      ["v7-site-80", "Unnamed site", false, true], ["v7-site-81", "Unnamed site 2", true, false],
    ]);
  });

  it("plans Langtons to merge on the site with entries, and holds a group where both have entries unless ruled", async () => {
    const plan = await withTenantWrite(database.pool, ORG, (tx) => planV7DuplicateSiteMerges(tx, ORG, []));
    assert.deepEqual(plan.merge.map((group) => [group.name, group.survivor.siteId, group.duplicates.map((site) => site.siteId), group.rowsMoving]), [
      ["Langtons", "v7-site-70", ["v7-site-69"], 0],
    ]);
    assert.deepEqual(plan.held.map((group) => [group.name, group.siteIds, group.why]), [["Yard", ["v7-site-294", "v7-site-295"], "more than one of these sites has entries"]]);
  });

  it("a dry run is the whole merge rolled back: nothing written", async () => {
    const fingerprint = async () => (await db.query<{ f: string }>(
      `SELECT md5(coalesce((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY site_id) FROM nzi_console.client_sites s), '')
        || coalesce((SELECT string_agg(to_jsonb(r)::text, '|' ORDER BY scope_row_id) FROM nzi_console.job_scope_rows r), '')
        || (SELECT count(*) FROM nzi_console.v7_site_links)::text || (SELECT count(*) FROM nzi_console.audit_events)::text) AS f`)).rows[0]!.f;
    const was = await fingerprint();
    const outcome = await mergeV7DuplicateSites(database.pool, context, { commit: false, ruled: BRYSON_SHAPE });
    assert.equal(outcome.plan.merge.length, 2);
    assert.equal(outcome.rowsMoved, 2);
    assert.equal(await fingerprint(), was);
  });

  it("merges: Langtons is one site with no row moved; Yard's duplicate's 2 rows move, each audited; both retired, never deleted", async () => {
    const outcome = await mergeV7DuplicateSites(database.pool, context, { commit: true, ruled: BRYSON_SHAPE });
    assert.deepEqual(outcome.plan.held, []);
    const all = await sites();
    const live = all.filter((site) => site.merged_into_site_id === null);
    assert.ok(!all.some((site) => /\(v7 site/i.test(site.name)), "no name carries the suffix");
    assert.deepEqual(live.filter((site) => /langtons/i.test(site.name)).map((site) => [site.site_id, site.name]), [["v7-site-70", "Langtons"]]);
    assert.deepEqual(all.filter((site) => site.merged_into_site_id).map((site) => [site.site_id, site.name, site.archived, site.merged_into_site_id]), [
      ["v7-site-295", "Yard", true, "v7-site-294"], ["v7-site-69", "Langtons", true, "v7-site-70"],
    ]);
    assert.deepEqual([await link("69"), await link("70"), await link("294"), await link("295")], ["v7-site-70", "v7-site-70", "v7-site-294", "v7-site-294"]);
    const moved = (await db.query<{ entity_id: string; before_json: { siteId: string }; after_json: { siteId: string } }>(
      `SELECT entity_id, before_json, after_json FROM nzi_console.audit_events WHERE action = 'job.scope_row.site_moved' ORDER BY entity_id`)).rows;
    assert.deepEqual(moved.map((event) => [event.entity_id, event.before_json.siteId, event.after_json.siteId]), [
      ["v7-row-1003", "v7-site-295", "v7-site-294"], ["v7-row-1004", "v7-site-295", "v7-site-294"],
    ]);
    const merged = (await db.query<{ entity_id: string }>(`SELECT entity_id FROM nzi_console.audit_events WHERE action = 'client.site.merged' ORDER BY entity_id`)).rows;
    assert.deepEqual(merged.map((event) => event.entity_id), ["v7-site-295", "v7-site-69"]);
  });

  it("the job's per-scope totals are unchanged by the merge, and it still matches V7 per scope and per site", async () => {
    assert.deepEqual(await byScope(), scopeBefore, "per scope, the merge moved no figure");
    // V7's side: the plan of V7's own records, each at its V7 site resolved to the console site.
    const plan = planOf(rowsWith(V7_NAMES));
    const summary = await withTenantWrite(database.pool, ORG, (tx) => summariseV7JobForImport(tx, {
      organisationId: ORG, jobId: JOB, legacyJobNumber: "J000612", extractSha256: "a".repeat(64), rows: jobRows(plan) }));
    assert.deepEqual([...new Set(summary.rows.map((row) => row.status))], ["matched"], "every row matches V7, its site included");
    const expected = new Map<string, number>();
    const survivor = (siteId: string | null) => siteId === "v7-site-69" ? "v7-site-70" : siteId === "v7-site-295" ? "v7-site-294" : siteId;
    for (const row of jobRows(plan).filter((row) => row.enabled)) {
      const key = survivor(row.siteId) ?? "none";
      expected.set(key, (expected.get(key) ?? 0) + row.calculatedTco2e);
    }
    const held = new Map((await bySite()).map((row) => [row.site_id ?? "none", Number(row.t)]));
    assert.deepEqual([...held.keys()].sort(), [...expected.keys()].sort());
    for (const [site, total] of expected) assert.ok(Math.abs(held.get(site)! - total) < 1e-6, `${site}: ${held.get(site)} vs V7 ${total}`);
  });

  it("a re-import with V7's own names creates no site and no duplicate, and takes a name V7 now gives a nameless site", async () => {
    const count = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.client_sites`)).rows[0]!.n;
    const was = await count();
    const again = await loadV7ClientPlan(database.pool, planOf(rowsWith(V7_NAMES)), { commit: true, runId: "run-again" });
    assert.deepEqual(again.clients.map((client) => [client.clientId, client.state, client.inserted.sites]), [[CLIENT, "unchanged", 0], ["v7-client-2", "unchanged", 0]]);
    assert.equal(await count(), was);
    // Named in V7 since: the next load takes the name and clears the flag.
    const named = await loadV7ClientPlan(database.pool, planOf(rowsWith({ ...V7_NAMES, 80: "Great Yarmouth" })), { commit: true, runId: "run-named" });
    assert.equal(named.clients[0]!.refusal, undefined);
    const site80 = (await sites()).find((site) => site.site_id === "v7-site-80")!;
    assert.deepEqual([site80.name, site80.name_needs_review], ["Great Yarmouth", false]);
    assert.equal(await count(), was);
  });

  it("a re-sync lands a merged site's rows, from either V7 site, on the survivor, and creates no site", async () => {
    const count = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.client_sites`)).rows[0]!.n;
    const was = await count();
    // V7 now holds row 1006 on site 69 (unchanged otherwise), and row 1007 on site 69 with a new quantity.
    const plan = planOf(rowsWith({ ...V7_NAMES, 80: "Great Yarmouth" }, (rows) => {
      const row = (id: string) => rows.job_scope_rows.find((candidate) => candidate.row_id === id)!;
      row("1006").site_id = "69";
      row("1007").site_id = "69"; row("1007").qty = "60";
    }));
    const result = await withTenantWrite(database.pool, ORG, (tx) => resyncV7JobInTransaction(tx, {
      jobId: JOB, runId: `v7-resync-${randomUUID()}`, extractSha256: "b".repeat(64), rows: jobRows(plan),
    }, { organisationId: ORG, actorId: V7_RESYNC_ACTOR, principal: "system", reason: "the duplicate-site test" }));
    assert.deepEqual(result.superseded.map((entry) => entry.rowId), ["v7-row-1007"], "1006 on V7 site 69 is the same row on the survivor");
    const placed = (await db.query<{ scope_row_id: string; site_id: string }>(
      `SELECT scope_row_id, site_id FROM nzi_console.job_scope_rows WHERE legacy_db_id IN ('1006','1007') AND superseded_by_row_id IS NULL ORDER BY scope_row_id`)).rows;
    assert.deepEqual(placed.map((row) => [row.scope_row_id, row.site_id]), [["v7-row-1006", "v7-site-70"], ["v7-row-1007-r1", "v7-site-70"]]);
    assert.equal(await count(), was);
  });

  it("guards: a migrated row's site moves only onto its own site's survivor, and the links are append-only", async () => {
    await assert.rejects(db.query(`UPDATE nzi_console.job_scope_rows SET site_id = 'v7-site-12' WHERE scope_row_id = 'v7-row-1000'`), /merged into/);
    await assert.rejects(db.query(`UPDATE nzi_console.v7_site_links SET site_id = 'v7-site-12'`), /append-only/);
    await assert.rejects(db.query(`DELETE FROM nzi_console.v7_site_links`), /append-only/);
    await assert.rejects(db.query(`UPDATE nzi_console.client_sites SET merged_into_site_id = 'v7-site-12' WHERE site_id = 'v7-site-11'`), /client_sites_merged_is_retired/);
  });
});

describe("a fresh import of two same-named v7 sites", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  before(async () => {
    database = (await createDisposableDatabase("v7sitefresh"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("refuses the client for a person where both have entries, and maps one onto the other where one has none", async () => {
    const both = await loadV7ClientPlan(database.pool, planOf(rowsWith(V7_NAMES)), { commit: true, runId: "run-both" });
    assert.equal(both.clients[0]!.state, "refused");
    assert.match(both.clients[0]!.refusal!, /share a name on v7-client-1 and both have entries/);
    const one = await loadV7ClientPlan(database.pool, planOf(rowsWith(V7_NAMES, (rows) => {
      for (const row of rows.job_scope_rows) if (row.site_id === "295") row.site_id = "294";
    })), { commit: true, runId: "run-one" });
    assert.equal(one.clients[0]!.state, "loaded");
    const names = (await db.query<{ site_id: string; name: string }>(`SELECT site_id, name FROM nzi_console.client_sites WHERE client_id = $1 ORDER BY site_id`, [CLIENT])).rows;
    assert.ok(!names.some((site) => /\(v7 site/i.test(site.name)));
    assert.deepEqual(names.filter((site) => /langtons|yard/i.test(site.name)).map((site) => [site.site_id, site.name]), [["v7-site-294", "Yard"], ["v7-site-69", "Langtons"]]);
    const rows = (await db.query<{ legacy_db_id: string; site_id: string }>(`SELECT legacy_db_id, site_id FROM nzi_console.job_scope_rows WHERE legacy_db_id IN ('1006','1007') ORDER BY 1`)).rows;
    assert.deepEqual(rows.map((row) => row.site_id), ["v7-site-69", "v7-site-69"], "V7 site 70's rows land on the same-named site");
  });
});
