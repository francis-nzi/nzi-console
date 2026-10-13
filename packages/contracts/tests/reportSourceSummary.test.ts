import assert from "node:assert/strict";
import { test } from "node:test";
import { datasetLabelFromId, snapshotSourceSummary, type SnapshotProvenanceStamp } from "../src/index";

// R3/R6 (RULING-report-studio-consolidation). Synthetic stamps, shaped like a re-ingested job's: dataset `name`/`version`
// are the upload file names the reference load imported, which no source line may show.
const stamp = (factorSets: SnapshotProvenanceStamp["factorSets"]): SnapshotProvenanceStamp =>
  ({ resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" }, factorSets, boundary: { siteIds: [], excludedRowIds: [] } });
const uploaded = (id: string, file: string) => ({ source: "dataset" as const, id, name: file, version: file });

test("a dataset is named from its id — registry source, country, year — the same name datasetDisplayLabel gives", () => {
  assert.equal(datasetLabelFromId("uk-ghg-gb-2026"), "DESNZ GB 2026");
  assert.equal(datasetLabelFromId("uk-ghg-gb-2025"), "DESNZ GB 2025", "the longest registered prefix, not a shorter one");
  assert.equal(datasetLabelFromId("ceda-ae-2025"), "CEDA AE 2025");
  assert.equal(datasetLabelFromId("nzi-gb-2026"), "NZI GB 2026");
  assert.equal(datasetLabelFromId("uk-ghg-gb-2023-edition-2"), "DESNZ GB 2023", "a kept-apart upload names its edition's year");
  assert.equal(datasetLabelFromId("uk-ghg-gb-2023-original"), "DESNZ GB 2023");
});

test("an id the registry cannot name is shown as the id — never a file name", () => {
  assert.equal(datasetLabelFromId("bespoke-gb-2025"), "bespoke-gb-2025", "unregistered family");
  assert.equal(datasetLabelFromId("uk-ghg-multi"), "uk-ghg-multi", "registered family, but no country and year");
  assert.equal(datasetLabelFromId("synthetic-template"), "synthetic-template");
});

test("the source line names the snapshot and each stamped dataset once, by id — not the upload file names", () => {
  const line = snapshotSourceSummary({ jobNumber: "J000001", provenance: stamp([uploaded("uk-ghg-gb-2025", "Conversion Factors 2019-2025.xlsx"), uploaded("uk-ghg-gb-2026", "tmpupload1.csv")]) });
  assert.equal(line, "Reviewed snapshot J000001 · DESNZ GB 2025 · DESNZ GB 2026");
  assert.doesNotMatch(line!, /\.csv|\.xlsx/);
});

test("two editions that read alike are named once; a client factor keeps its stamped name; the order is stable", () => {
  const line = snapshotSourceSummary({ jobNumber: "J000002", provenance: stamp([
    { source: "client", id: "cf-1", name: "Client factor · Recycled steel", version: "v3" },
    uploaded("uk-ghg-gb-2025", "a.xlsx"), uploaded("uk-ghg-gb-2025-original", "b.xlsx"), uploaded("ceda-gb-2025", "GBR.csv"),
  ]) });
  assert.equal(line, "Reviewed snapshot J000002 · CEDA GB 2025 · Client factor · Recycled steel · DESNZ GB 2025");
});

test("without a stamp, or with an empty one, there is no summary — the chart keeps its own line", () => {
  assert.equal(snapshotSourceSummary({ jobNumber: "J000003" }), null);
  assert.equal(snapshotSourceSummary({ jobNumber: "J000003", provenance: null }), null);
  assert.equal(snapshotSourceSummary({ jobNumber: "J000003", provenance: stamp([]) }), null);
});
