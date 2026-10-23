import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emissionCategoryTaxonomy, offeredPortalProfile, resolvePortalProfile, type ApplicableCategory, type ClientFacingPublishedCrpReport, type InputSpecCategory, type ReportComposition } from "@nzi/contracts";
import type { PortalDataView, PortalScopeRow } from "@nzi/isolated-backend";
import { previewLink, portalPreviewApi, portalPreviewBase } from "../app/portal/portalPreviewLinks";
import { reportEntry } from "../app/portal/reportsView";
import { organisationCopy } from "../app/lib/organisationName";

/**
 * BUILD-staff-portal-preview-job-aware — the console half. The reads, their authorizer and the audit are proved against a real
 * database in `portalPreviewJobsReal`; here, what the consultant is shown:
 *  - the client's own components, pointed at the preview's mirror of the client's routes and the preview's own pages (R2);
 *  - read-only (R5): no entry, no change, no deactivation, no approval, no download, nothing that would POST;
 *  - the mirror routes are GET only, on the staff session, through the staff-preview authorizer — never a portal session.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const app = new URL("../app/", import.meta.url);
const CLIENT = "client-a";
const org = organisationCopy({ displayName: "Net Zero International", shortName: "NZI" });
const components = async () => ({
  ...(await import("../app/portal/portalSurface")), ...(await import("../app/portal/jobs/[jobId]/data/PortalDataView")),
  ...(await import("../app/portal/reports/PortalReports")), ...(await import("../app/portal-preview/PortalWorkspace")),
});
/** Drawn inside the staff preview's surface for CLIENT, or (`client`) as the client's portal draws it. */
const drawn = async (element: React.ReactElement, client = false) => {
  const { PreviewSurfaceProvider } = await components();
  return renderToStaticMarkup(client ? element : createElement(PreviewSurfaceProvider, { clientId: CLIENT, children: element }));
};

const seed = JSON.parse(read("apps/console/tests/fixtures/inputSpec.seed.json")) as InputSpecCategory[];
const gasSpec = seed.find((category) => category.categoryCode === "1.natural-gas")!;
const gas = { ...emissionCategoryTaxonomy.find((category) => category.code === "1.natural-gas")!, entryCount: 1, tco2e: 0.18, completeness: 0, noData: false } as ApplicableCategory;
const row = { id: "r1", jobId: "job-1", scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler gas", reportLabel: "Boiler gas", categoryPath: ["Scope 1", "Gas"],
  quantity: 1000, unit: "kWh", datasetId: "ds", factorId: "gas-demo", factorVersion: "v1", factorLabel: "Natural gas", qualityTier: null,
  calculatedTco2e: null, overrideTco2e: null, overrideReason: null, reviewStatus: "pending", version: 1, enabled: true, siteId: null, siteLabel: null,
  monthlyActivity: [], provenance: { capturedAs: "client-portal", capturedAt: "2026-10-22T09:00:00.000Z" }, lineage: [], editable: true, origin: "live" } as unknown as PortalScopeRow;
// Deactivate offered by the profile and the window open: the most a client could do with this row.
const view = { profile: offeredPortalProfile(resolvePortalProfile([{ profileKey: "deactivate", value: "enabled" }])),
  access: { jobId: "job-1", startsAt: "2026-10-01T00:00:00Z", expiresAt: "2026-12-31T00:00:00Z", state: "open", reportingMonths: [] },
  categories: { audience: "portal", includedScopes: ["1"], categories: [gas] }, rows: [row], factors: [], sites: [], purchasedGoodsCategories: [], reportingMonths: [] } as unknown as PortalDataView;

const composition = JSON.parse(readFileSync(new URL("./fixtures/composition-composed2-whole.json", import.meta.url), "utf8")) as ReportComposition;
const report: ClientFacingPublishedCrpReport = {
  reportVersionId: "rv-663", manifestVersion: 1, publishedAt: "2026-10-01T09:00:00.000Z", dataHash: composition.snapshotDataHash,
  scopeLabel: "Whole client", signee: null, clientLogoAssetId: null, issuer: composition.issuer,
  snapshot: { id: "reviewed-crp-J000663", jobId: "job-663", jobNumber: "J000663", client: "EFF Group", reportingYear: 2026, version: 1, jobVersion: 1,
    createdAt: "2026-09-30T00:00:00.000Z", dataHash: composition.snapshotDataHash, target: null, intensityTarget: null, annualComparison: [], sections: [], gapResolutions: [], measurements: [] },
} as unknown as ClientFacingPublishedCrpReport;

describe("the staff portal preview, job-aware (console)", () => {
  describe("the client's components, pointed at the preview", () => {
    it("a portal page maps to its preview page; anything without one is left out", () => {
      const base = portalPreviewBase(CLIENT);
      assert.equal(previewLink(CLIENT, "/portal"), base);
      assert.equal(previewLink(CLIENT, "/portal/reports"), `${base}/reports`);
      assert.equal(previewLink(CLIENT, "/portal/jobs/job-1"), `${base}/jobs/job-1`);
      assert.equal(previewLink(CLIENT, "/portal/jobs/job-1/dashboard"), `${base}/jobs/job-1/dashboard`);
      assert.equal(previewLink(CLIENT, "/portal/jobs/job-1/data"), `${base}/jobs/job-1/data`);
      assert.equal(previewLink(CLIENT, "/portal/jobs/job-1?report=rv-1#client-approval"), `${base}/jobs/job-1?report=rv-1#client-approval`);
      for (const none of ["/portal/intensity", "/portal/account", "/portal/jobs/job-1/print", "/api/portal/jobs/job-1/deliverables/report?reportVersionId=x", "https://example.invalid"]) {
        assert.equal(previewLink(CLIENT, none), null, none);
      }
      assert.equal(portalPreviewApi("a b"), "/api/isolated/clients/a%20b/portal-preview");
    });

    it("the Data view, Dashboard and Reports read through the surface — no client route is named in them", () => {
      for (const path of ["apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx", "apps/console/app/portal/jobs/[jobId]/PortalDashboard.tsx", "apps/console/app/portal/reports/PortalReports.tsx"]) {
        const code = read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        assert.doesNotMatch(code, /["'`]\/api\/portal/, `${path} reads through usePortalSurface`);
        assert.doesNotMatch(code, /redirectIfPortalSessionEnded/, `${path}: an ended session is the surface's to handle`);
      }
    });

    it("the report page is one page for the client and the preview", () => {
      assert.match(read("apps/console/app/portal/jobs/[jobId]/page.tsx"), /<PortalReportPage source=\{\{api:`\$\{base\}\/api\/portal`,pages:"\/portal"/);
      assert.match(read("apps/console/app/clients/[clientId]/portal-preview/jobs/[jobId]/page.tsx"), /<PortalReportPage source=\{\{ api: `\$\{base\}\$\{portalPreviewApi\(clientId\)\}`, pages: portalPreviewBase\(clientId\), cookie, org, sessionEndedNext: null \}\}/);
    });
  });

  describe("R5 — read-only, every surface", () => {
    it("the Data view's row: the client could change and deactivate it; the preview draws neither", async () => {
      const { PortalRowDrawer } = await components();
      const props = { jobId: "job-1", row, view, specs: { "1.natural-gas": gasSpec }, refs: [], open: true, adviser: "Your NZI adviser", onSaved: async () => undefined };
      const client = await drawn(createElement(PortalRowDrawer, props), true);
      assert.match(client, /Change this entry/);
      assert.match(client, />Deactivate</);
      const preview = await drawn(createElement(PortalRowDrawer, props));
      assert.doesNotMatch(preview, /Change this entry|>Deactivate<|<textarea|<form/);
      assert.match(preview, /Read-only preview\. The client can change this entry/);
      assert.match(read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx"), /canAdd=\{open && !surface\.readOnly\}/, "no Add entry in preview");
    });

    it("the Reports index: Open goes to the preview's report; no Review & approve, no download", async () => {
      const { PortalReportsView } = await components();
      const awaiting = reportEntry({ report, approval: null, view: { state: "composed", composition }, scopeLabel: null });
      const issued = reportEntry({ report: { ...report, reportVersionId: "rv-512" }, approval: { approvalId: "a", reportVersionId: "rv-512", approvedAt: "2025-10-14T10:00:00.000Z", statementVersion: 1 }, view: { state: "pre-composition" }, scopeLabel: null });
      const state = { kind: "ready" as const, entries: [awaiting, issued], unread: [] };
      const client = await drawn(createElement(PortalReportsView, { state, org }), true);
      assert.match(client, /Review &amp; approve/);
      assert.match(client, /Download PDF/);
      const preview = await drawn(createElement(PortalReportsView, { state, org }));
      assert.doesNotMatch(preview, /Review &amp; approve|Download PDF|\/api\/portal|href="\/portal/);
      assert.match(preview, new RegExp(`href="${portalPreviewBase(CLIENT)}/jobs/job-663\\?report=rv-663">Open<`));
      assert.match(preview, new RegExp(`href="${portalPreviewBase(CLIENT)}">Back to reporting jobs<`));
    });

    it("the report: the approval card is drawn disabled, and no Documents or Review messages tab is offered", async () => {
      const { PortalWorkspace } = await components();
      const props = { specs: {}, report, approval: null, view: { state: "pre-composition" as const }, clientMode: true };
      const client = await drawn(createElement(PortalWorkspace, props), true);
      assert.match(client, /type="checkbox"/);
      assert.match(client, />Review messages</);
      const preview = await drawn(createElement(PortalWorkspace, props));
      assert.match(preview, /<button class="nz-btn pri" disabled="" [^>]*>Approve this report version<\/button>/);
      assert.doesNotMatch(preview, /type="checkbox"|>Review messages<|>Documents<|Account security|href="\/portal/);
      assert.match(preview, /Disabled in the staff preview/);
    });
  });

  describe("the mirror routes and the preview pages", () => {
    const walk = (dir: URL): string[] => readdirSync(dir).flatMap((name) => {
      const path = new URL(name, dir);
      return statSync(path).isDirectory() ? walk(new URL(`${name}/`, dir)) : [path.pathname];
    });
    const routes = walk(new URL("api/isolated/clients/[clientId]/portal-preview/", app)).filter((path) => path.endsWith("route.ts"));
    const pages = walk(new URL("clients/[clientId]/portal-preview/", app)).filter((path) => path.endsWith(".tsx"));

    it("mirror every client GET the previewed components make", () => {
      const rel = routes.map((path) => decodeURIComponent(path).split("/portal-preview/")[1] ?? "").sort();
      for (const expected of ["route.ts", "jobs/route.ts", "input-spec/route.ts", "broadcasts/route.ts", "jobs/[jobId]/data-view/route.ts",
        "jobs/[jobId]/scope-rows/[rowId]/history/route.ts", "jobs/[jobId]/dashboard/route.ts", "jobs/[jobId]/published-report/route.ts",
        "jobs/[jobId]/published-report/composition/route.ts", "jobs/[jobId]/data-entry-access/route.ts", "jobs/[jobId]/data-entry-records/route.ts"]) {
        assert.ok(rel.includes(expected), expected);
      }
    });

    it("are GET only, on the staff session, never a portal one, and call no command", () => {
      for (const path of routes) {
        const code = readFileSync(decodeURIComponent(path).replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
        assert.doesNotMatch(code, /export async function (POST|PUT|PATCH|DELETE)/, path);
        assert.match(code, /portalPreviewGet\(request|currentStaff\(request\)/, path);
        assert.doesNotMatch(code, /currentPortalUser|portalCommandContext|runPostgresCommand|Portal(Scope)?Row\b/, path);
      }
      assert.match(read("apps/console/app/lib/portalPreviewRoute.ts"), /await currentStaff\(request\)/);
    });

    it("the preview's own pages hold no form and send nothing; each surface is behind the client's own flag", () => {
      for (const path of pages) {
        const code = readFileSync(decodeURIComponent(path).replace(/^\/([A-Za-z]:)/, "$1"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        assert.doesNotMatch(code, /<form|method:\s*"(POST|PATCH|PUT|DELETE)"|onSubmit/, path);
      }
      const page = (path: string) => read(`apps/console/app/clients/[clientId]/portal-preview/${path}`);
      assert.match(page("jobs/[jobId]/dashboard/page.tsx"), /if \(!portalFeatureEnabled\("portal-analytics"\)\) redirect/);
      assert.match(page("jobs/[jobId]/data/page.tsx"), /if \(!portalFeatureEnabled\("portal-data"\)\) redirect/);
      assert.match(page("reports/page.tsx"), /if \(!portalFeatureEnabled\("portal-reports"\)\) redirect/);
      assert.doesNotMatch(page("jobs/[jobId]/dashboard/page.tsx"), /PortalActionTracker/, "the action tracker writes; it is not previewed");
    });

    it("every surface opens through the audited preview read, naming its job and surface (R1)", () => {
      const frame = read("apps/console/app/clients/[clientId]/portal-preview/PreviewFrame.tsx");
      assert.match(frame, /new URLSearchParams\(\{ surface, \.\.\.\(jobId \? \{ jobId \} : \{\}\) \}\)/);
      assert.match(frame, /`clients\/\$\{encodeURIComponent\(clientId\)\}\/portal-preview\?\$\{query\}`/);
      for (const [path, surface] of [["page.tsx", "home"], ["jobs/[jobId]/page.tsx", "report"], ["jobs/[jobId]/dashboard/page.tsx", "dashboard"], ["jobs/[jobId]/data/page.tsx", "data"], ["reports/page.tsx", "reports"]]) {
        assert.match(read(`apps/console/app/clients/[clientId]/portal-preview/${path}`), new RegExp(`<PreviewFrame clientId=\\{clientId\\}${surface === "home" || surface === "reports" ? "" : " jobId=\\{jobId\\}"} surface="${surface}">`), path);
      }
    });
  });
});
