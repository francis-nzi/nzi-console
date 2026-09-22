import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { readJobEmissions, scopeShares } from "../src/emissionsAggregation";

/**
 * The live emissions aggregation, against real Postgres (NZC-143, NZC-144).
 *
 * Two claims carry this, and both are about the location rule rather than about arithmetic:
 *
 *   1. **A market-based row contributes 0 to every tier** — headline, its scope band, its category — and
 *      is still fully readable, carrying its own value so a surface can show it in parentheses.
 *   2. **The rule can fail.** A same-size location row sits beside the market one, so the two totals
 *      differ by exactly the market row's value. Without that pair, "market contributes 0" would pass
 *      just as well over a table with no market rows in it — which is what the rule looked like before
 *      0109, when nothing could be market-based at all.
 *
 * The constraints from 0109 are asserted here too, because the reason they exist is that they make a
 * whole class of undercount unrepresentable, and a CHECK nobody tests is a comment.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-agg";
const OTHER = "org-other";
const JOB = "job-1";

/** One figure, used for both the market row and its location twin, so the difference is unambiguous. */
const TWIN = 250;

describe("the live emissions aggregation (NZC-144)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  const row = async (
    id: string,
    fields: {
      scope: string; tco2e: number | null; site?: string | null; category?: string | null;
      method?: "location" | "market" | null; show?: boolean; enabled?: boolean; override?: number | null;
      organisation?: string; job?: string;
    },
  ) => {
    const organisation = fields.organisation ?? ORG;
    await db.query(
      // `report_label`, `level_1` and `level_2` are NOT NULL with no default, so the fixture supplies
      // them; none of them affects what this suite measures.
      `INSERT INTO nzi_console.job_scope_rows
         (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,site_id,category_code,
          calculated_tco2e,override_tco2e,override_reason,scope2_method,show_in_report,enabled)
       VALUES ($1,$2,$3,$4,$5,$5,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [organisation, id, fields.job ?? JOB, fields.scope, `Row ${id}`, fields.site ?? null,
        fields.category ?? null, fields.tco2e, fields.override ?? null,
        fields.override == null ? null : "stated", fields.method ?? null,
        fields.show ?? true, fields.enabled ?? true]);
  };

  before(async () => {
    database = (await createDisposableDatabase("emissagg"))!;
    db = await database.admin();
    for (const organisation of [ORG, OTHER]) {
      await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [organisation]);
      await db.query(`SELECT nzi_console.provision_organisation($1)`, [organisation]);
    }
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-1','Acme','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
       VALUES ($1,$2,'client-1',1,'crp','CRP','open','setup')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.client_sites (organisation_id,client_id,site_id,name,is_registered_office,created_by)
       VALUES ($1,'client-1','site-a','Site A',true,'seed'), ($1,'client-1','site-b','Site B',false,'seed')`, [ORG]);

    // Scope 1, two sites.
    await row("s1-a", { scope: "1", tco2e: 100, site: "site-a", category: "1.natural-gas" });
    await row("s1-b", { scope: "1", tco2e: 40, site: "site-b", category: "1.natural-gas" });

    // Scope 2: the twins. Same figure, same site, same category — one location, one market.
    await row("s2-loc", { scope: "2", tco2e: TWIN, site: "site-a", category: "2.purchased-electricity", method: "location" });
    await row("s2-mkt", { scope: "2", tco2e: TWIN, site: "site-a", category: "2.purchased-electricity", method: "market" });
    // A Scope 2 row with no method at all, which 0109 permits and the rule counts.
    await row("s2-null", { scope: "2", tco2e: 10, site: "site-a", category: "2.purchased-electricity", method: null });

    // Scope 3, and one disabled row that must not count.
    await row("s3-1", { scope: "3.6", tco2e: 60, site: "site-b", category: "3.business-travel" });
    await row("s3-off", { scope: "3.6", tco2e: 999, site: "site-b", category: "3.business-travel", enabled: false });

    // An override beats the calculation, as everywhere else that reads a row's emissions.
    await row("s3-ovr", { scope: "3.5", tco2e: 5, override: 7, site: "site-a", category: "3.waste" });

    // Another tenant's job, same job id, to prove the read is confined.
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [OTHER]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-1','Other','active')`, [OTHER]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
       VALUES ($1,$2,'client-1',2,'crp','CRP','open','setup')`, [OTHER, JOB]);
    await row("other-1", { scope: "1", tco2e: 100000, organisation: OTHER });
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The location rule, and that it can fail ─────────────────────────────────────────

  it("excludes a market row from every total while still reading its value", async () => {
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB });

    // 100 + 40 (scope 1) + 250 + 10 (scope 2 location and unstated) + 60 (3.6) + 7 (override) = 467.
    // The market twin's 250 is absent from that, and the disabled 999 with it.
    assert.equal(emissions.headline.tco2e, 467);
    assert.equal(emissions.headline.marketTco2e, TWIN, "and the market figure is reported alongside, not lost");
    assert.equal(emissions.headline.entries, 7, "the market row is still an entry");
    assert.equal(emissions.headline.marketEntries, 1);

    const scope2 = emissions.byScope.find((scope) => scope.scope === "2")!;
    assert.equal(scope2.tco2e, TWIN + 10, "the band excludes it too");
    assert.equal(scope2.marketTco2e, TWIN);

    const electricity = emissions.byCategory.find((category) => category.categoryCode === "2.purchased-electricity")!;
    assert.equal(electricity.tco2e, TWIN + 10, "and so does the category title");
    assert.equal(electricity.marketTco2e, TWIN);
    assert.equal(electricity.entries, 3);
  });

  it("proves the rule bites, by pairing the market row with an identical location one", async () => {
    // Anti-vacuity. "Market contributes 0" passes over a table with no market rows just as happily as
    // over one where the rule works — which is exactly what it looked like before 0109 made a row
    // capable of being market at all. The twins are the same size, so the rule's effect is the
    // difference between them and nothing else.
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB });
    const scope2 = emissions.byScope.find((scope) => scope.scope === "2")!;

    const asIfCounted = scope2.tco2e + scope2.marketTco2e;
    assert.equal(asIfCounted - scope2.tco2e, TWIN,
      "the market row's value is exactly what the location rule keeps out of the band");
    assert.notEqual(scope2.tco2e, asIfCounted, "if these are equal the rule is not doing anything");

    // And the twin that does count is in there, so the exclusion is selective rather than total.
    assert.ok(scope2.tco2e >= TWIN, "the location twin of the same size still counts");
  });

  it("counts a Scope 2 row whose method was never stated", async () => {
    // 0109 permits a null method and this is the direction chosen: an unset method counts, so a missing
    // declaration can only ever over-count the headline. The opposite default would let a row disappear
    // from a client's total by omission, which is the failure that matters.
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB, siteId: "site-a" });
    const scope2 = emissions.byScope.find((scope) => scope.scope === "2")!;
    assert.equal(scope2.tco2e, TWIN + 10, "the unstated row is inside the total, not outside it");
    assert.equal(scope2.marketEntries, 1, "and it is not counted as market either");
  });

  // ── The narrowing, and what stays unnarrowed ────────────────────────────────────────

  it("narrows to one site, and still counts every site for the tabs", async () => {
    const siteA = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB, siteId: "site-a" });
    // 100 (s1) + 250 + 10 (scope 2) + 7 (override) = 367; site B's 40 and 60 are elsewhere.
    assert.equal(siteA.headline.tco2e, 367);
    assert.equal(siteA.siteId, "site-a");

    const siteB = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB, siteId: "site-b" });
    assert.equal(siteB.headline.tco2e, 100);

    // The site list is never narrowed: the tabs show every site's count while one of them is selected.
    assert.deepEqual(siteA.bySite.map((site) => site.siteId).sort(), ["site-a", "site-b"]);
    const both = siteA.bySite.reduce((total, site) => total + site.tco2e, 0);
    assert.equal(both, 467, "the unnarrowed site breakdown still adds to the whole job");
  });

  it("ignores a disabled row and prefers an override to a calculation", async () => {
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB });
    const travel = emissions.byCategory.find((category) => category.categoryCode === "3.business-travel")!;
    assert.equal(travel.tco2e, 60, "the disabled 999 is not in the total");
    assert.equal(travel.entries, 1, "nor is it counted as an entry");

    const waste = emissions.byCategory.find((category) => category.categoryCode === "3.waste")!;
    assert.equal(waste.tco2e, 7, "the override, not the 5 it replaced");
  });

  it("is one read, so no tier can disagree with another", async () => {
    // The reason every tile, band and title bar reads this and nothing else.
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB });
    const scopeSum = emissions.byScope.reduce((total, scope) => total + scope.tco2e, 0);
    const categorySum = emissions.byCategory.reduce((total, category) => total + category.tco2e, 0);
    assert.equal(scopeSum, emissions.headline.tco2e);
    assert.equal(categorySum, emissions.headline.tco2e);

    const shares = scopeShares(emissions);
    assert.ok(Math.abs(shares.reduce((total, scope) => total + scope.share, 0) - 1) < 1e-9,
      "the split bar's shares add to the whole");
  });

  it("reads one tenant's job and not another's with the same id", async () => {
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB });
    assert.equal(emissions.headline.tco2e, 467, "the other tenant's 100000 is not in here");

    const other = await readJobEmissions(database.pool, { organisationId: OTHER, jobId: JOB });
    assert.equal(other.headline.tco2e, 100000, "and theirs reads only theirs");
  });

  it("returns an honest zero for a job with nothing in it", async () => {
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
       VALUES ($1,'job-empty','client-1',3,'crp','Empty','open','setup')`, [ORG]);
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: "job-empty" });
    assert.equal(emissions.headline.tco2e, 0, "zero, not null — an empty job has emissions of nought");
    assert.equal(emissions.headline.entries, 0);
    assert.deepEqual(emissions.byScope, []);
    assert.deepEqual(scopeShares(emissions), [], "and no division by zero on the way to an empty bar");
  });

  // ── The constraints that make an undercount unrepresentable ─────────────────────────

  it("refuses a method on a row that has no such question", async () => {
    await assert.rejects(
      () => row("bad-1", { scope: "1", tco2e: 1, method: "market" }),
      /job_scope_rows_scope2_method_is_scope2_only/,
      "location-versus-market is a Scope 2 concept and the column may not be filled elsewhere");
    await assert.rejects(
      () => row("bad-2", { scope: "3.6", tco2e: 1, method: "location" }),
      /job_scope_rows_scope2_method_is_scope2_only/);
    await assert.rejects(
      () => row("bad-3", { scope: "2", tco2e: 1, method: "residual" as never }),
      /job_scope_rows_scope2_method_values/);
  });

  it("makes hiding a row that counts unrepresentable", async () => {
    // The point of the CHECK. `show_in_report` governs presentation, and a location or Scope 1/3 row
    // being hidden would silently undercount what a client's report says — so the database refuses it
    // rather than trusting every future caller to.
    await assert.rejects(
      () => row("hide-1", { scope: "1", tco2e: 1, show: false }),
      /job_scope_rows_hidden_rows_are_market_only/);
    await assert.rejects(
      () => row("hide-2", { scope: "2", tco2e: 1, method: "location", show: false }),
      /job_scope_rows_hidden_rows_are_market_only/);

    // Allowed on a market row, which contributes nothing to any total in the first place.
    await row("hide-ok", { scope: "2", tco2e: 1, method: "market", show: false, category: "2.purchased-electricity" });
    const emissions = await readJobEmissions(database.pool, { organisationId: ORG, jobId: JOB });
    assert.equal(emissions.headline.tco2e, 467, "a hidden market row moves no number");
    assert.equal(emissions.headline.marketTco2e, TWIN + 1, "and is still readable as market");
  });
});
