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

  describe("R4 (increment 3): the row drawer at CRM parity, gated by the profile", () => {
    const profileOf = (decisions: Array<{ profileKey: string; value: string }>) => import("@nzi/contracts").then(({ offeredPortalProfile, resolvePortalProfile }) => offeredPortalProfile(resolvePortalProfile(decisions)));
    const drawer = async (decisions: Array<{ profileKey: string; value: string }>, readOnly = false) => {
      process.env.NEXT_PUBLIC_FEATURE_PORTAL = "portal-shell,portal-data";
      const [{ PortalRowDrawer }, { PreviewSurfaceProvider }, profile] = await Promise.all([
        import("../app/portal/jobs/[jobId]/data/PortalDataView"), import("../app/portal/portalSurface"), profileOf(decisions)]);
      const row = { id: "r1", jobId: "j", scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Bakery boiler gas", reportLabel: "Bakery boiler gas", categoryPath: ["Scope 1", "Natural Gas"],
        quantity: 182000, unit: "kWh", datasetId: "ds", factorId: "gas-demo", factorVersion: "v1", factorLabel: "Natural gas", qualityTier: null, dataConfidence: null,
        calculatedTco2e: 32.76, overrideTco2e: null, overrideReason: null, reviewStatus: "pending", version: 2, enabled: true, siteId: "s-a", siteLabel: "Bristol bakery",
        monthlyActivity: [], provenance: { capturedAt: "2026-10-22T09:00:00.000Z", capturedAs: "staff" }, lineage: [{ title: "Calculated", detail: "182,000 kWh × factor" }], editable: false, origin: "live" };
      const view = { profile, access: null, emissions, categories: { audience: "portal", includedScopes: ["1"], categories: [] }, rows: [row], factors: [], sites: [], purchasedGoodsCategories: [], reportingMonths: [] };
      const element = createElement(PortalRowDrawer, { jobId: "j", row: row as never, view: view as never, specs: {}, refs: [], open: true, adviser: "Your adviser", adviserInline: "your adviser", onSaved: async () => undefined });
      return renderToStaticMarkup(readOnly ? createElement(PreviewSurfaceProvider, { clientId: "c", children: element }) : element);
    };
    const titles = (html: string) => [...html.matchAll(/class="t">([^<]+)</g)].map((match) => match[1]!.replace("&amp;", "&"));

    it("the CRM's frame: its calculation banner and seven key fields, read-only — never Calculate, Review or a snapshot", async () => {
      const html = await drawer([{ profileKey: "entryDrawer", value: "detailed" }]);
      assert.match(html, /data-crm-parity=""/);
      assert.match(html, /class="nz-rd-keys"/);
      for (const key of ["Site", "Scope", "Category", "Report label", "Quantity", "UoM", "tCO₂e"]) assert.match(html, new RegExp(`<span class="l">${key}</span>`), key);
      assert.doesNotMatch(html, /class="kv edit"|<input/, "the key fields are read-only for the client");
      assert.match(html, /Calculated — waiting for your adviser&#x27;s review\./);
      assert.doesNotMatch(html, /Save &amp; calculate|Approve row|>Reject<|reviewed snapshot|Override tCO|Reviewer note/i, "no staff action (R4)");
    });

    it("detailed: each of the four sections the profile offers, with the CRM's titles; Apportionment & site and Monthly activity always; History by its one footer button", async () => {
      const html = await drawer([{ profileKey: "entryDrawer", value: "detailed" }, { profileKey: "evidenceProvenance", value: "visible" }, { profileKey: "factorCalculation", value: "visible" }, { profileKey: "dataQuality", value: "visible" }, { profileKey: "sourceDetail", value: "visible" }]);
      const all = titles(html);
      assert.deepEqual(all, ["Factor & calculation", "Data quality", "Apportionment & site", all.find((title) => !["Factor & calculation", "Data quality", "Apportionment & site", "Monthly activity", "Evidence & provenance"].includes(title))!, "Monthly activity", "Evidence & provenance"]);
      // Polish fix 2: one History control — the CRM's footer button, closed to start; no second History header.
      assert.equal((html.match(/>History</g) ?? []).length, 1, "History appears once");
      assert.match(html, /<div class="nz-rd-foot"><button type="button" class="nz-btn" aria-expanded="false">History<\/button><\/div>/);
      const none = titles(await drawer([{ profileKey: "entryDrawer", value: "detailed" }, { profileKey: "evidenceProvenance", value: "hidden" }, { profileKey: "factorCalculation", value: "hidden" }, { profileKey: "dataQuality", value: "hidden" }, { profileKey: "sourceDetail", value: "hidden" }]));
      assert.deepEqual(none, ["Apportionment & site", "Monthly activity"], "a hidden section is simply absent");
      const simple = titles(await drawer([{ profileKey: "entryDrawer", value: "simple" }, { profileKey: "factorCalculation", value: "visible" }]));
      assert.deepEqual(simple, ["Apportionment & site", "Monthly activity"], "the simple drawer carries none of the four (phase 2, settled)");
    });

    it("no staff identity in the drawer, and none of it in preview can act", async () => {
      const html = await drawer([{ profileKey: "entryDrawer", value: "detailed" }, { profileKey: "evidenceProvenance", value: "visible" }, { profileKey: "deactivate", value: "enabled" }], true);
      assert.ok(titles(html).includes("Evidence & provenance"));
      assert.doesNotMatch(html, /reviewedBy|Approved by|capturedBy/);
      // The section's body mounts on open: its review line is the status only — never who reviewed.
      const source = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
      assert.match(source, /<div className="nz-sect">Independent review<\/div>\s*<div className=\{`nz-banner \$\{row\.reviewStatus === "approved" \? "ok" : "warn"\}`\}>\{reviewLabel\(row\)\}<\/div>/);
      assert.doesNotMatch(html, /<textarea|>Deactivate<|<form/, "read-only in preview");
      assert.match(html, /Read-only preview\./);
    });
  });

  it("R4: the drawers open as the CRM's do — the right-hand overlay — while the shell is on", () => {
    const view = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(view, /const drawerClass = crmParity \? "nz-site-drawer nz-pdv-drawer" : "nz-pdv-drawer";/);
    assert.equal((view.match(/className=\{drawerClass\}/g) ?? []).length, 2, "the add drawer and the row drawer");
  });

  it("R4: the CRM's own Editor draws through the same frame (one layout, two drawers)", () => {
    const crm = read("apps/console/app/jobs/CrpScopeWorkspace.tsx");
    assert.match(crm, /import \{ RowCalcBanner, RowKeyFields \} from "\.\/RowDrawerFrame";/);
    assert.match(crm, /<RowKeyFields siteLabel=\{value\.siteLabel \?\? null\}[\s\S]*?quantity=\{\{ edit: <input className="nz-inp" type="number"/);
  });

  it("R5: the preview's shell shows the client's own logo, versioned by asset; none, the monogram", () => {
    const frame = read("apps/console/app/clients/[clientId]/portal-preview/PreviewFrame.tsx");
    assert.match(frame, /client\.logoAssetId \? `\/api\/isolated\/clients\/\$\{encodeURIComponent\(client\.id\)\}\/logo\?v=\$\{encodeURIComponent\(client\.logoAssetId\)\}` : null/);
    assert.match(frame, /logoSrc: previewClientLogoSrc\(preview\.client\)/);
    // The client portal's shell already uses the client's own logo route.
    assert.match(read("apps/console/app/portal/shell/PortalShellClient.tsx"), /logoSrc: user\.clientLogoAssetId \? `\/api\/portal\/logo\?v=/);
  });
});
