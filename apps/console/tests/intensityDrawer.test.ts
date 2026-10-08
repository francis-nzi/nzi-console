import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { targetText } from "../app/jobs/intensityTargetText";

// Phase 3c (RULING-3c3-intensity-readers): the job's intensity lives in its own drawer — the year's Values beside the
// client's targets, naming the metric the CRP reports — and the per-job intensity target is retired.
const app = join(dirname(resolve(fileURLToPath(import.meta.url))), "..", "app");
const source = (path: string) => readFileSync(join(app, path), "utf8");

describe("the job's Intensity drawer (Phase 3c)", () => {
  it("reads a client target in one line: the baseline, the optional interim, the end point (net zero at 100%)", () => {
    const base = { baselineYear: 2022, baselineIntensity: 4.5, interimYear: 2030, interimReductionPct: 42, targetYear: 2040, targetReductionPct: 90 };
    assert.equal(targetText(base), "2022 baseline 4.5 → −42% by 2030 → −90% by 2040");
    assert.equal(targetText({ ...base, interimYear: null, interimReductionPct: null, targetReductionPct: 100 }), "2022 baseline 4.5 → net zero by 2040");
    assert.equal(targetText({ ...base, targetYear: null, targetReductionPct: null }), "2022 baseline 4.5 → −42% by 2030");
  });

  it("is a drawer of the job shell, opened from its own chip", () => {
    const header = source("jobs/JobShellHeader.tsx");
    assert.match(header, /export type JobShellDrawer = [^;]*"intensity"/);
    assert.match(header, /onOpen\("intensity"\)/);
    assert.match(source("jobs/CrpScopeWorkspace.tsx"), /intensity: intensityTarget \? `\$\{reportedIntensityLabel\(intensityTarget\)\} · reported` : "None reported"/);
  });

  it("names the metric the CRP reports, from the read model's one rule — never its own guess", () => {
    const drawer = source("jobs/JobAnnualMetrics.tsx");
    assert.match(drawer, /reported=\{payload\?\.reportedMetricKey === metric\.key\}/);
    assert.match(drawer, /Reported in the CRP/);
    assert.match(drawer, /#client-intensity-targets/, "links to the client's targets and metric order");
  });

  it("has retired the per-job intensity target: no panel, no PUT", () => {
    const workspace = source("jobs/CrpScopeWorkspace.tsx");
    assert.doesNotMatch(workspace, /function IntensityPanel/);
    assert.doesNotMatch(workspace, /<IntensityPanel/);
    const route = source("api/isolated/jobs/[jobId]/intensity-target/route.ts");
    assert.doesNotMatch(route, /export (async )?function PUT/);
    assert.match(route, /export (async )?function GET/);
  });
});
