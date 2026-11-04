import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { entryFactorRefsFor, optionsForCategory, searchActivityOptions, type DeclaredFactorPreviewResult } from "../app/jobs/emissionEntryModel";

/**
 * The data-entry smart search. Employee Commuting offered freight and embodied-carbon factors, and a multi-word query found nothing:
 * the category's offered set is now its own members (where the category is made of pairs), and the search matches every word, in any
 * order, over the label and the unit.
 */
const source = (factorId: string, label: string, unit: string, over: Record<string, unknown> = {}) => ({
  factorId, label, activityUnit: unit, scopes: ["3"], datasetId: "gb-2025", datasetVersion: "2025.1", factorSource: "dataset" as const,
  clientFactorId: null, synthetic: false, datasetLabel: "DESNZ GB 2025", preferred: false, ...over,
});
const LIBRARY = entryFactorRefsFor([
  source("car-medium-petrol", "Business travel- land - Cars (by size) - Medium car - Petrol", "km"),
  source("car-medium-petrol-c", "Employee commuting- land - Cars (by size) - Medium car - Petrol", "km"),
  source("car-small-diesel", "Business travel- land - Cars (by size) - Small car - Diesel", "km"),
  source("ferry-foot", "Business travel- sea - Ferry - Foot passenger", "passenger.km"),
  source("ferry-foot-c", "Employee commuting- sea - Ferry - Foot passenger", "passenger.km"),
  source("ropax", "Freighting goods - Cargo ship - Large RoPax ferry", "tonne.km"),
  source("ice-block", "Material use - Construction - Medium single skin concrete block - ICE GB 2026", "tonne"),
  source("ice-concrete", "Material use - Construction - Concrete, medium strength - ICE GB 2026", "tonne"),
  source("client-ferry", "Our staff ferry pass", "passenger.km", { factorSource: "client", datasetId: null, clientFactorId: "cf-1" }),
] as never);
const COMMUTING: DeclaredFactorPreviewResult = { enabled: false, excludedFactorIds: [], optionLabels: {}, foldedOptions: [],
  memberFactorIds: ["car-medium-petrol", "car-medium-petrol-c", "ferry-foot", "ferry-foot-c"] };
const ids = (options: ReadonlyArray<{ factorId?: string }>) => options.map((option) => option.factorId);

describe("a category offers only its own factors", () => {
  it("Employee Commuting's set holds no freight, no embodied carbon and no other category's factor - whatever is typed, or nothing", () => {
    const offered = optionsForCategory(LIBRARY, COMMUTING);
    assert.deepEqual(ids(offered), ["car-medium-petrol", "car-medium-petrol-c", "ferry-foot", "ferry-foot-c", "client-ferry"]);
    for (const option of offered) assert.ok(!/Freighting|Material use|ICE GB/.test(option.label), option.label);
    for (const query of ["", "ferry", "medium", "concrete", "tonne", "ICE", "cargo"]) {
      for (const hit of searchActivityOptions(offered, query)) assert.ok(!/Freighting|Material use|ICE GB/.test(hit.label), `${query}: ${hit.label}`);
    }
  });

  it("the three reported searches: 'ferry' and 'medium' stay inside commuting, and a multi-word query finds the medium petrol car", () => {
    const offered = optionsForCategory(LIBRARY, COMMUTING);
    assert.deepEqual(ids(searchActivityOptions(offered, "ferry")), ["client-ferry", "ferry-foot", "ferry-foot-c"], "no freight RoPax ferry (shortest label first)");
    assert.deepEqual(ids(searchActivityOptions(offered, "medium")), ["car-medium-petrol", "car-medium-petrol-c"], "no ICE block");
    assert.deepEqual(ids(searchActivityOptions(offered, "medium car petrol km")), ["car-medium-petrol", "car-medium-petrol-c"]);
    assert.deepEqual(ids(searchActivityOptions(offered, "km petrol medium car")), ["car-medium-petrol", "car-medium-petrol-c"], "any order");
    assert.deepEqual(ids(searchActivityOptions(offered, "commuting medium petrol")), ["car-medium-petrol-c"]);
  });

  it("a category without a membership list is as before (scope only), and a client factor is always kept", () => {
    const nothing: DeclaredFactorPreviewResult = { enabled: false, excludedFactorIds: [] };
    assert.equal(optionsForCategory(LIBRARY, nothing).length, LIBRARY.length);
    assert.equal(optionsForCategory(LIBRARY, null).length, LIBRARY.length);
    assert.ok(ids(optionsForCategory(LIBRARY, { ...COMMUTING, memberFactorIds: [] })).includes("client-ferry"));
    assert.deepEqual(ids(optionsForCategory(LIBRARY, { ...COMMUTING, memberFactorIds: [] })), ["client-ferry"], "an empty membership offers nothing of the dataset's");
  });

  it("the form hands the preview's membership to every list that offers a category (CRM quick-add and the portal)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const model = readFileSync(resolve(here, "../app/jobs/emissionEntryModel.ts"), "utf8");
    assert.match(model, /members\.has\(option\.factorId \?\? ""\)/);
    for (const file of ["../app/jobs/CrpScopeWorkspace.tsx", "../app/portal/jobs/[jobId]/data/PortalDataView.tsx"]) {
      assert.match(readFileSync(resolve(here, file), "utf8"), /optionsForCategory\(/, file);
    }
  });
});

describe("searchActivityOptions: every word, any order, over the label and its unit", () => {
  const option = (label: string, unit: string, over: Record<string, unknown> = {}) => ({ label, unit, ...over });
  const list = [
    option("Natural gas", "kWh"), option("Natural gas (gross CV)", "kWh", { preferred: true }), option("Gas oil", "litres"), option("Diesel", "litres"),
    option("Average petrol car", "km"),
  ];

  it("matches words in any order, and across the label and the unit", () => {
    assert.deepEqual(searchActivityOptions(list, "kwh natural").map((o) => o.label), ["Natural gas (gross CV)", "Natural gas"]);
    assert.deepEqual(searchActivityOptions(list, "car km petrol average").map((o) => o.label), ["Average petrol car"]);
    assert.deepEqual(searchActivityOptions(list, "  gas   LITRES ").map((o) => o.label), ["Gas oil"], "case, and runs of spaces, do not matter");
    assert.deepEqual(searchActivityOptions(list, "gas diesel"), [], "every word has to match");
  });

  it("ranks before it limits: a Preferred factor, then a shorter label, ahead of the rest", () => {
    assert.deepEqual(searchActivityOptions(list, "gas").map((o) => o.label), ["Natural gas (gross CV)", "Gas oil", "Natural gas"]);
    assert.deepEqual(searchActivityOptions(list, "gas", 1).map((o) => o.label), ["Natural gas (gross CV)"], "the limit keeps the best, not the first");
  });

  it("a word that starts a word outranks one found inside another", () => {
    const inside = option("Oscar rail", "km"), starts = option("Cars (by size)", "km");
    assert.deepEqual(searchActivityOptions([inside, starts], "car").map((o) => o.label), ["Cars (by size)", "Oscar rail"], "the shorter label comes second here: word start outranks length");
  });

  it("an empty query keeps the list's own order and limit", () => {
    assert.deepEqual(searchActivityOptions(list, "").map((o) => o.label), list.map((o) => o.label));
    assert.equal(searchActivityOptions(list, "   ", 2).length, 2);
  });

  it("treats the query as text, not a pattern", () => {
    assert.deepEqual(searchActivityOptions([option("CO2 (e) [kg]", "kg")], "(e) [kg]").length, 1);
    assert.deepEqual(searchActivityOptions(list, ".*"), []);
  });
});
