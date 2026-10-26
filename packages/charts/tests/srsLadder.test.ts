import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SRS_LADDER, SrsDial, SrsHeatmap, SrsMeter, SrsPillarTable, SrsRadar, SrsScaleKey, SrsTrend, srsFill, srsStepOf, tokens } from "../src/index";

/**
 * SRS S2's ladder graphics: one validated ordinal ramp on every dial, ring, meter and cell; the number and step name
 * always beside the colour; at most two shapes on the radar; a provisional draft hatched and dashed; a hover layer and a
 * text equivalent on every plot.
 */

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

test("one ramp, the tokens' own, monotone light→dark in light mode and dark→light in dark mode", () => {
  assert.deepEqual([...tokens.srs.maturity], [...SRS_LADDER.light.ramp], "the token ramp is the validated ladder");
  assert.deepEqual([...tokens.srs.maturityInk], [...SRS_LADDER.light.ink]);
  const light = SRS_LADDER.light.ramp.map(luminance);
  const dark = SRS_LADDER.dark.ramp.map(luminance);
  for (let step = 1; step < 5; step += 1) {
    assert.ok(light[step]! < light[step - 1]!, `light step ${step} is darker than ${step - 1}`);
    assert.ok(dark[step]! > dark[step - 1]!, `dark step ${step} is lighter than ${step - 1} (more salient on the dark surface)`);
  }
  // The scope palette means scope — never maturity.
  for (const scope of ["#FF5C48", "#FFC24B", "#0BA75E"]) assert.ok(![...SRS_LADDER.light.ramp, ...SRS_LADDER.dark.ramp].includes(scope as never));
});

test("every step's label ink is legible on its fill (≥ 4.5:1), in both modes", () => {
  for (const mode of ["light", "dark"] as const) {
    SRS_LADDER[mode].ramp.forEach((fill, step) => {
      assert.ok(contrast(fill, SRS_LADDER[mode].ink[step]!) >= 4.5, `${mode} step ${step}: ${contrast(fill, SRS_LADDER[mode].ink[step]!).toFixed(2)}`);
    });
  }
});

test("a colour names the step reached — the floor", () => {
  assert.equal(srsStepOf(2.99), 2);
  assert.equal(srsFill(2.99), SRS_LADDER.light.ramp[2]);
  assert.equal(srsFill(9), SRS_LADDER.light.ramp[4], "clamped to the ladder");
  assert.equal(srsFill(Number.NaN), SRS_LADDER.light.ramp[0]);
});

test("the dial prints the number and the step name in its centre, with a hover layer and an accessible summary", () => {
  const svg = html(createElement(SrsDial, { label: "Governance", level: 2.6, stepName: "Established", target: 3 }));
  assert.match(svg, />2\.6</);
  assert.match(svg, />Established</);
  assert.match(svg, /aria-label="Governance: 2\.6 of 4 · Established · target 3"/);
  assert.match(svg, /class="nzs-hit"[^>]*tabindex="0"/);
  assert.match(svg, /class="nzs-tip"/);
  assert.ok(svg.includes(SRS_LADDER.light.ramp[2]), "the arc wears the step reached");
  assert.doesNotMatch(svg, /pattern/, "a completed assessment is not hatched");
});

test("a provisional dial, meter, radar and heatmap are hatched and say so", () => {
  const dial = html(createElement(SrsDial, { label: "Strategy", level: 1.5, stepName: "Developing", provisional: true }));
  assert.match(dial, /<pattern/);
  assert.match(dial, /provisional · of 4/);
  const meter = html(createElement(SrsMeter, { rows: [{ label: "Strategy", level: 1.5, stepName: "Developing" }], provisional: true }));
  assert.match(meter, /<pattern/);
  assert.match(meter, /stroke-dasharray="3 2"/);
  const radar = html(createElement(SrsRadar, { axes: [{ label: "A", value: 1 }, { label: "B", value: 2 }, { label: "C", value: 3 }, { label: "D", value: 0 }], seriesLabel: "Client", provisional: true }));
  assert.match(radar, /stroke-dasharray="5 3"/);
  assert.match(radar, /\(provisional\)/);
  const heat = html(createElement(SrsHeatmap, { provisional: true, columns: [{ label: "Gov", cells: [{ code: "G1", title: "Board", maturity: 2, stepName: "Established", target: 3 }] }] }));
  assert.match(heat, /<pattern/);
  assert.match(heat, /provisional/);
});

test("the radar draws at most two shapes — the client and the target — and labels every vertex", () => {
  const axes = [
    { label: "Governance", value: 3, target: 3 }, { label: "Strategy", value: 2, target: 3 },
    { label: "Risk mgmt", value: 1.5, target: 3 }, { label: "Metrics", value: 2.25, target: 4 },
  ];
  const svg = html(createElement(SrsRadar, { axes, seriesLabel: "Client A" }));
  // Four ring polygons (one per step 1–4) + at most two data shapes.
  const polygons = svg.match(/<polygon/g)?.length ?? 0;
  assert.equal(polygons, 4 + 2);
  for (const value of ["3.0", "2.0", "1.5", "2.3"]) assert.match(svg, new RegExp(`>${value.replace(".", "\\.")}<`), value);
  for (const step of ["1", "2", "3", "4"]) assert.match(svg, new RegExp(`>${step}</text>`), `ring ${step} is labelled`);
  assert.match(svg, />Client A</);
  assert.match(svg, />Target</);
  const noTarget = html(createElement(SrsRadar, { axes: axes.map(({ label, value }) => ({ label, value })), seriesLabel: "Client A" }));
  assert.equal(noTarget.match(/<polygon/g)?.length ?? 0, 4 + 1, "no target, one shape");
});

test("the heatmap prints each cell's number, marks unanswered as '–' (not zero), and notches a gap", () => {
  const svg = html(createElement(SrsHeatmap, { columns: [
    { label: "Governance", cells: [
      { code: "G1", title: "Board oversight", maturity: 4, stepName: "Assured", target: 3, detail: ["Owner: Ada"] },
      { code: "G2", title: "Skills", maturity: 1, stepName: "Developing", target: 3 },
      { code: "G3", title: "Unanswered", maturity: null, stepName: null, target: 2 },
    ] },
  ] }));
  assert.match(svg, />4</);
  assert.match(svg, />1</);
  assert.match(svg, />–</);
  assert.match(svg, /Not yet answered · target 2/);
  assert.match(svg, /Owner: Ada/, "staff detail rides on the hover where it is given");
  assert.equal(svg.match(/<path d="M/g)?.length ?? 0, 2, "two below target — the gap and the unanswered — each notched");
  assert.ok(svg.includes(`fill="${SRS_LADDER.light.ramp[4]}"`));
});

test("the trend: one assessment is one point and no line; two are a line on the same 0–4 axis", () => {
  const one = html(createElement(SrsTrend, { title: "Overall", points: [{ label: "1 Mar 2026", level: 1.2 }] }));
  assert.doesNotMatch(one, /<polyline/);
  assert.match(one, />1\.2</);
  const two = html(createElement(SrsTrend, { title: "Overall", points: [{ label: "Mar", level: 1.2 }, { label: "Jun", level: 2.1 }] }));
  assert.match(two, /<polyline/);
  assert.match(two, />4 Assured</, "the axis names the steps");
  const none = html(createElement(SrsTrend, { title: "Overall", points: [] }));
  assert.match(none, /No completed assessment yet/);
});

test("the scale key and the pillar table carry the numbers and names beside the colour", () => {
  const key = html(createElement(SrsScaleKey, { ladder: [{ level: 0, name: "Not started" }, { level: 4, name: "Assured" }], provisional: true }));
  assert.match(key, />0<\/span>Not started/);
  assert.match(key, /Provisional — in progress, not yet assessed/);
  const table = html(createElement(SrsPillarTable, { caption: "By pillar", rows: [{ label: "Governance", level: 2.6, stepName: "Established", target: 3, delta: 0.4 }] }));
  assert.match(table, /<td class="num">2\.6<\/td><td>2 · Established<\/td><td class="num">3<\/td><td class="num">\+0\.4<\/td>/);
});

test("the hover layer is painted last, so no later mark covers a tooltip", () => {
  const heat = html(createElement(SrsHeatmap, { columns: ["A", "B", "C"].map((label) => ({ label, cells: [{ code: `${label}1`, title: "T", maturity: 1, stepName: "Developing", target: 3 }] })) }));
  const meter = html(createElement(SrsMeter, { rows: [{ label: "A", level: 1, stepName: "Developing" }, { label: "B", level: 2, stepName: "Established" }] }));
  const radar = html(createElement(SrsRadar, { axes: ["A", "B", "C", "D"].map((label) => ({ label, value: 2, target: 3 })), seriesLabel: "Client" }));
  const trend = html(createElement(SrsTrend, { title: "T", points: [{ label: "Mar", level: 1 }, { label: "Jun", level: 2 }] }));
  for (const [name, svg, lastMark] of [["heatmap", heat, ">C1<"], ["meter", meter, ">B<"], ["radar", radar, ">Target<"], ["trend", trend, ">Jun<"]] as const) {
    assert.ok(svg.indexOf(`class="nzs-hit"`) > svg.indexOf(lastMark) && svg.indexOf(lastMark) > 0, `${name}: every hit area and tip comes after the marks`);
  }
});

test("dark mode renders its own steps, not a flip of the light ones", () => {
  const dark = html(createElement(SrsDial, { label: "Governance", level: 3, stepName: "Advanced", mode: "dark" }));
  assert.ok(dark.includes(SRS_LADDER.dark.ramp[3]));
  assert.ok(!dark.includes(SRS_LADDER.light.ramp[3]));
});
