import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultReportSectionPlan } from "@nzi/contracts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * F-1b: the section-plan editors over F-1's commands — the client's report profile, the preparation page's reorder that
 * publishes the version it holds, the job page's publish pinning its version, the three routes, and the ruled CSS wrap.
 */
describe("the section-plan editors (F-1b)", () => {
  it("the editor lists the data sections in plan order, fixes the cover and the methodology, and offers an include switch on the optional sections only (F-4b)", async () => {
    (globalThis as { React?: unknown }).React = React;
    const { SectionPlanEditor } = await import("../app/reports/SectionPlanEditor");
    const html = renderToStaticMarkup(createElement(SectionPlanEditor, { plan: defaultReportSectionPlan, onChange: () => undefined }));
    const names = [...html.matchAll(/<span class="nm">([^<]+)(?:<span|<\/span>)/g)].map((match) => match[1]);
    assert.deepEqual(names, ["Carbon Reduction Plan", "Executive summary", "Emissions by scope", "Sites &amp; reporting boundary", "Emissions intensity",
      "Targets &amp; reduction pathway", "Decarbonisation actions", "UK SRS readiness statement", "Methodology &amp; provenance"]);
    assert.match(html, /Always first/);
    assert.match(html, /Always last/);
    assert.doesNotMatch(html, /narrative|Background|Net zero commitment/i, "the narrative is not drawn yet, so it is not offered");
    // One switch per optional section (sites, intensity, targets, plan, SRS) — none on the cover, summary, emissions or methodology.
    assert.equal([...html.matchAll(/type="checkbox"/g)].length, 5);
    assert.match(html, /<button type="button" class="nz-editlink" disabled="" aria-label="Move Executive summary earlier">/, "the first movable section cannot move before the cover");
    assert.match(html, /<button type="button" class="nz-editlink" disabled="" aria-label="Move UK SRS readiness statement later">/, "nor the last after the methodology");
    const editor = read("apps/console/app/reports/SectionPlanEditor.tsx");
    assert.match(editor, /setReportSectionIncluded\(plan, entry\.key, event\.target\.checked\)/, "an exclusion goes through the one contracts helper, which refuses a mandatory section");
    assert.doesNotMatch(editor, /included:\s*(false|!)/, "the editor never writes an exclusion by hand");
  });

  it("a left-out section stays listed, marked, with its switch off — so it can be put back", async () => {
    (globalThis as { React?: unknown }).React = React;
    const { SectionPlanEditor } = await import("../app/reports/SectionPlanEditor");
    const plan = defaultReportSectionPlan.map((entry) => entry.key === "targets" ? { ...entry, included: false } : entry);
    const html = renderToStaticMarkup(createElement(SectionPlanEditor, { plan, onChange: () => undefined }));
    assert.match(html, /<li class="left-out"><span class="nm">Targets &amp; reduction pathway<span class="muted"> · left out<\/span>/);
    assert.equal([...html.matchAll(/type="checkbox" checked=""/g)].length, 4, "the other four optional sections stay included");
  });

  it("the preparation page loads the validated plan, saves a reorder with the version it holds, and publishes that version", () => {
    const action = read("apps/console/app/report-preview/ReportValidationAction.tsx");
    assert.match(action, /await loadPlan\(result\.data\.reportVersionId\)/);
    assert.match(action, /\/api\/isolated\/report-versions\/\$\{encodeURIComponent\(reportVersionId\)\}\/section-plan/);
    assert.match(action, /"\/api\/isolated\/reports\/section-plan",\{reportVersionId:validated\.reportVersionId,expectedVersion:held\.version,sectionPlan:draft\}/);
    assert.match(action, /setHeld\(\{version:result\.data\.version,sectionPlan:draft,origin:result\.data\.origin\}\)/, "a saved reorder moves the version held");
    assert.match(action, /expectedVersion:held\.version,manifestVersion/, "publish pins the version held, never a constant");
    assert.doesNotMatch(action, /expectedVersion:1\b/);
    assert.match(action, /disabled=\{pending!==null\|\|!held\|\|orderDirty\}/, "an unsaved order cannot be published past");
    // Found by the rendered check: as a sibling in the gate's desktop flex row, the order block squeezed the status line to
    // nothing. It sits inside the copy column, after the version proof and before the column closes.
    const at = (needle: string) => action.indexOf(needle);
    assert.ok(at('className="nz-version-proof"') < at('className="nz-report-order"') && at('className="nz-report-order"') < at("<ReportScopeSelector"), "inside the copy column");
  });

  it("the job page publishes the version it holds (pre-existing: it sent none, so every publish from it failed validation)", () => {
    const release = read("apps/console/app/jobs/CrpReleaseControl.tsx");
    assert.match(release, /expectedStatus:"validated",expectedVersion:validated\.version,manifestVersion:validated\.manifestVersion/);
    assert.match(read("packages/isolated-backend/src/readModels.ts"), /scopeLabel:reportScopeLabel\(scope,names\),version:row\.version\}/);
  });

  it("the three command routes call F-1's commands under their own permission; the read route reads the plan", () => {
    const profile = read("apps/console/app/api/isolated/clients/[clientId]/report-profile/route.ts");
    assert.match(profile, /requireCommandPrincipal\(request, "client\.reportProfile\.set"\)/);
    assert.match(profile, /setClientReportProfile\(isolatedPool\(\), \{ \.\.\.body, clientId \}/);
    const withdraw = read("apps/console/app/api/isolated/clients/[clientId]/report-profile/deactivate/route.ts");
    assert.match(withdraw, /requireCommandPrincipal\(request, "client\.reportProfile\.deactivate"\)/);
    assert.match(withdraw, /deactivateClientReportProfile\(isolatedPool\(\), \{ \.\.\.body, clientId \}/);
    const reorder = read("apps/console/app/api/isolated/reports/section-plan/route.ts");
    assert.match(reorder, /requireCommandPrincipal\(request, "report\.sectionPlan\.update"\)/);
    assert.match(reorder, /updateReportSectionPlan\(isolatedPool\(\), body,/);
    const plan = read("apps/console/app/api/isolated/report-versions/[versionId]/section-plan/route.ts");
    assert.match(plan, /withTenantRead\(isolatedPool\(\), principal\.organisationId, \(db\) => getReportVersionSectionPlan\(db, versionId\)\)/);
    assert.doesNotMatch(plan, /export async function (POST|PUT|PATCH|DELETE)/, "read only");
  });

  it("the client workspace shows the report profile and edits it in a drawer, with the latest version the save expects", () => {
    const overview = read("apps/console/app/clients/[clientId]/OverviewArea.tsx");
    assert.match(overview, /<ReportProfileCard profile=\{workspace\.reportProfile/);
    const view = read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    assert.match(view, /drawer\?\.kind === "report-profile" \? <ReportProfileForm key=\{`profile-\$\{workspace\.reportProfile\.latestVersion\}`\}/);
    const form = read("apps/console/app/clients/[clientId]/ClientReportProfile.tsx");
    assert.match(form, /\{ expectedVersion: profile\.latestVersion, sectionPlan: plan, issuerLine: line \}/);
    assert.match(form, /postBrowserCommandWithReason<\{ version: number \}>\(`\$\{path\}\/deactivate`/, "withdrawal carries a reason");
    assert.match(form, /reportIssuerLineIssues\(line\)/, "the cover line is checked before it is sent");
  });

  it("the evidence hash wraps on a phone — CSS only, as ruled; the markup pins stay byte-identical", () => {
    const css = read("apps/console/app/reports/[versionId]/report-composed.css");
    assert.match(css, /\.nzr-tbl td:last-child\{overflow-wrap:anywhere\}/, "the value cell wraps");
    assert.doesNotMatch(css, /\.nzr-tbl td\{[^}]*overflow-wrap/, "labels keep whole words (found by the phone render: 'Standa rd')");
  });
});
