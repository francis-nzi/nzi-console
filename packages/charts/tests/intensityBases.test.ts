import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntensityBasesIndexed, RENDERER_VERSION, TOKENS_VERSION, basisColour } from "../src/index";
import type { IntensityBasesIndexedData } from "../src/types";

const provenance = { jobId: "job-a", dataHash: "sha256:demo", factorSets: ["Synthetic evidence v1"], generatedAt: "2026-09-01T00:00:00Z", reviewedSnapshotId: "snapshot-a", resolverVersion: 1, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION };

const data: IntensityBasesIndexedData = {
  spec: { id: "intensity_bases", type: "intensity_bases_indexed", title: "Intensity — all bases", family: "crp", specVersion: 1 },
  unit: "index", state: "success", provenance, baseYear: 2023,
  series: [
    { key: "turnover", label: "Revenue", points: [{ year: 2023, value: 100, absolute: 48.1, absoluteUnit: "tCO₂e / £m" }, { year: 2024, value: 89.2, absolute: 42.9, absoluteUnit: "tCO₂e / £m" }] },
    { key: "floor-area", label: "Floor area", points: [{ year: 2023, value: 100, absolute: 541, absoluteUnit: "kgCO₂e / m²" }, { year: 2024, value: 104.5, absolute: 565, absoluteUnit: "kgCO₂e / m²" }] },
  ],
};

test("every basis is plotted with its own line, direct label and absolute figure", () => {
  const svg = renderToStaticMarkup(createElement(IntensityBasesIndexed, { data, showChrome: false }));
  assert.match(svg, /role="img"/);
  // Direct labels and the base-year reference, so identity never depends on colour.
  assert.match(svg, />Revenue</);
  assert.match(svg, />Floor area</);
  assert.match(svg, /2023 = 100/);
  // The tooltip keeps the real figure in its own unit — the index never replaces it.
  assert.match(svg, /42\.9 tCO₂e \/ £m/);
  assert.match(svg, /565 kgCO₂e \/ m²/);
});

test("basis identity carries a dash pattern as well as a colour, and never a scope colour", () => {
  const svg = renderToStaticMarkup(createElement(IntensityBasesIndexed, { data, showChrome: false }));
  assert.match(svg, /stroke-dasharray="2 4"/); // floor area
  const scopeColours = ["#FF5C48", "#FFC24B", "#0BA75E"];
  for (const key of ["turnover", "employee", "floor-area"] as const) {
    assert.ok(!scopeColours.includes(basisColour(key)), `${key} must not borrow a scope colour`);
  }
  assert.equal(new Set(["turnover", "employee", "floor-area"].map((key) => basisColour(key as "turnover"))).size, 3);
});

test("the reference line claims a shared base year only when there is one", () => {
  const shared = renderToStaticMarkup(createElement(IntensityBasesIndexed, { data, showChrome: false }));
  assert.match(shared, /2023 = 100/);
  // Bases that start in different years cannot share a base — the chart must say so
  // rather than name a year two of the three series were never indexed to.
  const ownBase = renderToStaticMarkup(createElement(IntensityBasesIndexed, { data: { ...data, baseYear: null }, showChrome: false }));
  assert.match(ownBase, /each basis · first year = 100/);
  assert.ok(!ownBase.includes("2023 = 100"));
});

test("the index axis frames the values and always carries the 100 reference", () => {
  const svg = renderToStaticMarkup(createElement(IntensityBasesIndexed, { data, showChrome: false }));
  // Values run 89–105, so a zero-based axis would flatten both series into one line.
  assert.ok(!/>0</.test(svg.split("<g><line")[1] ?? ""), "the axis is not forced to zero");
  assert.match(svg, /stroke-dasharray="2 4" opacity="0.5"/); // the 100 reference line
  assert.match(svg, />100</);
});

test("a basis with no points is left out rather than drawn flat", () => {
  const svg = renderToStaticMarkup(createElement(IntensityBasesIndexed, {
    data: { ...data, series: [...data.series, { key: "employee" as const, label: "FTE", points: [] }] }, showChrome: false,
  }));
  assert.ok(!svg.includes(">FTE<"), "an unresolved basis must not appear on the chart");
});
