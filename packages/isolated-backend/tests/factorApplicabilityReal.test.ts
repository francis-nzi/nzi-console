import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { parseFactorId } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import {
  addFactorApplicability, FactorApplicabilityError, listFactorApplicability, retireFactorApplicability,
} from "../src/factorApplicability";
import { withTenantRead, withTenantWrite, type Queryable } from "../src/postgres";
import { AuthorizationError, type StaffPrincipal } from "../src/auth";

/**
 * Factor applicability and the value-equality guard, against real Postgres (BUILD-dataset-factor-dedup slice 1, migration 0170).
 *
 * Real Postgres, because every claim here is the database's: a trigger, a policy, a grant, a migration's own refusal. The mock
 * pool enforces none of them — which is how the self-approval CHECK reached production unseen (#484, #486).
 *
 * The data is seeded **between 0169 and 0170**, so the migration meets the shapes it meets on the v7 library:
 *   - J000663's: the spend factors it prices through `-p`, `-b`, `-d`, `-u` variants, each its base's value; commuting variants of
 *     car and rail factors; a well-to-tank factor and an electricity factor with no variants at all;
 *   - the freight defect: 2024's downstream (`-d`) variants of a van factor in km and tonne.km carrying the per-mile figure, and
 *     2025's carrying the base's, as on staging;
 *   - a variant whose base was never loaded, and a second organisation with its own pair.
 * Public DESNZ factor codes and values; no client data.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-dedup";
const OTHER = "org-dedup-two";
const ACTOR = "admin-a";

const principal = (...held: string[]) => ({
  userId: ACTOR, organisationId: ORG, role: "admin",
  capabilities: held.map((capability) => ({ capability, scope: "all" })),
} as unknown as StaffPrincipal);
const admin = principal("factor.manage");

type Seed = [dataset: string, factorId: string, unit: string, value: number];

/** J000663's reference factors with variants, as staging holds them (uk-ghg-gb-2025/2026 folded into one set here). */
const J000663: Seed[] = [
  ["gb-2025", "uk-ghg-SPEND-SIC-26", "GBP", 0.536410493080756],
  ["gb-2025", "uk-ghg-SPEND-SIC-26-p", "GBP", 0.536410493080756],
  ["gb-2025", "uk-ghg-SPEND-SIC-49.1-2", "GBP", 0.423399994606277],
  ["gb-2025", "uk-ghg-SPEND-SIC-49.1-2-b", "GBP", 0.423399994606277],
  ["gb-2025", "uk-ghg-SPEND-SIC-49.3-5", "GBP", 0.57488070034094],
  ["gb-2025", "uk-ghg-SPEND-SIC-49.3-5-b", "GBP", 0.57488070034094],
  ["gb-2025", "uk-ghg-SPEND-SIC-49.3-5-d", "GBP", 0.57488070034094],
  ["gb-2025", "uk-ghg-SPEND-SIC-49.3-5-u", "GBP", 0.57488070034094],
  ["gb-2025", "uk-ghg-SPEND-SIC-50", "GBP", 0.969026278122163],
  ["gb-2025", "uk-ghg-SPEND-SIC-50-d", "GBP", 0.969026278122163],
  ["gb-2025", "uk-ghg-SPEND-SIC-51", "GBP", 1.46881078109381],
  ["gb-2025", "uk-ghg-SPEND-SIC-51-b", "GBP", 1.46881078109381],
  ["gb-2025", "uk-ghg-SPEND-SIC-51-d", "GBP", 1.46881078109381],
  ["gb-2025", "uk-ghg-SPEND-SIC-55", "GBP", 0.289715617932492],
  ["gb-2025", "uk-ghg-SPEND-SIC-55-b", "GBP", 0.289715617932492],
  ["gb-2025", "uk-ghg-SPEND-SIC-52", "GBP", 0.351246310632378],
  ["gb-2025", "uk-ghg-25_301_3070_9_1", "miles", 0.26187],
  ["gb-2025", "uk-ghg-25_301_3070_9_1-c", "miles", 0.26187],
  ["gb-2025", "uk-ghg-25_315_3147_11_1", "passenger.km", 0.03546],
  ["gb-2025", "uk-ghg-25_315_3147_11_1-c", "passenger.km", 0.03546],
  // No variants: the large car under Scope 1, its well-to-tank (a different number, its own factor), and grid electricity.
  ["gb-2025", "uk-ghg-4_301_3070_4_1", "km", 0.16272],
  ["gb-2025", "uk-ghg-26_904_3075_9_1", "miles", 0.04721],
  ["gb-2025", "uk-ghg-7_400_4000_5_1", "kWh", 0.177],
];

/** The freight defect: 2024's km and tonne.km `-d` rows carry the per-mile value; 2025's carry the base's. */
const FREIGHT: Seed[] = [
  ["gb-2024", "uk-ghg-27_303_3081_4_1", "km", 0.15356],
  ["gb-2024", "uk-ghg-27_303_3081_4_1-d", "km", 0.24716],
  ["gb-2024", "uk-ghg-27_303_3081_14_1", "tonne.km", 0.85353],
  ["gb-2024", "uk-ghg-27_303_3081_14_1-d", "tonne.km", 0.24716],
  ["gb-2024", "uk-ghg-27_303_3081_9_1", "miles", 0.24716],
  ["gb-2024", "uk-ghg-27_303_3081_9_1-d", "miles", 0.24716],
  ["gb-2025", "uk-ghg-27_303_3081_4_1", "km", 0.15738],
  ["gb-2025", "uk-ghg-27_303_3081_4_1-d", "km", 0.15738],
];

const dataset = (db: pg.Client, org: string, id: string) => db.query(
  `INSERT INTO nzi_console.emission_factor_datasets
     (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
   VALUES ($1,$2,$2,$2,'2024-01-01','2026-12-31','GB','active','test','test')`, [org, id]);

const factor = (db: Queryable, org: string, [ds, id, unit, value]: Seed) => db.query(
  `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
   VALUES ($1,$2,$3,$3,$4,$5,ARRAY['3'])`, [org, ds, id, unit, value]);

async function organisation(db: pg.Client, org: string) {
  await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [org]);
  await db.query(`SELECT nzi_console.provision_organisation($1)`, [org]);
}

/** What the database holds once the suite's fixture hook has run, read back as the app would see it. */
const valueOf = async (db: pg.Client, ds: string, id: string) =>
  Number((await db.query<{ v: string }>(
    `SELECT kgco2e_per_unit::text AS v FROM nzi_console.emission_factors WHERE organisation_id=$1 AND dataset_id=$2 AND factor_id=$3`,
    [ORG, ds, id])).rows[0]?.v);

describe("factor applicability and the value-equality guard (0170)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;

  before(async () => {
    database = (await createDisposableDatabase("factorapplicability", {
      onMigration: async (filename, owner) => {
        if (!filename.startsWith("0169_")) return;
        for (const org of [ORG, OTHER]) await organisation(owner, org);
        for (const id of ["gb-2024", "gb-2025"]) await dataset(owner, ORG, id);
        await dataset(owner, OTHER, "gb-2025");
        for (const seed of [...J000663, ...FREIGHT]) await factor(owner, ORG, seed);
        // A variant whose base was never a factor here: nothing for it to be applicable to.
        await factor(owner, ORG, ["gb-2025", "orphan-thing-c", "km", 1]);
        await factor(owner, OTHER, ["gb-2025", "other-car", "km", 0.2]);
        await factor(owner, OTHER, ["gb-2025", "other-car-b", "km", 0.2]);
      },
    }))!;
    db = await database.admin();
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── The correction ──────────────────────────────────────────────────────────────────────────────────────────

  it("corrects the freight -d defect to each variant's base, and nothing else", async () => {
    assert.equal(await valueOf(db, "gb-2024", "uk-ghg-27_303_3081_4_1-d"), 0.15356, "km: its base's value, not the per-mile figure");
    assert.equal(await valueOf(db, "gb-2024", "uk-ghg-27_303_3081_14_1-d"), 0.85353, "tonne.km: its base's value");
    assert.equal(await valueOf(db, "gb-2024", "uk-ghg-27_303_3081_9_1-d"), 0.24716, "the miles variant was right, and is untouched");
    assert.equal(await valueOf(db, "gb-2025", "uk-ghg-27_303_3081_4_1-d"), 0.15738, "2025 was right, and is untouched");
    for (const [ds, id, , value] of J000663) assert.equal(await valueOf(db, ds, id), value, `${id} is untouched`);
  });

  it("records each corrected value as its own audit event, before and after", async () => {
    const { rows } = await db.query<{ entity_id: string; actor_id: string; principal_type: string;
      before_json: { kgco2ePerUnit: number }; after_json: { kgco2ePerUnit: number; base: string } }>(
      `SELECT entity_id, actor_id, principal_type, before_json, after_json FROM nzi_console.audit_events
        WHERE action = 'emission_factor.value.corrected' ORDER BY entity_id`);
    assert.deepEqual(rows.map((row) => [row.entity_id, row.before_json.kgco2ePerUnit, row.after_json.kgco2ePerUnit, row.after_json.base]), [
      ["gb-2024/uk-ghg-27_303_3081_14_1-d", 0.24716, 0.85353, "uk-ghg-27_303_3081_14_1"],
      ["gb-2024/uk-ghg-27_303_3081_4_1-d", 0.24716, 0.15356, "uk-ghg-27_303_3081_4_1"],
    ]);
    assert.ok(rows.every((row) => row.actor_id === "migration:0170" && row.principal_type === "system"));
  });

  // ── The parser, in SQL and in TypeScript ────────────────────────────────────────────────────────────────────

  it("splits ids in SQL exactly as parseFactorId does — registered suffixes only, longest first", async () => {
    // A longer suffix ending in a registered shorter one, and a retired suffix, which must still parse.
    await db.query(`INSERT INTO nzi_console.factor_category_variants (suffix_code,label,ghg_category,description,sort_order,created_by,updated_by)
                    VALUES ('-ud','Upstream, disaggregated','3.4','Parity probe.',500,'test','test')`);
    await db.query(`UPDATE nzi_console.factor_category_variants SET status='retired', retired_at=now(), retired_by='test' WHERE suffix_code='-w'`);
    const registry = await listCategoryVariants(db);
    const corpus = [
      "uk-ghg-SPEND-SIC-49.3-5-d", "uk-ghg-SPEND-SIC-49.3-5", "uk-ghg-27_303_3081_14_1-d", "uk-ghg-1_101_1011_8_1-vcd",
      "uk-ghg-1_101_1011_8_1-vvd", "car-bcp", "diesel-demo", "electricity-us-demo", "lca-rpet-demo", "freight-demo",
      "-c", "-vcd", "pallet-ud", "pallet-d", "skip-hire-w", "a-b-c", "x-", "x", "", "uk-ghg-25_301_3070_9_1-c",
    ];
    for (const id of corpus) {
      const ts = parseFactorId(id, registry);
      const sql = (await db.query<{ base: string; suffix_code: string | null }>(
        `SELECT base, suffix_code FROM nzi_console.factor_id_parts($1)`, [id])).rows[0]!;
      assert.deepEqual({ base: sql.base, suffix: sql.suffix_code }, { base: ts.base, suffix: ts.variant?.suffixCode ?? null }, id);
    }
  });

  // ── The backfill ────────────────────────────────────────────────────────────────────────────────────────────

  it("backfills J000663's applicability set from its materialised variants, and nothing for factors without one", async () => {
    const recorded = await withTenantRead(database.pool, ORG, (client) => listFactorApplicability(client, ORG));
    const bySuffix = (factorId: string) => recorded.filter((entry) => entry.factorId === factorId).map((entry) => entry.suffixCode);
    assert.deepEqual(bySuffix("uk-ghg-SPEND-SIC-26"), ["-p"]);
    assert.deepEqual(bySuffix("uk-ghg-SPEND-SIC-49.1-2"), ["-b"]);
    assert.deepEqual(bySuffix("uk-ghg-SPEND-SIC-49.3-5"), ["-b", "-u", "-d"], "in the registry's order");
    assert.deepEqual(bySuffix("uk-ghg-SPEND-SIC-50"), ["-d"]);
    assert.deepEqual(bySuffix("uk-ghg-SPEND-SIC-51"), ["-b", "-d"]);
    assert.deepEqual(bySuffix("uk-ghg-SPEND-SIC-55"), ["-b"]);
    assert.deepEqual(bySuffix("uk-ghg-25_301_3070_9_1"), ["-c"]);
    assert.deepEqual(bySuffix("uk-ghg-25_315_3147_11_1"), ["-c"]);
    // The freight factors serve downstream once corrected — applicability is the factor's, whatever a year's copy carried.
    assert.deepEqual(bySuffix("uk-ghg-27_303_3081_4_1"), ["-d"]);
    assert.deepEqual(bySuffix("uk-ghg-27_303_3081_14_1"), ["-d"]);
    assert.deepEqual(bySuffix("uk-ghg-27_303_3081_9_1"), ["-d"]);
    for (const none of ["uk-ghg-4_301_3070_4_1", "uk-ghg-26_904_3075_9_1", "uk-ghg-7_400_4000_5_1", "uk-ghg-SPEND-SIC-52", "orphan-thing"]) {
      assert.deepEqual(bySuffix(none), [], `${none}: no materialised variant, so no applicability`);
    }
    assert.ok(recorded.every((entry) => entry.status === "active" && entry.source === "migration"));
    const registry = await listCategoryVariants(db);
    assert.ok(!recorded.some((entry) => parseFactorId(entry.factorId, registry).variant),
      "applicability is recorded on bases, never on a variant id");
  });

  it("derives the same set the TypeScript parser does, organisation by organisation", async () => {
    const registry = await listCategoryVariants(db);
    for (const org of [ORG, OTHER]) {
      const ids = (await db.query<{ factor_id: string }>(
        `SELECT DISTINCT factor_id FROM nzi_console.emission_factors WHERE organisation_id=$1`, [org])).rows.map((row) => row.factor_id);
      // Every variant id implies (base, suffix) — where the base is a factor here, since applicability hangs off its identity.
      const expected = [...new Set(ids.map((id) => parseFactorId(id, registry))
        .filter((parsed) => parsed.variant && ids.includes(parsed.base))
        .map((parsed) => `${parsed.base}${parsed.variant!.suffixCode}`))].sort();
      const actual = (await db.query<{ pair: string }>(
        `SELECT factor_id || suffix_code AS pair FROM nzi_console.factor_identity_categories WHERE organisation_id=$1`, [org]))
        .rows.map((row) => row.pair).sort();
      assert.deepEqual(actual, expected, org);
    }
  });

  // ── The guard ───────────────────────────────────────────────────────────────────────────────────────────────

  const refusedAsVariantValue = (error: unknown) =>
    (error as { code?: string; constraint?: string; message?: string }).code === "23514"
    && (error as { constraint?: string }).constraint === "emission_factor_variant_carries_base_value"
    && /carries its base's value/.test((error as Error).message);

  it("refuses a variant whose value differs from its base, even as the owner", async () => {
    await assert.rejects(() => factor(db, ORG, ["gb-2025", "uk-ghg-SPEND-SIC-52-b", "GBP", 0.4]), refusedAsVariantValue);
    await assert.rejects(() => factor(db, ORG, ["gb-2025", "uk-ghg-SPEND-SIC-52-b", "kg", 0.351246310632378]), refusedAsVariantValue,
      "the activity unit is part of the value: a variant in another unit is another factor");
  });

  it("refuses it as the application role too, and accepts a variant at its base's value", async () => {
    await assert.rejects(
      () => withTenantWrite(database.pool, ORG, (client) => factor(client, ORG, ["gb-2025", "uk-ghg-SPEND-SIC-52-p", "GBP", 0.35])),
      refusedAsVariantValue);
    await withTenantWrite(database.pool, ORG, (client) => factor(client, ORG, ["gb-2025", "uk-ghg-SPEND-SIC-52-p", "GBP", 0.351246310632378]));
    assert.equal(await valueOf(db, "gb-2025", "uk-ghg-SPEND-SIC-52-p"), 0.351246310632378);
  });

  it("refuses a base changed without its variants, and accepts both changed in one statement", async () => {
    await assert.rejects(() => db.query(
      `UPDATE nzi_console.emission_factors SET kgco2e_per_unit = 0.6 WHERE organisation_id=$1 AND dataset_id='gb-2025' AND factor_id='uk-ghg-SPEND-SIC-51'`,
      [ORG]), refusedAsVariantValue);
    await db.query(
      `UPDATE nzi_console.emission_factors SET kgco2e_per_unit = 1.5
        WHERE organisation_id=$1 AND dataset_id='gb-2025' AND factor_id IN ('uk-ghg-SPEND-SIC-51','uk-ghg-SPEND-SIC-51-b','uk-ghg-SPEND-SIC-51-d')`, [ORG]);
    for (const id of ["uk-ghg-SPEND-SIC-51", "uk-ghg-SPEND-SIC-51-b", "uk-ghg-SPEND-SIC-51-d"]) assert.equal(await valueOf(db, "gb-2025", id), 1.5);
  });

  it("refuses a base that arrives after its variant at another value", async () => {
    await factor(db, ORG, ["gb-2025", "late-base-c", "km", 0.3]);
    await assert.rejects(() => factor(db, ORG, ["gb-2025", "late-base", "km", 0.31]), refusedAsVariantValue);
    await factor(db, ORG, ["gb-2025", "late-base", "km", 0.3]);
  });

  it("compares within one dataset only, and never compares factors that are not variants", async () => {
    // Years differ, correctly: 2024's and 2025's freight bases already carry different values.
    assert.notEqual(await valueOf(db, "gb-2024", "uk-ghg-27_303_3081_4_1"), await valueOf(db, "gb-2025", "uk-ghg-27_303_3081_4_1"));
    // A look-alike: `-demo` is not a registered suffix, so diesel-demo is its own factor whatever its value.
    await factor(db, ORG, ["gb-2025", "diesel", "litres", 2.5]);
    await factor(db, ORG, ["gb-2025", "diesel-demo", "litres", 2.7]);
    // Well-to-tank is a different number with its own id, so it is never in the car factor's group.
    await factor(db, ORG, ["gb-2025", "uk-ghg-26_904_3070_4_1", "km", 0.04]);
    // A variant whose base is not in this dataset has nothing to disagree with.
    await factor(db, ORG, ["gb-2024", "uk-ghg-SPEND-SIC-26-p", "GBP", 0.9]);
  });

  it("serialises two writers: a base and a divergent variant written at once cannot both commit", async () => {
    const first = await database.pool.connect();
    const second = await database.pool.connect();
    const begin = async (client: pg.PoolClient) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nzi_console_app");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
    };
    try {
      await begin(first);
      await begin(second);
      await factor(first, ORG, ["gb-2025", "race-car", "km", 0.1]);
      // Blocks on the first writer's lock, then reads its committed base and refuses.
      const pending = factor(second, ORG, ["gb-2025", "race-car-b", "km", 0.2]).then(() => "inserted", (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query("COMMIT");
      const outcome = await pending;
      assert.ok(refusedAsVariantValue(outcome), `the second writer must be refused, got ${String(outcome)}`);
      await second.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }
    assert.equal(await valueOf(db, "gb-2025", "race-car"), 0.1);
    assert.ok(Number.isNaN(await valueOf(db, "gb-2025", "race-car-b")), "the divergent variant was never written");
  });

  // ── The applicability table ─────────────────────────────────────────────────────────────────────────────────

  it("has forced row-level security, the tenant policy, and no DELETE for the app", async () => {
    const shape = (await db.query<{ rls: boolean; forced: boolean; policies: string[] }>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              ARRAY(SELECT polname::text FROM pg_policy WHERE polrelid = c.oid ORDER BY polname) AS policies
         FROM pg_class c WHERE c.oid = 'nzi_console.factor_identity_categories'::regclass`)).rows[0]!;
    assert.deepEqual(shape, { rls: true, forced: true, policies: ["tenant_isolation"] });
    const grants = (await db.query<{ privilege: string; granted: boolean }>(
      `SELECT p AS privilege, has_table_privilege('nzi_console_app', 'nzi_console.factor_identity_categories', p) AS granted
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p`)).rows;
    assert.deepEqual(grants.map((row) => `${row.privilege}:${row.granted}`), ["SELECT:true", "INSERT:true", "UPDATE:true", "DELETE:false"]);
  });

  it("refuses a delete or a re-pointing even as the owner, and applicability on a variant id", async () => {
    await assert.rejects(() => db.query(
      `DELETE FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 AND factor_id='uk-ghg-SPEND-SIC-26'`, [ORG]),
      /never deleted/);
    await assert.rejects(() => db.query(
      `UPDATE nzi_console.factor_identity_categories SET suffix_code='-b' WHERE organisation_id=$1 AND factor_id='uk-ghg-SPEND-SIC-26'`, [ORG]),
      /never re-pointed/);
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.factor_identity_categories (organisation_id,factor_id,suffix_code,source,created_by,updated_by)
       VALUES ($1,'uk-ghg-SPEND-SIC-26-p','-c','admin','t','t')`, [ORG]), /belongs to the base factor/);
    await assert.rejects(() => db.query(
      `INSERT INTO nzi_console.factor_identity_categories (organisation_id,factor_id,suffix_code,source,created_by,updated_by)
       VALUES ($1,'uk-ghg-SPEND-SIC-52','-zz','admin','t','t')`, [ORG]), /foreign key/);
    assert.equal((await db.query(
      `SELECT 1 FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 AND factor_id='uk-ghg-SPEND-SIC-26' AND suffix_code='-p'`, [ORG])).rows.length, 1);
  });

  it("is confined to its own tenant", async () => {
    const seenByOther = await withTenantRead(database.pool, OTHER, (client) => client.query<{ factor_id: string; organisation_id: string }>(
      `SELECT organisation_id, factor_id FROM nzi_console.factor_identity_categories`));
    assert.deepEqual(seenByOther.rows.map((row) => `${row.organisation_id}:${row.factor_id}`), [`${OTHER}:other-car`]);
  });

  // ── The commands ────────────────────────────────────────────────────────────────────────────────────────────

  it("adds a category the source never shipped, idempotently, and retires and reinstates it with a reason", async () => {
    // The DEEP-DIVE's first case: the large car may serve commuting with no new row and no new value.
    const added = await addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-4_301_3070_4_1", suffixCode: "-c" });
    assert.deepEqual([added.outcome, added.applicability.status, added.applicability.source], ["added", "active", "admin"]);
    assert.equal((await addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-4_301_3070_4_1", suffixCode: "-c" })).outcome,
      "already-applicable");

    await assert.rejects(() => retireFactorApplicability(database.pool, admin,
      { organisationId: ORG, factorId: "uk-ghg-4_301_3070_4_1", suffixCode: "-c", reason: "  " }),
      (error: unknown) => error instanceof FactorApplicabilityError && error.reason === "no-reason");
    const retired = await retireFactorApplicability(database.pool, admin,
      { organisationId: ORG, factorId: "uk-ghg-4_301_3070_4_1", suffixCode: "-c", reason: "Commuting moved to a distance factor." });
    assert.deepEqual([retired.alreadyRetired, retired.applicability.status], [false, "retired"]);
    assert.equal((await retireFactorApplicability(database.pool, admin,
      { organisationId: ORG, factorId: "uk-ghg-4_301_3070_4_1", suffixCode: "-c", reason: "again" })).alreadyRetired, true);
    assert.equal((await addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-4_301_3070_4_1", suffixCode: "-c" })).outcome,
      "reinstated");

    const audited = (await db.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM nzi_console.audit_events WHERE entity_type='factor_applicability' ORDER BY occurred_at, action`)).rows;
    assert.deepEqual(audited.map((row) => row.action),
      ["factor.applicability.added", "factor.applicability.retired", "factor.applicability.reinstated"]);
    assert.ok(audited.every((row) => row.actor_id === ACTOR));
  });

  it("refuses a variant id, an unknown factor, an unknown or retired suffix — before writing anything", async () => {
    const refusal = (reason: string) => (error: unknown) => error instanceof FactorApplicabilityError && error.reason === reason;
    await assert.rejects(() => addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-SPEND-SIC-26-p", suffixCode: "-c" }),
      refusal("variant-id"));
    await assert.rejects(() => addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "no-such-factor", suffixCode: "-c" }),
      refusal("unknown-factor"));
    await assert.rejects(() => addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-SPEND-SIC-52", suffixCode: "-zz" }),
      refusal("unknown-suffix"));
    await assert.rejects(() => addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-SPEND-SIC-52", suffixCode: "-w" }),
      refusal("retired-suffix"));
    assert.deepEqual(await withTenantRead(database.pool, ORG, (client) => listFactorApplicability(client, ORG, "uk-ghg-SPEND-SIC-52")), []);
  });

  it("refuses a caller without factor.manage, on both commands", async () => {
    for (const held of [[], ["clientfactor.manage"], ["dataset.manage"]]) {
      const caller = principal(...held);
      await assert.rejects(() => addFactorApplicability(database.pool, caller, { organisationId: ORG, factorId: "uk-ghg-SPEND-SIC-52", suffixCode: "-b" }),
        (error: unknown) => error instanceof AuthorizationError && error.permission === "factor.manage");
      await assert.rejects(() => retireFactorApplicability(database.pool, caller,
        { organisationId: ORG, factorId: "uk-ghg-SPEND-SIC-26", suffixCode: "-p", reason: "not theirs" }),
        (error: unknown) => error instanceof AuthorizationError && error.permission === "factor.manage");
    }
    assert.deepEqual(await withTenantRead(database.pool, ORG, (client) => listFactorApplicability(client, ORG, "uk-ghg-SPEND-SIC-52")), []);
    assert.equal((await withTenantRead(database.pool, ORG, (client) => listFactorApplicability(client, ORG, "uk-ghg-SPEND-SIC-26")))[0]!.status, "active");
  });
});

/**
 * 0170 refuses rather than guesses. Each of these builds a database to 0169, seeds a divergence the correction was not ruled for,
 * and must watch 0170 fail — leaving the value exactly as it was, and no applicability table behind.
 */
describe("0170 refuses a divergence it was not ruled to correct", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const afterRefusal = async (suite: string, probe: (client: pg.Client) => Promise<void>) => {
    const url = new URL(DATABASE_URL!);
    url.pathname = `${url.pathname.replace(/\/$/, "")}_${suite}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try { await probe(client); } finally { await client.end(); }
  };
  const stillAt0169 = async (client: pg.Client) => {
    assert.equal((await client.query(`SELECT to_regclass('nzi_console.factor_identity_categories') AS t`)).rows[0]!.t, null,
      "the failed migration left nothing behind");
  };

  it("a variant that differs from its base and is not the freight defect", async () => {
    await assert.rejects(() => createDisposableDatabase("factorapplicabilityodd", {
      onMigration: async (filename, owner) => {
        if (!filename.startsWith("0169_")) return;
        await organisation(owner, ORG);
        await dataset(owner, ORG, "gb-2025");
        await factor(owner, ORG, ["gb-2025", "car-petrol", "km", 0.17]);
        await factor(owner, ORG, ["gb-2025", "car-petrol-b", "km", 0.18]);
      },
    }), /0170: 1 variant value row\(s\) differ from their base and are not the characterised freight -d defect.*car-petrol-b/);
    await afterRefusal("factorapplicabilityodd", async (client) => {
      await stillAt0169(client);
      const { rows } = await client.query<{ v: string }>(`SELECT kgco2e_per_unit::text AS v FROM nzi_console.emission_factors WHERE factor_id='car-petrol-b'`);
      assert.equal(rows[0]!.v, "0.18", "nothing was corrected");
    });
  });

  it("the freight defect, when something already names the row", async () => {
    await assert.rejects(() => createDisposableDatabase("factorapplicabilityused", {
      onMigration: async (filename, owner) => {
        if (!filename.startsWith("0169_")) return;
        await organisation(owner, ORG);
        await dataset(owner, ORG, "gb-2024");
        for (const seed of FREIGHT.filter(([ds]) => ds === "gb-2024")) await factor(owner, ORG, seed);
        await owner.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-a','Client','active')`, [ORG]);
        await owner.query(
          `INSERT INTO nzi_console.client_factor_aliases (organisation_id,client_id,factor_id,label,active,created_by)
           VALUES ($1,'client-a','uk-ghg-27_303_3081_4_1-d','Deliveries — vans',true,'test')`, [ORG]);
      },
    }), /0170: 1 divergent freight -d row\(s\) are in use.*uk-ghg-27_303_3081_4_1-d \(named by a client alias\)/);
    await afterRefusal("factorapplicabilityused", async (client) => {
      await stillAt0169(client);
      const { rows } = await client.query<{ v: string }>(
        `SELECT kgco2e_per_unit::text AS v FROM nzi_console.emission_factors WHERE factor_id='uk-ghg-27_303_3081_14_1-d'`);
      assert.equal(rows[0]!.v, "0.24716", "nothing was corrected, not even the row nothing names");
    });
  });
});
