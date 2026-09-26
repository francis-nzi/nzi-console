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
import { reconcileUnitForMapping } from "../src/unitCompatibility";
import { primaryFactorFor } from "../src/portalPrimaryFactor";
import { previewDeclaredFactor } from "../src/declarativeResolution";
// The portal's own default, imported across the package seam as the capture suites import the console's model (NZC-162).
import * as portalDefaultModule from "../../../apps/console/app/portal/portalFactorDefault";

const { defaultPortalFactorId } = ((portalDefaultModule as any).defaultPortalFactorId ? portalDefaultModule : (portalDefaultModule as any).default) as typeof import("../../../apps/console/app/portal/portalFactorDefault");

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
 *   - **The portal** — the client chooses from a staff-granted allow-list. Until H1 it was pre-selected to the
 *     first by `lower(label)`; since 2d it is pre-selected to the category's declared factor when the bucket
 *     authorises it (P4). Since 2d acceptance is a write path like the CRM's: it re-resolves under F1 — from the
 *     lookup's stored attributes for a vehicle (P3) — so for an enabled category what lands is the declared
 *     factor, unless the reviewer records why the client's pick stands.
 *
 * So the "before" side here is **the old code, executed**: the real DVLA stub, the real `resolveVehicleFactor`
 * SQL against real rows, and the portal's real ordering expression under the database's real collation. It is
 * never the resolver compared with itself — the suite proves that at the end, by mutating a seeded rule and
 * watching a divergence appear where there was none — **except where a category is switched on**, because there
 * the write path *is* the resolver. Since 2b that is electricity's primary: its "before" is the live write-path
 * resolution, identical by construction while the switch holds, and proved through the command elsewhere
 * (electricityPrimaryEnabledReal). Each enabling slice moves its rows here the same way.
 *
 * ## Two datasets, and why the second is a probe
 *
 * **shipped** is the factor seed staging carries (0003). Every label there reads "<fuel> — demonstration
 * factor", with no vehicle class in it, so the `ILIKE` matcher can never succeed on it: that is itself a
 * finding about today, and it is also why shipped data alone could not show what the matcher *does* when it
 * matches. **probe** adds factors labelled the way DESNZ labels them ("Medium car — Diesel"), inserted by this
 * test and named as such, to exercise the matcher's positive branch. Nothing about the probe is a claim about
 * staging's data.
 *
 * ## What this does not cover — stated so nobody reads it as complete
 *
 * **Three of the five write paths.** A factor lands on a scope row through `createScopeRow`, `updateScopeRow`,
 * portal acceptance, emission-source sync (`syncEmissionSourceToScope` / `reaggregateGroupRollup`) and year
 * roll-forward (`rollforwardScopeRows`). This characterises the upstream choice for the CRM and the portal; it
 * says nothing about source sync or roll-forward, which have their own characterise-then-wire stops (Stop 2, F4).
 *
 * **The resolver, not the whole command.** It calls the resolver directly, so it does not apply the checks the
 * write command makes before resolution matters — notably NZC-146's accepted units per field. Business travel
 * and commuting accept distances only, so the 3.6/3.7 rows here that are recorded in **litres** describe
 * entries the write path refuses with UNIT_NOT_ACCEPTED. Their resolver outcome is accurate; their premise is
 * not an input anyone can submit. Found in Stop 2a, and the reason Stop 2's own proofs go through the commands.
 *
 * **A person's pick is the factor's own id.** The CRM rows model a person picking, say, `uk-ghg-7_400_4000_5_1`. Until
 * the quick-add fix (found in Stop 2b) the form actually sent its option key, `dataset:<id>|<factor>`, which no
 * factor has: the row was stored and calculation refused it. So those rows described what the form was meant to
 * do rather than what it did, and are accurate only from that fix on.
 *
 * **Keep the "before" live.** Any change to how a factor is chosen, offered, defaulted or accepted updates the
 * rows here that model it, in the same PR (the lesson of H1, whose portal change left these rows stale).
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
      available: factors.map((factor) => ({ factorId: factor.factor_id, scopes: factor.scopes, unit: factor.activity_unit })),
      registry, enrichment, rulesByCategory: rules, reconcileUnit: reconcileUnitForMapping,
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

        // Plated entries: today's CRM path is lookup → the route's suggestion → the form applies it. Since 2c the
        // route answers an enabled category from the declared resolution, asked with the lookup's attributes and no
        // unit (the CRM has none until a factor gives it one), and never with the ILIKE (H6). A category that is
        // off — business travel, commuting — still gets the ILIKE. Both halves are the route's own logic, run here.
        for (const [name, plate] of Object.entries(PLATES)) {
          for (const unit of ["litres", "km"]) {
            const vehicle = await vehicleFor(plate);
            const attributes = vehicleAttributes(vehicle);
            const live = await previewDeclaredFactor(db, ORG, jobId, { scope: spec, unit: null, supplySource: null,
              assertedVehicleAttributes: { source: "stub", fuel: attributes.fuel ?? null, vehicleClass: attributes.class ?? null } }, category);
            const old = live.enabled ? null : await resolveVehicleFactor(db, jobId, vehicle);
            const suggested = live.enabled ? live.declared?.factorId ?? null : old?.factorId ?? null;
            const { outcome, factors } = await declared(jobId, category, spec,
              { registrationFinder: plate, unit }, { dvla: attributes });
            record({
              id: `${dataset}:${category}:plate-${name}-${unit}`, dataset, category,
              entry: `plate → ${name}, recorded in ${unit}`,
              before: live.enabled
                ? { kind: "automated", path: "CRM lookup → declared resolution (2c; ILIKE retired, H6)", factorId: suggested,
                  detail: suggested ? `declared ${suggested}` : "nothing declared — the person picks" }
                : { kind: "automated", path: "CRM lookup → resolveVehicleFactor (ILIKE, Scope 1 only)", factorId: suggested,
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
          ["diesel, litres", "litres", "uk-ghg-1_101_1011_8_1"],
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
    // Since 2b (0121) the CRM write path resolves electricity's primary itself, so "today" is no longer a
    // person's pick: it is what the shipped write-path resolution fills, asked here through the same function
    // the capture form previews it with. For the primary that is identical by construction while the switch is
    // on — which is the claim — and if the switch goes off the before becomes empty and every row here goes red.
    // What proves the write itself does this is electricityPrimaryEnabledReal, through createScopeRow. The
    // companion stays held (H4), so its divergence (D6) is unchanged.
    for (const [dataset, jobId] of [["shipped", JOB_SHIPPED], ["probe", JOB_PROBE]] as const) {
      for (const category of ELECTRICITY) {
        for (const supply of SUPPLY) {
          const entry = { unit: "kWh", supplySource: supply };
          const { outcome, companions, factors } = await declared(jobId, category, "2", entry);
          const live = await previewDeclaredFactor(db, ORG, jobId, { scope: "2", unit: "kWh", supplySource: supply }, category);
          record({
            id: `${dataset}:${category}:supply-${supply ?? "unstated"}`, dataset, category,
            entry: `metered kWh, supplySource ${supply ?? "not stated"}`,
            before: { kind: "automated", path: "CRM write path, declarative since 2b (0121)",
              factorId: live.enabled ? live.declared?.factorId ?? null : null,
              detail: live.enabled ? "filled by the write path; the T&D companion is held (H4)" : "the switch is off" },
            after: shape(outcome),
            companions: { before: [], after: companions.proposed.map((companion) => `${companion.factorId} (${companion.ghgCategory})`) },
            unitCheck: unitNote(factors, shape(outcome).factorId, "kWh"),
          });
        }
      }
    }
  });

  // ── The portal: the client's allow-list, and acceptance re-resolving what the client sent ────────────

  it("characterises the portal as it is since 2d: the declared factor pre-selected, and re-resolved at acceptance", async () => {
    // The bucket offers only factors its row may carry — the shipped primaryFactorFor predicate, run here (H1). The
    // listing asks the declared resolution what the category resolves to independently of any entry — no unit, no
    // supply source, no vehicle, exactly as listPortalDataEntryBuckets asks it — and the portal's own default picks
    // that when the bucket authorises it (P4), else the one eligible factor, else nothing and the client picks.
    const offeredFor = async (category: string, spec: string, allowed: string[]) => (await db.query<{ factor_id: string }>(
      `SELECT f.factor_id FROM nzi_console.emission_factors f
         JOIN nzi_console.job_dataset_selections s ON (s.organisation_id,s.dataset_id)=(f.organisation_id,f.dataset_id)
         CROSS JOIN (SELECT $3::text AS scope, $4::text AS category_code) r
        WHERE s.job_id=$1 AND f.factor_id = ANY($2) AND ${primaryFactorFor("f", "r")}
        ORDER BY f.factor_id`, [JOB_SHIPPED, allowed, spec, category])).rows.map((row) => row.factor_id);
    const allowLists: Array<[string, string, string[], string]> = [
      ["2.purchased-electricity", "2", ["uk-ghg-7_400_4000_5_1", "uk-ghg-13_402_4000_5_1"], "uk-ghg-7_400_4000_5_1"],
      ["2.purchased-electricity", "2", ["uk-ghg-7_400_4000_5_1", "electricity-us-demo"], "uk-ghg-7_400_4000_5_1"],
      ["1.company-vehicles", "1", ["uk-ghg-1_101_1011_8_1", "gas-demo"], "uk-ghg-1_101_1011_8_1"],
    ];
    for (const [category, spec, allowed, plausiblePick] of allowLists) {
      const offered = await offeredFor(category, spec, allowed);
      const listing = await previewDeclaredFactor(db, ORG, JOB_SHIPPED, { scope: spec, unit: null, supplySource: null, assertedVehicleAttributes: null }, category);
      const listed = listing.enabled ? listing.declared?.factorId ?? null : null;
      const preselected = defaultPortalFactorId(offered.map((id) => ({ id })), listed && offered.includes(listed) ? listed : null);
      const entry = category === "1.company-vehicles" ? { unit: "litres" } : { unit: "kWh", supplySource: "grid" };
      const { outcome, companions, factors } = await declared(JOB_SHIPPED, category, spec, entry);
      record({
        id: `shipped:${category}:portal-default-${allowed.join("+")}`, dataset: "shipped", category,
        entry: `portal bucket granted ${allowed.join(", ")} — offered ${offered.join(", ") || "nothing"}`,
        before: preselected
          ? { kind: "automated", path: preselected === listed ? "portal, the declared factor pre-selected (2d, P4)" : "portal, the one eligible factor pre-selected (H1)",
            factorId: preselected, detail: `pre-selected ${preselected}; acceptance re-resolves under F1` }
          : { kind: "person", path: "portal, nothing declared for the bucket and several eligible, so none pre-selected (H1)", plausiblePick,
            detail: `the client chooses among ${offered.join(", ")}` },
        after: shape(outcome),
        companions: { before: [], after: companions.proposed.map((companion) => `${companion.factorId} (${companion.ghgCategory})`) },
        unitCheck: unitNote(factors, shape(outcome).factorId, entry.unit),
      });
    }

    // A plated vehicle. The lookup's attributes travel in the draft (P3), and acceptance re-resolves from them with the
    // entry's unit — which in the portal, as in the CRM, follows the factor the client picked. So what lands for an
    // enabled category is the write path's declared answer; it is asked here through the same function.
    for (const [name, plate] of [["dieselVan", PLATES.dieselVan], ["petrolCar", PLATES.petrolCar]] as const) {
      const attributes = vehicleAttributes(await vehicleFor(plate));
      const asserted = { source: "stub" as const, fuel: attributes.fuel ?? null, vehicleClass: attributes.class ?? null };
      const atAcceptance = await previewDeclaredFactor(db, ORG, JOB_SHIPPED, { scope: "1", unit: "litres", supplySource: null, assertedVehicleAttributes: asserted }, "1.company-vehicles");
      const landed = atAcceptance.enabled ? atAcceptance.declared?.factorId ?? null : null;
      const { outcome, factors } = await declared(JOB_SHIPPED, "1.company-vehicles", "1", { registrationFinder: plate, unit: "litres" }, { dvla: attributes });
      record({
        id: `shipped:1.company-vehicles:portal-plate-${name}-litres`, dataset: "shipped", category: "1.company-vehicles",
        entry: `portal plate → ${name}, bucket granted uk-ghg-1_101_1011_8_1, gas-demo, recorded in litres`,
        before: landed
          ? { kind: "automated", path: "portal lookup → attributes in the draft → F1 at acceptance (2d, P3)", factorId: landed,
            detail: `the declared ${landed} lands unless the reviewer records why the client's pick stands` }
          : { kind: "person", path: "portal lookup → nothing declared, so the client's pick stands at acceptance (2d)", plausiblePick: null,
            detail: "no suitable factor in this dataset" },
        after: shape(outcome), companions: { before: [], after: [] },
        unitCheck: unitNote(factors, shape(outcome).factorId, "litres"),
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
    assert.equal(baseline.outcome.kind === "resolved" ? baseline.outcome.factorId : null, "uk-ghg-7_400_4000_5_1");

    await db.query("BEGIN");
    try {
      await db.query(`ALTER TABLE nzi_console.input_spec_factor_rules DISABLE TRIGGER USER`);
      await db.query(`UPDATE nzi_console.input_spec_factor_rules SET factor_base='gas-demo'
                       WHERE category_code='2.purchased-electricity' AND rule_key='grid-electricity'`);
      const mutated = await declared(JOB_SHIPPED, "2.purchased-electricity", "2", { unit: "kWh", supplySource: "grid" });
      assert.equal(mutated.outcome.kind === "resolved" ? mutated.outcome.factorId : null, "gas-demo",
        "a changed rule did not change the declarative answer — the harness is not reading the live rules");
      assert.notEqual(mutated.outcome.kind === "resolved" ? mutated.outcome.factorId : null, "uk-ghg-7_400_4000_5_1",
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
          WHERE factor_id IN ('uk-ghg-7_400_4000_5_1','uk-ghg-13_402_4000_5_1') AND dataset_id = 'synthetic-gb-2026'
          ORDER BY lower(label) COLLATE "C", factor_id LIMIT 1`)).rows[0]!.factor_id;
    } catch (error) {
      // A WIN1252 cluster has no "C" collation for its encoding. CI's does; say so rather than pass quietly.
      t.skip(`"C" collation unavailable here: ${(error as Error).message}`);
      return;
    }
    assert.equal(first, "uk-ghg-13_402_4000_5_1");
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
      // No unit captured: since D2 a fallback that cannot price the entry's unit declines, which is not H2
      // being closed — a fallback whose unit reconciles, or an entry with no unit yet, still answers. The
      // entry is left unit-less so this keeps showing the hazard D2 does not touch.
      const { outcome } = await declared(JOB_SHIPPED, "3.6", "3",
        { registrationFinder: PLATES.petrolCar }, { dvla: vehicleAttributes(vehicle) });
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
 * - `D2` new-mapping defect — `dvla-diesel` ignored the unit, so a diesel vehicle recorded in km resolved to a
 *   per-litre factor. **Ruled: fix before wiring. Fixed** — a resolved factor must reconcile with the entry's
 *   unit or its rule declines, to a person's pick and never to the `ILIKE`. Its six entries moved by that
 *   intent: three to identical, three to D4. No entry carries D2 now; the class is kept so its history reads.
 * - `D3` new-mapping defect — `fuel-litres` assumed diesel, so an unplated petrol vehicle in litres resolved to
 *   the diesel factor. **Ruled: fix before wiring. Fixed by 0119**, which deactivated the rule: a unit alone cannot
 *   identify a fuel. Its entries moved by that intent — shipped petrol to identical, probe petrol to D5 — and so
 *   did every unplated diesel entry, to D5. **What that gives up:** in 3.6 and 3.7 an unplated diesel entry used
 *   to resolve to its own variant through the sub-flow (D1); it is a person's pick again, and today's pick list
 *   offers the Scope 1 base. Only plated entries still get the variant declaratively.
 * - `D4` coverage traded for safety — today's `ILIKE` suggests a Scope 1 per-km factor for petrol and hybrid;
 *   the declarative side leaves the entry to a person. **Ruled: accepted, conditional on retiring the `ILIKE`
 *   for enabled categories.**
 * - `D5` search either way — the resolver declines and the person's pick stands. **Ruled: identical, on the
 *   same condition.**
 * - `D6` new companion row by design — T&D losses (3.3) beside grid-delivered electricity (NZC-154). **Ruled:
 *   change by reviewed intent**, held from activation until manual 3.3 coexistence is decided and supplySource
 *   is required rather than offered for electricity.
 * - `D7` the lookup's declared suggestion carries no unit — for a plated diesel in company vehicles it suggests the
 *   per-litre factor, where the resolver asked with an entry already in km declines (D2). In the CRM the unit
 *   follows the factor, so applying the suggestion makes the entry litres, shown before any quantity (H3); an entry
 *   *recorded in km* before the lookup is portal-shaped, where D2 governs. **Proposed at 2c: accepted by reviewed
 *   intent, pending the ruling.**
 *
 * Since 2c company vehicles resolve declaratively and the ILIKE is retired for them (H6), so their plated diesel in
 * litres (was D1) and the probe's petrol and hybrid plates (was D4) are identical: both sides are the declared
 * answer or a person's pick. Business travel and commuting are unchanged — still off, still the ILIKE.
 */
const LEDGER: Record<string, "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7"> = (() => {
  const ledger: Record<string, "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7"> = {};
  for (const dataset of ["shipped", "probe"] as const) {
    // Company vehicles, enabled in 2c: plated diesel in km is the one divergence left (D7).
    ledger[`${dataset}:1.company-vehicles:plate-dieselVan-km`] = "D7";
    for (const category of ["1.company-vehicles", "3.6", "3.7"]) {
      if (category !== "1.company-vehicles") ledger[`${dataset}:${category}:plate-dieselVan-litres`] = "D1";
      // D2 fixed (the unit now has to reconcile): shipped went from ∅ → uk-ghg-1_101_1011_8_1 to ∅ → search, which is
      // identical; the probe's ILIKE still suggests a Scope 1 per-km van factor where a person now picks — D4.
      if (dataset === "probe" && category !== "1.company-vehicles") ledger[`probe:${category}:plate-dieselVan-km`] = "D4";
      // D3 fixed (0119 retired fuel-litres): an unplated vehicle in litres has no declared answer and goes to a
      // person. Shipped petrol had no factor to pick, so ∅ → search is identical; the probe's petrol pick
      // stands — D5. Unplated diesel, company vehicles or a sub-flow, is now a person's pick too — D5, where
      // for 3.6/3.7 it was D1 (base → variant); see the note on D3 above for what that gives up.
      if (dataset === "probe") ledger[`probe:${category}:no-plate-petrol-litres`] = "D5";
      ledger[`${dataset}:${category}:no-plate-diesel-litres`] = "D5";
      if (dataset === "probe") {
        if (category !== "1.company-vehicles") {
          for (const name of ["petrolCar", "hybridCar"]) {
            for (const unit of ["litres", "km"]) ledger[`probe:${category}:plate-${name}-${unit}`] = "D4";
          }
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
  // The portal, modelled as it is since 2d. Electricity pre-selects its declared grid factor, whether the bucket
  // offers it alone (T&D is a companion, so not offered — H1) or beside another grid factor (P4, where before 2d the
  // client picked): the primary is identical and only the held companion diverges. The unplated vehicle bucket has
  // nothing declared without a vehicle, so the client picks, against the declared search — D5. A plated vehicle is
  // re-resolved at acceptance from its stored attributes, so it is identical by construction while the switch holds.
  ledger["shipped:2.purchased-electricity:portal-default-uk-ghg-7_400_4000_5_1+uk-ghg-13_402_4000_5_1"] = "D6";
  ledger["shipped:2.purchased-electricity:portal-default-uk-ghg-7_400_4000_5_1+electricity-us-demo"] = "D6";
  ledger["shipped:1.company-vehicles:portal-default-uk-ghg-1_101_1011_8_1+gas-demo"] = "D5";
  return ledger;
})();
