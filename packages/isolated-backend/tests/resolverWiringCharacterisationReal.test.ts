import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  proposeCompanions, resolveFactorForEntry,
  type CategoryVariant, type CompanionRule, type FactorRule, type MappingOutcome,
} from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { companionRulesFor, factorRulesFor, listCompanionRules, listFactorRules } from "../src/inputSpecFactorRules";
import { lookupVehicleByRegistration, resolveVehicleFactor, vehicleAttributes, type VehicleSpec } from "../src/vehicleLookup";

/**
 * Stop 1 of the wiring commit: what today's paths choose, against what the declarative resolver would choose.
 *
 * ## What "today" is, because it is not the write command
 *
 * `createScopeRow` resolves no factor. It stores the `factorId` its caller sends. What chooses that factor
 * today is upstream of the write, and differs by path:
 *
 *   - **Registration categories** (company vehicles, business travel, commuting) — the CRM lookup route runs
 *     `resolveVehicleFactor`, an `ILIKE` over factor labels restricted to `'1' = ANY(scopes)`, and the form
 *     applies its answer as the entry's factor. This is the only automated resolution that exists today.
 *   - **Everything else in the CRM** — a person picks from the job's factors (the full form's select starts
 *     blank; lean capture exact-matches the label the person chose).
 *   - **The portal** — the client chooses from a staff-granted allow-list, pre-selected to the first by
 *     `lower(label)`; the portal lookup discards the suggested factor. A reviewer's acceptance copies the
 *     choice onto the scope row.
 *
 * So the "before" side here is **the old code, executed**: the real DVLA stub, the real `resolveVehicleFactor`
 * SQL against real rows, and the portal's real ordering expression under the database's real collation. It is
 * never the resolver compared with itself — the suite proves that at the end, by mutating a seeded rule and
 * watching a divergence appear where there was none.
 *
 * ## Two datasets, and why the second is a probe
 *
 * **shipped** is the factor seed staging carries (0003). Every label there reads "<fuel> — demonstration
 * factor", with no vehicle class in it, so the `ILIKE` matcher can never succeed on it: that is itself a
 * finding about today, and it is also why shipped data alone could not show what the matcher *does* when it
 * matches. **probe** adds factors labelled the way DESNZ labels them ("Medium car — Diesel"), inserted by this
 * test and named as such, to exercise the matcher's positive branch. Nothing about the probe is a claim about
 * staging's data.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const CLIENT = "client-char";
const JOB_SHIPPED = "job-char-shipped";
const JOB_PROBE = "job-char-probe";
const here = dirname(fileURLToPath(import.meta.url));

/** Registrations the staging stub maps to each of its four vehicles — asserted below, never assumed. */
const PLATES = {
  dieselVan: "AB12CDH",
  petrolCar: "AB12CDE",
  electricCar: "AB12CDF",
  hybridCar: "AB12CDG",
} as const;

const ENABLED = ["1.company-vehicles", "2.purchased-electricity", "2.renewable-electricity", "3.6", "3.7"];
const VEHICLE_FLOW = ["1.company-vehicles", "3.6", "3.7"];
const ELECTRICITY = ["2.purchased-electricity", "2.renewable-electricity"];
const SUPPLY = ["grid", "grid-renewable", "green-tariff", "rego", "self-generated", null] as const;

type Before =
  | { kind: "automated"; path: string; factorId: string | null; detail: string }
  | { kind: "person"; path: string; plausiblePick: string | null; detail: string };

type Row = {
  id: string;
  dataset: "shipped" | "probe";
  category: string;
  entry: string;
  before: Before;
  after: { kind: MappingOutcome["kind"]; factorId: string | null; ghgCategory: string | null; ruleKey: string | null; reason: string | null };
  companions: { before: string[]; after: string[] };
  unitCheck: string;
  verdict: "identical" | "different";
};

describe("wiring characterisation — today's paths against the declarative resolver (Stop 1)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let registry: CategoryVariant[];
  const rows: Row[] = [];

  const available = async (jobId: string) => (await db.query<{ factor_id: string; scopes: string[]; activity_unit: string; label: string }>(
    `SELECT f.factor_id, f.scopes, f.activity_unit, f.label
       FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factors f ON (f.organisation_id, f.dataset_id) = (s.organisation_id, s.dataset_id)
      WHERE s.job_id = $1 AND f.active`, [jobId])).rows;

  const vehicleFor = async (plate: string): Promise<VehicleSpec> => {
    const result = await lookupVehicleByRegistration(plate, { allowStub: true });
    assert.ok(result.ok, `the stub refused ${plate}`);
    return result.vehicle;
  };

  before(async () => {
    database = (await createDisposableDatabase("wirechar"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    for (const [index, job] of [JOB_SHIPPED, JOB_PROBE].entries()) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, CLIENT, index + 1]);
      await db.query(
        `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
         VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, job]);
    }

    // The shipped seed, run as written: it inserts the factors and selects them for both jobs.
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));

    // The probe: DESNZ-shaped labels, selected for the probe job only. Test-inserted and named so.
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
       VALUES ($1,'probe-desnz-shaped','Probe — DESNZ-shaped labels','probe','2026-01-01','2026-12-31','GB','active','Characterisation probe','Test only')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES
        ($1,'probe-desnz-shaped','probe-car-diesel-km','Medium car — Diesel','km',0.17,ARRAY['1']),
        ($1,'probe-desnz-shaped','probe-van-diesel-km','Average van — Diesel','km',0.25,ARRAY['1']),
        ($1,'probe-desnz-shaped','probe-car-petrol-km','Medium car — Petrol','km',0.18,ARRAY['1']),
        ($1,'probe-desnz-shaped','probe-car-hybrid-km','Medium car — Hybrid','km',0.11,ARRAY['1']),
        ($1,'probe-desnz-shaped','probe-car-bev-km','Medium car — Battery electric','km',0.05,ARRAY['2']),
        ($1,'probe-desnz-shaped','probe-petrol-litres','Petrol (average biofuel blend)','litres',2.1,ARRAY['1'])`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by)
       VALUES ($1,$2,'probe-desnz-shaped','manual','Characterisation probe','test')`, [ORG, JOB_PROBE]);

    const variants = await db.query<{ suffix_code: string; label: string; ghg_category: string; description: string; status: string; sort_order: number }>(
      `SELECT suffix_code, label, ghg_category, description, status, sort_order FROM nzi_console.factor_category_variants`);
    registry = variants.rows.map((row) => ({
      suffixCode: row.suffix_code, label: row.label, ghgCategory: row.ghg_category,
      description: row.description, status: row.status as CategoryVariant["status"], sortOrder: row.sort_order,
    }));
  });

  after(async () => {
    if (process.env.NZI_CHARACTERISATION_OUT) writeFileSync(process.env.NZI_CHARACTERISATION_OUT, JSON.stringify(rows, null, 2));
    await db?.end();
    await database?.end();
  });

  /** The declarative side, from the rules the migrations actually seeded. */
  const declared = async (
    jobId: string, category: string, specGhgCategory: string,
    entry: Readonly<Record<string, string | null | undefined>>, enrichment?: Record<string, Record<string, string | null> | null>,
  ) => {
    const factors = await available(jobId);
    const rules: Record<string, readonly FactorRule[]> = Object.fromEntries(await listFactorRules(db));
    const outcome = resolveFactorForEntry({
      rules: await factorRulesFor(db, category), specGhgCategory, entry,
      available: factors.map((factor) => ({ factorId: factor.factor_id, scopes: factor.scopes })),
      registry, enrichment, rulesByCategory: rules,
    });
    const companions = proposeCompanions({
      companions: await companionRulesFor(db, category), entry,
      available: factors.map((factor) => ({ factorId: factor.factor_id })), primary: outcome,
    });
    return { outcome, companions, factors };
  };

  const unitNote = (factors: Array<{ factor_id: string; activity_unit: string }>, factorId: string | null, entryUnit: string | null) => {
    if (!factorId) return "n/a";
    const unit = factors.find((factor) => factor.factor_id === factorId)?.activity_unit ?? null;
    if (entryUnit === null) return `factor per ${unit}`;
    return unit === entryUnit ? `ok (${unit})` : `MISMATCH: entry in ${entryUnit}, factor per ${unit}`;
  };

  const record = (row: Omit<Row, "verdict">) => {
    const beforeId = row.before.kind === "automated" ? row.before.factorId : row.before.plausiblePick;
    const same = beforeId === row.after.factorId
      && JSON.stringify([...row.companions.before].sort()) === JSON.stringify([...row.companions.after].sort());
    rows.push({ ...row, verdict: same ? "identical" : "different" });
  };

  const shape = (outcome: MappingOutcome) => outcome.kind === "resolved"
    ? { kind: outcome.kind, factorId: outcome.factorId, ghgCategory: outcome.scope.ghgCategory, ruleKey: outcome.rule.ruleKey, reason: null }
    : { kind: outcome.kind, factorId: null, ghgCategory: null, ruleKey: null, reason: outcome.reason };

  it("the stub answers each plate as the cases below assume", async () => {
    // A case labelled "diesel van" that the stub answered as petrol would test the petrol path twice and the
    // diesel path never — the fixture defect NZC-151's suite caught. Asserted, not assumed.
    assert.equal(vehicleAttributes(await vehicleFor(PLATES.dieselVan)).fuel, "diesel");
    assert.equal(vehicleAttributes(await vehicleFor(PLATES.dieselVan)).class, "van");
    assert.equal(vehicleAttributes(await vehicleFor(PLATES.petrolCar)).fuel, "petrol");
    assert.equal(vehicleAttributes(await vehicleFor(PLATES.electricCar)).fuel, "electric");
    assert.equal(vehicleAttributes(await vehicleFor(PLATES.hybridCar)).fuel, "hybrid");
  });

  it("the mapped set is exactly the five categories this characterises, and no more", async () => {
    const mapped = [...(await listFactorRules(db)).keys()].sort();
    assert.deepEqual(mapped, [...ENABLED].sort(), "a category is mapped that this characterisation does not cover");
    const withCompanions = [...(await listCompanionRules(db)).keys()].sort();
    assert.deepEqual(withCompanions, [...ELECTRICITY].sort());
  });

  // ── The vehicle flow: the one path where today's code resolves automatically ─────────────────────────

  it("characterises the vehicle flow in all three consumers, on both datasets", async () => {
    for (const [dataset, jobId] of [["shipped", JOB_SHIPPED], ["probe", JOB_PROBE]] as const) {
      for (const category of VEHICLE_FLOW) {
        const spec = category === "1.company-vehicles" ? "1" : "3";

        // Plated entries: today's CRM path is lookup → resolveVehicleFactor → the form applies its answer.
        for (const [name, plate] of Object.entries(PLATES)) {
          for (const unit of ["litres", "km"]) {
            const vehicle = await vehicleFor(plate);
            const old = await resolveVehicleFactor(db, jobId, vehicle);
            const { outcome, factors } = await declared(jobId, category, spec,
              { registrationFinder: plate, unit }, { dvla: vehicleAttributes(vehicle) });
            record({
              id: `${dataset}:${category}:plate-${name}-${unit}`, dataset, category,
              entry: `plate → ${name}, recorded in ${unit}`,
              before: { kind: "automated", path: "CRM lookup → resolveVehicleFactor (ILIKE, Scope 1 only)", factorId: old?.factorId ?? null,
                detail: old ? `${old.label} · per ${old.unit}` : "no label matched — form says 'pick one below'" },
              after: shape(outcome), companions: { before: [], after: [] },
              unitCheck: unitNote(factors, shape(outcome).factorId, unit),
            });
          }
        }

        // A plate whose lookup failed: today the form shows an error and the person enters it manually.
        {
          const { outcome, factors } = await declared(jobId, category, spec,
            { registrationFinder: "ZZ99ZZZ", unit: "litres" }, { dvla: null });
          record({
            id: `${dataset}:${category}:plate-lookup-failed-litres`, dataset, category,
            entry: "plate entered, lookup returned nothing, recorded in litres",
            before: { kind: "automated", path: "CRM lookup failed → manual", factorId: null, detail: "error banner; person picks" },
            after: shape(outcome), companions: { before: [], after: [] },
            unitCheck: unitNote(factors, shape(outcome).factorId, "litres"),
          });
        }

        // No plate. Today a person picks; in the CRM the unit then comes *from* that factor, which is what
        // the unit basis-branch reads. The plausible picks are the ones a consultant would make for the fuel.
        const unplated: Array<[string, string, string | null]> = [
          ["diesel, litres", "litres", "diesel-demo"],
          ["petrol, litres", "litres", dataset === "probe" ? "probe-petrol-litres" : null],
          ["diesel car, km", "km", dataset === "probe" ? "probe-car-diesel-km" : null],
        ];
        for (const [label, unit, pick] of unplated) {
          const { outcome, factors } = await declared(jobId, category, spec, { unit });
          record({
            id: `${dataset}:${category}:no-plate-${label.replace(/[ ,]+/g, "-")}`, dataset, category,
            entry: `no plate — ${label}`,
            before: { kind: "person", path: "CRM factor select (unit follows the factor)", plausiblePick: pick,
              detail: pick ? `a consultant would pick ${pick}` : "no suitable factor in this dataset" },
            after: shape(outcome), companions: { before: [], after: [] },
            unitCheck: unitNote(factors, shape(outcome).factorId, unit),
          });
        }
      }
    }
  });

  // ── Electricity: today is always a person's pick; the declarative side adds a companion ──────────────

  it("characterises both electricity categories under every supply source", async () => {
    for (const [dataset, jobId] of [["shipped", JOB_SHIPPED], ["probe", JOB_PROBE]] as const) {
      for (const category of ELECTRICITY) {
        for (const supply of SUPPLY) {
          const entry = { unit: "kWh", supplySource: supply };
          const { outcome, companions, factors } = await declared(jobId, category, "2", entry);
          record({
            id: `${dataset}:${category}:supply-${supply ?? "unstated"}`, dataset, category,
            entry: `metered kWh, supplySource ${supply ?? "not stated"}`,
            before: { kind: "person", path: "CRM factor select", plausiblePick: "electricity-demo",
              detail: "the grid factor; no companion row exists on any path today" },
            after: shape(outcome),
            companions: { before: [], after: companions.proposed.map((companion) => `${companion.factorId} (${companion.ghgCategory})`) },
            unitCheck: unitNote(factors, shape(outcome).factorId, "kWh"),
          });
        }
      }
    }
  });

  // ── The portal: the client's allow-list, pre-selected by collation ───────────────────────────────────

  it("characterises the portal default, which the database's collation decides", async () => {
    // The expression listPortalDataEntryBuckets orders a bucket's factors by, run against this database so
    // the collation is the real one. An electricity bucket granted both electricity factors is the case that
    // matters: whichever sorts first is what a client submits without touching the control.
    const allowLists: Array<[string, string, string[]]> = [
      ["2.purchased-electricity", "2", ["electricity-demo", "electricity-td-demo"]],
      ["1.company-vehicles", "1", ["diesel-demo", "gas-demo"]],
    ];
    for (const [category, spec, allowed] of allowLists) {
      const first = (await db.query<{ factor_id: string }>(
        `SELECT f.factor_id FROM nzi_console.emission_factors f
           JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.dataset_id)=(f.organisation_id,f.dataset_id)
          WHERE s.job_id=$1 AND f.factor_id = ANY($2) AND f.active
          ORDER BY lower(f.label), f.factor_id LIMIT 1`, [JOB_SHIPPED, allowed])).rows[0]?.factor_id ?? null;
      const entry = category === "1.company-vehicles" ? { unit: "litres" } : { unit: "kWh", supplySource: "grid" };
      const { outcome, companions, factors } = await declared(JOB_SHIPPED, category, spec, entry);
      record({
        id: `shipped:${category}:portal-default-${allowed.join("+")}`, dataset: "shipped", category,
        entry: `portal bucket allowing ${allowed.join(", ")} — untouched default`,
        before: { kind: "automated", path: "portal allow-list, first by lower(label)", factorId: first,
          detail: `collation picks ${first}` },
        after: shape(outcome),
        companions: { before: [], after: companions.proposed.map((companion) => `${companion.factorId} (${companion.ghgCategory})`) },
        unitCheck: unitNote(factors, shape(outcome).factorId, entry.unit),
      });
    }
  });

  // ── The additive fallback: every category not enabled resolves exactly as it does today ─────────────

  it("leaves every un-enabled category on the search, with nothing declared to apply", async () => {
    const categories = (await db.query<{ category_code: string; ghg: string }>(
      `SELECT DISTINCT category_code, split_part(category_code, '.', 1) AS ghg FROM nzi_console.input_spec_fields ORDER BY category_code`)).rows;
    const unmapped = categories.filter((category) => !ENABLED.includes(category.category_code));
    // Fifteen, not "some": a loop over an empty list proves nothing (NZC-149's own correction).
    assert.equal(unmapped.length, 15, `expected 15 un-enabled categories, found ${unmapped.length}`);

    for (const category of unmapped) {
      // An entry shaped to tempt every kind of rule: litres, kWh, a plate, a supply source. None may fire.
      for (const entry of [{ unit: "litres" }, { unit: "kWh", supplySource: "grid" }, { unit: "litres", registrationFinder: PLATES.dieselVan }]) {
        const vehicle = await vehicleFor(PLATES.dieselVan);
        const { outcome, companions } = await declared(JOB_SHIPPED, category.category_code, category.ghg, entry, { dvla: vehicleAttributes(vehicle) });
        assert.equal(outcome.kind, "free-search", `${category.category_code} resolved declaratively`);
        assert.equal(outcome.declined.length, 0, `${category.category_code} considered rules it should not have`);
        assert.equal(companions.proposed.length, 0, `${category.category_code} proposed a companion`);
      }
      record({
        id: `shipped:${category.category_code}:unmapped`, dataset: "shipped", category: category.category_code,
        entry: "any entry",
        before: { kind: "person", path: "CRM factor select", plausiblePick: null, detail: "unchanged" },
        after: { kind: "free-search", factorId: null, ghgCategory: null, ruleKey: null, reason: "no rules declared" },
        companions: { before: [], after: [] }, unitCheck: "n/a",
      });
    }
  });

  // ── Anti-vacuity: the comparison can report a difference, and does when one is made ─────────────────

  it("reports a divergence when a seeded rule is changed, so identical means identical", async () => {
    // Pick a case the characterisation calls identical, change the rule it resolves by, and re-run the
    // same comparison. If the harness compared the resolver with itself, or read a cached rule set, this
    // would still say identical.
    const baseline = await declared(JOB_SHIPPED, "2.purchased-electricity", "2", { unit: "kWh", supplySource: "grid" });
    assert.equal(baseline.outcome.kind === "resolved" ? baseline.outcome.factorId : null, "electricity-demo");

    await db.query("BEGIN");
    try {
      await db.query(`ALTER TABLE nzi_console.input_spec_factor_rules DISABLE TRIGGER USER`);
      await db.query(`UPDATE nzi_console.input_spec_factor_rules SET factor_base='gas-demo'
                       WHERE category_code='2.purchased-electricity' AND rule_key='grid-electricity'`);
      const mutated = await declared(JOB_SHIPPED, "2.purchased-electricity", "2", { unit: "kWh", supplySource: "grid" });
      assert.equal(mutated.outcome.kind === "resolved" ? mutated.outcome.factorId : null, "gas-demo",
        "a changed rule did not change the declarative answer — the harness is not reading the live rules");
      assert.notEqual(mutated.outcome.kind === "resolved" ? mutated.outcome.factorId : null, "electricity-demo",
        "the comparison would have reported identical against a changed mapping");
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("reports a divergence on the old side too, when the old matcher's data changes", async () => {
    // The mirror: the before-side must be the live old code, not a remembered answer. Relabel the probe van
    // and the ILIKE matcher must stop finding it.
    const vehicle = await vehicleFor(PLATES.dieselVan);
    assert.equal((await resolveVehicleFactor(db, JOB_PROBE, vehicle))?.factorId, "probe-van-diesel-km");
    await db.query("BEGIN");
    try {
      await db.query(`UPDATE nzi_console.emission_factors SET label='Average LCV — Diesel' WHERE factor_id='probe-van-diesel-km'`);
      assert.equal(await resolveVehicleFactor(db, JOB_PROBE, vehicle), null,
        "the old matcher's answer did not follow the data — the before side is not the live old code");
    } finally {
      await db.query("ROLLBACK");
    }
  });

  // ── Two behaviours found while characterising, pinned so a ruling on them has something to move ─────

  it("under byte-order collation, the portal's electricity default is the T&D factor (today, unwired)", async (t) => {
    // Not a wiring divergence: a hazard in today's portal. The bucket's factors are ordered by lower(label),
    // and "UK electricity T&D" sorts before "UK electricity —" wherever the collation compares bytes. A
    // client who does not touch the control submits Scope 2 electricity priced as transmission losses.
    const collation = (await db.query<{ datcollate: string; datlocprovider: string }>(
      `SELECT datcollate, datlocprovider FROM pg_database WHERE datname = current_database()`)).rows[0]!;
    t.diagnostic(`database collation: ${collation.datcollate} (provider ${collation.datlocprovider})`);
    let first: string | null;
    try {
      first = (await db.query<{ factor_id: string }>(
        `SELECT factor_id FROM nzi_console.emission_factors
          WHERE factor_id IN ('electricity-demo','electricity-td-demo') AND dataset_id = 'synthetic-gb-2026'
          ORDER BY lower(label) COLLATE "C", factor_id LIMIT 1`)).rows[0]!.factor_id;
    } catch (error) {
      // A WIN1252 cluster has no "C" collation for its encoding. CI's does; say so rather than pass quietly.
      t.skip(`"C" collation unavailable here: ${(error as Error).message}`);
      return;
    }
    assert.equal(first, "electricity-td-demo");
  });

  it("a consulted-and-unmatched lookup does not STOP across a sub-flow, so a later fallback would answer", async () => {
    // Latent: no category carries a fallback behind its sub-flow today. NZC-158 permits one (a rail lookup
    // in business travel), and NZC-151's STOP does not survive the sub-flow boundary — the inner flow's
    // "consulted, matched nothing" comes back as a plain decline. So a petrol car in 3.6 would be answered by
    // whatever fallback sits behind the sub-flow. Proved with a test-inserted rule, rolled back.
    const vehicle = await vehicleFor(PLATES.petrolCar);
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO nzi_console.input_spec_factor_rules
           (category_code, rule_key, ordering, rule_kind, factor_base, note, created_by, updated_by)
         VALUES ('3.6', 'probe-rail-fallback', 20, 'lookup', 'freight-demo', 'probe', 'test', 'test')`);
      const { outcome } = await declared(JOB_SHIPPED, "3.6", "3",
        { registrationFinder: PLATES.petrolCar, unit: "litres" }, { dvla: vehicleAttributes(vehicle) });
      assert.equal(outcome.kind === "resolved" ? outcome.factorId : outcome.kind, "freight-demo",
        "the fallback did not answer — if this now fails, the STOP propagates and this pin should move");
    } finally {
      await db.query("ROLLBACK");
    }
  });

  // ── The ledger: every divergence, classified, so a new one cannot arrive unannounced ─────────────────

  it("every divergence is one the ledger names, and the ledger names nothing that is not one", () => {
    const different = rows.filter((row) => row.verdict === "different").map((row) => row.id).sort();
    assert.deepEqual(different, Object.keys(LEDGER).sort(),
      "the set of divergences moved — a change in what resolves must arrive as a ledger change, never silently");
  });

  it("finds at least one divergence and at least one identity, or it could not have told them apart", () => {
    assert.ok(rows.some((row) => row.verdict === "different"), "no divergence at all — suspicious for a swap of matcher");
    assert.ok(rows.some((row) => row.verdict === "identical"), "nothing identical — suspicious for an additive change");
  });
});

/**
 * Every divergence the characterisation found, and how it was **ruled at Stop 1 (24 Sep 2026)**. The ledger moves
 * only by reviewed intent: D2 and D3 are defects whose fixes will move their entries, and each fix is its own stop.
 *
 * - `D1` old-path defect, declarative correct — today's answer is none, a Scope 1 per-km factor, or the Scope 1
 *   base in a Scope 3 category. **Ruled: change by reviewed intent.**
 * - `D2` new-mapping defect — `dvla-diesel` ignores the unit, so a diesel vehicle recorded in km resolves to a
 *   per-litre factor. **Ruled: fix before wiring** — a unit that does not reconcile declines to the person's
 *   pick, never to the `ILIKE`.
 * - `D3` new-mapping defect — `fuel-litres` assumes diesel, so an unplated petrol vehicle in litres resolves to
 *   the diesel factor. **Ruled: fix before wiring** — deactivate the rule; a unit alone cannot identify a fuel.
 * - `D4` coverage traded for safety — today's `ILIKE` suggests a Scope 1 per-km factor for petrol and hybrid;
 *   the declarative side leaves the entry to a person. **Ruled: accepted, conditional on retiring the `ILIKE`
 *   for enabled categories.**
 * - `D5` search either way — the resolver declines and the person's pick stands. **Ruled: identical, on the
 *   same condition.**
 * - `D6` new companion row by design — T&D losses (3.3) beside grid-delivered electricity (NZC-154). **Ruled:
 *   change by reviewed intent**, held from activation until manual 3.3 coexistence is decided and supplySource
 *   is required rather than offered for electricity.
 */
const LEDGER: Record<string, "D1" | "D2" | "D3" | "D4" | "D5" | "D6"> = (() => {
  const ledger: Record<string, "D1" | "D2" | "D3" | "D4" | "D5" | "D6"> = {};
  for (const dataset of ["shipped", "probe"] as const) {
    for (const category of ["1.company-vehicles", "3.6", "3.7"]) {
      ledger[`${dataset}:${category}:plate-dieselVan-litres`] = "D1";
      ledger[`${dataset}:${category}:plate-dieselVan-km`] = "D2";
      ledger[`${dataset}:${category}:no-plate-petrol-litres`] = "D3";
      if (category !== "1.company-vehicles") ledger[`${dataset}:${category}:no-plate-diesel-litres`] = "D1";
      if (dataset === "probe") {
        for (const name of ["petrolCar", "hybridCar"]) {
          for (const unit of ["litres", "km"]) ledger[`probe:${category}:plate-${name}-${unit}`] = "D4";
        }
        ledger[`probe:${category}:no-plate-diesel-car-km`] = "D5";
      }
    }
    for (const category of ["2.purchased-electricity", "2.renewable-electricity"]) {
      for (const supply of ["grid", "grid-renewable", "green-tariff", "rego"]) {
        ledger[`${dataset}:${category}:supply-${supply}`] = "D6";
      }
    }
  }
  ledger["shipped:2.purchased-electricity:portal-default-electricity-demo+electricity-td-demo"] = "D6";
  return ledger;
})();
