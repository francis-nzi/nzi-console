import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClientFacingPublishedCrpReport, ReportComposition } from "@nzi/contracts";
import {
  approvable, approveHref, documentLine, documentOf, pdfHref, publishedScopesOf, readPublishedReport, reportEntry, reportGroups, reportHref,
  type PortalReportEntry,
} from "../app/portal/reportsView";
import { PortalReportsView, SessionEnded, loadReports, type ReportsState } from "../app/portal/reports/PortalReports";
import { PRE_COMPOSITION_LABEL } from "../app/portal/portalReportView";
import { organisationCopy } from "../app/lib/organisationName";

/**
 * BUILD-client-portal-reports: the client's Reports index laid out as MOCKUP-client-portal.html — the published reports grouped
 * awaiting approval / issued, each routing into what exists (the job's published report and its approval card, the version-bound
 * PDF). The guards hold through this entry point: an unreadable report is not approvable; one issued before compositions is
 * labelled. Read-only, the client's copy only, no money (NZC-120). "Uploaded · previous system" has no source yet and is not drawn.
 */
(globalThis as { React?: unknown }).React = React;
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const org = organisationCopy({ displayName: "Net Zero International", shortName: "NZI" });

const composition = JSON.parse(fixture("composition-composed2-whole.json")) as ReportComposition;
const reportFor = (over: { reportVersionId?: string; jobId?: string; jobNumber?: string; year?: number; logo?: string | null } = {}): ClientFacingPublishedCrpReport => ({
  reportVersionId: over.reportVersionId ?? "rv-663", manifestVersion: 1, publishedAt: "2026-10-01T09:00:00.000Z", dataHash: composition.snapshotDataHash,
  scopeLabel: "Whole client", signee: null, clientLogoAssetId: over.logo === undefined ? "client-logo" : over.logo, issuer: composition.issuer,
  snapshot: {
    id: `reviewed-crp-${over.jobNumber ?? "J000663"}`, jobId: over.jobId ?? "job-663", jobNumber: over.jobNumber ?? "J000663", client: "EFF Group",
    reportingYear: over.year ?? 2026, version: 1, jobVersion: 1, createdAt: "2026-09-30T00:00:00.000Z", dataHash: composition.snapshotDataHash,
    target: null, intensityTarget: null, annualComparison: [], sections: [], gapResolutions: [], measurements: [],
  },
});
const composedView = (rendererName?: string) => ({ state: "composed" as const, composition: { ...composition, ...(rendererName ? { renderer: rendererName } : {}) } });

const AWAITING = reportEntry({ report: reportFor(), approval: null, view: composedView("composed@5"), scopeLabel: null });
const UNREADABLE = reportEntry({ report: reportFor({ reportVersionId: "rv-700", jobId: "job-700", jobNumber: "J000700" }), approval: null, view: { state: "failed", message: "x" }, scopeLabel: null });
const ISSUED = reportEntry({
  report: reportFor({ reportVersionId: "rv-512", jobId: "job-512", jobNumber: "J000512", year: 2025, logo: null }),
  approval: { approvalId: "a1", reportVersionId: "rv-512", approvedAt: "2025-10-14T10:00:00.000Z", statementVersion: 1 },
  view: { state: "pre-composition" }, scopeLabel: null,
});
const render = (state: ReportsState) => renderToStaticMarkup(createElement(PortalReportsView, { state, org }));
const READY: ReportsState = { kind: "ready", entries: [ISSUED, UNREADABLE, AWAITING], unread: [] };

describe("the client portal Reports view (BUILD-client-portal-reports)", () => {
  describe("what the view derives", () => {
    it("the document is what the composition route says: composed under its renderer, pre-composition, or unreadable", () => {
      assert.deepEqual(documentOf(composedView("composed@5")), { kind: "composed", renderer: "composed@5" });
      assert.deepEqual(documentOf(composedView()), { kind: "composed", renderer: composition.renderer?.trim() || "composed@1" }, "no stamp: issued before F-0, under composed@1");
      assert.deepEqual(documentOf({ state: "pre-composition" }), { kind: "pre-composition" });
      assert.deepEqual(documentOf({ state: "failed", message: "x" }), { kind: "unreadable" });
    });

    it("each route's answer is verified as the report page verifies it — a mismatch is unread, never guessed", () => {
      const report = reportFor();
      assert.ok(readPublishedReport({ report, approval: null }, { jobId: "job-663", reportVersionId: "rv-663" }));
      assert.equal(readPublishedReport({ report, approval: null }, { jobId: "job-663", reportVersionId: "rv-other" }), null, "another version's body");
      assert.equal(readPublishedReport({ report, approval: null }, { jobId: "job-other", reportVersionId: "rv-663" }), null, "another job's report");
      assert.equal(readPublishedReport({ report, approval: { approvalId: "a", reportVersionId: "rv-other", approvedAt: "2026-01-01T00:00:00Z", statementVersion: 1 } }, { jobId: "job-663", reportVersionId: "rv-663" }), null, "an approval of another version");
      assert.equal(readPublishedReport({ report: { ...report, snapshot: undefined }, approval: null }, { jobId: "job-663", reportVersionId: "rv-663" }), null);
      assert.deepEqual(publishedScopesOf({ reports: [{ reportVersionId: "a", scopeLabel: "Whole client" }, { reportVersionId: "b", scopeLabel: "Head Office" }] }),
        [{ reportVersionId: "a", scopeLabel: "Whole client" }, { reportVersionId: "b", scopeLabel: "Head Office" }]);
      for (const bad of [{}, { reports: [] }, { reports: [{ reportVersionId: "" , scopeLabel: "x" }] }, null]) assert.equal(publishedScopesOf(bad), null);
    });

    it("grouped by this user's approval of each version — newest year first — and nothing else", () => {
      const groups = reportGroups([ISSUED, UNREADABLE, AWAITING]);
      assert.deepEqual(groups.awaiting.map((entry) => entry.jobNumber), ["J000663", "J000700"]);
      assert.deepEqual(groups.issued.map((entry) => entry.jobNumber), ["J000512"]);
      const older = { ...AWAITING, reportVersionId: "rv-old", reportingYear: 2024 };
      assert.deepEqual(reportGroups([older, AWAITING]).awaiting.map((entry) => entry.reportingYear), [2026, 2024]);
    });

    it("every affordance routes into what exists — and an unreadable report is not approvable", () => {
      assert.equal(reportHref(AWAITING), "/portal/jobs/job-663?report=rv-663");
      assert.equal(approveHref(AWAITING), "/portal/jobs/job-663?report=rv-663#client-approval");
      assert.equal(pdfHref(ISSUED), "/api/portal/jobs/job-512/deliverables/report?reportVersionId=rv-512");
      assert.equal(approvable(AWAITING), true);
      assert.equal(approvable(UNREADABLE), false, "nothing is approved unseen");
      assert.equal(approvable(ISSUED), false, "already approved");
      assert.equal(approvable({ ...ISSUED, approvedAt: null }), true, "a labelled pre-composition report is approvable, as on its page");
    });

    it("the document line says what the report is, and the logo only where this version froze one", () => {
      assert.equal(documentLine(AWAITING), "FY2026 · composed@5 document · your logo on the cover");
      assert.equal(documentLine({ ...AWAITING, clientLogoOnCover: false }), "FY2026 · composed@5 document");
      assert.equal(documentLine({ ...AWAITING, scopeLabel: "Head Office" }), "FY2026 · Head Office · composed@5 document · your logo on the cover");
      assert.equal(documentLine(ISSUED), "FY2025 · issued before reports were frozen in full · approved & issued");
      assert.equal(documentLine(UNREADABLE), "FY2026 · this report could not be loaded");
    });
  });

  describe("the loader, over the routes' real answers", () => {
    const job = (id: string, number: string, over: Record<string, unknown> = {}) => ({ id, number, title: `${number} CRP`, reportingYear: 2026, hasPublishedReport: true, approved: false, approvedAt: null, hasUnreadNziResponse: false, ...over });
    const routes = (): Record<string, unknown> => ({
      "/api/portal/jobs": { jobs: [job("job-663", "J000663"), job("job-512", "J000512", { reportingYear: 2025 }), job("job-800", "J000800", { hasPublishedReport: false }), job("job-900", "J000900"), job("job-950", "J000950")] },
      "/api/portal/jobs/job-663/published-report": { reports: [{ reportVersionId: "rv-663", scopeLabel: "Whole client" }] },
      "/api/portal/jobs/job-663/published-report?reportVersionId=rv-663": { report: reportFor(), approval: null },
      "/api/portal/jobs/job-663/published-report/composition?reportVersionId=rv-663": { state: "composed", reportVersionId: "rv-663", composition: { ...composition, reportVersionId: "rv-663", jobId: "job-663", renderer: "composed@5" } },
      "/api/portal/jobs/job-512/published-report": { reports: [{ reportVersionId: "rv-512", scopeLabel: "Whole client" }] },
      "/api/portal/jobs/job-512/published-report?reportVersionId=rv-512": { report: reportFor({ reportVersionId: "rv-512", jobId: "job-512", jobNumber: "J000512", year: 2025 }), approval: { approvalId: "a", reportVersionId: "rv-512", approvedAt: "2025-10-14T10:00:00.000Z", statementVersion: 1 } },
      "/api/portal/jobs/job-512/published-report/composition?reportVersionId=rv-512": { state: "pre-composition", reportVersionId: "rv-512" },
      // job-900: its report route fails. job-950: two scopes — one whose composition fails (unreadable), one whose body is another version's.
      "/api/portal/jobs/job-950/published-report": { reports: [{ reportVersionId: "rv-950a", scopeLabel: "Whole client" }, { reportVersionId: "rv-950b", scopeLabel: "Depot" }] },
      "/api/portal/jobs/job-950/published-report?reportVersionId=rv-950a": { report: reportFor({ reportVersionId: "rv-950a", jobId: "job-950", jobNumber: "J000950" }), approval: null },
      "/api/portal/jobs/job-950/published-report?reportVersionId=rv-950b": { report: reportFor({ reportVersionId: "rv-950a", jobId: "job-950", jobNumber: "J000950" }), approval: null },
    });
    const getter = (table: Record<string, unknown>) => async (url: string) => { if (!(url in table)) throw new Error(`404 ${url}`); return table[url]; };

    it("one entry per published version with its own approval and document; a version that does not verify names its job; unpublished jobs are not asked", async () => {
      const asked: string[] = [];
      const table = routes();
      const { entries, unread } = await loadReports(async (url) => { asked.push(url); return getter(table)(url); });
      const byVersion = Object.fromEntries(entries.map((entry) => [entry.reportVersionId, entry]));
      assert.deepEqual(Object.keys(byVersion).sort(), ["rv-512", "rv-663", "rv-950a"]);
      assert.deepEqual(byVersion["rv-663"]!.document, { kind: "composed", renderer: "composed@5" });
      assert.equal(byVersion["rv-663"]!.approvedAt, null);
      assert.deepEqual(byVersion["rv-512"]!.document, { kind: "pre-composition" });
      assert.equal(byVersion["rv-512"]!.approvedAt, "2025-10-14T10:00:00.000Z");
      assert.deepEqual(byVersion["rv-950a"]!.document, { kind: "unreadable" }, "its composition did not answer: unreadable, never the snapshot");
      assert.equal(byVersion["rv-950a"]!.scopeLabel, "Whole client", "a job with two scopes names each");
      assert.equal(byVersion["rv-663"]!.scopeLabel, null);
      assert.deepEqual(unread.map((entry) => entry.jobNumber), ["J000900", "J000950"], "a failed route and another version's body are both named, once each");
      assert.ok(!asked.some((url) => url.includes("job-800")), "an unpublished job is not asked for a report");
    });

    it("the job list as the route answers it — { jobs } — and a list that does not verify fails the whole view, never an empty one", async () => {
      await assert.rejects(loadReports(getter({ ...routes(), "/api/portal/jobs": [job("job-663", "J000663")] })));
      await assert.rejects(loadReports(getter({ ...routes(), "/api/portal/jobs": { jobs: [{ id: "x" }] } })));
      await assert.rejects(loadReports(async () => { throw new Error("401"); }));
    });

    it("an ended session ends the load, rather than marking every report unread", async () => {
      const table = routes();
      await assert.rejects(loadReports(async (url) => { if (url.includes("composition")) throw new SessionEnded(); return getter(table)(url); }), SessionEnded);
    });
  });

  describe("the view", () => {
    it("draws the mockup's groups, each card with its affordances, and the evidence one click away", () => {
      const html = render(READY);
      for (const text of ["Published disclosures", ">Reports<", "Your Carbon Reduction Plans and certificates, by period", "Awaiting your approval", ">Issued<",
        "Carbon Reduction Plan — J000663", "Carbon Reduction Plan — J000512", "View report evidence", "Reviewed snapshot reviewed-crp-J000512 · approved ",
        "Reviewed snapshot reviewed-crp-J000663 · publication gate passed", "Issued "]) assert.ok(html.includes(text), text);
      assert.match(html, /href="\/portal\/jobs\/job-663\?report=rv-663#client-approval"[^>]*>Review &amp; approve</, "approve → the existing approval card");
      assert.match(html, /href="\/portal\/jobs\/job-663\?report=rv-663"[^>]*>Open</, "open → the report");
      assert.match(html, /href="\/api\/portal\/jobs\/job-512\/deliverables\/report\?reportVersionId=rv-512"[^>]*>Download PDF</, "download → the version-bound PDF");
      assert.equal((html.match(/Download PDF/g) ?? []).length, 1, "only an issued report offers its PDF here, as the mockup lays out");
      assert.ok(html.indexOf("Awaiting your approval") < html.indexOf(">Issued<"), "awaiting first");
    });

    it("the guards hold through this entry point: unreadable → no approve, said; pre-composition → labelled", () => {
      const html = render(READY);
      assert.doesNotMatch(html, /job-700\?report=rv-700#client-approval/, "no approve affordance for an unreadable report");
      assert.match(html, /It can(?:’|&#x27;|')t be approved until it can be shown in full — nothing is approved unseen/);
      assert.match(html, /href="\/portal\/jobs\/job-700\?report=rv-700"[^>]*>Open</, "it can still be opened, where its page says why it is not shown");
      assert.ok(html.toLowerCase().includes(PRE_COMPOSITION_LABEL.toLowerCase()), "the report page's own label, in the same words");
    });

    it("a report that could not be read is named, not dropped; the loading, failed and empty states are distinct", () => {
      const html = render({ kind: "ready", entries: [AWAITING], unread: [{ jobId: "job-9", jobNumber: "J000009", reportingYear: 2024 }] });
      assert.match(html, /One report could not be loaded just now \(J000009\)/);
      assert.match(render({ kind: "loading" }), /Loading your reports/);
      assert.match(render({ kind: "failed" }), /Your reports are temporarily unavailable/);
      assert.match(render({ kind: "ready", entries: [], unread: [] }), /No published reports yet/);
      assert.doesNotMatch(render({ kind: "ready", entries: [], unread: [{ jobId: "j", jobNumber: "J1", reportingYear: null }] }), /No published reports yet/, "an unread report is not 'none'");
    });

    it("no 'previous system' group: the portal has no source for legacy files yet (raised, not invented)", () => {
      const html = render(READY);
      assert.doesNotMatch(html, /previous system|Legacy report|file history/i);
    });
  });

  describe("boundaries", () => {
    it("no money anywhere (NZC-120), the client's copy only, and no write path", () => {
      assert.doesNotMatch(render(READY), /£|\$|€|turnover|revenue/i);
      const source = read("apps/console/app/portal/reports/PortalReports.tsx") + read("apps/console/app/portal/reportsView.ts");
      assert.ok(!/\/api\/isolated/.test(source), "never a staff route");
      assert.match(source, /\/published-report\?\$\{query\}/, "the client's copy (clientFacingPublishedReport, applied at the route)");
      assert.ok(!/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(source), "the index makes no approval: GETs only");
    });

    it("Review & approve lands on the existing approval card, which still refuses an unreadable report", async () => {
      const { PortalWorkspace } = await import("../app/portal-preview/PortalWorkspace");
      const workspace = (view: unknown) => renderToStaticMarkup(createElement(PortalWorkspace, { specs: {}, report: reportFor(), approval: null, view: view as never, clientMode: true }));
      assert.match(workspace({ state: "pre-composition" }), /id="client-approval"/, "the anchor is the approval card");
      assert.doesNotMatch(workspace({ state: "failed", message: "The issued report could not be loaded." }), /id="client-approval"/, "unreadable: no card to approve with");
    });

    it("behind its own flag, off by default; the portfolio links to it only when it is on", () => {
      assert.match(read("apps/console/app/lib/portalFlags.ts"), /"portal-reports"/);
      assert.match(read("apps/console/app/portal/reports/page.tsx"), /if \(!portalFeatureEnabled\("portal-reports"\)\) redirect\("\/portal"\)/);
      assert.match(read("apps/console/app/portal/PortalHome.tsx"), /portalFeatureEnabled\("portal-reports"\)\?<a className="nz-btn" href="\/portal\/reports">Your reports<\/a>:null/);
    });
  });
});
