import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportComposition } from "@nzi/contracts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
(globalThis as { React?: unknown }).React = React;

/**
 * The one path (CORRECTION-report-studio-live-path): the Report Studio is where a report goes from draft to published — composed@5
 * drawn properly inside it (its view mode, the rail finding its sections), validate freezing the chosen signee, publish from the
 * studio, and every "Prepare report" opening the studio instead of the old preparation page. Display and rewiring only: the
 * composed renderers are untouched (their own pins), and the studio writes only through governed commands.
 */
describe("the one path: composed@5 inside the studio", async () => {
  const { ReportStudioPrinting } = await import("../app/jobs/[jobId]/report/ReportStudio");
  const { ReportComposedView } = await import("../app/reports/[versionId]/ReportComposedView");
  const composed5 = () => JSON.parse(fixture("composition-composed5-whole.json")) as ReportComposition;
  const version = { reportVersionId: "rv-1", status: "validated" as const, createdAt: "2026-10-15T09:00:00Z", publishedAt: null, scopeLabel: "Whole client", version: 2, manifestVersion: 1, snapshotId: "snap-1" };

  it("the studio passes its view to composed@5 — Continuous by default — and the document is otherwise the renderer's own, unchanged", () => {
    const issued = composed5();
    const html = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "712", version, composition: issued }));
    assert.match(html, /<main class="nzr5 r5-mode-flow"/, "the studio opens in Continuous, and composed@5 draws it");
    // React hoists the logos' preload hints to the front of the markup, so the document is compared from its <main> element.
    const own = renderToStaticMarkup(createElement(ReportComposedView, { composition: issued, preview: true, mode: "flow" }));
    const document = own.slice(own.indexOf("<main class=\"nzr5"));
    const at = html.indexOf("<main class=\"nzr5");
    assert.equal(html.slice(at, at + document.length), document, "byte for byte the renderer's flow drawing");
    assert.match(html, /aria-pressed="true">Continuous<\/button>/);
  });

  it("composed@1–4 draw exactly as before inside the studio: the view is the studio's CSS, the renderer ignores the prop", () => {
    const issued = JSON.parse(fixture("composition-composed4-whole.json")) as ReportComposition;
    for (const mode of ["page", "flow"] as const) {
      assert.equal(renderToStaticMarkup(createElement(ReportComposedView, { composition: issued, mode })), renderToStaticMarkup(createElement(ReportComposedView, { composition: issued })), mode);
    }
  });

  it("the rail's cover row is live on composed@5 (it draws its cover always) — and counting it moves no section's number", async () => {
    const { studioRail } = await import("../app/jobs/[jobId]/report/studio");
    const rail = studioRail(composed5());
    assert.deepEqual([rail[0]!.key, rail[0]!.drawn, rail[0]!.number, rail[0]!.note], ["cover", true, null, null]);
    const html = renderToStaticMarkup(createElement(ReportComposedView, { composition: composed5() }));
    const pages = [...html.matchAll(/<div class="r5-kicker">(\d\d) · [^<]*<\/div>/g)].map((match) => match[1]);
    // The document labels its reference block "Reference" / "Appendix" rather than by number; the numbered pages agree.
    assert.deepEqual(rail.filter((row) => row.number).map((row) => row.number).slice(0, pages.length), pages, "01–12 as the document numbers them");
  });

  it("the rail finds composed@5's sections by data-section and its cover, and composed@1–4's by heading, as before", () => {
    const studio = read("apps/console/app/jobs/[jobId]/report/ReportStudio.tsx");
    // Small-fixes D: the copy on screen — in Page · A4 the flow document is the hidden source, so the paged copy is the one found.
    assert.match(studio, /visible\(root\.querySelectorAll<HTMLElement>\("\.nzr-cover, \.r5-cover"\)\)/);
    assert.match(studio, /visible\(root\.querySelectorAll<HTMLElement>\(`\[data-section="\$\{CSS\.escape\(key\)\}"\]`\)\)/);
    assert.match(studio, /\?\? Array\.from\(root\.querySelectorAll<HTMLElement>\("section\.nzr-page"\)\)\.find\(\(page\) => page\.querySelector\("h2"\)\?\.textContent\?\.trim\(\) === title\)/);
    const html = renderToStaticMarkup(createElement(ReportComposedView, { composition: composed5() }));
    for (const key of ["executive-summary", "narrative:background", "sites", "methodology", "appendix-sites"]) assert.match(html, new RegExp(`data-section="${key}"`), key);
  });
});

describe("the one path: validate and publish in the studio", async () => {
  const { ReportStudioPrinting } = await import("../app/jobs/[jobId]/report/ReportStudio");
  const composition = () => JSON.parse(fixture("composition-composed5-whole.json")) as ReportComposition;
  const base = { reportVersionId: "rv-1", createdAt: "2026-10-15T09:00:00Z", scopeLabel: "Whole client", version: 2, manifestVersion: 1, snapshotId: "snap-1" };
  const draft = (issued: ReportComposition) => ({
    draftedAt: "2026-10-15T09:00:00Z", snapshotId: "snap-1", snapshotVersion: 1, sectionPlan: issued.sectionPlan!, planOrigin: "default" as const,
    scope: { kind: "whole" as const }, scopeChoices: { sites: [], unallocatedTco2e: 0, totalTco2e: 1 }, blockers: [],
  });

  it("the version the studio opens carries what publish pins — its row version, manifest and snapshot — from the register's own row", async () => {
    const { pickStudioVersion } = await import("../app/jobs/[jobId]/report/studio");
    const row = { reportVersionId: "rv-9", jobId: "712", status: "validated" as const, createdAt: "2026-10-15T09:00:00Z", publishedAt: null, scopeLabel: "Whole client", version: 4, manifestVersion: 7, snapshotId: "snap-9" };
    const opened = pickStudioVersion([row], "712")!;
    assert.deepEqual([opened.version, opened.manifestVersion, opened.snapshotId], [4, 7, "snap-9"]);
  });

  it("a validated version offers Publish — waiting on the permission check, never live before it", () => {
    const html = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "712", version: { ...base, status: "validated" as const, publishedAt: null }, composition: composition() }));
    assert.match(html, /<button type="button" class="nz-btn pri" data-studio-publish="true" disabled="" title="Checking your permissions…">Publish to client portal<\/button>/);
    assert.doesNotMatch(html, /data-studio-validate|data-studio-signee/, "a validated version is not validated again");
  });

  it("a published version offers neither publish nor validate; a draft offers validate with the signee, never publish", () => {
    const published = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "712", version: { ...base, status: "published" as const, publishedAt: "2026-10-15T10:00:00Z" }, composition: composition() }));
    assert.doesNotMatch(published, /data-studio-publish|data-studio-validate|data-studio-signee/);
    const issued = composition();
    const drafted = renderToStaticMarkup(createElement(ReportStudioPrinting, { jobId: "712", version: null, composition: issued, draft: draft(issued) }));
    assert.match(drafted, /data-studio-validate/);
    assert.match(drafted, /<select class="nz-sel"[^>]*aria-label="Report signee" data-studio-signee="true"/, "the signee is chosen beside Validate");
    assert.match(drafted, /<option value=""[^>]*>Loading signees…<\/option>/, "read, not guessed");
    assert.doesNotMatch(drafted, /data-studio-publish/);
  });

  it("publish asks once more before it sends, and is held back while the section plan has unsaved changes", () => {
    const studio = read("apps/console/app/jobs/[jobId]/report/ReportStudio.tsx");
    assert.match(studio, /onClick=\{\(\) => \{ setMessage\(null\); setConfirming\(true\); \}\}>Publish to client portal<\/button>/, "the first click only asks");
    assert.match(studio, /<button type="button" className="nz-btn pri" disabled=\{pending !== null \|\| dirty\} onClick=\{publish\}>/, "the confirmation sends");
    assert.match(studio, /if \(kind !== "validated" \|\| !version \|\| dirty \|\| pending \|\| publishAccess\.state !== "allowed"\) return;/);
    assert.match(studio, /disabled=\{dirty \|\| pending !== null \|\| publishAccess\.state !== "allowed"\}/);
    assert.match(studio, /accessFor\(me, "report\.publish"\)/, "the capability the command layer enforces (NZC-022); the server refuses the preparer");
  });

  it("the signee list is a read only — the same endpoint the job's release panel reads", () => {
    const hook = read("apps/console/app/lib/useReportSignees.ts");
    assert.match(hook, /fetch\(`\/api\/isolated\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/report-signees`, \{ cache: "no-store" \}\)/);
    assert.doesNotMatch(hook, /method:|postBrowserCommand/);
    assert.match(read("apps/console/app/jobs/CrpReleaseControl.tsx"), /\/report-signees`/);
  });
});

describe("the one path: every \"Prepare report\" opens the studio", () => {
  it("the job's report link and the register's rows ask the shared rule for the studio wherever it is on", () => {
    for (const file of ["apps/console/app/jobs/JobReportLink.tsx", "apps/console/app/reports/ReportRegisterView.tsx"]) {
      assert.match(read(file), /reportLinkFor\((row|job), \{ studio: reportFeatureEnabled\("report-sections"\) \}\)/, file);
    }
  });

  it("an old /report-preview?jobId= link or bookmark lands in the studio; the job-less picker stays the way to choose a job", () => {
    const page = read("apps/console/app/report-preview/page.tsx");
    assert.match(page, /if \(jobId && reportFeatureEnabled\("report-sections"\)\) redirect\(`\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/report\/printing`\);/);
    assert.match(page, /return <PreviewJobSelection \/>;/);
  });

  it("the studio itself never sends anyone to the old page: Preparation waits for B2-6, the empty state explains in place", () => {
    const studio = read("apps/console/app/jobs/[jobId]/report/ReportStudio.tsx");
    assert.doesNotMatch(studio, /report-preview\?jobId/);
    assert.match(studio, /\{ page: "preparation", href: null \}/);
    for (const state of ["checking", "v7", "awaiting-approval", "no-evidence", "unread"]) assert.match(studio, new RegExp(`"${state}"`), state);
  });

  it("the job header shows one way into the studio, not two: the studio button steps aside where the report link already opens it", () => {
    const link = read("apps/console/app/jobs/JobReportStudioLink.tsx");
    assert.match(link, /if \(!row \|\| !studioHasReport\(row\.stage\) \|\| !reportFeatureEnabled\("report-sections"\)\) return null;/);
    assert.match(link, /if \(reportLinkFor\(row, \{ studio: true \}\)\.kind === "prepare"\) return null;/);
  });

  it("no console page links a job to the old preparation page any more, except through the flag-off rule and the old page itself", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.tsx?$/.test(name)) files.push(path); } };
    walk(fileURLToPath(new URL("../app/", import.meta.url)));
    const linking = files.filter((file) => /report-preview\?jobId/.test(readFileSync(file, "utf8"))).map((file) => file.replace(/\\/g, "/").replace(/^.*\/app\//, "")).sort();
    // lib/crumbs.ts: the old page's own trail (reachable only with the studio off).
    assert.deepEqual(linking, ["lib/crumbs.ts"]);
  });
});
