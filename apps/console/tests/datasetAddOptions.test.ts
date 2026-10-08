import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { DatasetOption } from "@nzi/contracts";
import { datasetAddOptions } from "../app/jobs/datasetAddOptions";

/**
 * Phase 3c (JW-2): the Datasets drawer's "Add dataset" offers the editions a job could add by exception, in the order to
 * consider them, each in one honest line; adding is Admin-only (dataset.manage, ruled #12, pending Francis) and anyone else
 * sees the control blocked with the reason — "ask an admin" — not hidden.
 */
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");
const dataset = (over: Partial<DatasetOption>): DatasetOption => ({
  datasetId: "d", name: "file.xlsx", label: "DESNZ GB 2026", version: "1", validFrom: "2026-01-01", validTo: "2026-12-31", countryCode: "GB",
  status: "active", synthetic: false, selected: false, selectionSource: null, selectionReason: null, applicable: true, warnings: [],
  reportingFrom: "2026-01-01", reportingTo: "2026-12-31", jobCountryCode: "GB", ...over,
});

describe("the Add dataset picker (Phase 3c, JW-2)", () => {
  it("offers only editions not already selected, cleanest fit first, the job's country before others, newest first", () => {
    const options = datasetAddOptions([
      dataset({ datasetId: "selected", selected: true, selectionSource: "automatic" }),
      dataset({ datasetId: "gb-2024", label: "DESNZ GB 2024", validFrom: "2024-01-01", validTo: "2024-12-31", applicable: false, warnings: ["Does not cover the complete reporting period."] }),
      dataset({ datasetId: "us-2026", label: "EPA US 2026", countryCode: "US", applicable: false, warnings: ["Geography US differs from job geography GB."] }),
      dataset({ datasetId: "global-2026", label: "CEDA Global 2026", countryCode: "GLOBAL" }),
      dataset({ datasetId: "gb-2026b", label: "Other GB 2026" }),
      dataset({ datasetId: "gb-2025", label: "DESNZ GB 2025", validFrom: "2025-01-01", validTo: "2025-12-31", applicable: false, warnings: ["Does not cover the complete reporting period."] }),
    ]);
    assert.deepEqual(options.map((option) => option.datasetId), ["gb-2026b", "global-2026", "gb-2025", "gb-2024", "us-2026"]);
  });

  it("says what each edition is in one line: its label, the years it is valid for, and its warning count", () => {
    const options = datasetAddOptions([
      dataset({ datasetId: "a", label: "DESNZ GB 2026" }),
      dataset({ datasetId: "b", label: "DESNZ GB 2024–2025", validFrom: "2024-04-01", validTo: "2025-03-31", applicable: false, warnings: ["x", "y"] }),
      dataset({ datasetId: "c", label: "Synthetic GB 2026", synthetic: true, validTo: "2026-12-30" }),
    ]);
    const [clean, warned, demo] = ["a", "b", "c"].map((id) => options.find((option) => option.datasetId === id));
    assert.equal(clean!.text, "DESNZ GB 2026 · valid 2026");
    assert.equal(demo!.text, "Synthetic GB 2026 · valid 2026 · demonstration data");
    assert.equal(warned!.text, "DESNZ GB 2024–2025 · valid 2024–2025 · 2 warnings");
  });

  it("is gated on dataset.manage — blocked with the reason for anyone else, never hidden", () => {
    const workspace = readFileSync(join(APP, "jobs/CrpScopeWorkspace.tsx"), "utf8");
    const panel = workspace.slice(workspace.indexOf("function DatasetPanel("));
    assert.match(panel, /const access = useEditAccess\("dataset\.manage", writeEnabled\);/);
    assert.match(panel, /<GatedButton[\s\S]*?blocked=\{access\.state !== "allowed" \|\| pending \|\| !reason\.trim\(\)\}/);
    assert.match(panel, /ask one to add it, with the reason/);
    assert.match(panel, /\{options\.length > 0 && \(/, "the picker shows whenever there is an edition to add — not only for admins");
  });
});
