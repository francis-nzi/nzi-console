import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectedPathway, RENDERER_VERSION, TOKENS_VERSION, tokens } from "../src/index";
import type { ProjectedPathwayData } from "../src/types";

const provenance = {
  jobId: "job-a", dataHash: "sha256:demo", factorSets: ["Synthetic v1"], generatedAt: "2026-09-15T00:00:00Z",
  reviewedSnapshotId: "snap-a", resolverVersion: 1, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION,
};

const data: ProjectedPathwayData = {
  spec: { id: "proj", type: "projected_pathway", title: "Projected against target", family: "crp", specVersion: 1 },
  unit: "tCO₂e", state: "success", provenance,
  actual: [{ year: 2024, value: 1000 }, { year: 2026, value: 940 }],
  projected: [{ year: 2024, value: 1000 }, { year: 2030, value: 700 }, { year: 2040, value: 500 }],
  target: [{ year: 2024, value: 1000 }, { year: 2030, value: 500 }, { year: 2040, value: 50 }],
};

const svg = () => renderToStaticMarkup(createElement(ProjectedPathway, { data, showChrome: false }));

test("the projected series is never presented as the measured one", () => {
  const out = svg();
  // Distinct by hue AND by dash, so "estimate" survives greyscale, print and colour
  // blindness — identity never rests on colour alone.
  assert.ok(out.includes(tokens.projection.projected), "projected has its own hue");
  assert.ok(out.includes(tokens.projection.actual), "measured keeps the brand emerald");
  assert.notEqual(tokens.projection.projected, tokens.projection.actual);
  assert.match(out, /stroke-dasharray="7 4"/, "projected is dashed");
  // And named, in the legend and in the accessible description.
  assert.match(out, /Projected — planned/);
  assert.match(out, /Measured — assured/);
  assert.match(out, /not a measurement/);
});

test("draws one axis and never borrows a scope colour", () => {
  const out = svg();
  // Three series, one scale. A second y-axis would invite a relationship between the lines
  // that the numbers do not support.
  assert.equal(out.match(/<polyline /g)?.length, 3, "three series, one plot");
  // Every y tick label sits in the same column — one scale, not two facing each other.
  const tickX = [...out.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="end"/g)].map((match) => match[1]);
  assert.ok(tickX.length > 0 && new Set(tickX).size === 1, "a single y-axis");
  for (const scopeColour of ["#FF5C48", "#FFC24B"]) {
    assert.ok(!out.toUpperCase().includes(scopeColour), `${scopeColour} carries scope identity`);
  }
});

test("renders as inline SVG with every series named", () => {
  const out = svg();
  assert.match(out, /^<svg /);
  assert.ok(!out.includes("<image"), "nothing external to fetch");
  assert.match(out, /Target — needed/);
});
