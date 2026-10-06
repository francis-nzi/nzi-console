import assert from "node:assert/strict";
import { test } from "node:test";
import { DATASET_EDITION_SUFFIX, datasetDisplayLabel, datasetPreferenceRank, datasetSeriesKey, datasetSourceOf, isPreferredDataset } from "../src/datasetSources";

test("a dataset's series is its id without the edition tail the reference load gives it", () => {
  assert.equal(datasetSeriesKey("uk-ghg-gb-2025"), "uk-ghg-gb");
  assert.equal(datasetSeriesKey("nzi-gb-2026"), "nzi-gb");
  assert.equal(datasetSeriesKey("uk-ghg-gb-2023-original"), "uk-ghg-gb", "a kept-apart upload is the same series");
  assert.equal(datasetSeriesKey("uk-ghg-gb-2023-edition-9"), "uk-ghg-gb");
  assert.equal(datasetSeriesKey("synthetic-template"), "synthetic-template", "an id with no edition tail is its own series");
  assert.equal(new RegExp(DATASET_EDITION_SUFFIX).test("ceda-gb-2025"), true);
});

test("the source comes from the registry, by the id's family prefix — never the imported name", () => {
  assert.equal(datasetSourceOf("uk-ghg-gb-2025")?.label, "DESNZ");
  assert.equal(datasetSourceOf("nzi-gb-2025")?.label, "NZI");
  assert.equal(datasetSourceOf("ceda-gb-2025")?.label, "CEDA");
  assert.equal(datasetSourceOf("ice-gb-2026")?.label, "ICE");
  assert.equal(datasetSourceOf("ukghg-2025"), null, "a prefix must end at a hyphen");
  assert.equal(datasetSourceOf("unknown-gb-2025"), null);
});

test("a dataset is named source · country · year, derived — never its imported file name", () => {
  const dataset = (datasetId: string, validFrom: string, validTo: string, sourceName: string | null = "tmpai4mgnde.csv") => ({ datasetId, countryCode: "GB", validFrom, validTo, sourceName });
  assert.equal(datasetDisplayLabel(dataset("uk-ghg-gb-2025", "2025-01-01", "2025-12-31")), "DESNZ GB 2025");
  assert.equal(datasetDisplayLabel(dataset("nzi-gb-2026", "2026-01-01", "2026-12-31")), "NZI GB 2026");
  assert.equal(datasetDisplayLabel({ ...dataset("ice-gb-2026", "2026-01-01", "2026-12-31"), countryCode: "GLOBAL" }), "ICE GLOBAL 2026");
  assert.equal(datasetDisplayLabel(dataset("uk-ghg-gb-multi", "2019-01-01", "2025-12-31")), "DESNZ GB 2019–2025", "a span names both ends");
  assert.equal(datasetDisplayLabel(dataset("bespoke-2025", "2025-01-01", "2025-12-31", "Supplier EPDs")), "Supplier EPDs GB 2025", "unregistered: its source name");
  assert.equal(datasetDisplayLabel(dataset("bespoke-2025", "2025-01-01", "2025-12-31", " ")), "bespoke-2025 GB 2025", "no source name: its id");
});

test("DESNZ is the preferred source for the UK, and only there; it ranks first, then the registry's order, then the rest", () => {
  assert.equal(isPreferredDataset("uk-ghg-gb-2025", "GB"), true);
  assert.equal(isPreferredDataset("uk-ghg-gb-2025", "FR"), false);
  assert.equal(isPreferredDataset("nzi-gb-2025", "GB"), false);
  assert.equal(isPreferredDataset(null, "GB"), false);
  const ids = ["mystery-2025", "ice-gb-2026", "nzi-gb-2025", "ceda-gb-2025", "uk-ghg-gb-2025"];
  assert.deepEqual([...ids].sort((a, b) => datasetPreferenceRank(a, "GB") - datasetPreferenceRank(b, "GB")),
    ["uk-ghg-gb-2025", "nzi-gb-2025", "ceda-gb-2025", "ice-gb-2026", "mystery-2025"]);
  assert.equal(datasetPreferenceRank(null, "GB"), datasetPreferenceRank("mystery-2025", "GB"), "a client factor (no dataset) sorts with the unregistered");
});
