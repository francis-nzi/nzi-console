import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { categoriesForLevels, commandGrantForRole, emissionCategoryTaxonomy, familylessCategories, levelsAreFiled, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { previewDeclaredFactor } from "../src/declarativeResolution";
import { addMembershipCommand, retireMembershipCommand } from "../src/factorMembership";
import { listMembershipRules, membershipReport } from "../src/index";
import { withTenantRead } from "../src/postgres";

/**
 * NZC-171, ruled: a category offers the factors whose DESNZ family the membership map files under it - and nothing else. Real Postgres, so
 * the migration's seed, the table's guards, the pick-list read and the admin commands are tested together.
 *
 * Every category's offered set is asserted exactly (no cross-category leak in either direction), the families that exist in the live
 * library (a snapshot of its distinct level paths) are each shown to resolve - nothing is orphaned into invisibility - and the existing
 * applicability pairs are shown to agree with the derived map.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ORG = "org-nzc171", CLIENT = "client-nzc171", JOB = "job-nzc171", ACTOR = "ada", DS = "uk-m-2026", ICE = "ice-m-2026", NZI = "nzi-m-2026";

type Fixture = { id: string; label: string; unit: string; scopes: string[]; levels: string[]; ds?: string };
const F = (id: string, label: string, unit: string, scope: string, levels: string[], ds = DS): Fixture => ({ id, label, unit, scopes: [scope], levels, ds });
const FACTORS: Fixture[] = [
  F("natgas", "Natural gas", "kWh", "1", ["Fuels", "Gaseous fuels", "Natural gas"]),
  F("natgas-blend", "Natural gas (100% mineral blend)", "kWh", "1", ["Fuels", "Gaseous fuels", "Natural gas (100% mineral blend)"]),
  F("lpg", "LPG", "litres", "1", ["Fuels", "Gaseous fuels", "LPG"]),
  F("greengas", "Green gas", "kWh", "1", ["Fuels", "Gaseous fuels", "Green gas"], NZI),
  F("diesel", "Diesel (average biofuel blend)", "litres", "1", ["Fuels", "Liquid fuels", "Diesel (average biofuel blend)"]),
  F("coal", "Coal (industrial)", "tonnes", "1", ["Fuels", "Solid fuels", "Coal (industrial)"]),
  F("biomass", "Wood pellets", "tonnes", "1", ["Bioenergy", "Biomass", "Wood pellets"]),
  F("refrig", "R-410A", "kg", "1", ["Refrigerant & other", "Blends", "R410A"]),
  F("pcar", "Passenger vehicles - Cars (by size) - Large car - Diesel", "km", "1", ["Passenger vehicles", "Cars (by size)", "Large car"]),
  F("van", "Delivery vehicles - Vans - Class III", "km", "1", ["Delivery vehicles", "Vans", "Class III"]),
  F("grid", "UK electricity - Electricity generated", "kWh", "2", ["UK electricity", "Electricity generated"]),
  F("ev", "UK electricity for EVs - Cars", "km", "2", ["UK electricity for EVs", "Cars (by size)"]),
  F("renew", "UK Renewable Electricity", "kWh", "2", ["UK Renewable Electricity", "Electricity generated"], NZI),
  F("heat", "Heat and steam", "kWh", "2", ["Heat and steam", "Heat and steam", "District heat and steam"]),
  F("wttheat", "WTT- heat and steam", "kWh", "3", ["WTT- heat and steam", "WTT- heat and steam", "District heat and steam"]),
  F("td", "T&D- UK electricity", "kWh", "3", ["Transmission and distribution", "T&D- UK electricity"]),
  F("wttfuel", "WTT- liquid fuels", "litres", "3", ["WTT- fuels", "Liquid fuels"]),
  F("freight", "Freighting goods - Cargo ship - Container ship", "tonne.km", "3", ["Freighting goods", "Cargo ship"]),
  F("wttfreight", "WTT- cargo ship", "tonne.km", "3", ["WTT- delivery vehs & freight", "WTT- cargo ship"]),
  F("flight", "Business travel- air - Flights - Short-haul", "passenger.km", "3", ["Business travel- air", "Flights"]),
  F("btcar", "Business travel- land - Cars (by size) - Average car - Petrol", "miles", "3", ["Business travel- land", "Cars (by size)"]),
  F("btcar-c", "Employee commuting- land - Cars (by size) - Average car - Petrol", "miles", "3", ["Employee commuting- land", "Cars (by size)"]),
  F("ferry", "Business travel- sea - Ferry - Foot passenger", "passenger.km", "3", ["Business travel- sea", "Ferry"]),
  F("walk", "Business travel- land - Walking", "km", "3", ["Business travel- land", "Walking"], NZI),
  F("wttcar", "WTT- cars (by size) - Average car", "km", "3", ["WTT- pass vehs & travel- land", "WTT- cars (by size)"]),
  F("hotel", "Hotel stay - United Kingdom", "room per night", "3", ["Hotel stay", "Hotel stay"]),
  F("homew", "Homeworking - Office equipment", "FTE working hour", "3", ["Homeworking", "Office Equipment"]),
  F("materials", "Material use - Construction - Aggregates", "tonnes", "3", ["Material use", "Construction"]),
  F("concrete", "Concrete - RC32/40", "tonnes", "3", ["Concrete", "RC32/40"], ICE),
  F("water", "Water supply", "cubic metres", "3", ["Water supply", "Water supply"]),
  F("watertreat", "Water treatment", "cubic metres", "3", ["Water treatment", "Water treatment"]),
  F("waste", "Waste disposal - Plastic - Landfill", "tonnes", "3", ["Waste disposal", "Plastic"]),
  F("managed", "Managed assets- vehicles - Managed cars (by size)", "km", "3", ["Managed assets- vehicles", "Managed cars (by size)"]),
  // Spend: priced in a currency, carries an industry as level 1, never a DESNZ family. A base with pairs, and its -b variant.
  F("SPEND-air", "Air transport services", "GBP", "3", ["Air transport services"]),
  F("SPEND-air-b", "Air transport services", "GBP", "3", ["Air transport services"]),
  F("SPEND-legal", "Legal services", "GBP", "3", ["Legal services"]),
  // A family the map does not know: offered in no list and reported as unfiled.
  F("mystery", "Mystery family", "kg", "3", ["Hovercraft", "Cushions"]),
];
const idOf = (fixture: Fixture) => `${fixture.ds === DS ? "uk-ghg" : "x"}-${fixture.id}`;
const factorId = (name: string) => idOf(FACTORS.find((fixture) => fixture.id === name)!);
const setOf = (...names: string[]) => names.map(factorId).sort();

describe("factor → category membership (NZC-171)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actorId = ACTOR, role: "admin" | "consultant" = "admin", reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId, principal: "staff", idempotencyKey: `m-${keys}`, correlationId: `corr-m-${keys}`, grant: commandGrantForRole(role, ORG, actorId), ...(reason ? { reason } : {}) };
  };
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const db = await database.admin();
    try { return (await db.query(sql, params)).rows as T[]; } finally { await db.end(); }
  };
  /** A command refused by its validation, naming the field. */
  const refusedFor = (field: string) => (error: Error & { issues?: Array<{ field: string }> }) => error.name === "CommandValidationError" && (error.issues ?? []).some((issue) => issue.field === field);
  const offered = async (categoryCode: string) => {
    const preview = await withTenantRead(database.pool, ORG, (db) => previewDeclaredFactor(db, ORG, JOB,
      { scope: categoryCode.split(".")[0]!, unit: null, supplySource: null, assertedVehicleAttributes: null }, categoryCode));
    return { members: preview.memberFactorIds ? [...preview.memberFactorIds].sort() : undefined, notice: preview.scopeWideNotice };
  };

  before(async () => {
    database = (await createDisposableDatabase("nzc171member", {
      // The organisation exists when 0210 runs, as every real one does, so the seed's audit event is written for it.
      onMigration: async (filename, owner) => {
        if (!filename.startsWith("0208_")) return;
        await owner.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
        await owner.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
      },
    }))!;
    for (const [ds, name] of [[DS, "DESNZ GB 2026"], [ICE, "ICE"], [NZI, "NZI"]] as const) {
      await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
               VALUES ($1,$2,$3,'2026.1','2026-01-01','2026-12-31','GB','active',$3,'OGL')`, [ORG, ds, name]);
    }
    for (const fixture of FACTORS) {
      await q(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
        [ORG, fixture.ds, idOf(fixture), fixture.label, fixture.unit, fixture.scopes, fixture.levels]);
    }
    // The pairs: a business-travel car and ferry used for commuting, air-transport spend used for business travel and downstream freight.
    for (const [name, suffix] of [["btcar", "-c"], ["ferry", "-c"], ["SPEND-air", "-b"], ["SPEND-air", "-d"]] as const) {
      await q(`INSERT INTO nzi_console.factor_identity_categories (organisation_id,factor_id,suffix_code,status,source,created_by,updated_by) VALUES ($1,$2,$3,'active','admin','test','test')`, [ORG, factorId(name), suffix]);
    }
    await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Membership Co','active')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
             VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    for (const ds of [DS, ICE, NZI]) {
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`, [ORG, JOB, ds, ACTOR]);
    }
  });
  after(async () => { await database?.end(); });

  it("the migrations seed the ruled map: 125 rules (0211 retired the held-back one and filed Heat and steam), none held back, every category named but the four without a family", async () => {
    const rules = await withTenantRead(database.pool, ORG, (db) => listMembershipRules(db, { includeRetired: true }));
    assert.equal(rules.length, 125);
    assert.deepEqual(rules.filter((rule) => rule.categoryCode === null).map((rule) => [rule.sourceL1, rule.status]), [["Heat and steam", "retired"]], "the held-back rule is retired, its record kept");
    const live = await withTenantRead(database.pool, ORG, (db) => listMembershipRules(db));
    assert.deepEqual(live.filter((rule) => rule.categoryCode === null), [], "no family is held back: the held-back count is 0");
    assert.deepEqual(live.filter((rule) => rule.sourceL1 === "Heat and steam").map((rule) => rule.categoryCode), ["2.purchased-heat-steam"]);
    assert.deepEqual(familylessCategories(rules), ["3.10", "3.11", "3.14", "3.15"]);
    const audited = await q<{ n: string }>(`SELECT count(*)::text n FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='factor.membership.seeded' AND actor_id='migration:0210'`, [ORG]);
    assert.equal(audited[0]!.n, "1", "the seed is audited, once per organisation");
  });

  it("each category offers exactly the factors whose family maps to it - no leak in either direction", async () => {
    const expected: Record<string, string[]> = {
      "1.natural-gas": setOf("natgas", "natgas-blend"),
      "1.other-stationary-fuels": setOf("lpg", "greengas", "diesel", "coal", "biomass"),
      "1.company-vehicles": setOf("diesel", "pcar", "van"),
      "1.refrigerants": setOf("refrig"),
      "2.purchased-electricity": setOf("grid", "ev"),
      "2.renewable-electricity": setOf("renew"),
      "2.purchased-heat-steam": setOf("heat"),
      "3.1": setOf("materials", "concrete", "water", "SPEND-air", "SPEND-legal"),
      "3.2": setOf("materials", "concrete", "SPEND-air", "SPEND-legal"),
      "3.3": setOf("td", "wttfuel", "wttheat"),
      "3.4": setOf("freight", "wttfreight"),
      "3.5": setOf("waste", "watertreat"),
      "3.6": setOf("flight", "btcar", "ferry", "walk", "wttcar", "hotel", "SPEND-air", "SPEND-air-b"),
      "3.7": setOf("btcar", "btcar-c", "ferry", "walk", "wttcar", "homew"),
      "3.8": setOf("managed"),
      "3.9": setOf("freight", "wttfreight", "SPEND-air"),
      "3.12": setOf("waste"),
      "3.13": setOf("managed"),
    };
    for (const [code, want] of Object.entries(expected)) assert.deepEqual((await offered(code)).members, want, code);

    // The leaks the ruling names, in both directions.
    const commuting = (await offered("3.7")).members!, travel = (await offered("3.6")).members!, upstream = (await offered("3.4")).members!;
    for (const freightOrIce of ["freight", "wttfreight", "concrete", "materials", "waste"]) assert.ok(!commuting.includes(factorId(freightOrIce)), `${freightOrIce} is not commuting`);
    assert.ok(!commuting.includes(factorId("flight")), "commuting has no flights");
    for (const transport of ["btcar", "ferry", "btcar-c", "flight"]) assert.ok(!upstream.includes(factorId(transport)), `${transport} is not freight`);
    assert.ok(!upstream.includes(factorId("concrete")) && !upstream.includes(factorId("materials")), "3.4 loses ICE and materials");
    assert.ok(!travel.includes(factorId("btcar-c")), "a commuting copy is not business travel's");
    assert.deepEqual((await offered("3.5")).members, setOf("waste", "watertreat"), "3.5 keeps only waste and water treatment");
  });

  it("EV charging is Scope 2 only (the dual company-vehicles membership is not shipped), renewable electricity is its own category, and natural gas is not split", async () => {
    assert.ok(!(await offered("1.company-vehicles")).members!.includes(factorId("ev")));
    assert.ok((await offered("2.purchased-electricity")).members!.includes(factorId("ev")));
    assert.ok(!(await offered("2.purchased-electricity")).members!.includes(factorId("renew")));
    assert.ok(!(await offered("1.other-stationary-fuels")).members!.includes(factorId("natgas-blend")), "every natural-gas level 3 is natural gas");
  });

  it("a category no rule names offers the whole scope with a notice - never an empty list", async () => {
    for (const code of ["3.10", "3.11", "3.14", "3.15"]) {
      const result = await offered(code);
      assert.equal(result.members, undefined, `${code} carries no membership list`);
      assert.match(result.notice ?? "", /No category-specific factors for this category/, code);
    }
    for (const code of ["3.6", "3.7"]) assert.equal((await offered(code)).notice, undefined, `${code} has families of its own`);
  });

  it("the unfiled report names what no rule claims, lists the held-back family apart, and a rule filed by an Admin clears it", async () => {
    const before = await withTenantRead(database.pool, ORG, (db) => membershipReport(db, ORG));
    assert.deepEqual(before.unfiled.map((factor) => factor.factorId), [factorId("mystery")], "the one family the map does not know");
    assert.deepEqual(before.heldBack, [], "nothing is held back since 0211 filed Heat and steam: the held-back count is 0");
    assert.ok(!(await offered("3.6")).members!.includes(factorId("mystery")) && !(await offered("3.1")).members!.includes(factorId("mystery")), "offered in no list");

    await addMembershipCommand(database.pool, { sourceL1: "Hovercraft", sourceL2: "Cushions", categoryCode: "3.4", note: "Test family" }, context());
    assert.ok((await offered("3.4")).members!.includes(factorId("mystery")));
    assert.deepEqual((await withTenantRead(database.pool, ORG, (db) => membershipReport(db, ORG))).unfiled, []);
    await retireMembershipCommand(database.pool, { sourceL1: "hovercraft", sourceL2: "  CUSHIONS", categoryCode: "3.4" }, context(ACTOR, "admin", "Filed in error"));
    assert.ok(!(await offered("3.4")).members!.includes(factorId("mystery")), "retired: out of the list, the record kept");
  });

  it("the map is edited by Admin alone, idempotently, with a reason to retire, and a rule is never deleted or re-pointed", async () => {
    await assert.rejects(addMembershipCommand(database.pool, { sourceL1: "Hovercraft", categoryCode: "3.4" }, context("cora", "consultant")), /Permission denied/);
    const first = await addMembershipCommand(database.pool, { sourceL1: "Zeppelins", categoryCode: "3.4" }, context());
    const again = await addMembershipCommand(database.pool, { sourceL1: "zeppelins", categoryCode: "3.4" }, context());
    assert.equal((first as { data: { outcome: string } }).data.outcome, "added");
    assert.equal((again as { data: { outcome: string } }).data.outcome, "already-filed");
    await assert.rejects(retireMembershipCommand(database.pool, { sourceL1: "Zeppelins", categoryCode: "3.4" }, context()), refusedFor("reason"));
    await retireMembershipCommand(database.pool, { sourceL1: "Zeppelins", categoryCode: "3.4" }, context(ACTOR, "admin", "Not a freight family"));
    const reinstated = await addMembershipCommand(database.pool, { sourceL1: "Zeppelins", categoryCode: "3.4" }, context());
    assert.equal((reinstated as { data: { outcome: string } }).data.outcome, "reinstated");
    await assert.rejects(addMembershipCommand(database.pool, { sourceL1: "Zeppelins", categoryCode: "9.9" }, context()), refusedFor("categoryCode"));
    await assert.rejects(q(`DELETE FROM nzi_console.factor_category_membership WHERE source_l1='Zeppelins'`), /never deleted/);
    await assert.rejects(q(`UPDATE nzi_console.factor_category_membership SET category_code='3.9' WHERE source_l1='Zeppelins'`), /never re-pointed/);
    const audited = await q<{ action: string }>(`SELECT action FROM nzi_console.audit_events WHERE organisation_id=$1 AND action LIKE 'factor.membership.%' AND action <> 'factor.membership.seeded' ORDER BY occurred_at, audit_event_id`, [ORG]);
    assert.ok(audited.length >= 5, "each add, retire and reinstatement is audited");
  });

  it("no factor in the live library is orphaned into invisibility: every physical family in it is filed or deliberately held back", async () => {
    const rules = await withTenantRead(database.pool, ORG, (db) => listMembershipRules(db));
    const paths = JSON.parse(readFileSync(resolve(here, "fixtures/desnz-level-paths.json"), "utf8")) as Array<{ family: string; l1: string | null; l2: string | null; l3: string | null; suffixed: boolean; factors: number; example: string }>;
    assert.ok(paths.length > 100, "a real enumeration of the library's level paths");
    const unclaimed = paths.filter((path) => !path.suffixed && !levelsAreFiled(rules, [path.l1, path.l2, path.l3].filter((level): level is string => level !== null)));
    assert.deepEqual(unclaimed.map((path) => `${path.family}: ${path.l1} / ${path.l2} / ${path.l3}`), [], "no physical path is unfiled");
    const heldBack = paths.filter((path) => !path.suffixed && categoriesForLevels(rules, [path.l1, path.l2, path.l3].filter((level): level is string => level !== null)).length === 0);
    assert.deepEqual([...new Set(heldBack.map((path) => path.l1))], [], "every physical family has a category: none is held back");
    const resolves = (l1: string, l2: string | null, l3: string | null, want: string[]) =>
      assert.deepEqual(categoriesForLevels(rules, [l1, l2, l3].filter((level): level is string => level !== null)), want.sort(), `${l1}/${l2}/${l3}`);
    resolves("Business travel- land", "Cars (by size)", null, ["3.6", "3.7"]);
    resolves("Business travel- air", "Flights", null, ["3.6"]);
    resolves("Freighting goods", "HGV (all diesel)", null, ["3.4", "3.9"]);
    resolves("Fuels", "Liquid fuels", "Diesel (average biofuel blend)", ["1.company-vehicles", "1.other-stationary-fuels"]);
    resolves("Fuels", "Gaseous fuels", "Natural gas (100% mineral blend)", ["1.natural-gas"]);
    resolves("Fuels", "Gaseous fuels", "Green gas", ["1.other-stationary-fuels"]);
    resolves("Concrete", "RC32/40", null, ["3.1", "3.2"]);
    resolves("Employee commuting- land", "Cars (by size)", null, ["3.7"]);
    resolves("Waste disposal", "Plastic", null, ["3.12", "3.5"]);
    resolves("Central  Government\n", null, null, []);
    resolves("Heat and steam", "Heat and steam", "District heat and steam", ["2.purchased-heat-steam"]);
    resolves("Heat and steam", "Heat and steam", "Onsite heat and steam", ["2.purchased-heat-steam"]);
    resolves("WTT- heat and steam", "WTT- heat and steam", "District heat and steam", ["3.3"]);
  });

  it("reconciliation: the derived map includes every base the existing applicability pairs file, in the category the pair names", async () => {
    const rules = await withTenantRead(database.pool, ORG, (db) => listMembershipRules(db));
    // The bases the staging library files under its physical pairs (probed 4 Nov 2026): -c -> 3.7, -d -> 3.9 (freight), the vehicle suffixes -> company vehicles.
    const pairs: Array<[string, string[], string]> = [
      ["-c", ["Business travel- land", "Bus"], "3.7"], ["-c", ["Business travel- land", "Cars (by size)"], "3.7"], ["-c", ["Business travel- land", "Motorbike"], "3.7"],
      ["-c", ["Business travel- land", "Rail"], "3.7"], ["-c", ["Business travel- land", "Taxis"], "3.7"], ["-c", ["Business travel- sea", "Ferry"], "3.7"],
      ["-d", ["Freighting goods", "Cargo ship"], "3.9"], ["-d", ["Freighting goods", "Freight flights"], "3.9"], ["-d", ["Freighting goods", "HGV (all diesel)"], "3.9"],
      ["-d", ["Freighting goods", "HGV refrigerated (all diesel)"], "3.9"], ["-d", ["Freighting goods", "Rail"], "3.9"], ["-d", ["Freighting goods", "Sea tanker"], "3.9"],
      ["-d", ["Freighting goods", "Vans"], "3.9"],
      ["-vcd", ["Fuels", "Liquid fuels"], "1.company-vehicles"], ["-vcp", ["Fuels", "Liquid fuels"], "1.company-vehicles"],
      ["-vh", ["Fuels", "Liquid fuels"], "1.company-vehicles"], ["-vvd", ["Fuels", "Liquid fuels"], "1.company-vehicles"],
    ];
    for (const [suffix, levels, category] of pairs) assert.ok(categoriesForLevels(rules, levels).includes(category), `${suffix} base ${levels.join(" / ")} -> ${category}`);
    // And back: the registry's own physical suffixes name categories that exist.
    const variants = await q<{ suffix_code: string; ghg_category: string }>(`SELECT suffix_code, ghg_category FROM nzi_console.factor_category_variants WHERE status='active'`);
    for (const variant of variants) assert.ok(variant.ghg_category === "1" || emissionCategoryTaxonomy.some((category) => category.code === variant.ghg_category), variant.suffix_code);
  });
});
