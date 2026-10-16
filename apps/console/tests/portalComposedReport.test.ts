import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clientFacingComposition, defaultReportSectionPlan, type ClientFacingPublishedCrpReport, type ReportComposition } from "@nzi/contracts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * F-4b (RULING-reporting-F4; the high-stakes check): with exclusion on, a section the issuer left out is **absent on the console
 * report and on the client's portal, and stated on the Methodology page** — rendered here from one frozen composition on both
 * surfaces. The client's copy carries no reviewer (and so no "Reviewed by" line). A composed version is never drawn from the
 * snapshot; a version issued before compositions keeps its labelled snapshot render; an unreadable one draws nothing.
 * The real-database half — the frozen plan reaching the portal read, and no staff identity in what the client is sent — is
 * `portalCompositionReal`.
 */
describe("the portal shows the issued report, and a left-out section is absent everywhere (F-4b)", () => {
  const withoutTargets = (): ReportComposition => {
    const composition = JSON.parse(fixture("composition-composed2-whole.json")) as ReportComposition;
    return {
      ...composition,
      issuer: { ...composition.issuer!, logoAssetId: "issuer-asset" },
      sectionPlan: defaultReportSectionPlan.map((entry) => entry.key === "targets" ? { ...entry, included: false } : entry),
    };
  };
  const reportFor = (composition: ReportComposition): ClientFacingPublishedCrpReport => ({
    reportVersionId: composition.reportVersionId, manifestVersion: 1, publishedAt: "2026-02-01T00:00:00.000Z", dataHash: composition.snapshotDataHash,
    scopeLabel: "Whole client", signee: { name: "Client Signee", jobTitle: "Finance Director" }, clientLogoAssetId: null, issuer: composition.issuer,
    snapshot: {
      id: composition.snapshotId, jobId: composition.jobId, jobNumber: composition.jobNumber, client: composition.client, reportingYear: composition.reportingYear,
      version: 1, jobVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", dataHash: composition.snapshotDataHash, target: null, intensityTarget: null,
      annualComparison: [], sections: [], gapResolutions: [],
      measurements: (composition.chartBasis?.measurements ?? []).map((row) => ({ ...row, rowVersion: 1, scope: row.scope as "1" | "2" | "3", qualityTier: "measured" as const })),
    },
  });
  const staffRender = async (composition: ReportComposition) => {
    (globalThis as { React?: unknown }).React = React;
    const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
    return renderToStaticMarkup(createElement(ReportComposedView, { composition }));
  };
  const portalRender = async (report: ClientFacingPublishedCrpReport, view: unknown) => {
    (globalThis as { React?: unknown }).React = React;
    const { PortalWorkspace } = await import("../app/portal-preview/PortalWorkspace");
    return renderToStaticMarkup(createElement(PortalWorkspace, { specs: {}, report, approval: null, view: view as never, clientMode: true }));
  };
  const TARGETS = /<h2>Targets &amp; reduction pathway<\/h2>/;
  const PATHWAY = "Emissions reduction pathway to net zero";
  // React writes the view's &rsquo; as the character itself.
  const OMITTED = /<p class="nzr-note nzr-omitted">Omitted from this report at the issuer(?:’|&rsquo;)s choice: Targets &amp; reduction pathway\.<\/p>/;

  it("the console report: the section is absent — heading and chart — and the Methodology says it was left out", async () => {
    const html = await staffRender(withoutTargets());
    assert.doesNotMatch(html, TARGETS);
    assert.ok(!html.includes(PATHWAY), "its chart goes with it");
    assert.match(html, OMITTED);
    assert.match(html, /<td>Reviewed by<\/td>/, "the staff copy keeps its reviewer");
    // D4: the logo prop's default is the staff route, byte for byte as before F-4b — so no issued staff render moves. (The
    // golden fixtures carry no issuer logo, so this is the pin that holds it; found by a surviving mutant.)
    assert.match(html, /src="\/api\/isolated\/organisation\/logo\?asset=issuer-asset"/);
    // Control: the same composition with the section kept draws it.
    const kept = await staffRender({ ...withoutTargets(), sectionPlan: defaultReportSectionPlan });
    assert.match(kept, TARGETS);
    assert.ok(kept.includes(PATHWAY));
  });

  it("the client's portal: the same issued document — the section absent, the omission stated, no reviewer, nothing from the snapshot", async () => {
    const composition = withoutTargets();
    const html = await portalRender(reportFor(composition), { state: "composed", composition: clientFacingComposition(composition) });
    assert.match(html, /class="nzr-doc"/, "the composed report is drawn");
    assert.doesNotMatch(html, TARGETS);
    assert.ok(!html.includes(PATHWAY));
    assert.match(html, OMITTED);
    assert.doesNotMatch(html, /Reviewed by/, "no reviewer line — and no organisation in its place");
    assert.match(html, /<td>Assurance basis<\/td>/, "the basis stands alone");
    assert.doesNotMatch(html, /nz-manifest|data-manifest|Manifest v/i, "no snapshot chart set beside it");
    assert.match(html, /\/api\/portal\/jobs\/j-cur\/published-report\/issuer-logo\?asset=issuer-asset/, "the issuer logo from the portal's grant-checked route (D4)");
    assert.doesNotMatch(html, /\/api\/isolated\/organisation\/logo/, "never the staff route");
    assert.match(html, /Signed off by <b>Client Signee<\/b>, Finance Director/, "the signee from the version row (D3)");
    assert.match(html, /Evidence matched/);
  });

  it("an issued document that cannot be read draws nothing in its place — never the snapshot, never an approval of an unseen report", async () => {
    const composition = withoutTargets();
    const html = await portalRender(reportFor(composition), { state: "failed", message: "The issued report could not be loaded." });
    assert.match(html, /The issued report could not be shown/);
    assert.doesNotMatch(html, /nzr-doc|Approve this report version|<svg/, "no figures, no chart, no approval");
    assert.match(html, /Unavailable/);
  });

  it("a version issued before compositions were frozen keeps its snapshot render, labelled (D1)", async () => {
    const html = await portalRender(reportFor(withoutTargets()), { state: "pre-composition" });
    assert.match(html, /Issued before reports were frozen in full/);
    assert.doesNotMatch(html, /nzr-doc/);
  });

  it("the client's print renders the same issued document, and prints nothing for an unreadable one", () => {
    const print = read("apps/console/app/portal/jobs/[jobId]/print/page.tsx");
    assert.match(print, /if\(view\.state==="failed"\)return <PrintUnavailable/);
    // The composed@5 publish gate: the client's logo through the portal's route too (pinned below).
    assert.match(print, /if\(view\.state==="composed"\)return [\s\S]*<ReportComposedView composition=\{view\.composition\} issuerLogoSrc=\{portalIssuerLogoSrc\(jobId\)\} clientLogoSrc=\{portalClientLogoSrc\}\/>/);
    assert.match(print, /PRE_COMPOSITION_LABEL/);
  });

  it("the portal page reads the issued document for the report in view, and the staff preview shows the client's copy", () => {
    const page = read("apps/console/app/portal/jobs/[jobId]/page.tsx");
    assert.match(page, /published-report\/composition\?reportVersionId=\$\{encodeURIComponent\(reportVersionId\)\}/);
    assert.match(page, /<PortalWorkspace specs=\{specs\} report=\{body\.report\} approval=\{body\.approval\} view=\{view\} clientMode\/>/);
    const preview = read("apps/console/app/portal-preview/page.tsx");
    assert.match(preview, /report=\{clientFacingPublishedReport\(data\.report\)\}/);
    assert.match(preview, /return \{state:"composed",composition:clientFacingComposition\(composition\)\}/);
    const route = read("apps/console/app/api/portal/jobs/[jobId]/published-report/route.ts");
    assert.match(route, /report:clientFacingPublishedReport\(report\)/, "the client's copy is what the route sends");
  });

  it("the scope switcher, comments, approval and analytics are untouched", () => {
    const page = read("apps/console/app/portal/jobs/[jobId]/page.tsx");
    assert.match(page, /function ScopeSwitcher\(\{jobId,reports,current\}/);
    const workspace = read("apps/console/app/portal-preview/PortalWorkspace.tsx");
    assert.match(workspace, /\/published-report\/comments`/);
    assert.match(workspace, /\/published-report\/approval`/);
    // The dashboard's exclusion question was ruled (a): F-4c — it draws through the report's plan. Pinned in
    // `portalDashboardHonoursReport`; here only that it still reads its figures from the published report.
    const dashboard = read("apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx");
    assert.match(dashboard, /fetch\(`\/api\/portal\/jobs\/\$\{jobId\}\/published-report`/);
    // RULING-report-studio-consolidation R5: with the snapshot's years, so a single-year client's annual comparison is absent, not blocking.
    assert.match(dashboard, /<ManifestChartSet manifest=\{manifest\} charts=\{charts\} reviewedSnapshotId=\{snapshotId\} context=\{\{ reportingYears: /, "through the manifest view F-4c draws with");
  });
});

/**
 * The composed@5 publish gate: composed@5's cover draws the client's frozen logo. In the portal it must load through the portal's
 * client-scoped route (`/api/portal/logo-assets/{id}`, an asset of the user's own client only) — never the staff route, which a
 * client cannot reach. The real-database half (the route serves the frozen asset to its own client only) is
 * `portalClientLogoReal`.
 */
describe("the portal draws a composed@5 report's client logo through the portal's route (the composed@5 publish gate)", () => {
  const LOGO = "c5-client-logo";
  const composition = () => clientFacingComposition(JSON.parse(fixture("composition-composed5-whole.json")) as ReportComposition);
  const reportFor = (issued: ReportComposition): ClientFacingPublishedCrpReport => ({
    reportVersionId: issued.reportVersionId, manifestVersion: 1, publishedAt: "2026-02-01T00:00:00.000Z", dataHash: issued.snapshotDataHash,
    scopeLabel: "Whole client", signee: null, clientLogoAssetId: issued.clientLogoAssetId ?? null, issuer: issued.issuer,
    snapshot: {
      id: issued.snapshotId, jobId: issued.jobId, jobNumber: issued.jobNumber, client: issued.client, reportingYear: issued.reportingYear,
      version: 1, jobVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", dataHash: issued.snapshotDataHash, target: null, intensityTarget: null,
      annualComparison: [], sections: [], gapResolutions: [], measurements: [],
    },
  });
  const workspace = async (clientMode: boolean) => {
    (globalThis as { React?: unknown }).React = React;
    const { PortalWorkspace } = await import("../app/portal-preview/PortalWorkspace");
    const issued = composition();
    return renderToStaticMarkup(createElement(PortalWorkspace, { specs: {}, report: reportFor(issued), approval: null, view: { state: "composed", composition: issued } as never, clientMode }));
  };
  const cover = (html: string) => html.match(/<div class="r5-clframe"><img src="([^"]*)"/)?.[1];

  it("the fixture is a composed@5 report that froze a client logo", () => {
    assert.equal(composition().renderer, "composed@5");
    assert.equal(composition().clientLogoAssetId, LOGO, "kept in the client's copy");
  });

  it("the client's portal: the cover's logo, and the issued-for card's, from the portal's route — never the staff one", async () => {
    const html = await workspace(true);
    assert.equal(cover(html), `/api/portal/logo-assets/${LOGO}`);
    assert.match(html, /class="nz-portal-issued"[\s\S]*?src="\/api\/portal\/logo-assets\/c5-client-logo"/, "the card loads the same asset, the same way");
    assert.doesNotMatch(html, /\/api\/isolated\//, "no staff route anywhere on the client's page");
  });

  it("the staff preview of the same report keeps the staff routes, as before", async () => {
    const html = await workspace(false);
    assert.equal(cover(html), `/api/isolated/logo-assets/${LOGO}`);
    assert.doesNotMatch(html, /\/api\/portal\//);
  });

  it("the client's print: the cover, the header and the issuer all through the portal's routes; no staff route in the page", () => {
    const print = read("apps/console/app/portal/jobs/[jobId]/print/page.tsx");
    assert.match(print, /<ReportComposedView composition=\{view\.composition\} issuerLogoSrc=\{portalIssuerLogoSrc\(jobId\)\} clientLogoSrc=\{portalClientLogoSrc\}\/>/);
    assert.match(print, /<LogoMark src=\{report\.clientLogoAssetId\?portalClientLogoSrc\(report\.clientLogoAssetId\):null\}/);
    assert.doesNotMatch(print, /\/api\/isolated\/|staffIssuerLogoSrc/);
  });

  it("one helper names the route; it encodes the asset id; the route reads only the portal user's own client's asset", async () => {
    const { portalClientLogoSrc } = await import("../app/portal/portalReportView");
    assert.equal(portalClientLogoSrc("a/b c"), "/api/portal/logo-assets/a%2Fb%20c");
    const route = read("apps/console/app/api/portal/logo-assets/[assetId]/route.ts");
    assert.match(route, /const user = await currentPortalUserForData\(request\)/, "the portal session, terms accepted");
    assert.match(route, /getLogoAsset\(db, assetId, \{ clientId: user\.clientId \}\)/, "restricted to the user's own client");
    assert.match(route, /withTenantRead\(isolatedPool\(\), user\.organisationId,/);
    assert.match(route, /logoResponse\(/, "served as every logo is (nosniff, sandbox)");
    assert.doesNotMatch(route, /requireIsolatedApiContext|currentStaff/, "never the staff context");
  });
});
