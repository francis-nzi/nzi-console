import assert from "node:assert/strict";
import test from "node:test";
import { addManualDataset, datasetApplies, datasets, recommendDatasets } from "../src/datasets";

const context = { reportingFrom: "2024-01-01", reportingTo: "2024-12-31", country: "GB" };

test("datasets are automatically selected from the reporting period and geography", () => {
  assert.deepEqual(recommendDatasets(context).map((item) => item.dataset.id), ["defra-2024", "desnz-2024", "ceda-2024"]);
});

test("applicability includes period and geography and excludes superseded automatic selection", () => {
  assert.equal(datasetApplies(datasets.find((item) => item.id === "defra-2024")!, context), true);
  assert.equal(datasetApplies(datasets.find((item) => item.id === "epa-2024")!, context), false);
  assert.equal(recommendDatasets(context).some((item) => item.dataset.status !== "active"), false);
});

test("manual datasets require a reason and preserve warnings", () => {
  assert.throws(() => addManualDataset("epa-2024", context, ""), /reason is required/);
  const selection = addManualDataset("epa-2024", context, "US activity supplied by client");
  assert.equal(selection.source, "manual");
  assert.equal(selection.warnings.length, 1);
});
