import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportComposition } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/**
 * B1 (RULING-report-studio-consolidation R3/R6; REVIEW-report-srcline-and-B1-rulings, both calls confirmed): `composed@3` is
 * `composed@2` with one source line per chart and section from the composition's frozen `sources`, "Largest emissions
 * activities" aggregated (resolver v2), the audit appendix closing Methodology, and a preview that says it is one. Its first
 * render is pinned byte-for-byte; `composed@1/2` keep theirs (`reportComposedRenderer`, `reportComposedV2`), untouched.
 *
 * The fixture (synthetic) is the composed@2 one re-issued under composed@3 with a re-ingested job's shape: per-row factor
 * strings ending in upload file names, a stamp naming its datasets by id, and "Gas" split across two rows.
 */
describe("composed@3: one source line, aggregated activities, the audit appendix (B1)", () => {
  const render = async (composition: ReportComposition, preview = false) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition, preview }));
  };
  const composition = () => JSON.parse(fixture("composition-composed3-whole.json")) as ReportComposition;
  const SUMMARY = "Reviewed snapshot J-j-cur · CEDA GB 2025 · DESNZ GB 2025";
  const perRow = () => (composition().chartBasis?.measurements ?? []).map((row) => row.factorSet);
  const methodology = (html: string) => html.split('<section class="nzr-page">').find((page) => page.includes("<h2>Methodology")) ?? "";

  it("draws a composed@3 report byte-for-byte as pinned", async () => {
    assert.equal(composition().renderer, "composed@3");
    assert.equal(await render(composition()), fixture("composition-composed3-whole.html"));
  });

  it("names its sources once under every chart and section — never a per-row factor string, never an upload file name", async () => {
    const html = await render(composition());
    const charts = html.match(/Source<\/(b|span)>  [^<]*/g) ?? [];
    assert.ok(charts.length >= 6, `every chart has a source line (${charts.length})`);
    for (const line of charts) assert.ok(line.endsWith(`${SUMMARY} · as at 10/10/2026 — derived, not captured`), line);
    const sections = html.match(/<div class="nzr-prov">[^<]*/g) ?? [];
    assert.ok(sections.length >= 3 && sections.every((line) => line.includes(`Source: ${SUMMARY}.`)), "each section's basis names it");
    assert.match(methodology(html), new RegExp(`<td>Factor set</td><td>${SUMMARY}</td>`));
    assert.doesNotMatch(html, /\.csv|\.xlsx/);
    for (const row of perRow()) assert.ok(!html.includes(row), `no per-row string: ${row}`);
  });

  it("draws 'Largest emissions activities' one bar per activity — the two Gas rows are one 10 t bar", async () => {
    const html = await render(composition());
    const start = html.indexOf("Largest emissions activities"), chart = html.slice(start, html.indexOf("</figure>", start));
    assert.deepEqual([...chart.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]), ["Goods: 20 tCO₂e", "Gas: 10 tCO₂e", "Electricity: 5 tCO₂e", "Steel: 4 tCO₂e"]);
  });

  it("closes Methodology with the audit appendix: every row, its factor and dataset by id, its tier — and the total", async () => {
    const page = methodology(await render(composition()));
    assert.match(page, /<h3 class="nzr-h3">Full emissions audit<\/h3>/);
    const body = page.slice(page.indexOf("nzr-audit-tbl"));
    assert.equal((body.match(/<tr>/g) ?? []).length - 2, 5, "five rows, between the header and the total");
    assert.match(body, /<td>Direct emissions<\/td><td>Gas<\/td><td>Works<\/td><td>Natural gas - Gross CV - kWh<\/td><td>DESNZ GB 2025<\/td><td>Measured<\/td><td class="r num">6<\/td>/);
    assert.match(body, /<td>Purchased goods and services<\/td><td>Goods<\/td><td>Organisation-level<\/td><td>Manufacture of goods<\/td><td>CEDA GB 2025<\/td><td>Estimated<\/td>/);
    assert.match(body, /<td colSpan="6">Total<\/td><td class="r num">39<\/td>|<td colspan="6">Total<\/td><td class="r num">39<\/td>/);
  });

  it("a preview says so — on the cover and the Methodology page — and an issued composed@3 states its issue date", async () => {
    const issued = await render(composition()), preview = await render(composition(), true);
    assert.match(issued, /issued 10\/10\/2026/);
    assert.match(methodology(issued), /<td>Issued<\/td><td>2026-10-10<\/td>/);
    assert.doesNotMatch(issued, /not issued/i);
    assert.match(preview, /preview — not issued/);
    assert.match(methodology(preview), /<td>Issued<\/td><td>Not issued — preview<\/td>/);
    assert.doesNotMatch(preview, /issued 10\/10\/2026/);
  });

  it("the fork is the difference: the same composition issued under composed@2 is drawn as composed@2 always drew", async () => {
    const { sources: _sources, audit: _audit, ...rest } = composition();
    const html = await render({ ...rest, renderer: "composed@2" });
    assert.doesNotMatch(html, /derived, not captured|Full emissions audit/);
    assert.ok(perRow().every((row) => html.includes(row)), "composed@2 names the section's frozen factor sets, as issued");
    const asIssued = await render({ ...composition(), renderer: "composed@2" }, true);
    assert.doesNotMatch(asIssued, /derived, not captured|Full emissions audit|not issued/, "composed@2 ignores sources, audit and the preview flag");
  });
});
