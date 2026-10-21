import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, composeReportAudit, composeScopedEmissions, type CommandContext } from "@nzi/contracts";
import type { StaffPrincipal } from "../src/auth";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { DIVERGENT_EXTRACT, FOLD_EXTRACT, FOLDED_IDS } from "./support/v7FoldExtract";
import { addFactorApplicability } from "../src/factorApplicability";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import { calculateScopeRow, createReviewedCrpSnapshot, createScopeRow } from "../src/postgresCommands";
import { listScopeRows } from "../src/readModels";
import { withTenantRead } from "../src/postgres";
import { planV7Load, type LoadPlan } from "../src/v7ReferenceImport";
import { loadV7Plan, V7LoadRefused } from "../src/v7ReferenceLoad";

/**
 * Dedup slice 4 (migration 0173, REPORT_FACTOR_APPLICABILITY): the v7 reference import folds a same-value `<base><suffix>` row into
 * its base's applicability — the pair, the variant's labels and its lineage — instead of writing the duplicate value row.
 *
 * **The gate is an import run, old vs new, on J000663-shaped data**: the same extract loaded today's way (flag off, every variant
 * row written) into one organisation and the new way (flag on, folded) into another, then J000663's entries written on each —
 * variant ids today, bases filed by applicability on the new path — must price, total, label and compose byte-identically. Two
 * organisations holding the same ids (dataset, client, job), so every field the report carries can be compared as it stands.
 */
const OLD = "org-s4-old", NEW = "org-s4-new", CLIENT = "client-s4", JOB = "job-s4", ACTOR = "ada";
const DS = "uk-ghg-gb-2025";

/** J000663's categories, each written as its variant (today) and as its base (the new path). `-bcp` is not folded: both cite it. */
const ENTRIES: Array<{ key: string; scope: string; variant: string; base: string; suffix: string | null; unit: string; label: string; quantity: number }> = [
  { key: "Car commute", scope: "3.7", variant: "uk-ghg-25_301_3070_9_1-c", base: "uk-ghg-25_301_3070_9_1", suffix: "-c", unit: "miles", label: "Employee commuting- land - Cars (by size) - Average car - Petrol", quantity: 1200 },
  { key: "Travel spend", scope: "3.6", variant: "uk-ghg-SPEND-SIC-49.3-5-b", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-b", unit: "GBP", label: "Land transport services", quantity: 10000 },
  { key: "Inbound haulage spend", scope: "3.4", variant: "uk-ghg-SPEND-SIC-49.3-5-u", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-u", unit: "GBP", label: "Land transport services", quantity: 8000 },
  { key: "Outbound haulage spend", scope: "3.9", variant: "uk-ghg-SPEND-SIC-49.3-5-d", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-d", unit: "GBP", label: "Land transport services", quantity: 6000 },
  { key: "Outbound shipping", scope: "3.9", variant: "uk-ghg-27_320_3235_14_1-d", base: "uk-ghg-27_320_3235_14_1", suffix: "-d", unit: "tonne.km", label: "Freighting goods - Cargo ship - Container ship", quantity: 20000 },
  { key: "Large car travel", scope: "3.6", variant: "uk-ghg-4_301_3070_4_1-bcp", base: "uk-ghg-4_301_3070_4_1-bcp", suffix: null, unit: "km", label: "Business travel - Large car - Diesel", quantity: 300 },
];

describe("dedup slice 4: the v7 import folds same-value variants into applicability (0173, REPORT_FACTOR_APPLICABILITY)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  let registry: Awaited<ReturnType<typeof listCategoryVariants>>;
  const context = (organisationId: string): CommandContext => {
    keys += 1;
    return { organisationId, actorId: ACTOR, principal: "staff", idempotencyKey: `s4-${keys}`, correlationId: `corr-s4-${keys}`, grant: commandGrantForRole("admin", organisationId, ACTOR) };
  };
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const db = await database.admin();
    try { return (await db.query(sql, params)).rows as T[]; } finally { await db.end(); }
  };
  // Both states set explicitly: absent is on since slice 5 Step D, and "false" is the kill-switch (kept until Step E).
  const withFlag = async <T>(value: "true" | "false", work: () => Promise<T>): Promise<T> => {
    const saved = process.env.REPORT_FACTOR_APPLICABILITY;
    process.env.REPORT_FACTOR_APPLICABILITY = value;
    try { return await work(); } finally { if (saved === undefined) delete process.env.REPORT_FACTOR_APPLICABILITY; else process.env.REPORT_FACTOR_APPLICABILITY = saved; }
  };
  const ids = async (organisationId: string) => (await q<{ factor_id: string }>(
    `SELECT factor_id FROM nzi_console.emission_factors WHERE organisation_id=$1 AND dataset_id=$2 ORDER BY factor_id`, [organisationId, DS])).map((row) => row.factor_id);
  const pairs = async (organisationId: string) => q<{ factor_id: string; suffix_code: string; source: string; report_label: string | null; label: string | null;
    source_system: string | null; legacy_original_id: string | null; legacy_db_id: string | null; created_by: string; status: string }>(
    `SELECT factor_id, suffix_code, source, report_label, label, source_system, legacy_original_id, legacy_db_id, created_by, status
       FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 ORDER BY factor_id, suffix_code`, [organisationId]);
  const plans = { old: undefined as unknown as LoadPlan, new: undefined as unknown as LoadPlan };

  before(async () => {
    database = (await createDisposableDatabase("v7fold"))!;
    for (const organisationId of [OLD, NEW, "org-s4-guard"]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [organisationId]);
      await q(`SELECT nzi_console.provision_organisation($1)`, [organisationId]);
    }
    const db = await database.admin();
    try { registry = await listCategoryVariants(db as never); } finally { await db.end(); }
    plans.old = planV7Load(FOLD_EXTRACT, registry, { organisationId: OLD });
    plans.new = planV7Load(FOLD_EXTRACT, registry, { organisationId: NEW, fold: true });
    assert.deepEqual([plans.old.refusals, plans.new.refusals], [[], []]);
  });
  after(async () => { await database?.end(); });

  // ── The import ───────────────────────────────────────────────────────────────────────────────────────────────

  it("a folding plan is written only with the flag on: off, it is refused and nothing is written", async () => {
    await withFlag("false", async () => {
      await assert.rejects(loadV7Plan(database.pool, plans.new), (error) => error instanceof V7LoadRefused && /only resolves with REPORT_FACTOR_APPLICABILITY on/.test(error.message));
    });
    assert.deepEqual(await ids(NEW), []);
  });

  it("a folded row is re-checked in SQL against the base as written: a tampered plan is refused, and nothing is written", async () => {
    const tampered: LoadPlan = { ...plans.new, folded: plans.new.folded.map((row) => row.factorId.endsWith("-c") ? { ...row, kgco2ePerUnit: "0.26188" } : row) };
    await withFlag("true", async () => {
      await assert.rejects(loadV7Plan(database.pool, tampered), (error) => error instanceof V7LoadRefused && /uk-ghg-25_301_3070_9_1-c/.test(error.message) && /Nothing was written/.test(error.message));
    });
    assert.deepEqual([await ids(NEW), await pairs(NEW)], [[], []]);
  });

  it("flag off: today's import exactly — every variant row written, no pair, nothing folded", async () => {
    const outcome = await withFlag("false", () => loadV7Plan(database.pool, plans.old));
    assert.deepEqual(outcome, { datasetsInserted: 1, datasetsUnchanged: 0, identitiesInserted: FOLD_EXTRACT.length, identitiesKept: 0, factorsInserted: FOLD_EXTRACT.length,
      factorsFolded: 0, applicabilityInserted: 0, applicabilityKept: 0 });
    assert.deepEqual(await ids(OLD), plans.old.factors.map((factor) => factor.factorId).sort());
    assert.deepEqual(await pairs(OLD), [], "0170 backfilled at migration time; a flag-off import adds no pair");
  });

  it("flag on: the duplicate rows are not written; each pair is, with the variant's exact strings and its lineage — 0170's guard satisfied", async () => {
    const outcome = await withFlag("true", () => loadV7Plan(database.pool, plans.new));
    assert.deepEqual(outcome, { datasetsInserted: 1, datasetsUnchanged: 0, identitiesInserted: FOLD_EXTRACT.length - FOLDED_IDS.length, identitiesKept: 0,
      factorsInserted: FOLD_EXTRACT.length - FOLDED_IDS.length, factorsFolded: FOLDED_IDS.length, applicabilityInserted: FOLDED_IDS.length, applicabilityKept: 0 });
    const loaded = await ids(NEW);
    assert.deepEqual(loaded, (await ids(OLD)).filter((id) => !FOLDED_IDS.includes(id)), "today's rows less exactly the folded ones");
    for (const kept of ["uk-ghg-4_301_3070_4_1-bcp", "uk-ghg-77_700_7000_1_1-b", "uk-ghg-WTT-25_301_3070_9_1", "uk-ghg-25_301_3070_4_1"]) assert.ok(loaded.includes(kept), kept);
    const variantIdentities = await q(`SELECT factor_id FROM nzi_console.factor_identities WHERE organisation_id=$1 AND factor_id = ANY($2)`, [NEW, FOLDED_IDS]);
    assert.deepEqual(variantIdentities, [], "no identity for a variant with no row left to describe");

    const written = await pairs(NEW);
    assert.deepEqual(written.map((pair) => `${pair.factor_id}${pair.suffix_code}`).sort(), FOLDED_IDS);
    // Exactly what the materialised import's variant identity holds, byte for byte — that is what slice 3 prints for a filed row.
    const identities = new Map((await q<{ factor_id: string; report_label: string | null; label: string; legacy_original_id: string }>(
      `SELECT factor_id, report_label, label, legacy_original_id FROM nzi_console.factor_identities WHERE organisation_id=$1`, [OLD])).map((row) => [row.factor_id, row]));
    for (const pair of written) {
      const variant = identities.get(`${pair.factor_id}${pair.suffix_code}`)!;
      assert.deepEqual([pair.report_label, pair.label], [variant.report_label, variant.label], `${pair.factor_id}${pair.suffix_code}: the variant's strings`);
      assert.deepEqual([pair.source, pair.created_by, pair.status, pair.source_system, pair.legacy_original_id], ["import", "import:v7", "active", "nzi-pro-v7", variant.legacy_original_id]);
    }
    const car = written.find((pair) => pair.suffix_code === "-c")!;
    assert.deepEqual([car.report_label, car.legacy_db_id], ["Employee Commuting: Average Car Petrol", "502"], "the commuting copy's label, not the business-travel base's");
    assert.equal(written.find((pair) => pair.suffix_code === "-p")!.report_label, null, "no curated report label: NULL, never the base's");

    // The lineage, row by row, in one audit event per pair: every field the fold did not write.
    const events = await q<{ entity_id: string; principal_type: string; after_json: { outcome: string; folded: Array<Record<string, unknown>> } }>(
      `SELECT entity_id, principal_type, after_json FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='factor.applicability.imported' ORDER BY entity_id`, [NEW]);
    assert.deepEqual(events.map((event) => event.entity_id), FOLDED_IDS);
    const commute = events.find((event) => event.entity_id.endsWith("-c"))!;
    assert.equal(commute.principal_type, "system");
    assert.deepEqual(commute.after_json.folded, [{ datasetId: DS, factorId: "uk-ghg-25_301_3070_9_1-c", legacyDbId: "502", legacyOriginalId: "25_301_3070_9_1-c",
      kgco2ePerUnit: "0.261870", activityUnit: "miles", scopes: ["3"], label: "Employee commuting- land - Cars (by size) - Average car - Petrol",
      sourceCategory: "Employee Commuting", sourceLevels: ["Employee commuting- land", "Cars (by size)", "Average car", "Petrol"] }]);
    assert.equal(commute.after_json.outcome, "added");
  });

  it("re-running either load changes nothing: the dataset is unchanged, so no pair and no event is written twice", async () => {
    const before = (await q(`SELECT 1 FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='factor.applicability.imported'`, [NEW])).length;
    const again = await withFlag("true", () => loadV7Plan(database.pool, plans.new));
    assert.deepEqual([again.datasetsUnchanged, again.factorsInserted, again.factorsFolded, again.applicabilityInserted], [1, 0, 0, 0]);
    // The old organisation, re-run with the flag now on: its dataset's hash is of the source edition, so it is unchanged too.
    const flipped = await withFlag("true", () => loadV7Plan(database.pool, { ...planV7Load(FOLD_EXTRACT, registry, { organisationId: OLD, fold: true }) }));
    assert.deepEqual([flipped.datasetsUnchanged, flipped.factorsFolded, flipped.applicabilityInserted], [1, 0, 0]);
    assert.equal((await q(`SELECT 1 FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='factor.applicability.imported'`, [NEW])).length, before);
  });

  it("a copy at a different number is never folded: 0170's guard refuses it on either path, as today", async () => {
    for (const flag of ["false", "true"] as const) {
      const divergent = planV7Load(DIVERGENT_EXTRACT, registry, { organisationId: "org-s4-guard", fold: flag === "true" });
      assert.deepEqual(divergent.folded, []);
      await withFlag(flag, async () => {
        await assert.rejects(loadV7Plan(database.pool, divergent), /A category variant carries its base's value/);
      });
    }
    assert.deepEqual(await q(`SELECT 1 FROM nzi_console.emission_factor_datasets WHERE organisation_id='org-s4-guard'`), []);
  });

  it("0173: an imported pair names its lineage and no other does; where a pair came from is never rewritten", async () => {
    const check = (await q<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='factor_identity_category_source'`))[0];
    assert.equal(check?.def, "CHECK ((source = ANY (ARRAY['migration'::text, 'admin'::text, 'import'::text])))");
    await assert.rejects(q(`INSERT INTO nzi_console.factor_identity_categories (organisation_id,factor_id,suffix_code,source,created_by,updated_by) VALUES ($1,'uk-ghg-WTT-25_301_3070_9_1','-c','import','x','x')`, [NEW]),
      /factor_identity_category_import_lineage/, "an import with no lineage");
    await assert.rejects(q(`INSERT INTO nzi_console.factor_identity_categories (organisation_id,factor_id,suffix_code,source,created_by,updated_by,source_system,legacy_original_id,legacy_db_id) VALUES ($1,'uk-ghg-WTT-25_301_3070_9_1','-c','admin','x','x','nzi-pro-v7','a','1')`, [NEW]),
      /factor_identity_category_import_lineage/, "an admin pair claiming a source row");
    for (const set of ["source='admin', source_system=NULL, legacy_original_id=NULL, legacy_db_id=NULL", "legacy_db_id='999'", "source_system='other'"]) {
      await assert.rejects(q(`UPDATE nzi_console.factor_identity_categories SET ${set} WHERE organisation_id=$1 AND factor_id='uk-ghg-25_301_3070_9_1' AND suffix_code='-c'`, [NEW]),
        /keeps where it came from/, set);
    }
    // Status and labels stay writable: an admin may still curate an imported pair.
    const relabelled = await q(`UPDATE nzi_console.factor_identity_categories SET report_label='Employee Commuting: Car (Petrol)', version=version+1 WHERE organisation_id=$1 AND factor_id='uk-ghg-27_320_3235_14_1' AND suffix_code='-d' RETURNING source`, [NEW]);
    assert.deepEqual(relabelled, [{ source: "import" }]);
    await q(`UPDATE nzi_console.factor_identity_categories SET report_label='Freight: Container Ship', version=version+1 WHERE organisation_id=$1 AND factor_id='uk-ghg-27_320_3235_14_1' AND suffix_code='-d'`, [NEW]);
    // The admin path is unchanged: no lineage, source admin.
    const admin = { userId: ACTOR, organisationId: NEW, role: "admin", capabilities: [{ capability: "factor.manage", scope: "all" }] } as unknown as StaffPrincipal;
    await addFactorApplicability(database.pool, admin, { organisationId: NEW, factorId: "uk-ghg-25_301_3070_4_1", suffixCode: "-c" });
    const added = (await pairs(NEW)).find((pair) => pair.factor_id === "uk-ghg-25_301_3070_4_1")!;
    assert.deepEqual([added.source, added.source_system, added.legacy_original_id, added.legacy_db_id, added.report_label], ["admin", null, null, null, null]);
  });

  // ── The gate: J000663 on the imported data, old vs new ───────────────────────────────────────────────────────

  it("J000663: a folded factor prices, totals, labels and composes byte-identically to the materialised variant", async () => {
    // The job number is one global counter (NZC-025), so the two organisations' jobs carry different sequences.
    for (const [organisationId, sequence] of [[OLD, 1], [NEW, 2]] as const) {
      await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [organisationId, ACTOR]);
      await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Slice Four Co','active')`, [organisationId, CLIENT]);
      await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
               VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [organisationId, JOB, CLIENT, sequence]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [organisationId, JOB]);
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`, [organisationId, JOB, DS, ACTOR]);
    }
    const version = (await q<{ version: string }>(`SELECT version FROM nzi_console.emission_factor_datasets WHERE organisation_id=$1 AND dataset_id=$2`, [OLD, DS]))[0]!.version;
    const write = (factorId: string, entry: typeof ENTRIES[number]): any => ({ jobId: JOB, scope: entry.scope, categoryCode: entry.scope, sourceLabel: entry.key, reportLabel: entry.key,
      quantity: entry.quantity, unit: entry.unit, datasetId: DS, factorId, factorVersion: version, factorLabel: entry.label, qualityTier: "measured" });
    const row = async (organisationId: string, rowId: string) => (await q<{ factor_id: string; filed_suffix_code: string | null; factor_label: string; calculated_tco2e: string | null; version: number }>(
      `SELECT factor_id, filed_suffix_code, factor_label, calculated_tco2e, version FROM nzi_console.job_scope_rows WHERE organisation_id=$1 AND scope_row_id=$2`, [organisationId, rowId]))[0]!;

    const created = { old: new Map<string, string>(), new: new Map<string, string>() };
    await withFlag("false", async () => {
      for (const entry of ENTRIES) created.old.set(entry.key, (await createScopeRow(database.pool, write(entry.variant, entry), context(OLD))).data.rowId);
    });
    await withFlag("true", async () => {
      for (const entry of ENTRIES) created.new.set(entry.key, (await createScopeRow(database.pool, write(entry.base, entry), context(NEW))).data.rowId);
    });
    for (const [organisationId, rows] of [[OLD, created.old], [NEW, created.new]] as const) {
      for (const id of rows.values()) await calculateScopeRow(database.pool, { jobId: JOB, rowId: id, expectedVersion: (await row(organisationId, id)).version }, context(organisationId));
      await q(`UPDATE nzi_console.job_scope_rows SET review_status='approved', reviewed_by=$3, reviewed_row_version=version, reviewed_at=now() WHERE organisation_id=$1 AND job_id=$2`, [organisationId, JOB, ACTOR]);
    }
    for (const entry of ENTRIES) {
      const before = await row(OLD, created.old.get(entry.key)!), now = await row(NEW, created.new.get(entry.key)!);
      assert.deepEqual([before.factor_id, before.filed_suffix_code], [entry.variant, null], `${entry.key}: today, the materialised variant`);
      assert.deepEqual([now.factor_id, now.filed_suffix_code], [entry.base, entry.suffix], `${entry.key}: the new path`);
      assert.equal(now.calculated_tco2e, before.calculated_tco2e, `${entry.key}: priced identically`);
      assert.equal(now.factor_label, before.factor_label, `${entry.key}: the factor label the audit names`);
    }
    const reads = async (organisationId: string) => new Map((await withTenantRead(database.pool, organisationId, (db) => listScopeRows(db, JOB))).map((entry) => [entry.sourceLabel, entry.reportLabel]));
    assert.deepEqual(await reads(NEW), await reads(OLD), "the scope-row read model's labels");

    const snapshot = async (organisationId: string) => {
      const jobVersion = (await q<{ version: number }>(`SELECT version FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`, [organisationId, JOB]))[0]!.version;
      const createdSnapshot = await createReviewedCrpSnapshot(database.pool, { jobId: JOB, expectedJobVersion: jobVersion }, context(organisationId));
      return (await q<{ payload_json: { measurements: Array<Record<string, unknown>>; provenance: unknown } }>(
        `SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id=$1 AND snapshot_id=$2`, [organisationId, createdSnapshot.data.snapshotId]))[0]!.payload_json;
    };
    const before = await snapshot(OLD), now = await snapshot(NEW);
    const strip = ({ rowId: _rowId, rowVersion: _rowVersion, ...rest }: Record<string, unknown>) => rest;
    const byKey = (payload: typeof before) => new Map(payload.measurements.map((measurement) => [measurement.sourceLabel as string, strip(measurement)]));
    const [b, n] = [byKey(before), byKey(now)];
    for (const entry of ENTRIES) assert.deepEqual(n.get(entry.key), b.get(entry.key), `${entry.key}: the frozen measurement`);
    assert.equal(b.get("Car commute")!.reportLabel, "Employee Commuting: Average Car Petrol", "the commuting line reads as commuting on both");
    // In one stable order on both sides (a snapshot lists rows by their random id; float sums depend on order).
    const ordered = (payload: typeof before) => [...payload.measurements].sort((x, y) => String(x.sourceLabel).localeCompare(String(y.sourceLabel)));
    const totals = (payload: typeof before, key: "scope" | "scopeCode") => Object.fromEntries([...ordered(payload).reduce((sum, m) => sum.set(m[key] as string, (sum.get(m[key] as string) ?? 0) + Number(m.tco2e)), new Map<string, number>())].sort());
    assert.deepEqual(totals(now, "scope"), totals(before, "scope"));
    assert.deepEqual(totals(now, "scopeCode"), totals(before, "scopeCode"));
    assert.deepEqual(now.provenance, before.provenance, "the snapshot's provenance");
    const compose = (payload: typeof before) => {
      const measurements = ordered(payload).map(strip) as never;
      return { emissions: composeScopedEmissions(measurements, { kind: "whole" }, new Map()), audit: composeReportAudit({ measurements, provenance: payload.provenance as never, scope: { kind: "whole" } }) };
    };
    assert.deepEqual(compose(now), compose(before), "the composed emissions and audit are identical");
  });

  // ── The next edition ─────────────────────────────────────────────────────────────────────────────────────────

  it("the next edition, folded: a curated variant identity's strings win over the extract's; a pair already in place is kept as it stands", async () => {
    // 2026, with v7's own wording moved on for the commuting copy.
    const edition = FOLD_EXTRACT.map((entry) => ({ ...entry, db_id: String(Number(entry.db_id) + 1000), dataset_id: "10", year: "2026", valid_from: "2026-01-01", valid_to: "2026-12-31",
      ...(entry.original_id === "25_301_3070_9_1-c" ? { report_label: "Employee Commuting: Average Car Petrol (2026)" } : {}) }));
    // The organisation loaded 2025 today's way: its variant identities exist, curated here, and it has no pair for them.
    await q(`UPDATE nzi_console.factor_identities SET report_label='Employee Commuting: Petrol Car (curated)' WHERE organisation_id=$1 AND factor_id='uk-ghg-25_301_3070_9_1-c'`, [OLD]);
    const intoOld = await withFlag("true", () => loadV7Plan(database.pool, planV7Load(edition, registry, { organisationId: OLD, fold: true })));
    assert.deepEqual([intoOld.datasetsInserted, intoOld.factorsFolded, intoOld.applicabilityInserted, intoOld.applicabilityKept], [1, FOLDED_IDS.length, FOLDED_IDS.length, 0]);
    const car = (await pairs(OLD)).find((pair) => pair.factor_id === "uk-ghg-25_301_3070_9_1" && pair.suffix_code === "-c")!;
    assert.deepEqual([car.report_label, car.label, car.legacy_db_id], ["Employee Commuting: Petrol Car (curated)", "Employee commuting- land - Cars (by size) - Average car - Petrol", "1502"],
      "the identity in place is curated and is what a materialised row prints — never the extract's wording over it");

    // The organisation folded 2025: every pair is in place, and stays exactly as it was; the event says so.
    const beforePairs = await pairs(NEW);
    const intoNew = await withFlag("true", () => loadV7Plan(database.pool, planV7Load(edition, registry, { organisationId: NEW, fold: true })));
    assert.deepEqual([intoNew.datasetsInserted, intoNew.factorsFolded, intoNew.applicabilityInserted, intoNew.applicabilityKept], [1, FOLDED_IDS.length, 0, FOLDED_IDS.length]);
    assert.deepEqual(await pairs(NEW), beforePairs);
    const kept = await q<{ after_json: { outcome: string; reportLabel?: string; folded: Array<{ legacyDbId: string }> } }>(
      `SELECT after_json FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='factor.applicability.imported' AND entity_id='uk-ghg-25_301_3070_9_1-c' AND after_json->>'outcome'='kept'`, [NEW]);
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0]!.after_json.reportLabel, kept[0]!.after_json.folded.map((row) => row.legacyDbId)], [undefined, ["1502"]], "the 2026 row's lineage, against the pair it joined");
  });
});
