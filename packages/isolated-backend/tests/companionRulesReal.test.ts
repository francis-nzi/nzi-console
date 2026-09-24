import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { proposeCompanions, resolveFactorForEntry, type CategoryVariant } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { companionRulesFor, factorRulesFor, listCompanionRules } from "../src/inputSpecFactorRules";
import { readJobEmissions } from "../src/emissionsAggregation";
import { reconcileUnitForMapping } from "../src/unitCompatibility";

/**
 * Companions and the market row, against the real tables (NZC-154).
 *
 * Three things only a real database shows. That the rules `0115` seeds are shaped the way the proposer
 * reads them — a companion right in the abstract and mis-keyed in the migration proposes nothing while
 * every unit test stays green. That the enumerated supply values are the ones actually stored. And that a
 * market row stays out of the headline, which is a property of the **aggregation** rather than of the
 * mapping, and can only be shown by summing real rows.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-companion";
const CLIENT = "client-companion";
const JOB = "job-companion";

describe("an entry resolves to more than one row, and market stays out of the headline (NZC-154)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let pool: pg.Pool;
  const registry: CategoryVariant[] = [];

  const available = [
    { factorId: "electricity-demo", scopes: ["2"], unit: "kWh" },
    { factorId: "electricity-td-demo", scopes: ["3"], unit: "kWh" },
  ];

  before(async () => {
    database = (await createDisposableDatabase("companion"))!;
    pool = database.pool;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`,
      [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  const primaryFor = async (category: string, entry: Record<string, string>) => resolveFactorForEntry({ reconcileUnit: reconcileUnitForMapping,
    rules: await factorRulesFor(db, category), specGhgCategory: "2", entry, available, registry,
  });

  const proposeFor = async (category: string, entry: Record<string, string>) => proposeCompanions({
    companions: await companionRulesFor(db, category), entry, available,
    primary: await primaryFor(category, entry),
  });

  // ── The rules, as seeded ─────────────────────────────────────────────────────────────

  it("declares the T&D companion only where a primary exists to accompany", async () => {
    // An equality rather than a presence check, and it earns its keep: the first draft of 0115 also
    // seeded this companion on `2.renewable-electricity`, which then had no primary factor rule — so it
    // could never have fired, and nothing but this assertion would have said so.
    //
    // 0117 gave that category its primary (the location-based grid factor, NZC-157) and its companion with
    // it. The set grows by reviewed intent, which is what updating this list records.
    const all = await listCompanionRules(db);
    assert.deepEqual([...all.keys()].sort(), ["2.purchased-electricity", "2.renewable-electricity"],
      "a companion is declared on a category that has no primary rule, so it can never fire");

    const rules = await companionRulesFor(db, "2.purchased-electricity");
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.kind, "transmission-distribution");
    assert.equal(rules[0]!.ghgCategory, "3.3");
    assert.deepEqual([...rules[0]!.whenValues].sort(), ["green-tariff", "grid", "grid-renewable", "rego"],
      "the enumerated supply values are not the ones stored");
    assert.ok(!rules[0]!.whenValues.includes("self-generated"),
      "self-generated is listed among the values that fire the companion");
  });

  // ── The pair, against the seeded rules ───────────────────────────────────────────────

  it("creates the T&D companion for grid supply", async () => {
    const outcome = await proposeFor("2.purchased-electricity", { unit: "kWh", supplySource: "grid" });
    assert.equal(outcome.proposed.length, 1, "no companion was proposed for grid supply");
    assert.equal(outcome.proposed[0]!.factorId, "electricity-td-demo");
    assert.equal(outcome.proposed[0]!.ghgCategory, "3.3");
  });

  it("creates it for REGO-backed and green-tariff supply, which still crossed the network", async () => {
    // The correction that matters, and it turns on the *supply*, never the category: a certificate
    // changes what the electricity is accounted as, not the wires it arrived on.
    for (const supply of ["rego", "green-tariff", "grid-renewable"]) {
      const outcome = await proposeFor("2.purchased-electricity", { unit: "kWh", supplySource: supply });
      assert.equal(outcome.proposed.length, 1, supply + " was given no transmission losses");
    }
  });

  it("resolves renewable electricity to the same grid factor as purchased (NZC-157)", async () => {
    // Under the location-based method a REGO or green tariff does not change the figure: it is the grid
    // average whatever the contract says, and the renewable-ness lives in the market row. So the two
    // categories resolving to one factor is the accounting answer rather than a copy-paste, and it is
    // asserted here so a future reader finds a test saying so rather than a suspicious coincidence.
    const renewable = await primaryFor("2.renewable-electricity", { unit: "kWh", supplySource: "rego" });
    const purchased = await primaryFor("2.purchased-electricity", { unit: "kWh", supplySource: "grid" });

    assert.equal(renewable.kind, "resolved");
    assert.equal(purchased.kind, "resolved");
    if (renewable.kind !== "resolved" || purchased.kind !== "resolved") return;
    assert.equal(renewable.factorId, "electricity-demo");
    assert.equal(renewable.factorId, purchased.factorId,
      "renewable electricity resolved to a different location-based factor from purchased");
  });

  it("now fires the companion on renewable electricity, which 0115 could not", async () => {
    // The companion 0115 withheld because the category had no primary to accompany. It fires now for the
    // same reason it always would have — the supply crossed a network — and the category it is filed
    // under is unchanged.
    const outcome = await proposeFor("2.renewable-electricity", { unit: "kWh", supplySource: "rego" });
    assert.equal(outcome.proposed.length, 1, "a REGO-backed supply was given no transmission losses");
    assert.equal(outcome.proposed[0]!.ghgCategory, "3.3");
  });

  it("does not fire it on renewable electricity that was generated on site", async () => {
    // The pair, on the category where the confusion is likeliest: "renewable" says nothing about whether
    // the electricity crossed a network, and roof-mounted solar lost nothing in transmission.
    const entry = { unit: "kWh", supplySource: "self-generated" };
    assert.equal((await primaryFor("2.renewable-electricity", entry)).kind, "resolved",
      "the primary must still resolve, or this proves nothing");
    const outcome = await proposeFor("2.renewable-electricity", entry);
    assert.equal(outcome.proposed.length, 0, "self-generated renewable electricity was given T&D losses");
  });

  it("does NOT create it for self-generated electricity", async () => {
    // The half that makes the others mean anything. Note what is asserted first: the **primary still
    // resolves**. Without that, a proposal of zero companions could simply mean the entry failed, and the
    // test would pass for a reason that has nothing to do with transmission losses.
    const entry = { unit: "kWh", supplySource: "self-generated" };
    const primary = await primaryFor("2.purchased-electricity", entry);
    assert.equal(primary.kind, "resolved", "the primary must still resolve, or this proves nothing");

    const outcome = await proposeFor("2.purchased-electricity", entry);
    assert.equal(outcome.proposed.length, 0, "self-generated electricity was given transmission losses");
    assert.match(outcome.declined[0]!.reason, /not among the values this companion fires for/);
  });

  // ── Market stays out of the headline ─────────────────────────────────────────────────

  const scopeRow = (rowId: string, scope: string, method: string | null, tco2e: number) => db.query(
    `INSERT INTO nzi_console.job_scope_rows
       (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2,
        calculated_tco2e, scope2_method)
     VALUES ($1,$2,$3,$4,'Electricity','Electricity',$5,'Purchased energy',$6,$7)`,
    [ORG, rowId, JOB, scope, `Scope ${scope.split(".")[0]}`, tco2e, method]);

  it("keeps a market row out of the headline while still reporting it", async () => {
    // Paired on purpose: the location row must count. A headline of zero would satisfy "market is
    // excluded" while proving only that the aggregation had stopped adding anything at all.
    await scopeRow("c-location", "2", "location", 100);
    await scopeRow("c-market", "2", "market", 40);

    const emissions = await readJobEmissions(pool, { organisationId: ORG, jobId: JOB });
    assert.equal(emissions.headline.tco2e, 100, "the headline is not the location-based figure alone");
    assert.equal(emissions.headline.marketTco2e, 40, "the market figure is not reported separately");
    assert.equal(emissions.headline.marketEntries, 1);
    assert.equal(emissions.headline.entries, 2, "the market row is missing from the entry count");
  });

  it("counts a companion row in the headline, under its own scope", async () => {
    // The other side of the market assertion: not everything that is "extra" is kept out of the total. A
    // T&D companion is a real row with real emissions, and excluding it would understate Scope 3.
    const before = await readJobEmissions(pool, { organisationId: ORG, jobId: JOB });
    await scopeRow("c-td", "3.3", null, 2.5);
    const after = await readJobEmissions(pool, { organisationId: ORG, jobId: JOB });

    assert.equal(after.headline.tco2e, before.headline.tco2e + 2.5, "the T&D companion did not reach the headline");
    assert.ok(after.byScope.some((band) => band.scope.startsWith("3")), "the companion is not filed under Scope 3");
  });
});
