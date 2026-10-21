import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, composeReportAudit, composeScopedEmissions, type CommandContext } from "@nzi/contracts";
import type { StaffPrincipal } from "../src/auth";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, CommandValidationError, createReviewedCrpSnapshot, createScopeRow, rollforwardScopeRows } from "../src/postgresCommands";
import { addFactorApplicability, retireFactorApplicability } from "../src/factorApplicability";
import { listScopeRows } from "../src/readModels";
import { withTenantRead } from "../src/postgres";

/**
 * Dedup slice 3 (migration 0172; unconditional since slice 5 Step E): the resolver prices a (base, category) pair off the base's own
 * value, filed under the row's category because the category is in the base's applicability — no `<base><suffix>` row needed.
 *
 * **The gate is the J000663 characterisation**: the same entries sent as variant ids and as bases must price, total, label and compose
 * byte-identically — each variant id filed as its base under the pair (slice 5 Step A; unconditional since Step E, which retired the
 * covered variants — the suite holds its seeded ones active, as the variants a citation keeps materialised are). The data is seeded between 0169 and 0170 so 0170's
 * applicability backfill and 0172's label relocation run on it as they ran on the library — with staging's J000663 shapes: spend
 * variants whose labels equal their base's, and commuting copies of DESNZ's *business travel* factors whose curated labels do not.
 */
const ORG = "org-slice3", CLIENT = "client-slice3", ACTOR = "ada";
const OLD = "job-s3-old", NEW = "job-s3-new", MISC = "job-s3-misc", NEXT = "job-s3-next";
const DS = "gb-2025", DS_VERSION = "2025.1";

type Factor = { id: string; unit: string; value: number; scopes: string[]; label: string; reportLabel: string };
const F = (id: string, unit: string, value: number, scopes: string[], label: string, reportLabel: string): Factor => ({ id, unit, value, scopes, label, reportLabel });
const FACTORS: Factor[] = [
  // J000663's commuting: NZI's -c copies of DESNZ business-travel factors — same value, a different curated label.
  F("uk-ghg-25_301_3070_9_1", "miles", 0.26187, ["3"], "Business travel- land - Cars (by size) - Average car - Petrol", "Business Travel: Average Car Petrol"),
  F("uk-ghg-25_301_3070_9_1-c", "miles", 0.26187, ["3"], "Employee commuting- land - Cars (by size) - Average car - Petrol", "Employee Commuting: Average Car Petrol"),
  F("uk-ghg-25_315_3147_11_1", "passenger.km", 0.03546, ["3"], "Business travel- land - Rail - National rail", "Business Travel: Rail National Rail"),
  F("uk-ghg-25_315_3147_11_1-c", "passenger.km", 0.03546, ["3"], "Employee commuting- land - Rail - National rail", "Employee Commuting: Rail National Rail"),
  // J000663's spend variants: labels equal to the base's (as on staging).
  F("uk-ghg-SPEND-SIC-49.3-5", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  F("uk-ghg-SPEND-SIC-49.3-5-b", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  F("uk-ghg-SPEND-SIC-49.3-5-u", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  F("uk-ghg-SPEND-SIC-49.3-5-d", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  // The DESNZ freight case: one container-ship factor, upstream natively and downstream by its -d copy.
  F("uk-ghg-27_320_3235_14_1", "tonne.km", 0.01612, ["3"], "Freighting goods - Cargo ship - Container ship", "Freight: Container Ship"),
  F("uk-ghg-27_320_3235_14_1-d", "tonne.km", 0.01612, ["3"], "Freighting goods - Cargo ship - Container ship", "Freight: Container Ship"),
  // Scope 1 figures, no variants: the D1 cases and the commuting case the source never shipped a row for.
  F("uk-ghg-1_101_1011_8_1", "litres", 2.58354, ["1", "3"], "Diesel (average biofuel blend)", "Diesel"),
  F("uk-ghg-4_301_3070_4_1", "km", 0.16272, ["1", "3"], "Passenger vehicles - Large car - Diesel", "Company Vehicles: Large Car Diesel"),
  // The declarative sub-flow's car: 0160's rule for `car|small|petrol`.
  F("uk-ghg-4_301_3046_9_1", "miles", 0.23, ["1", "3"], "Passenger vehicles - Small car - Petrol", "Company Vehicles: Small Car Petrol"),
];
const byId = new Map(FACTORS.map((factor) => [factor.id, factor]));

/** The characterised entries: J000663's categories, each written as its variant (today) and as its base (the new path). */
const ENTRIES: Array<{ key: string; scope: string; categoryCode: string; variant: string; base: string; suffix: string; quantity: number }> = [
  { key: "Car commute", scope: "3.7", categoryCode: "3.7", variant: "uk-ghg-25_301_3070_9_1-c", base: "uk-ghg-25_301_3070_9_1", suffix: "-c", quantity: 1200 },
  { key: "Rail commute", scope: "3.7", categoryCode: "3.7", variant: "uk-ghg-25_315_3147_11_1-c", base: "uk-ghg-25_315_3147_11_1", suffix: "-c", quantity: 5000 },
  { key: "Travel spend", scope: "3.6", categoryCode: "3.6", variant: "uk-ghg-SPEND-SIC-49.3-5-b", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-b", quantity: 10000 },
  { key: "Inbound haulage spend", scope: "3.4", categoryCode: "3.4", variant: "uk-ghg-SPEND-SIC-49.3-5-u", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-u", quantity: 8000 },
  { key: "Outbound haulage spend", scope: "3.9", categoryCode: "3.9", variant: "uk-ghg-SPEND-SIC-49.3-5-d", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-d", quantity: 6000 },
  { key: "Outbound shipping", scope: "3.9", categoryCode: "3.9", variant: "uk-ghg-27_320_3235_14_1-d", base: "uk-ghg-27_320_3235_14_1", suffix: "-d", quantity: 20000 },
];

describe("dedup slice 3: (base, category) by applicability (0172; unconditional since slice 5 Step E)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `s3-${keys}`, correlationId: `corr-s3-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const db = await database.admin();
    try { return (await db.query(sql, params)).rows as T[]; } finally { await db.end(); }
  };
  // Runs a block of work. (The blocks once ran under a flag; there is no flag since slice 5 Step E, but they stay grouped as they were.)
  const run = <T>(work: () => Promise<T>): Promise<T> => work();
  // Typed loosely: a command input; the command validates it.
  const write = (jobId: string, factorId: string, scope: string, categoryCode: string, sourceLabel: string, quantity: number, over: Record<string, unknown> = {}): any => {
    const factor = byId.get(factorId)!;
    return { jobId, scope, categoryCode, sourceLabel, reportLabel: sourceLabel, quantity, unit: factor.unit, datasetId: DS, factorId,
      factorVersion: DS_VERSION, factorLabel: factor.label, qualityTier: "measured", ...over };
  };
  const row = async (rowId: string) => (await q<{ factor_id: string; filed_suffix_code: string | null; factor_label: string; calculated_tco2e: string | null; provenance_json: Record<string, unknown>; version: number }>(
    `SELECT factor_id, filed_suffix_code, factor_label, calculated_tco2e, provenance_json, version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]))[0]!;
  const calculate = async (jobId: string, rowId: string) => calculateScopeRow(database.pool, { jobId, rowId, expectedVersion: (await row(rowId)).version }, context());
  const refusedAs = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);

  before(async () => {
    database = (await createDisposableDatabase("factorappresolve", {
      onMigration: async (filename, owner) => {
        if (!filename.startsWith("0169_")) return;
        await owner.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
        await owner.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
        await owner.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                           VALUES ($1,$2,'DESNZ GB 2025',$3,'2025-01-01','2026-12-31','GB','active','DESNZ','OGL')`, [ORG, DS, DS_VERSION]);
        for (const factor of FACTORS) {
          await owner.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [ORG, DS, factor.id, factor.label, factor.unit, factor.value, factor.scopes]);
          // The curated identity, as the v7 import leaves it: label and report label per factor id.
          await owner.query(`UPDATE nzi_console.factor_identities SET label=$3, report_label=$4 WHERE organisation_id=$1 AND factor_id=$2`, [ORG, factor.id, factor.label, factor.reportLabel]);
        }
      },
    }))!;
    await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Slice Three Co','active')`, [ORG, CLIENT]);
    for (const [job, seq, year] of [[OLD, 1, 2025], [NEW, 2, 2025], [MISC, 3, 2025], [NEXT, 4, 2026]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
               VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',$5,$6,$7)`, [ORG, job, CLIENT, seq, year, `${year}-01-01`, `${year}-12-31`]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, job, `${year}-01-01`, `${year}-12-31`]);
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`, [ORG, job, DS, ACTOR]);
    }
    // 0175 retired the seeded variants as the database was built (nothing cited them then); held active again, as the variants a
    // citation keeps materialised (J000663's) are.
    await q(`UPDATE nzi_console.emission_factors SET active = true WHERE organisation_id = $1 AND NOT active`, [ORG]);
  });
  after(async () => { await database?.end(); });

  // ── 0172 ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("0172 relocates each pair's curated strings from its variant identity, byte for byte, and adds filed_suffix_code (dataset only)", async () => {
    const pairs = await q<{ factor_id: string; suffix_code: string; report_label: string | null; label: string | null }>(
      `SELECT factor_id, suffix_code, report_label, label FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 ORDER BY factor_id, suffix_code`, [ORG]);
    const car = pairs.find((pair) => pair.factor_id === "uk-ghg-25_301_3070_9_1" && pair.suffix_code === "-c")!;
    assert.deepEqual([car.report_label, car.label], ["Employee Commuting: Average Car Petrol", "Employee commuting- land - Cars (by size) - Average car - Petrol"],
      "the commuting copy's own strings, not the business-travel base's");
    for (const pair of pairs) {
      const variant = byId.get(`${pair.factor_id}${pair.suffix_code}`)!;
      assert.deepEqual([pair.report_label, pair.label], [variant.reportLabel, variant.label], `${pair.factor_id}${pair.suffix_code}`);
    }
    const column = (await q<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_schema='nzi_console' AND table_name='job_scope_rows' AND column_name='filed_suffix_code'`))[0];
    assert.equal(column?.is_nullable, "YES");
    const check = (await q<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='job_scope_rows_filed_suffix_dataset_only'`))[0];
    assert.equal(check?.def, "CHECK (((filed_suffix_code IS NULL) OR (factor_source = 'dataset'::text)))", "only a dataset factor may be filed by applicability");
    await assert.rejects(q(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,filed_suffix_code)
                            VALUES ($1,'bad-suffix',$2,'3.7','x','x','Scope 3','Indirect','-zz')`, [ORG, MISC]), /foreign key/);
  });

  // ── The gate: J000663, today's way and the new way ───────────────────────────────────────────────────────────

  it("J000663: variant ids sent are filed as their bases, and price, total, label and compose byte-identically to the bases sent", async () => {
    const created = { old: new Map<string, string>(), new: new Map<string, string>() };
    await run(async () => {
      for (const entry of ENTRIES) created.old.set(entry.key, (await createScopeRow(database.pool, write(OLD, entry.variant, entry.scope, entry.categoryCode, entry.key, entry.quantity), context())).data.rowId);
    });
    await run(async () => {
      for (const entry of ENTRIES) created.new.set(entry.key, (await createScopeRow(database.pool, write(NEW, entry.base, entry.scope, entry.categoryCode, entry.key, entry.quantity), context())).data.rowId);
    });
    // Priced (the flag plays no part in arithmetic), approved, frozen.
    for (const [job, ids] of [[OLD, created.old], [NEW, created.new]] as const) {
      for (const id of ids.values()) await calculate(job, id);
      await q(`UPDATE nzi_console.job_scope_rows SET review_status='approved', reviewed_by=$2, reviewed_row_version=version, reviewed_at=now() WHERE job_id=$1`, [job, ACTOR]);
    }
    // What each stored: both the base, filed under the pair — the variant id is filed as its base.
    for (const entry of ENTRIES) {
      const before = await row(created.old.get(entry.key)!), now = await row(created.new.get(entry.key)!);
      assert.deepEqual([before.factor_id, before.filed_suffix_code], [entry.base, entry.suffix], `${entry.key}: the variant id, filed as its base`);
      assert.deepEqual([now.factor_id, now.filed_suffix_code], [entry.base, entry.suffix], `${entry.key}: the base, filed by applicability`);
      assert.equal(now.calculated_tco2e, before.calculated_tco2e, `${entry.key}: priced identically, off the base's own value`);
      assert.equal(now.factor_label, before.factor_label, `${entry.key}: the factor label the audit names`);
      assert.deepEqual(now.provenance_json.filedUnder, { suffixCode: entry.suffix, by: "applicability" });
      assert.deepEqual(before.provenance_json.filedUnder, { suffixCode: entry.suffix, by: "applicability" });
    }

    const snapshot = async (jobId: string) => {
      const version = (await q<{ version: number }>(`SELECT version FROM nzi_console.jobs WHERE job_id=$1`, [jobId]))[0]!.version;
      const createdSnapshot = await createReviewedCrpSnapshot(database.pool, { jobId, expectedJobVersion: version }, context());
      return (await q<{ payload_json: { measurements: Array<Record<string, unknown>>; provenance: unknown } }>(`SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id=$1`, [createdSnapshot.data.snapshotId]))[0]!.payload_json;
    };
    const before = await snapshot(OLD), now = await snapshot(NEW);
    // Row by row, every field the report reads (rowId and its version are the row's own, not the report's).
    const strip = ({ rowId: _rowId, rowVersion: _rowVersion, ...rest }: Record<string, unknown>) => rest;
    const byKey = (payload: typeof before) => new Map(payload.measurements.map((measurement) => [measurement.sourceLabel as string, strip(measurement)]));
    const [b, n] = [byKey(before), byKey(now)];
    for (const entry of ENTRIES) assert.deepEqual(n.get(entry.key), b.get(entry.key), `${entry.key}: the frozen measurement`);
    const commuting = b.get("Car commute")!;
    assert.equal(commuting.reportLabel, "Employee Commuting: Average Car Petrol", "and the line still reads as commuting, never 'Business Travel'");

    // Totals by scope and by category, and the composed report itself.
    // In one stable order on both sides: a snapshot lists rows by their (random) id, and floating-point sums depend on the order
    // they are added in — two jobs of the same rows would otherwise differ in the last bit, which says nothing about either path.
    const ordered = (payload: typeof before) => [...payload.measurements].sort((x, y) => String(x.sourceLabel).localeCompare(String(y.sourceLabel)));
    const totals = (payload: typeof before, key: "scope" | "scopeCode") => Object.fromEntries([...ordered(payload).reduce((sum, m) => sum.set(m[key] as string, (sum.get(m[key] as string) ?? 0) + Number(m.tco2e)), new Map<string, number>())].sort());
    assert.deepEqual(totals(now, "scope"), totals(before, "scope"));
    assert.deepEqual(totals(now, "scopeCode"), totals(before, "scopeCode"));
    const compose = (payload: typeof before) => {
      const measurements = ordered(payload).map(strip) as never;
      return { emissions: composeScopedEmissions(measurements, { kind: "whole" }, new Map()), audit: composeReportAudit({ measurements, provenance: payload.provenance as never, scope: { kind: "whole" } }) };
    };
    assert.deepEqual(compose(now), compose(before), "the composed emissions and audit are identical");
  });

  // ── Validity: applicability, and D1 ──────────────────────────────────────────────────────────────────────────

  it("a base applicable under the category is filed; a Scope 1 base that is not is refused (D1, as applicability)", async () => {
    await run(async () => {
      const filed = (await createScopeRow(database.pool, write(MISC, "uk-ghg-25_301_3070_9_1", "3.7", "3.7", "Commute (base)", 10), context())).data.rowId;
      assert.deepEqual([(await row(filed)).factor_id, (await row(filed)).filed_suffix_code], ["uk-ghg-25_301_3070_9_1", "-c"]);
      assert.equal((await row(filed)).factor_label, "Employee commuting- land - Cars (by size) - Average car - Petrol", "stored at the write, before any calculation: the pair's factor label");
      await assert.rejects(createScopeRow(database.pool, write(MISC, "uk-ghg-4_301_3070_4_1", "3.7", "3.7", "Commute in a company car", 10), context()),
        (error: unknown) => error instanceof CommandValidationError
          && error.issues.some((issue) => issue.code === "FACTOR_IS_VARIANT_BASE" && /not applicable under this category \('-c'\)/.test(issue.message)));
      // Slice 5 Step A: a covered variant id sent is written as its base, filed under the pair — so nothing new
      // writes a variant id the retirement would leave dangling.
      const variant = (await createScopeRow(database.pool, write(MISC, "uk-ghg-25_301_3070_9_1-c", "3.7", "3.7", "Commute (variant)", 10), context())).data.rowId;
      assert.deepEqual([(await row(variant)).factor_id, (await row(variant)).filed_suffix_code, (await row(variant)).factor_label],
        ["uk-ghg-25_301_3070_9_1", "-c", "Employee commuting- land - Cars (by size) - Average car - Petrol"]);
    });
  });

  // ── The DESNZ cases ──────────────────────────────────────────────────────────────────────────────────────────

  it("commuting priced off a car factor the source never shipped a commuting row for, once an admin marks it applicable", async () => {
    await run(async () => {
      await assert.rejects(createScopeRow(database.pool, write(MISC, "uk-ghg-4_301_3070_4_1", "3.7", "3.7", "Large car commute", 400), context()), refusedAs("FACTOR_IS_VARIANT_BASE"),
        "a Scope 1 car is not a commuting factor until NZI says so");
      const admin = { userId: ACTOR, organisationId: ORG, role: "admin", capabilities: [{ capability: "factor.manage", scope: "all" }] } as unknown as StaffPrincipal;
      await addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-4_301_3070_4_1", suffixCode: "-c",
        reportLabel: "Employee Commuting: Large Car Diesel", label: "Employee commuting- land - Large car - Diesel" });
      const rowId = (await createScopeRow(database.pool, write(MISC, "uk-ghg-4_301_3070_4_1", "3.7", "3.7", "Large car commute", 400), context())).data.rowId;
      await calculate(MISC, rowId);
      const stored = await row(rowId);
      assert.deepEqual([stored.factor_id, stored.filed_suffix_code, stored.factor_label], ["uk-ghg-4_301_3070_4_1", "-c", "Employee commuting- land - Large car - Diesel"]);
      assert.equal(Number(stored.calculated_tco2e), Number((400 * 0.16272 / 1000).toFixed(12)), "the base's own value — no commuting row exists to price it");
      const read = (await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, MISC))).find((entry) => entry.id === rowId)!;
      assert.equal(read.reportLabel, "Employee Commuting: Large Car Diesel", "the pair's own report label, not the Scope 1 car's");
    });
  });

  it("upstream and downstream freight both priced off the one container-ship base", async () => {
    await run(async () => {
      const upstream = (await createScopeRow(database.pool, write(MISC, "uk-ghg-27_320_3235_14_1", "3.4", "3.4", "Inbound shipping", 1000), context())).data.rowId;
      const downstream = (await createScopeRow(database.pool, write(MISC, "uk-ghg-27_320_3235_14_1", "3.9", "3.9", "Outbound shipping", 1000), context())).data.rowId;
      await calculate(MISC, upstream);
      await calculate(MISC, downstream);
      const [up, down] = [await row(upstream), await row(downstream)];
      assert.deepEqual([up.factor_id, up.filed_suffix_code], ["uk-ghg-27_320_3235_14_1", null], "upstream: the base used natively");
      assert.deepEqual([down.factor_id, down.filed_suffix_code], ["uk-ghg-27_320_3235_14_1", "-d"], "downstream: the same base, filed by applicability");
      assert.equal(up.calculated_tco2e, down.calculated_tco2e, "one factor, one value");
    });
  });

  it("the declarative sub-flow files the vehicle flow's car under commuting by applicability, and stops without it", async () => {
    await q(`UPDATE nzi_console.input_spec_categories SET declarative_resolution_enabled=true WHERE category_code='3.7'`);
    try {
      const attributes = { source: "stub", fuel: "petrol", vehicleClass: "car", category: "car|small|petrol", fallbackCategory: "car|average|petrol" };
      const entry = (label: string) => write(MISC, "uk-ghg-4_301_3046_9_1", "3.7", "3.7", label, 100, { factorId: null, datasetId: null, factorVersion: null, factorLabel: null, assertedVehicleAttributes: attributes });
      await run(async () => {
        await assert.rejects(createScopeRow(database.pool, entry("Commute by small car (not applicable)"), context()), refusedAs("FACTOR_REQUIRED"),
          "not applicable: it stops too — never the Scope 1 base under Scope 3");
        const admin = { userId: ACTOR, organisationId: ORG, role: "admin", capabilities: [{ capability: "factor.manage", scope: "all" }] } as unknown as StaffPrincipal;
        await addFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-4_301_3046_9_1", suffixCode: "-c", reportLabel: "Employee Commuting: Small Car Petrol" });
        const rowId = (await createScopeRow(database.pool, entry("Commute by small car"), context())).data.rowId;
        const stored = await row(rowId);
        assert.deepEqual([stored.factor_id, stored.filed_suffix_code], ["uk-ghg-4_301_3046_9_1", "-c"], "filled with the base, filed under commuting");
        const trail = (stored.provenance_json.declarativeResolution ?? {}) as Record<string, unknown>;
        assert.deepEqual([trail.decision, trail.filedSuffixCode], ["filled", "-c"]);
      });
    } finally {
      await q(`UPDATE nzi_console.input_spec_categories SET declarative_resolution_enabled=false WHERE category_code='3.7'`);
    }
  });

  it("roll-forward keeps a row filed while the pair is applicable, and drops the pair once it is retired", async () => {
    await run(async () => {
      const kept = (await createScopeRow(database.pool, write(MISC, "uk-ghg-25_315_3147_11_1", "3.7", "3.7", "Rail commute (roll)", 100), context())).data.rowId;
      const rolled = await rollforwardScopeRows(database.pool, { jobId: NEXT, priorJobId: MISC, rowIds: [kept] }, context());
      assert.equal((await row(rolled.data.createdRowIds[0]!)).filed_suffix_code, "-c");
      const admin = { userId: ACTOR, organisationId: ORG, role: "admin", capabilities: [{ capability: "factor.manage", scope: "all" }] } as unknown as StaffPrincipal;
      await retireFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-25_315_3147_11_1", suffixCode: "-c", reason: "Rail commuting moved to its own factor." });
      const again = (await createScopeRow(database.pool, write(MISC, "uk-ghg-25_315_3147_11_1-c", "3.7", "3.7", "Rail commute (variant, roll)", 100), context())).data.rowId;
      const old = await q(`UPDATE nzi_console.job_scope_rows SET factor_id='uk-ghg-25_315_3147_11_1', filed_suffix_code='-c' WHERE scope_row_id=$1 RETURNING scope_row_id`, [again]);
      assert.equal(old.length, 1);
      const rolledAgain = await rollforwardScopeRows(database.pool, { jobId: NEXT, priorJobId: MISC, rowIds: [again] }, context());
      assert.equal((await row(rolledAgain.data.createdRowIds[0]!)).filed_suffix_code, null, "a new row may not newly cite a retired pair");
    });
  });
});
