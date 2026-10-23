import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { offeredPortalProfile, resolvePortalProfile, type ScopeQaReadiness } from "@nzi/contracts";
import { portalQaGates } from "../app/portal/data/portalDataView";

/**
 * BUILD-portal-data-parity-polish — the five fixes from the live walkthrough: the drawer white (1), one History (2), the NZI
 * logo top-left as in the CRM (3), no entry-helper banner (4), and the CRM's Review & QA as read-only status (5).
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const profile = (decisions: Array<{ profileKey: string; value: string }> = []) => offeredPortalProfile(resolvePortalProfile(decisions));
const detailedQuality = profile([{ profileKey: "entryDrawer", value: "detailed" }, { profileKey: "dataQuality", value: "visible" }]);
const qa = (over: Partial<ScopeQaReadiness> = {}): ScopeQaReadiness => ({
  total: 3, enabled: 3, approved: 1, pending: 1, rejected: 1, calculationMissing: 1, qualityMissing: 2, independentReviewPending: 2, migratedRows: 0, readyForReporting: false, ...over,
});

describe("the parity Data view — polish", () => {
  describe("fix 5: Review & QA, the CRM's gates as the client may see them", () => {
    it("calculations and independent review always; data quality only where the profile shows the client that section", () => {
      assert.deepEqual(portalQaGates(qa(), profile()).map((gate) => gate.key), ["calculation", "review"], "the default profile: no quality tier for the client");
      assert.deepEqual(portalQaGates(qa(), detailedQuality).map((gate) => gate.key), ["calculation", "quality", "review"]);
    });

    it("counts in the client's words — returned to you, not rejected; complete only when nothing waits", () => {
      const [calculation, quality, review] = portalQaGates(qa(), detailedQuality);
      assert.deepEqual(calculation, { key: "calculation", label: "Emission calculations", complete: false, detail: "1 awaiting calculation" });
      assert.equal(quality!.detail, "2 awaiting a quality rating");
      assert.equal(review!.detail, "1 reviewed · 1 waiting · 1 returned to you");
      const done = portalQaGates(qa({ calculationMissing: 0, qualityMissing: 0, independentReviewPending: 0, pending: 0, rejected: 0, approved: 3 }), detailedQuality);
      assert.ok(done.every((gate) => gate.complete));
      assert.ok(portalQaGates(qa({ enabled: 0 }), profile()).every((gate) => !gate.complete && gate.detail === "No entries yet"), "an empty job is never 'complete'");
    });

    it("renders read-only: no control, no name, no money, no sign-off — and not the CRM's setup gates or v7 note", async () => {
      const { PortalQaSection } = await import("../app/portal/jobs/[jobId]/data/PortalDataView");
      const html = renderToStaticMarkup(createElement(PortalQaSection, { qa: qa({ migratedRows: 4 }), profile: detailedQuality, adviser: "your adviser" }));
      assert.match(html, /Review &amp; QA/);
      assert.match(html, /class="nz-panel nz-readiness-card nz-pdv-qa"/, "the CRM's readiness card");
      assert.doesNotMatch(html, /<button|<form|<input|<textarea|href=/, "nothing acts");
      assert.doesNotMatch(html, /sign.?off|approve|Reporting datasets|Reduction pathway|Intensity metric|v7|imported|[£$€]/i);
      const source = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
      assert.match(source, /\{crmParity \? <PortalQaSection qa=\{view\.qa\} profile=\{view\.profile\} adviser=\{org\.your\("adviser"\)\} \/> : null\}/, "after the accordion, with the shell");
    });

    it("the read is the CRM's own QA readiness, limited to the rows the client sees", () => {
      assert.match(read("packages/isolated-backend/src/readModels.ts"), /export async function getScopeQaReadiness\(db:Queryable,jobId:string,rowIds\?:readonly string\[\]\)/);
      assert.match(read("packages/isolated-backend/src/portalCapture.ts"), /const qa = await getScopeQaReadiness\(db, jobId, visible\);/);
      assert.match(read("apps/console/app/portal/data/portalDataView.ts"), /!!view\.qa && typeof view\.qa\.enabled === "number"/, "drawn only from a verified read");
    });
  });

  it("fix 1: the drawer body is white, above the overlay's scrim", () => {
    assert.match(read("apps/console/app/portal/shell/portal-shell.css"), /\.nz-site-drawer\.nz-pdv-drawer \.nz-pdv-drawer-b\{background:#fff;flex:1 1 auto;min-height:0\}/);
  });

  it("fix 2: History is opened by one control — the drawer starts with it closed, as the CRM's", () => {
    const source = read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(source, /const \[showHistory, setShowHistory\] = useState\(!portalFeatureEnabled\("portal-shell"\)\);/);
    assert.match(source, /sections\.includes\("history"\) && showHistory \? <section className="nz-pdv-history" aria-label="History"><div className="nz-sect">History<\/div><RowHistoryList/);
    // The CRM's drawer keeps its collapsible History unchanged; the list is shared.
    assert.match(read("apps/console/app/jobs/RowHistory.tsx"), /<Collapsible title="History" open=\{open\} onOpenChange=\{onOpenChange\}>\s*<RowHistoryList state=\{state\} entries=\{entries\} \/>/);
  });

  it("fix 3: the NZI lockup top-left exactly as the CRM's rail, the client's logo still in its card — live and in preview", async () => {
    process.env.NEXT_PUBLIC_FEATURE_PORTAL = "portal-analytics,portal-data,portal-reports";
    const [{ PortalShell }, { PreviewSurfaceProvider }] = await Promise.all([import("../app/portal/shell/PortalShell"), import("../app/portal/portalSurface")]);
    const shell = (preview: boolean) => {
      const element = createElement(PortalShell, { client: { name: "EFF Group", logoSrc: "/api/portal/logo?v=a1" }, jobs: [], jobId: null, view: "dashboard", person: { kind: "preview" }, children: null });
      return renderToStaticMarkup(preview ? createElement(PreviewSurfaceProvider, { clientId: "c", children: element }) : element);
    };
    for (const html of [shell(false), shell(true)]) {
      assert.match(html, /class="nz-brand nzp-brand"[^>]*><span class="nz-brand-plate"><picture><source srcSet="\/brand\/netzero-logo\.webp"/, "the CRM rail's lockup on its white plate");
      assert.match(html, /<span class="wm">NZ Insights Pro<small>Client portal<\/small><\/span>/);
      assert.match(html, /class="nzp-client"/, "the client's identity card stays below");
      assert.doesNotMatch(html, /<circle cx="20" cy="20" r="19" fill="#1f9d57"/, "the generic green mark is gone");
    }
  });

  it("fix 4: no entry-helper banner in the parity view (kept only while the shell is off)", () => {
    assert.match(read("apps/console/app/portal/jobs/[jobId]/data/PortalDataView.tsx"), /\{crmParity \? null : <p className="nz-pdv-note" role="note">What you enter goes straight into this job/);
  });
});
