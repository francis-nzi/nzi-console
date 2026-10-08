import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntensityPathway, intensityMilestones, resolveCrpCoreCharts } from "../src/index";
import type { IntensityPathwayData } from "../src/types";

// Phase 3c (addendum (i)): the intensity pathway draws the target's own milestones. A frozen per-job target (baseline,
// interim, net zero) draws exactly as before 3c; a client target draws its optional interim and its end point at its own
// percentage — never a net zero the client did not commit to.
const frozen = { baselineYear: 2024, baselineIntensity: 12, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 };

test("a frozen per-job target draws baseline, interim and net zero, as before 3c", () => {
  assert.deepEqual(intensityMilestones(frozen), [
    { year: 2024, value: 12, label: "Baseline", kind: "baseline" },
    { year: 2030, value: 6, label: "Interim -50%", kind: "interim" },
    { year: 2045, value: 0, label: "Net zero", kind: "netzero" },
  ]);
});

test("a client target ends at its own percentage, with no net zero it did not commit to", () => {
  const milestones = intensityMilestones({ baselineYear: 2022, baselineIntensity: 10, interimYear: 2030, interimReductionPercent: 40, targetYear: 2040, targetReductionPercent: 70, netZeroYear: null });
  assert.deepEqual(milestones.map((m) => [m.year, m.kind, m.label]), [[2022, "baseline", "Baseline"], [2030, "interim", "Interim -40%"], [2040, "target", "Target -70%"]]);
  assert.ok(Math.abs(milestones[2]!.value - 3) < 1e-9);
  assert.ok(!milestones.some((m) => m.kind === "netzero"));
});

test("a client target of 100% is net zero at its year; with no interim it draws baseline and end point only", () => {
  assert.deepEqual(intensityMilestones({ baselineYear: 2025, baselineIntensity: 7.5, interimYear: null, interimReductionPercent: null, targetYear: 2050, targetReductionPercent: 100, netZeroYear: null }),
    [{ year: 2025, value: 7.5, label: "Baseline", kind: "baseline" }, { year: 2050, value: 0, label: "Net zero", kind: "netzero" }]);
});

test("an interim alone draws baseline and interim, in year order", () => {
  assert.deepEqual(intensityMilestones({ baselineYear: 2022, baselineIntensity: 10, interimYear: 2030, interimReductionPercent: 25, targetYear: null, targetReductionPercent: null, netZeroYear: null }).map((m) => m.year), [2022, 2030]);
});

// The ruling's pin: a frozen pre-3c snapshot renders byte-for-byte as before. The fixture is this snapshot's intensity
// pathway rendered by `main` @ 5282318 (before 3c), sha256 d7a9ac91…2445 — a frozen report's chart never moves.
const coreSnapshot = (intensityTarget: Record<string, unknown>) => ({ id: "snapshot-frozen-pre3c", jobId: "717", jobNumber: "J000717", client: "Synthetic Client", reportingYear: 2026,
  generatedAt: "2026-08-25T00:00:00Z", dataHash: "sha256:frozen-pre3c", intensityTarget,
  measurements: [{ rowId: "row-a", scope: "1", sourceLabel: "Synthetic fuel", tco2e: 80, factorSet: "Demo v1" }] }) as never;
const renderIntensity = (snapshot: never) => {
  const chart = resolveCrpCoreCharts(snapshot).find((item) => item.spec.type === "intensity_pathway") as IntensityPathwayData | undefined;
  assert.ok(chart, "the intensity pathway resolves");
  return renderToStaticMarkup(createElement(IntensityPathway, { data: chart }));
};

test("a pre-3c frozen snapshot's intensity pathway renders byte-for-byte as before 3c", () => {
  const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "frozen-pre3c-intensity-pathway.svg"), "utf8");
  assert.equal(renderIntensity(coreSnapshot({ metric: "employee", denominatorUnit: "FTE", reportingDenominator: 10, ...frozen })), fixture);
});

test("a partial client target is drawn and labelled as the target, never as net zero", () => {
  const svg = renderIntensity(coreSnapshot({ metric: "turnover", denominatorUnit: "£m", reportingDenominator: 12.5, source: "client-target", baselineYear: 2022, baselineIntensity: 10,
    interimYear: 2030, interimReductionPercent: 40, targetYear: 2040, targetReductionPercent: 70, netZeroYear: null }));
  assert.match(svg, /Target -70%/);
  assert.doesNotMatch(svg, /Net zero/i);
});
