import assert from "node:assert/strict";
import test from "node:test";
import { addManualDataset, recommendDatasets } from "../src/datasets";

const context = { reportingFrom: "2024-01-01", reportingTo: "2024-12-31", country: "GB" };

test("datasets are automatically selected from the reporting period and geography", () => {
  assert.deepEqual(recommendDatasets(context).map((item) => item.dataset.id), ["defra-2024", "desnz-2024", "ceda-2024"]);
});

test("manual datasets require a reason and preserve warnings", () => {
  assert.throws(() => addManualDataset("epa-2024", context, ""), /reason is required/);
  const selection = addManualDataset("epa-2024", context, "US activity supplied by client");
  assert.equal(selection.source, "manual");
  assert.equal(selection.warnings.length, 1);
});
