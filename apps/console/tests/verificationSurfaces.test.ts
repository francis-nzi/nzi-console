import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { REPORT_ASSURANCE_STATEMENT, reportSectionMetaFor, type ReportComposition } from "@nzi/contracts";

/**
 * NZI offers emissions verification, not assurance (NZC-170): the key surfaces a person reads say "Verification" / "Verified". (`check:terminology`
 * keeps the old words out of the rest; internal names - CrpAssuranceStage, assured_period_snapshots - are not copy and stay.)
 */
(globalThis as { React?: unknown }).React = React;
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, "../../..", path), "utf8");

describe("the report says Verification", () => {
  it("composed@5 heads its Methodology page Verification, draws a Verification basis, and says nothing of assurance of its own", async () => {
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    const composition = JSON.parse(read("apps/console/tests/fixtures/composition-composed5-whole.json")) as ReportComposition;
    const html = renderToStaticMarkup(createElement(ReportComposedView, { composition }));
    assert.match(html, /12 · Verification<\/div><h2 class="r5-h2">Standards, Methodology &amp; Sign-off/);
    assert.match(html, /<span>Verification basis<\/span>/);
    assert.match(html, /this report is <b>not third-party verified<\/b>|not third-party verified/);
    assert.match(html, /in the verification record/);
    // The one "assured" left is the basis statement already stored in this (older) fixture composition - issued text is never rewritten.
    assert.equal((html.match(/assur/gi) ?? []).length, 1);
    assert.match(html, /Reviewed snapshot \(internal review\); not third-party assured/);
  });

  it("a newly built composition states its basis as verification; composed@5/6 head by the Verification table and composed@4 keeps its issued one", () => {
    assert.match(REPORT_ASSURANCE_STATEMENT, /not third-party verified$/);
    assert.equal(reportSectionMetaFor({ renderer: "composed@6" }).methodology.eyebrow, "Verification");
    assert.equal(reportSectionMetaFor({ renderer: "composed@4" }).methodology.eyebrow, "Assurance");
  });
});

describe("the job workspace, the client record and the portal say Verification", () => {
  const stage = read("apps/console/app/jobs/CrpAssuranceStage.tsx");
  it("the Review & QA stage is Data verification: its heading, drawer, tabs, reopen control and messages", () => {
    for (const text of ["Review &amp; QA · Data verification", "Data verification detail", "Data verification views", "Close data verification detail", "Data verification is unavailable",
      "The verification surface is unavailable."]) assert.ok(stage.includes(text), text);
    assert.doesNotMatch(stage, /Data assurance/);
    assert.match(read("apps/console/app/jobs/CrpScopeWorkspace.tsx"), /Verification pathway/);
    assert.match(read("apps/console/app/jobs/CrpWorkspacePanels.tsx"), /Independent verification/);
  });

  it("the portal dashboard reads 'evidence state Verified' and 'Verified figures'; its empty and failed states say verified", () => {
    const dashboard = read("apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx");
    for (const text of ["evidence state <b>Verified</b>", 'aria-label="Verified figures"', "Your first verified report will appear here", "The verified figures could not be confirmed."]) assert.ok(dashboard.includes(text), text);
    assert.match(read("apps/console/app/portal/intensity/PortalIntensity.tsx"), /✓ Verified figures/);
    assert.match(read("apps/console/app/portal/jobs/[jobId]/PortalActionTracker.tsx"), /Engagement data · not verified emissions/);
  });

  it("the client record, the SRS readiness views, the LCA board, the platform page and the portal terms say it too", () => {
    assert.match(read("apps/console/app/clients/[clientId]/OverviewArea.tsx"), /Verified year/);
    assert.match(read("apps/console/app/clients/[clientId]/OverviewArea.tsx"), /<span className="eyebrow">Verification<\/span>/);
    assert.match(read("apps/console/app/lca/LcaBoard.tsx"), /Verification gate/);
    assert.match(read("apps/console/app/platform/PlatformBoard.tsx"), /Tenant verification is awaiting audit evidence/);
    assert.match(read("apps/console/app/portal/portalTermsContent.ts"), /drawn from verified, published report versions/);
    assert.match(read("apps/console/app/reports/page.tsx"), /Verified reporting/);
    assert.match(read("packages/charts/src/SrsLadder.tsx"), /"Advanced", "Verified"\]/);
  });

  it("the routes that raise messages say verification", () => {
    assert.match(read("apps/console/app/api/isolated/jobs/[jobId]/assurance/route.ts"), /Data verification is available only for CRP jobs/);
    assert.match(read("apps/console/app/api/portal/jobs/[jobId]/dashboard/route.ts"), /The verified analytics evidence could not be confirmed/);
  });
});
