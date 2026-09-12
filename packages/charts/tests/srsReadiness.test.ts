import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SrsPillarRadar, SrsMaturityBullets, SrsGapHeatmap, SrsReadinessTrend, RENDERER_VERSION, TOKENS_VERSION, tokens } from "../src/index";
import type { SrsGapHeatmapData, SrsMaturityBulletsData, SrsPillarRadarData, SrsReadinessTrendData } from "../src/types";

const provenance = { jobId: "job-srs", dataHash: "sha256:demo", factorSets: ["Synthetic evidence v1"], generatedAt: "2026-09-01T00:00:00Z", reviewedSnapshotId: "snapshot-srs", resolverVersion: 1, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION };

const radar: SrsPillarRadarData = {
  spec: { id: "srs_pillars", type: "srs_pillar_radar", title: "Readiness by pillar", family: "consultancy", specVersion: 1 },
  unit: "level", state: "success", provenance, maxLevel: 4,
  pillars: ["Governance", "Strategy", "Risk management", "Metrics and targets"],
  target: [3, 3, 3, 4],
  series: [
    { key: "S2", label: "Climate", values: [3, 2, 2, 3] },
    { key: "S1", label: "General", values: [2, 1, 1, 2] },
  ],
};

const bullets: SrsMaturityBulletsData = {
  spec: { id: "srs_bullets", type: "srs_maturity_bullets", title: "Maturity against target", family: "consultancy", specVersion: 1 },
  unit: "level", state: "success", provenance, maxLevel: 4,
  rows: [
    { label: "Governance", value: 3, valueLabel: "Embedded", comparison: 2, target: 3 },
    { label: "Strategy", value: 2, valueLabel: "Developing", comparison: null, target: 4 },
  ],
};

const heatmap: SrsGapHeatmapData = {
  spec: { id: "srs_gaps", type: "srs_gap_heatmap", title: "Requirement gaps", family: "consultancy", specVersion: 1 },
  unit: "level", state: "success", provenance,
  levels: ["Not started", "Scoping", "Developing", "Embedded", "Assured"],
  groups: [
    { label: "Governance", rows: [{ label: "Board oversight of climate-related risks", value: 3, target: 4 }, { label: "Management role", value: 1, target: 3 }] },
    { label: "Strategy", rows: [{ label: "Scenario analysis", value: 0, target: 3 }] },
  ],
};

const trend: SrsReadinessTrendData = {
  spec: { id: "srs_trend", type: "srs_readiness_trend", title: "Readiness over time", family: "consultancy", specVersion: 1 },
  unit: "%", state: "success", provenance,
  points: [{ label: "FY23", value: 24 }, { label: "FY24", value: 41 }, { label: "FY25", value: 63 }],
};

/** Bare SVG only: the figure chrome is shared package furniture, not part of these specs. */
const radarSvg = () => renderToStaticMarkup(createElement(SrsPillarRadar, { data: radar, showChrome: false }));
const bulletsSvg = () => renderToStaticMarkup(createElement(SrsMaturityBullets, { data: bullets, showChrome: false }));
const heatmapSvg = () => renderToStaticMarkup(createElement(SrsGapHeatmap, { data: heatmap, showChrome: false }));
const trendSvg = () => renderToStaticMarkup(createElement(SrsReadinessTrend, { data: trend, showChrome: false }));

const SCOPE_COLOURS = ["#FF5C48", "#FFC24B", "#0BA75E"];

test("the pillar radar names every axis, both standards and the target", () => {
  const svg = radarSvg();
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-labelledby="srs_pillars-title srs_pillars-desc"/);
  for (const pillar of radar.pillars) assert.ok(svg.includes(`>${pillar}<`), `${pillar} must be labelled on the radar`);
  // Legend carries the standard codes AND their names, so identity is never colour-alone.
  assert.match(svg, />S2 · Climate</);
  assert.match(svg, />S1 · General</);
  assert.match(svg, />Target</);
  // The target is a dashed outline, not a fill — a reference, not a result.
  assert.match(svg, /stroke-dasharray="4 4"/);
  // Both series plus the target profile are drawn as polygons.
  assert.ok((svg.match(/<polygon/g) ?? []).length >= radar.maxLevel + 3);
  assert.ok(svg.includes(tokens.srs.s1) && svg.includes(tokens.srs.s2));
});

test("each bullet row carries its level in words, its target tick and its comparison marker", () => {
  const svg = bulletsSvg();
  assert.match(svg, /role="img"/);
  assert.match(svg, />Governance</);
  assert.match(svg, />Embedded</);
  assert.match(svg, />Developing</);
  // Level 3 fills from the sequential maturity ramp, never from the scope palette.
  assert.ok(svg.includes(tokens.srs.maturity[3]!), "the achieved level uses its ramp colour");
  assert.ok(svg.includes(tokens.srs.maturity[2]!));
  // Target ticks: one per row, plus the legend swatch.
  assert.equal((svg.match(new RegExp(tokens.srs.target, "g")) ?? []).length, bullets.rows.length + 1);
  // A null comparison draws no marker — one row has one, the other does not (plus legend).
  assert.equal((svg.match(new RegExp(tokens.srs.s1, "g")) ?? []).length, 2);
});

test("the gap grid runs colour up to the achieved level and leaves the rest of the track empty", () => {
  const svg = heatmapSvg();
  assert.match(svg, /role="img"/);
  assert.match(svg, />GOVERNANCE</);
  assert.match(svg, />STRATEGY</);
  // Long requirement labels truncate on screen but keep the full text in a tooltip.
  assert.ok(svg.includes("<title>Board oversight of climate-related risks</title>"));
  assert.ok(svg.includes(">Board oversight of climate-rela…<"), "the visible label is truncated");
  // Column headers are abbreviated to at most four characters.
  assert.match(svg, />Deve</);
  const headers = [...svg.matchAll(/font-size="9\.5" fill="#616B65">([^<]*)</g)].map((match) => match[1] ?? "");
  assert.equal(headers.length, heatmap.levels.length);
  for (const header of headers) assert.ok(header.length <= 4, `header "${header}" is over four characters`);
  // The unreached cells are the empty track colour; reached cells take the ramp.
  assert.ok(svg.includes(tokens.line2), "unreached levels stay on the empty track colour");
  assert.ok(svg.includes(tokens.srs.maturity[3]!));
  // A row at level 0 still shows its own cell in the ramp's first step.
  assert.ok(svg.includes(tokens.srs.maturity[0]!));
  // The achieved cell carries a glyph in legible ink, so it never reads by colour alone.
  assert.ok(svg.includes(tokens.srs.maturityInk[3]!));
});

test("the readiness sparkline prints its latest value and every period label", () => {
  const svg = trendSvg();
  assert.match(svg, /role="img"/);
  assert.match(svg, /<polyline/);
  assert.match(svg, />63%</); // the latest value, printed
  for (const point of trend.points) assert.ok(svg.includes(`>${point.label}<`));
  // 0–100 is the real whole of a percent-complete measure: 24% must not sit on the floor.
  assert.ok(!/cy="46"/.test(svg), "the axis is the full 0-100, not the data range");
  assert.ok(svg.includes(tokens.srs.s2));
});

test("no SRS chart borrows a GHG scope colour — scope identity means scope", () => {
  const rendered: Array<[string, string]> = [
    ["srs_pillar_radar", radarSvg()],
    ["srs_maturity_bullets", bulletsSvg()],
    ["srs_gap_heatmap", heatmapSvg()],
    ["srs_readiness_trend", trendSvg()],
  ];
  for (const [name, svg] of rendered) {
    for (const colour of SCOPE_COLOURS) {
      assert.ok(!svg.toUpperCase().includes(colour), `${name} must not paint with the scope colour ${colour}`);
    }
  }
  // And the ramp itself is disjoint from the scope palette by construction.
  for (const colour of [...tokens.srs.maturity, tokens.srs.s1, tokens.srs.s2, tokens.srs.target, tokens.srs.warn]) {
    assert.ok(!SCOPE_COLOURS.includes(colour), `${colour} is a scope colour and must not be an SRS token`);
  }
});
