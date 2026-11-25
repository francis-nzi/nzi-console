import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { withTenantWrite } from "../src/postgres";
import { planV7ClientImport, type ClientImportPlan, type PlannedRow } from "../src/v7ClientImport";
import { loadV7ClientPlan } from "../src/v7ClientLoad";
import { summariseV7JobForImport } from "../src/v7ImportSummary";
import { resyncV7JobInTransaction, V7_RESYNC_ACTOR } from "../src/v7Resync";
import { mergeV7DuplicateSites, planV7DuplicateSiteMerges, V7_SITE_MERGE_ACTOR, type RuledRowMove } from "../src/v7SiteLinks";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticHeaders, syntheticRows } from "./support/v7SyntheticExtract";

/**
 * Duplicate sites (SWEEP-v7-duplicate-sites.md, ruled 25 Nov 2026; 0235), against a real database, on the synthetic extract
 * shaped as the 29 Sep import left J000434 and Bryson Tractors:
 *   - "Langtons": V7 sites 69 (no entries) and 70 (entries), the second suffixed " (v7 site 70)";
 *   - "Yard": V7 sites 294 and 295, both with entries, the second suffixed (Bryson's shape: ruled to merge, rows move);
 *   - two nameless V7 sites, one with entries (flagged for naming) and one without (archived).
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
const CLIENT = "v7-client-1";
const JOB = "v7-job-100";
type Rows = ReturnType<typeof syntheticRows>;

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
