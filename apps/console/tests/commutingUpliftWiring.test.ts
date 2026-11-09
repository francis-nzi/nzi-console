import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { portalCommutingRow, previewPortalCommuting } from "../app/portal/data/portalCommutingImport";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Commuting uplift (BRIEF-commuting-uplift-lean): commuters belong to a site, the headcount is entered where the data is, and the
// client never sees the calculation's tCO2e. Wiring only - the arithmetic and the figure that locks are pinned in contracts and the real-DB suite.
describe("commuting uplift wiring", () => {
  const line = previewPortalCommuting("Employee,Commute mode,Distance per year,Distance unit\nA,Rail,1000,km").lines[0]!;
  const factor = { id: "f", factorId: "f", datasetId: "d", datasetVersion: "v", label: "Rail" } as never;

  it("a portal commuter is filed at the site chosen, or at none where the client has no site", () => {
    assert.equal(portalCommutingRow(line, 1, factor, [], "s-leeds").siteId, "s-leeds");
    assert.equal(portalCommutingRow(line, 1, factor, []).siteId, null);
  });

  it("the portal import asks for a site when the client has several, defaults the only one, and blocks Confirm until chosen", () => {
    const source = read("app/portal/PortalCommutingImport.tsx");
    assert.match(source, /useState\(sites\.length === 1 \? sites\[0\]!\.id : ""\)/);
    assert.match(source, /sites\.length > 1 \? <label[^>]*data-commuting-site/);
    assert.match(source, /disabled=\{busy \|\| siteMissing \|\|/);
    assert.match(source, /portalCommutingRow\(line, existingCommuters \+ index \+ 1, factorFor\(line\)!, factors, siteId \|\| null\)/);
  });

  it("the CRM bulk panel files its commuters at a site the same way", () => {
    const source = read("app/jobs/CommutingBulkPanel.tsx");
    assert.match(source, /siteId: siteId \|\| null,/);
    assert.match(source, /Choose the site these commuters work at\./);
  });

  it("the panel is on the job (both drawers) and in the portal's 3.7 category; the portal route sends no tCO2e and no staff identity", () => {
    assert.equal(read("app/jobs/CrpScopeWorkspace.tsx").split('<CommutingUpliftPanel jobId={job.header.id} audience="staff"').length, 3);
    assert.match(read("app/portal/jobs/[jobId]/data/PortalDataView.tsx"), /<CommutingUpliftPanel jobId=\{jobId\} audience="portal"/);
    const route = read("app/api/portal/jobs/[jobId]/commuting-uplift/route.ts");
    assert.match(route, /sampledTco2e: _sampled, upliftedTco2e: _uplifted, savedBy: _by/);
    assert.match(route, /savePortalSiteHeadcount/);
    assert.match(read("app/api/isolated/jobs/[jobId]/commuting-uplift/route.ts"), /requireCommandPrincipal\(request, "job\.site\.headcount\.set"\)/);
  });

  it("the panel shows tCO2e to staff only, and says why a site cannot be scaled", () => {
    const source = read("app/jobs/CommutingUpliftPanel.tsx");
    assert.match(source, /audience === "staff" && site\.sampledTco2e !== undefined/);
    assert.match(source, /No commuting rows at this site yet/);
    assert.match(source, /disabled=\{locked \|\| !site\.available\}/);
  });
});
