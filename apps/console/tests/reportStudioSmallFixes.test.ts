import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { reportScopeChoices } from "@nzi/contracts";
(globalThis as { React?: unknown }).React = React;
/* eslint-disable @typescript-eslint/no-require-imports */
const { ReportScopeSelector } = require("../app/report-preview/ReportScopeSelector") as typeof import("../app/report-preview/ReportScopeSelector");
const { buildStudioPagedCss, buildStudioPrintCss, studioPrintMark, STUDIO_R5_PAGED_RULES } = require("../app/jobs/[jobId]/report/studioPrint") as typeof import("../app/jobs/[jobId]/report/studioPrint");

// DESIGN-report-studio-small-fixes A, B (the selector), D (draft print + Page · A4). C and the client-edit colour wait on B2-4.
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");
const read = (path: string) => readFileSync(join(APP, path), "utf8");
const studio = read("jobs/[jobId]/report/ReportStudio.tsx");
const paged = read("jobs/[jobId]/report/StudioPagedView.tsx");

const snapshot = { provenance: { boundary: { siteIds: ["s-uk", "v7-site-375"] } }, measurements: [{ siteId: "s-uk", siteLabel: "UK Office", tco2e: 10 }] };
const draw = (scope: { kind: "whole" } | { kind: "sites"; siteIds: string[] }, names = new Map([["v7-site-375", "Dubai Office"]])) =>
  renderToStaticMarkup(createElement(ReportScopeSelector, { choices: reportScopeChoices(snapshot, names), scope, onChange: () => {} }));

describe("A — the site filter is called Sites, not Scope", () => {
  it("labels the selector Sites — Scope means GHG Scope 1/2/3 — and keeps Whole client / By site", () => {
    const html = draw({ kind: "whole" });
    assert.match(html, /<span class="nz-eyebrow">Sites<\/span>/);
    assert.match(html, /role="group" aria-label="Report sites"/);
    assert.match(html, />Whole client<\/button>/);
    assert.match(html, />By site<\/button>/);
    assert.doesNotMatch(html, />Scope</);
  });

  it("labels the fixed control on a validated or published version Sites too, with the whole-client hint", () => {
    assert.match(studio, /<span className="nzs-ctl-label">Sites<\/span>/);
    assert.match(studio, /title="The sites are fixed when the version is validated"/);
    assert.match(studio, /\{whole \? "Whole client · all sites" : version\?\.scopeLabel\}/);
    assert.doesNotMatch(studio, /nzs-ctl-label">Scope</);
  });
});

describe("B — the selector names each site, never by its id", () => {
  it("draws a migrated boundary site's chip by the client's site name", () => {
    const html = draw({ kind: "sites", siteIds: ["s-uk", "v7-site-375"] });
    assert.match(html, /<i aria-hidden="true"><\/i>Dubai Office <small/);
    assert.match(html, /<i aria-hidden="true"><\/i>UK Office <small/);
    assert.doesNotMatch(html, />v7-site-375 </);
  });

  it("the draft passes the client's site names to the choices, as the composition reads them", () => {
    const backend = readFileSync(join(APP, "../../../packages/isolated-backend/src/reportDraftComposition.ts"), "utf8");
    assert.match(backend, /scopeChoices: reportScopeChoices\(snapshot\.payload_json as never, new Map\(\(await db\.query<\{ site_id: string; name: string \}>\(\n\s+`SELECT site_id, name FROM nzi_console\.client_sites WHERE client_id = \$1`, \[snapshot\.client_id\]\)\)/);
  });
});

describe("D — a draft prints and previews exactly what is on screen, marked as not issued", () => {
  it("marks a draft DRAFT and a validated preview PREVIEW on every page; a published version is the issued one, unmarked", () => {
    assert.equal(studioPrintMark("draft"), "DRAFT — not validated, not issued");
    assert.equal(studioPrintMark("validated"), "PREVIEW — validated, not issued");
    assert.equal(studioPrintMark("published"), null);
    const css = buildStudioPrintCss({ client: "Acme \"Ltd\"", title: "Carbon Reduction Plan 2025", mark: studioPrintMark("draft") });
    assert.match(css, /@top-right\{content:"DRAFT — not validated, not issued";[^}]*\}/);
    assert.match(css, /@page :first\{@top-left\{content:none\}@bottom-left\{content:none\}@bottom-right\{content:none\}\}/, "the cover drops the running head and foot, not the mark");
    assert.match(css, /@top-left\{content:"Acme \\"Ltd\\" · Carbon Reduction Plan 2025"/, "escaped");
    assert.match(css, /@bottom-right\{content:"Page " counter\(page\) " of " counter\(pages\)/);
  });

  it("the preview and the PDF are built from one rule set; print uses the document, never the paged copy", () => {
    const meta = { client: "Acme", title: "Carbon Reduction Plan 2025", mark: null };
    assert.ok(buildStudioPagedCss(meta).includes(STUDIO_R5_PAGED_RULES));
    const print = buildStudioPrintCss(meta);
    assert.ok(print.includes(`@media print{${STUDIO_R5_PAGED_RULES}`));
    assert.match(print, /\.nzs-paged\{display:none!important\}\.nzs-paged-source\{display:block!important\}/);
    assert.doesNotMatch(print, /@top-right/, "no mark when there is none to make");
  });

  it("prints the document alone: no console chrome, no on-screen band (every page is marked), no blank last page", () => {
    const print = buildStudioPrintCss({ client: "Acme", title: "Carbon Reduction Plan 2025", mark: studioPrintMark("draft") });
    assert.match(print, /\.nz-rail,\.nz-topbar,\.nz-skip-link,\.nzs-subnav,\[data-report-draft\],\[data-report-preview\]\{display:none!important\}/);
    // composed@5's own print rule breaks after every sheet, the last included; the studio starts each section instead.
    assert.match(STUDIO_R5_PAGED_RULES, /\.nzr5 \.r5-page\{[^}]*break-before:page;break-after:auto!important;/);
  });

  it("prints on paper, inside the page: no grey ground under the sections, no screen-width margin past the edge", () => {
    // The browser proof is the capture gate's studio-print spec; these pin the two rules it rests on.
    const print = buildStudioPrintCss({ client: "Acme", title: "Carbon Reduction Plan 2025", mark: studioPrintMark("draft") });
    assert.match(print, /@media print\{[^]*html,body\{background:#fff!important\}/, "the console's ground is not printed");
    assert.match(print, /@media print\{[^]*\.nzs-studio\{margin:0!important;background:none!important\}\}$/, "the studio frame keeps no margin");
    // A printed A4 page is ~680–794px wide: any studio max-width query must be screen-only, or it lays the PDF out too.
    const studioCss = read("jobs/[jobId]/report/report-studio.css");
    const queries = [...studioCss.matchAll(/@media([^{]*)\{/g)].map((match) => match[1]!.trim());
    assert.ok(queries.length > 0);
    for (const query of queries.filter((query) => /max-width/.test(query))) assert.match(query, /^screen and /, `"@media ${query}" applies in print`);
  });

  it("Page · A4 repeats a continued table's header, as print does — only inside the studio's composed@5 document", () => {
    assert.match(paged, /export function repeatingTableHeaders\(Handler: typeof import\("pagedjs"\)\.Handler\)/);
    assert.match(paged, /if \(!headersRegistered\) \{ registerHandlers\(repeatingTableHeaders\(Handler\)\); headersRegistered = true; \}/);
    assert.match(paged, /!table\.closest\("\.nzr5"\)/, "never the issued report's own Page view");
    assert.match(paged, /table\.insertBefore\(header\.cloneNode\(true\), table\.firstChild\)/);
  });

  it("strips screen-only provenance chrome in print — the template pill, the header note, the token chip — keeping the figures", () => {
    assert.match(STUDIO_R5_PAGED_RULES, /\.nzr5 \.r5-spill,\.nzr5 \.r5-thead-note\{display:none!important\}/);
    assert.match(STUDIO_R5_PAGED_RULES, /\.nzr5 \.r5-tok\{background:none!important;border:0!important;padding:0!important;color:inherit!important\}/);
    assert.doesNotMatch(STUDIO_R5_PAGED_RULES, /\.r5-tok\{display:none/);
  });

  it("offers Print / Save as PDF on a draft or validated preview only, and its stylesheet only then", () => {
    assert.match(studio, /const printable = kind !== "published";/);
    assert.match(studio, /\{printable \? <button type="button" className="nz-btn" data-studio-print onClick=\{\(\) => window\.print\(\)\}/);
    assert.match(studio, /\{printable \? <style data-studio-print-css>\{buildStudioPrintCss\(printMeta\)\}<\/style> : null\}/);
    assert.match(studio, /mark: studioPrintMark\(kind\)/);
    // The issued report keeps its own immutable print, untouched.
    assert.match(read("reports/[versionId]/PrintButton.tsx"), /<small>Current immutable version<\/small>/);
  });

  it("Page · A4 for composed@5 is Paged.js over the flow document; older renderers keep their view", () => {
    // B2-4: composed@6 is composed@5 drawing its frozen narrative — the same document, so it pages the same way.
    assert.match(studio, /const paged = drawsMockupDocument\(composition\);/);
    assert.match(studio, /<div className="nzs-paged-source" ref=\{flowSource\} hidden=\{mode === "page"\}>\n\s+<ReportComposedView composition=\{composition\} preview=\{kind !== "published"\} mode="flow" narrativeEditor=\{narrativeEditor\} \/>/);
    assert.match(studio, /\{mode === "page" \? <StudioPagedView source=\{flowSource\} css=\{buildStudioPagedCss\(printMeta\)\} readKey=\{composition\} \/> : null\}/);
    assert.match(studio, /: <ReportComposedView composition=\{composition\} preview=\{kind !== "published"\} mode=\{mode\} \/>\}/);
    // A copy is paginated; the renderer's own markup is never changed, and a failure is said, not hidden.
    assert.match(paged, /const copy = document\.cloneNode\(true\) as HTMLElement;/);
    assert.match(paged, /await import\("pagedjs"\)/);
    assert.match(paged, /<b>Page view is unavailable<\/b>/);
  });

  it("the rail goes to the copy of a section that is on screen", () => {
    assert.match(studio, /const visible = <T extends HTMLElement>\(nodes: NodeListOf<T> \| T\[\]\) => Array\.from\(nodes\)\.find\(\(node\) => node\.offsetParent !== null\) \?\? null;/);
  });
});
