import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { REPORT_STAGES, type EmissionSource, type ScopeRowReadModel, type JobApplicableCategories } from "@nzi/contracts";
import React from "react";
import { accordionKeysForRow, buildDataEntryAccordion } from "../app/jobs/dataEntryAccordion";

// These modules draw JSX as they load, under the classic runtime the tests use — so React is global before they are imported.
(globalThis as { React?: unknown }).React = React;
/* eslint-disable @typescript-eslint/no-require-imports */
const { reportStageNext } = require("../app/jobs/CrpReportStageCard") as typeof import("../app/jobs/CrpReportStageCard");
const { categorySourceKinds, scopeRegister } = require("../app/jobs/EmissionSourceRegister") as typeof import("../app/jobs/EmissionSourceRegister");
const { studioHasReport } = require("../app/jobs/[jobId]/report/studio") as typeof import("../app/jobs/[jobId]/report/studio");

// DESIGN-job-data-entry-usability D–F: retire the inline stage-4 editor, move "Add emissions source", fold the register.
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");
const read = (path: string) => readFileSync(join(APP, path), "utf8");
const workspace = read("jobs/CrpScopeWorkspace.tsx");
const card = read("jobs/CrpReportStageCard.tsx");
const accordion = read("jobs/CrpDataEntryAccordion.tsx");
const register = read("jobs/EmissionSourceRegister.tsx");
const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
const shellBody = between(workspace, "const shellBody = (", "return (\n    <AppShell");
const shellActions = between(workspace, "{shellOn ? <JobShellHeader", "</>} /> : <>");
const setupDrawer = between(workspace, "setup: { kicker: \"Job\", title: \"Setup\"", "milestones: { kicker:");

describe("D — Report & publish is the report's state and Open in Report Studio", () => {
  it("says, for every report stage, where the report stands and what comes next", () => {
    for (const stage of [...REPORT_STAGES, "v7-record" as const]) assert.ok(reportStageNext(stage, false).length > 10, stage);
    assert.match(reportStageNext("in-preparation", true), /freeze the reviewed snapshot in Review & QA/);
    assert.match(reportStageNext("in-preparation", false), /Finish calculation and independent review/);
    assert.match(reportStageNext("awaiting-review", false), /approve it in Review & QA, under Data assurance/);
    assert.match(reportStageNext("ready-to-validate", false), /validate it in the Report Studio/);
    assert.match(reportStageNext("ready-to-publish", false), /Publish it to the client portal from the Report Studio/);
  });

  it("offers Open in Report Studio as its one action, live once the studio has a report and disabled with the reason before", () => {
    assert.match(card, /const ready = studioHasReport\(row\.stage\);/);
    assert.match(card, /\? <Link className="nz-btn pri" href=\{studio\} data-report-studio-link>Open in Report Studio<\/Link>/);
    assert.match(card, /<button type="button" className="nz-btn pri" disabled aria-describedby=\{`report-stage-why-\$\{jobId\}`\}>Open in Report Studio<\/button>/);
    assert.match(card, /const studio = `\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/report\/printing`;/);
    assert.equal(studioHasReport("awaiting-review"), false);
    assert.equal(studioHasReport("ready-to-validate"), true);
    // The job's own register row — the read the header's report link uses — and a failed read is said, not guessed.
    assert.match(card, /const row = useJobReportRow\(jobId\);/);
    assert.match(card, /The report&rsquo;s state could not be read/);
    assert.doesNotMatch(card, /postBrowserCommand|putBrowserCommand|textarea/, "the card writes nothing and edits nothing");
  });

  it("replaces the inline editor and release panel in the shell's stage 4; they stay where the studio is off and in the other layouts", () => {
    assert.match(workspace, /const reportStage = reportFeatureEnabled\("report-sections"\) \? <CrpReportStageCard jobId=\{job\.header\.id\} readyForReporting=\{qa\.readyForReporting\}\/> : releaseControl;/);
    assert.match(shellBody, /<StageSection name="Report & publish"[^\n]*>\n\s+\{reportStage\}\n\s+<\/StageSection>/);
    assert.match(shellBody, /<div id=\{stageAnchorId\("Report & publish"\)\}>\{reportStage\}<\/div>/);
    assert.doesNotMatch(shellBody, /\{releaseControl\}/);
    // The editor's routes and component stay (RULING-report-studio-B2-4) — only the shell stops mounting them.
    // B2-4: the Jobs §4 editor is unmounted everywhere now — the narrative is edited in the Report Studio; its component and routes stay.
    assert.doesNotMatch(workspace, /<CrpReportSectionEditor/);
    assert.match(workspace, /const releaseControl = <>\n\s+<CrpReleaseControl /);
    assert.match(between(workspace, "const stageBody = (", "const shellSummary"), /\{releaseControl\}/);
  });
});

describe("E — Add emissions source lives in the Setup drawer", () => {
  it("is gone from the shell's header and its capture section", () => {
    assert.doesNotMatch(shellActions, /Add emissions source/);
    assert.doesNotMatch(between(shellBody, "<section className=\"nz-shell-capture\"", "</section>"), /\{createForm\}/);
  });

  it("is in the Setup drawer, with the job's data structure, and opens its form there", () => {
    assert.match(setupDrawer, /<section className="nz-panel nz-config-panel nz-add-source" aria-label="Add emissions source">/);
    assert.match(setupDrawer, /<span className="nz-eyebrow">Data structure<\/span><b>Add emissions source<\/b>/);
    assert.match(setupDrawer, /aria-controls="scope-row-editor" onClick=\{\(\) => setCreating\(!creating\)\}>\{creating \? "Close" : "\+ Add emissions source"\}<\/button>/);
    assert.match(setupDrawer, /\{createForm\}/);
  });

  it("after a save, steps the drawer aside, opens the new row and brings it into view with a notice", () => {
    const create = between(workspace, "async function create(e: React.FormEvent)", "const siteLabel = ");
    assert.match(create, /setSelectedId\(r\.data\.rowId\);/);
    assert.match(create, /if \(shellOn\) \{ setShellDrawer\(null\); setRevealRowId\(r\.data\.rowId\); \}/);
    assert.match(create, /added — it is open in the detail drawer and shown in Data entry/);
    assert.match(workspace, /revealRowId=\{revealRowId\}/);
    assert.match(accordion, /accordionKeysForRow\(buildDataEntryAccordion\(visibleAccordionRows\(rows, true\)\.rows, applicable\), revealRowId\)/);
    assert.match(accordion, /document\.querySelector\(`\[data-row-id="\$\{CSS\.escape\(revealRowId\)\}"\]`\)\?\.scrollIntoView/);
  });

  it("finds what to open for a row: its scope and its section, or Unsorted", () => {
    const row = (over: Partial<ScopeRowReadModel>): ScopeRowReadModel => ({ id: "r", jobId: "j", scope: "1", sourceLabel: "x", reportLabel: "x", notes: null, categoryPath: [], monthlyActivity: [], quantity: 1, unit: "kWh", datasetId: null, factorId: null, factorVersion: null, factorLabel: null, qualityTier: null, calculatedTco2e: null, overrideTco2e: null, overrideReason: null, reviewStatus: "pending", reviewedRowVersion: null, reviewedBy: null, reviewedAt: null, reviewerNote: null, version: 1, enabled: true, provenance: {}, lineage: [], ...over } as ScopeRowReadModel);
    const applicable: JobApplicableCategories = { audience: "crm", includedScopes: ["1", "3"], categories: [{ scope: "1", code: "1.natural-gas", name: "Gas", kind: "manual", entryCount: 1, tco2e: 1, completeness: 0, noData: false }] };
    const groups = buildDataEntryAccordion([row({ id: "gas", categoryCode: "1.natural-gas" }), row({ id: "loose", scope: "3", categoryCode: null })], applicable);
    assert.deepEqual(accordionKeysForRow(groups, "gas"), ["scope-1", "1.natural-gas"]);
    assert.deepEqual(accordionKeysForRow(groups, "loose"), ["scope-3", "unsorted-3"]);
    assert.equal(accordionKeysForRow(groups, "missing"), null);
  });
});

describe("F — the per-entity register is folded into its categories and rows (Phase 3d)", () => {
  const source = (over: Partial<EmissionSource>): EmissionSource => ({ id: "s", sourceType: "vehicle", groupId: null, scopeRowId: null, sourceName: "S", ...over } as EmissionSource);
  const full = {
    sources: [source({ id: "van", sourceType: "vehicle" }), source({ id: "car", sourceType: "vehicle", groupId: "fleet" }), source({ id: "commute", sourceType: "commuting", groupId: "staff" }), source({ id: "trip", sourceType: "travel" })],
    groups: [{ id: "fleet", name: "Fleet" }, { id: "staff", name: "Staff" }, { id: "empty", name: "Empty" }] as never[],
    rollups: [{ groupId: "fleet" }, { groupId: "staff" }] as never[],
    reportingMonths: [],
  };
  const ids = (list: ReadonlyArray<{ id: string } | { groupId: string }>) => list.map((item) => ("id" in item ? item.id : item.groupId));

  it("drops the loose section wherever the accordion is, keeping it for the layouts without one", () => {
    assert.match(workspace, /const sourceRegister = accordionOn \? null : <EmissionSourceRegister /);
    assert.doesNotMatch(shellBody, /Per-entity register/);
  });

  it("gives each source-writing category a Sources view beside its Import & templates", () => {
    assert.deepEqual(categorySourceKinds, { "1.company-vehicles": "vehicle", "3.1": "spend", "3.6": "travel", "3.7": "commuting" });
    assert.match(workspace, /return kind\?\{title:`\$\{category\.name\} — sources`,body:<EmissionSourceRegister jobId=\{job\.header\.id\}[^\n]*only=\{\{kinds:\[kind\]\}\}\/>\}:null;/);
    assert.match(workspace, /categorySources=\{categorySources\}/);
    assert.match(accordion, /\{sources \? <button type="button" className="nz-btn" onClick=\{\(\) => setImportFor\(sources\)\}>Sources<\/button> : null\}/);
    // Opening a source's row from the view hands over to the detail drawer: the view closes, the row opens.
    assert.match(workspace, /onOpenRow=\{rowId=>\{done\(\);setSelectedId\(rowId\);\}\} only=\{\{kinds:\[kind\]\}\}/);
    assert.match(accordion, /const sources = categorySources\?\.\(entry\.category, \(\) => setImportFor\(null\)\) \?\? null;/);
  });

  it("lists, by kind, that kind's sources and the roll-ups they belong to", () => {
    const vehicles = scopeRegister(full, { kinds: ["vehicle"] });
    assert.deepEqual(ids(vehicles.sources), ["van", "car"]);
    assert.deepEqual(ids(vehicles.rollups), ["fleet"]);
    assert.equal(vehicles.groups.length, 3, "every group stays choosable when adding a source");
    assert.deepEqual(ids(scopeRegister(full, { kinds: ["spend"] }).sources), []);
    assert.equal(scopeRegister(full, undefined), full, "unscoped is the whole register, unchanged");
  });

  it("from the row: a managed row shows its one source; a roll-up row its members and its roll-up", () => {
    const one = scopeRegister(full, { sourceId: "trip" });
    assert.deepEqual(ids(one.sources), ["trip"]);
    assert.deepEqual(ids(one.rollups), []);
    const members = scopeRegister(full, { groupId: "fleet" });
    assert.deepEqual(ids(members.sources), ["car"]);
    assert.deepEqual(ids(members.rollups), ["fleet"]);
    assert.deepEqual(ids(members.groups), ["fleet"]);
  });

  it("opens a managed row's source or members in its detail drawer, beside the editor", () => {
    const detail = between(workspace, "drawerState.kind === \"detail\"", "// The job shell's Setup drawer");
    assert.match(detail, /\{accordionOn && \(detailRow\.sourceId \|\| detailRow\.groupId\) \? \(/);
    assert.match(detail, /only=\{detailRow\.groupId \? \{ groupId: detailRow\.groupId \} : \{ sourceId: detailRow\.sourceId \?\? null \}\}/);
  });

  it("adds from a category's own view only, of its own kind; from the row it manages what exists", () => {
    assert.match(register, /const fromRow=Boolean\(only\?\.sourceId\|\|only\?\.groupId\);/);
    assert.match(register, /const addKinds:EmissionSourceKind\[\]=fromRow\?\[\]:\[[^;]*\]\.filter\(kind=>!only\?\.kinds\|\|only\.kinds\.includes\(kind\)\);/);
    // One full register's anchor on the page at a time; the scoped views carry none, so a row's view can sit beside a category's.
    assert.match(register, /id=\{only\?undefined:"emission-source-register"\}/);
    assert.match(register, /Spend sources come from Import &amp; templates/);
    // The same commands as before — the fold changes what is listed, not what is written.
    for (const path of ["/emission-source-groups/${groupId}/sync", "/emission-sources/${source.id}/sync", "/emission-source-groups`", "/emission-sources`", "/emission-sources/${editing.source.id}`", "/emission-sources/${source.id}/status`"]) assert.ok(register.includes(path), path);
  });
});
