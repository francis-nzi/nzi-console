import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entryFactorRefsFor, optionsForCategory, type DeclaredFactorPreviewResult } from "../app/jobs/emissionEntryModel";

/**
 * Dedup slice 5 Step D: a category's quick-add reads as the write files. With applicability the default, a base the category files
 * under a pair is offered under the pair's own label — the one the row will store and print — and a still-materialised variant whose
 * pick files as that same base is not offered a second time. Without the preview's filing (the kill-switch), the list is as before.
 */
const source = (factorId: string, label: string, unit: string, scopes: string[], over: Record<string, unknown> = {}) => ({
  factorId, label, activityUnit: unit, scopes, datasetId: "gb-2025", datasetVersion: "2025.1", factorSource: "dataset" as const,
  clientFactorId: null, synthetic: false, datasetLabel: "DESNZ GB 2025", preferred: true, ...over,
});
const OPTIONS = entryFactorRefsFor([
  source("uk-ghg-25_301_3070_9_1", "Business travel- land - Cars (by size) - Average car - Petrol", "miles", ["3"]),
  source("uk-ghg-25_301_3070_9_1-c", "Employee commuting- land - Cars (by size) - Average car - Petrol", "miles", ["3"]),
  source("uk-ghg-25_301_3070_9_1-c", "Employee commuting- land - Cars (by size) - Average car - Petrol", "miles", ["3"], { datasetId: "gb-2024", datasetVersion: "2024.1" }),
  source("uk-ghg-4_301_3070_4_1-bcp", "Business travel - Large car - Diesel", "km", ["3"]),
  source("uk-ghg-27_320_3235_14_1", "Freighting goods - Cargo ship - Container ship", "tonne.km", ["3"], { synthetic: true }),
  source("cf-1", "Our own commuting factor", "miles", ["3"], { factorSource: "client", datasetId: null, clientFactorId: "cf-1" }),
] as never);
const labels = (options: ReturnType<typeof optionsForCategory>) => options.map((option) => `${option.factorId}@${option.datasetId ?? "client"}: ${option.label}`);

describe("the quick-add list reads as applicability files it (dedup slice 5 Step D)", () => {
  it("relabels a filed base by its pair, and hides the variant whose pick files as that base", () => {
    const preview: DeclaredFactorPreviewResult = { enabled: false, excludedFactorIds: [],
      optionLabels: { "uk-ghg-25_301_3070_9_1": "Employee commuting- land - Cars (by size) - Average car - Petrol", "uk-ghg-27_320_3235_14_1": "Freight: Container Ship (downstream)" },
      foldedOptions: [{ datasetId: "gb-2025", factorId: "uk-ghg-25_301_3070_9_1-c" }] };
    assert.deepEqual(labels(optionsForCategory(OPTIONS, preview)), [
      "uk-ghg-25_301_3070_9_1@gb-2025: Employee commuting- land - Cars (by size) - Average car - Petrol · miles",
      // Folded only where its base is offered beside it: the 2024 copy has no base in its own dataset, so it stays.
      "uk-ghg-25_301_3070_9_1-c@gb-2024: Employee commuting- land - Cars (by size) - Average car - Petrol · miles",
      // A scope-shifted copy is never folded, and keeps its own label.
      "uk-ghg-4_301_3070_4_1-bcp@gb-2025: Business travel - Large car - Diesel · km",
      // The unit and the demo mark are kept; only the factor's own wording is replaced.
      "uk-ghg-27_320_3235_14_1@gb-2025: Freight: Container Ship (downstream) · tonne.km · DEMO",
      "cf-1@client: Our own commuting factor · miles",
    ]);
  });

  it("never relabels or hides a client factor, even one sharing a filed base's id", () => {
    const shared = entryFactorRefsFor([source("uk-ghg-25_301_3070_9_1", "A client's own wording", "miles", ["3"], { factorSource: "client", datasetId: null, clientFactorId: "cf-2" })] as never);
    const preview: DeclaredFactorPreviewResult = { enabled: false, optionLabels: { "uk-ghg-25_301_3070_9_1": "Pair" }, foldedOptions: [{ datasetId: "gb-2025", factorId: "uk-ghg-25_301_3070_9_1" }] };
    assert.deepEqual(labels(optionsForCategory(shared, preview)), ["uk-ghg-25_301_3070_9_1@client: A client's own wording · miles"]);
  });

  it("without the preview's filing — the kill-switch, or an older server — the list is exactly as before", () => {
    assert.deepEqual(optionsForCategory(OPTIONS, { enabled: false, excludedFactorIds: [] }), OPTIONS);
    assert.deepEqual(optionsForCategory(OPTIONS, null), OPTIONS);
    // The D1 exclusion still applies alongside.
    assert.ok(!labels(optionsForCategory(OPTIONS, { enabled: false, excludedFactorIds: ["uk-ghg-25_301_3070_9_1"] })).some((label) => label.startsWith("uk-ghg-25_301_3070_9_1@")));
  });
});
