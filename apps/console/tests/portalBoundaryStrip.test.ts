import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOUNDARY_SITES_INLINE_MAX, PortalBoundaryStrip } from "../app/portal/PortalBoundaryStrip";

/**
 * The portal job header's boundary summary (RULING-portal-setup-replacement): the reporting period and the included sites by name,
 * read-only. Replaces the removed "Setup" profile key; it is a mirror of what staff set in the CRM, not a place to change it.
 */
const render = (boundary: { reportingFrom: string | null; reportingTo: string | null; siteNames: string[] }) => renderToStaticMarkup(createElement(PortalBoundaryStrip, { boundary }));

describe("the portal job header's boundary summary", () => {
  it("shows the period as dates and a few sites as a plain list of names", () => {
    const html = render({ reportingFrom: "2025-04-01", reportingTo: "2026-03-31", siteNames: ["Head Office", "Depot"] });
    assert.match(html, /Reporting period<\/dt><dd>01\/04\/2025 – 31\/03\/2026<\/dd>/, "dd/mm/yyyy, the product's one date format (NZC-040)");
    assert.match(html, /Sites in boundary/);
    assert.match(html, /<li>Head Office<\/li><li>Depot<\/li>/);
    assert.doesNotMatch(html, /<details/);
  });

  it("past the inline limit shows the count with the names behind a disclosure", () => {
    const names = Array.from({ length: BOUNDARY_SITES_INLINE_MAX + 1 }, (_, index) => `Site ${index + 1}`);
    const html = render({ reportingFrom: "2026-01-01", reportingTo: "2026-12-31", siteNames: names });
    assert.match(html, new RegExp(`<details><summary>${names.length} sites</summary>`));
    for (const name of names) assert.ok(html.includes(`<li>${name}</li>`), name);
  });

  it("says plainly when nothing is set yet, rather than drawing a blank or a zero", () => {
    const html = render({ reportingFrom: null, reportingTo: null, siteNames: [] });
    assert.match(html, /Not set yet/);
    assert.match(html, /None set yet/);
  });

  it("is read-only: no control, no link, no field — and no edit path in the header", () => {
    const html = render({ reportingFrom: "2026-01-01", reportingTo: "2026-12-31", siteNames: ["Head Office"] });
    assert.doesNotMatch(html, /<(button|input|select|textarea|a)[\s>]/);
    const source = readFileSync(resolve(__dirname, "../app/portal/PortalBoundaryStrip.tsx"), "utf8");
    assert.doesNotMatch(source, /fetch\(|postBrowserCommand|putBrowserCommand|useState/);
  });

  it("is drawn in the Data page's header from the data-view read — the one portal read path, no route of its own", () => {
    const view = readFileSync(resolve(__dirname, "../app/portal/jobs/[jobId]/data/PortalDataView.tsx"), "utf8");
    assert.match(view, /<PortalBoundaryStrip boundary=\{view\.boundary\} \/>/);
    const capture = readFileSync(resolve(__dirname, "../../../packages/isolated-backend/src/portalCapture.ts"), "utf8");
    assert.match(capture, /siteNames: sites\.filter\(\(site\) => site\.included !== false\)\.map\(\(site\) => site\.name\)/, "included sites, names only");
  });
});
