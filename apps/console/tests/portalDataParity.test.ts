import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JobEmissions } from "@nzi/isolated-backend";

/**
 * BUILD-portal-data-crm-parity, increment 1: the client's logo in the shell (R5) and the CRM's own totals band in the portal
 * Data view (R2) — the same component as the CRM's, over the rows the client sees (proved against a real database in
 * `portalPreviewJobsReal`), narrowed by site, tCO₂e only, dark by absence with the shell.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const emissions: JobEmissions = {
  jobId: "j", siteId: null, headline: { tco2e: 45.9, marketTco2e: 0, entries: 3, marketEntries: 0 },
  byScope: [{ scope: "1", tco2e: 45.9, marketTco2e: 0, entries: 3, marketEntries: 0 }], byCategory: [], bySite: [],
};

describe("the portal Data view at CRM parity — increment 1", () => {
  it("R2: the band is the CRM's own EmissionsSummary, reading the portal's route, behind the shell flag", () => {
    const view = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(view, /import \{ EmissionsSummary \} from "\.\.\/\.\.\/\.\.\/\.\.\/jobs\/EmissionsSummary";/, "the CRM's component, not a portal copy");
    assert.match(view, /const crmParity = portalFeatureEnabled\("portal-shell"\);/);
    assert.match(view, /\{crmParity \? <>\s*<EmissionsSummary jobId=\{jobId\} siteId=\{siteId \|\| null\} siteLabel=\{site\?\.name \?\? "All sites"\} initial=\{view\.emissions\}\s*emissionsUrl=\{`\$\{base\}\/emissions`\}/);
    // The CRM keeps its own read: the new prop defaults to the staff route.
    assert.match(read("apps/console/app/jobs/EmissionsSummary.tsx"), /emissionsUrl = staffEmissionsUrl\(jobId\)/);
  });

  it("R2: tCO₂e only — the band draws no money, whatever it is given", async () => {
    const { EmissionsSummary } = await import("../app/jobs/EmissionsSummary");
    const html = renderToStaticMarkup(createElement(EmissionsSummary, { jobId: "j", siteId: null, siteLabel: "All sites", initial: emissions, emissionsUrl: "/api/portal/jobs/j/emissions", liveLabel: "Read-only preview" }));
    assert.match(html, /45\.9/);
    assert.match(html, /All sites · total emissions/);
    assert.match(html, /Read-only preview/);
    assert.doesNotMatch(html, /[£$€]|GBP|USD|EUR|price|spend/i, "no money (NZC-120)");
  });

  it("R2: the portal's band route and its preview mirror are GET only, on the right session, over the gated read", () => {
    const portal = read("apps/console/app/api/portal/jobs/[jobId]/emissions/route.ts");
    assert.match(portal, /const user = await currentPortalUserForData\(request\);/);
    assert.match(portal, /getPortalJobEmissions\(isolatedPool\(\), user, jobId, siteId\)/);
    const preview = read("apps/console/app/api/isolated/clients/[clientId]/portal-preview/jobs/[jobId]/emissions/route.ts");
    assert.match(preview, /getPortalJobEmissionsForStaff\(isolatedPool\(\), principal, clientId, jobId, siteId\)/);
    for (const route of [portal, preview]) assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.match(read("apps/console/app/portal/data/portalDataView.ts"), /!!view\.emissions && typeof view\.emissions\.headline\?\.tco2e === "number"/, "drawn only from a verified read");
  });

  it("R3 (increment 2): the CRM's own site tabs replace the dropdown — the job's included sites, counted from the band's all-sites read", async () => {
    const view = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(view, /import \{ JobSiteTabs \} from "\.\.\/\.\.\/\.\.\/\.\.\/jobs\/JobSiteTabs";/, "the CRM's component");
    assert.match(view, /<JobSiteTabs sites=\{view\.sites\} emissions=\{view\.emissions\} selected=\{siteId \|\| null\} onSelect=\{\(next\) => setSiteId\(next \?\? ""\)\} \/>/);
    assert.match(view, /\{crmParity \? null : \(\s*<label className="nz-pdv-site">Site/, "the dropdown only while the shell is off");
    const { JobSiteTabs } = await import("../app/jobs/JobSiteTabs");
    const html = renderToStaticMarkup(createElement(JobSiteTabs, {
      sites: [{ id: "s-a", name: "Bristol bakery" }, { id: "s-b", name: "Avonmouth depot" }],
      emissions: { ...emissions, bySite: [{ siteId: "s-a", tco2e: 32.8, marketTco2e: 0, entries: 2, marketEntries: 0 }, { siteId: null, tco2e: 1.6, marketTco2e: 0, entries: 1, marketEntries: 0 }] },
      selected: "s-a", onSelect: () => undefined,
    }));
    assert.match(html, /aria-selected="true" class="nz-site-tab on"><span class="nz-site-tab-name">Bristol bakery<\/span><span class="nz-site-tab-count tnum" aria-label="2 entries">2</);
    assert.match(html, />All sites<\/span><span class="nz-site-tab-count tnum" aria-label="3 entries">3</, "All sites counts every row, whichever tab is chosen");
    assert.match(html, />Avonmouth depot<\/span><span class="nz-site-tab-count tnum" aria-label="0 entries">0</, "an empty site is still offered");
  });

  it("R5: the preview's shell shows the client's own logo, versioned by asset; none, the monogram", () => {
    const frame = read("apps/console/app/clients/[clientId]/portal-preview/PreviewFrame.tsx");
    assert.match(frame, /client\.logoAssetId \? `\/api\/isolated\/clients\/\$\{encodeURIComponent\(client\.id\)\}\/logo\?v=\$\{encodeURIComponent\(client\.logoAssetId\)\}` : null/);
    assert.match(frame, /logoSrc: previewClientLogoSrc\(preview\.client\)/);
    // The client portal's shell already uses the client's own logo route.
    assert.match(read("apps/console/app/portal/shell/PortalShellClient.tsx"), /logoSrc: user\.clientLogoAssetId \? `\/api\/portal\/logo\?v=/);
  });
});
