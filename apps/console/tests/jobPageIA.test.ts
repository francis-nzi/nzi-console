import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jobWorkflowStages, type JobApplicableCategories, type ScopeRowReadModel } from "@nzi/contracts";
(globalThis as { React?: unknown }).React = React;
import { buildDataEntryAccordion, categoryHasWork, scopeOpenByDefault, scopeSummary } from "../app/jobs/dataEntryAccordion";
import { JobStageStepper, StageSection, stageAnchorId, type StageStatus } from "../app/jobs/CrpStageSections";

// DESIGN-job-data-entry-usability A–C: the job page's information architecture.
const APP = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app");
const workspace = readFileSync(join(APP, "jobs/CrpScopeWorkspace.tsx"), "utf8");
const accordion = readFileSync(join(APP, "jobs/CrpDataEntryAccordion.tsx"), "utf8");

const row = (overrides: Partial<ScopeRowReadModel> = {}): ScopeRowReadModel => ({
  id: "row-a", jobId: "job-a", scope: "1", sourceLabel: "Gas", reportLabel: "Gas", notes: null,
  categoryPath: [], monthlyActivity: [], quantity: 10, unit: "kWh", datasetId: "d", factorId: "f",
  factorVersion: "v1", factorLabel: "Gas factor", qualityTier: "measured", calculatedTco2e: 1,
  overrideTco2e: null, overrideReason: null, reviewStatus: "approved", reviewedRowVersion: 1,
  reviewedBy: "r", reviewedAt: "2026-08-29", reviewerNote: null, version: 2, enabled: true,
  provenance: {}, lineage: [], ...overrides,
});
type Category = JobApplicableCategories["categories"][number];
const cat = (over: Partial<Category> & { scope: "1" | "2" | "3"; code: string; name: string }): Category => ({
  kind: "manual", entryCount: 0, tco2e: 0, completeness: 0, noData: true, ...over,
});
const applicable = (categories: Category[], includedScopes: JobApplicableCategories["includedScopes"] = ["1", "2", "3"]): JobApplicableCategories => ({ audience: "crm", includedScopes, categories });

const stages = jobWorkflowStages.crp;
const statusAt = (active: number) => (index: number): StageStatus => (index < active ? "done" : index === active ? "active" : "todo");

describe("A/B — the job stepper", () => {
  it("is the four CRP stages, numbered 1–4, done ticked, current marked, to-do muted", () => {
    assert.deepEqual([...stages], ["Setup", "Data entry", "Review & QA", "Report & publish"]);
    const html = renderToStaticMarkup(createElement(JobStageStepper, { stages, status: statusAt(2), onJump: () => {} }));
    assert.match(html, /<nav class="nz-job-stepper" aria-label="Job stages">/);
    assert.match(html, /<li class="nz-step done"><button[^>]*aria-label="Setup — complete"><span class="n">✓<\/span><span class="lb">Setup<\/span>/);
    assert.match(html, /<li class="nz-step done"><button[^>]*aria-label="Data entry — complete"><span class="n">✓<\/span>/);
    assert.match(html, /<li class="nz-step active" aria-current="step"><button[^>]*aria-label="Review &amp; QA — current stage"><span class="n">3<\/span>/);
    assert.match(html, /<li class="nz-step todo"><button[^>]*aria-label="Report &amp; publish — to do"><span class="n">4<\/span>/);
    assert.equal(html.match(/class="bar"/g)?.length, 3, "a bar between each pair of stages");
  });

  it("styles done, current and to do through the shared stepper states", () => {
    const css = readFileSync(join(APP, "../../../packages/ui/src/styles.css"), "utf8");
    assert.match(css, /\.nz-step\.done \.n\{background:var\(--emerald\);color:#fff\}/);
    assert.match(css, /\.nz-step\.active \.n\{background:var\(--midnight\);color:#fff\}/);
    assert.match(css, /\.nz-job-stepper\{/);
  });

  it("sits in the job's sticky band under the job shell, reading the recorded workflow stage", () => {
    assert.match(workspace, /<div className="nz-job-emissions">\n\s+\{shellOn \? <JobStageStepper stages=\{crpStages\} status=\{stageStatus\} onJump=\{jumpToStage\} \/> : null\}/);
    assert.match(workspace, /const activeStageIndex = Math\.max\(0, crpStages\.indexOf\(job\.header\.workflowStage\)\);/);
    // The Setup drawer's stepper reads the same recorded stage.
    assert.match(readFileSync(join(APP, "jobs/WorkflowStageControl.tsx"), "utf8"), /const activeIndex = stages\.indexOf\(job\.header\.workflowStage\);/);
  });

  it("jumps: Setup opens its drawer; every other stage scrolls to its anchor, clear of the sticky band", () => {
    const jump = workspace.slice(workspace.indexOf("const jumpToStage = (name: string) => {"), workspace.indexOf("const selectedDatasets"));
    assert.match(jump, /if \(shellOn && name === "Setup"\) \{ setShellDrawer\("setup"\); return; \}/);
    assert.match(jump, /document\.getElementById\(stageAnchorId\(name\)\)/);
    assert.match(jump, /band\.offsetHeight \+ 8/);
    assert.match(jump, /scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
    // Each stage the stepper can jump to has its anchor in the shell.
    assert.equal(stageAnchorId("Data entry"), "stage-data-entry");
    assert.match(workspace, /<section className="nz-shell-capture" aria-label="Data capture" id=\{stageAnchorId\("Data entry"\)\}>/);
    assert.match(workspace, /<div id=\{stageAnchorId\("Review & QA"\)\}>/);
    assert.match(workspace, /<div id=\{stageAnchorId\("Report & publish"\)\}>\{releaseControl\}<\/div>/);
  });

  it("leaves no orphan 3 / 4 numbers in the shell; the legacy stage layout keeps its 1–4", () => {
    const shell = workspace.slice(workspace.indexOf("const shellBody = ("), workspace.indexOf("return (\n    <AppShell"));
    assert.doesNotMatch(shell, /<StageSection n=/);
    assert.match(shell, /<StageSection name="Review & QA"/);
    assert.match(shell, /<StageSection name="Report & publish"/);
    const legacy = workspace.slice(workspace.indexOf("const stageBody = ("), workspace.indexOf("const shellSummary"));
    for (const n of [1, 2, 3, 4]) assert.match(legacy, new RegExp(`<StageSection n=\\{${n}\\}`));
    const unnumbered = renderToStaticMarkup(createElement(StageSection, { name: "Review & QA", status: "active", summary: "2 pending", open: false, onToggle: () => {}, children: null }));
    assert.match(unnumbered, /<section class="nz-stage-sec active unnumbered" id="stage-review-qa">/);
    assert.match(unnumbered, /<b>Review &amp; QA<span/);
    const done = renderToStaticMarkup(createElement(StageSection, { name: "Review & QA", status: "done", summary: "", open: false, onToggle: () => {}, children: null }));
    assert.match(done, /<span class="nz-stage-sec-n">✓<\/span>/, "a done section keeps its tick");
    const numbered = renderToStaticMarkup(createElement(StageSection, { n: 3, name: "Review & QA", status: "todo", summary: "", open: false, onToggle: () => {}, children: null }));
    assert.match(numbered, /<b>3 · Review &amp; QA/);
  });
});

describe("C — two-level collapse", () => {
  const groups = buildDataEntryAccordion([
    row({ id: "gas", categoryCode: "1.natural-gas", reviewStatus: "approved" }),
    row({ id: "fleet", categoryCode: "1.company-vehicles", reviewStatus: "pending" }),
    row({ id: "pgs", scope: "3.1", categoryCode: "3.1", reviewStatus: "approved" }),
  ], applicable([
    cat({ scope: "1", code: "1.natural-gas", name: "Natural gas", noData: false, entryCount: 1, tco2e: 30, completeness: 100 }),
    cat({ scope: "1", code: "1.company-vehicles", name: "Company vehicles", noData: false, entryCount: 1, tco2e: 10, completeness: 50 }),
    cat({ scope: "1", code: "1.refrigerants", name: "Refrigerants" }),
    cat({ scope: "3", code: "3.1", name: "Purchased goods and services", noData: false, entryCount: 1, tco2e: 60, completeness: 100 }),
    cat({ scope: "3", code: "3.6", name: "Business travel" }),
  ]));
  const [scope1, scope2, scope3] = groups;
  const category = (code: string) => groups.flatMap((group) => group.categories).find((entry) => entry.category.code === code)!;

  it("keeps every category collapsed at rest — the capture gate's rule — so complete and no-data ones are quiet", () => {
    assert.match(accordion, /const categoryOpen = isOpen\(code\);/, "a category has no open-by-default");
    assert.match(accordion, /onClick=\{\(\) => toggle\(code\)\}/);
    // "Work" is what keeps a scope open: data in, and something still needing attention.
    assert.equal(categoryHasWork(category("1.company-vehicles")), true, "data, one row pending");
    assert.equal(categoryHasWork(category("1.natural-gas")), false, "complete");
    assert.equal(categoryHasWork(category("1.refrigerants")), false, "no data");
  });

  it("collapses a scope with data and nothing to do; a scope with work, or with nothing in it yet, stays open", () => {
    assert.equal(scopeOpenByDefault(scope1!), true, "Scope 1 has a pending row");
    assert.equal(scopeOpenByDefault(scope3!), false, "Scope 3 is complete");
    assert.equal(scopeOpenByDefault(scope2!), true, "Scope 2 is empty — a new job starts as it did");
    const unsorted = buildDataEntryAccordion([row({ id: "u", scope: "3", categoryCode: null })], applicable([cat({ scope: "3", code: "3.1", name: "PG&S" })], ["3"]));
    assert.equal(scopeOpenByDefault(unsorted[0]!), true, "an unsorted row is work to do");
  });

  it("summarises a collapsed scope: entries · tCO₂e · share of the job total, from the server figures", () => {
    assert.deepEqual(scopeSummary(scope1!, groups), { entries: 2, tco2e: 40, sharePercent: 40 });
    assert.deepEqual(scopeSummary(scope3!, groups), { entries: 1, tco2e: 60, sharePercent: 60 });
    assert.deepEqual(scopeSummary(scope2!, groups), { entries: 0, tco2e: 0, sharePercent: 0 });
    const empty = buildDataEntryAccordion([], applicable([cat({ scope: "1", code: "1.natural-gas", name: "Gas" })], ["1"]));
    assert.equal(scopeSummary(empty[0]!, empty).sharePercent, null, "no total, no share — never a divide by zero");
  });

  it("renders the scope as a toggle over its categories, with the person's choice winning over the default", () => {
    assert.match(accordion, /<button type="button" className=\{`nz-acc-scopehead toggle\$\{scopeOpen \? " open" : ""\}`\} aria-expanded=\{scopeOpen\} onClick=\{\(\) => toggle\(scopeKey, scopeOpenByDefault\(group\)\)\}>/);
    assert.match(accordion, /\{scopeOpen \? <>\n\s+\{group\.categories\.map/);
    assert.match(accordion, /const isOpen = \(key: string, byDefault = false\) => opened\.get\(key\) \?\? byDefault;/);
    assert.match(accordion, /% of total/);
  });

  it("offers Collapse all and Expand all over every scope and section", () => {
    assert.match(accordion, /onClick=\{\(\) => setAll\(false\)\}>Collapse all<\/button>/);
    assert.match(accordion, /onClick=\{\(\) => setAll\(true\)\}>Expand all<\/button>/);
    const setAll = accordion.slice(accordion.indexOf("const setAll"), accordion.indexOf("return (\n    <section"));
    for (const key of ["`scope-${group.scope}`", "entry.category.code", "`imported-${group.scope}`", "`unsorted-${group.scope}`"]) assert.ok(setAll.includes(key), key);
  });
});
