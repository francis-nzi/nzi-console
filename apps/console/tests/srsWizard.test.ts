import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SrsAssessment, SrsAssessmentItem, SrsFramework, SrsMaturity } from "@nzi/contracts";

import { addressedCount, canComplete, entersNewPillar, maturityMap, pillarSummary, resumeIndex, wizardSteps } from "../app/clients/[clientId]/srsWizard";

/**
 * SRS guided assessment (BRIEF-srs-assessment-ux): conducting is a one-question-per-screen modal; the page only reviews.
 * The logic is tested as functions, the screen as rendered markup, and the page's layout as source (as the neighbouring
 * SRS console tests do) because the page is a client component over a whole workspace read model.
 */
(globalThis as { React?: unknown }).React = React;
// The design system and the wizard are imported after React is on the global (the console compiles JSX with the classic runtime in tests).
let SrsWizard: typeof import("../app/clients/[clientId]/SrsAssessmentForms").SrsWizard;
before(async () => { ({ SrsWizard } = await import("../app/clients/[clientId]/SrsAssessmentForms")); });
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const level = (n: number, label: string) => ({ level: n as SrsMaturity, key: label.toLowerCase(), label, definition: `${label} definition` });
const requirement = (id: string, pillarKey: string, ordering: number) => ({
  id, standardKey: "S2", pillarKey, code: id.toUpperCase(), title: `Requirement ${id}`, helpText: `What ${id} asks`,
  weight: 1, source: "entered" as const, nziSourceKey: null, targetMaturity: 2 as SrsMaturity, ordering, active: true,
});
const framework: SrsFramework = {
  frameworkId: "uk-srs-2026", version: 2, label: "UK SRS", status: "active", effectiveFrom: null, notes: null,
  standards: [{ key: "S2", label: "UK SRS S2", description: "", climateLed: true, ordering: 1 }],
  pillars: [
    { key: "governance", label: "Governance", description: "Who is accountable.", ordering: 1 },
    { key: "strategy", label: "Strategy", description: "What is planned.", ordering: 2 },
    { key: "risk", label: "Risk management", description: "How risk is run.", ordering: 3 },
    { key: "metrics", label: "Metrics & targets", description: "What is measured.", ordering: 4 },
  ],
  maturityLevels: [level(0, "Not started"), level(1, "Developing"), level(2, "Established"), level(3, "Advanced"), level(4, "Verified")],
  requirements: [
    requirement("g1", "governance", 1), requirement("g2", "governance", 2),
    requirement("s1", "strategy", 1), requirement("s2", "strategy", 2),
    requirement("r1", "risk", 1), requirement("m1", "metrics", 1),
  ],
};
const item = (requirementId: string, maturity: SrsMaturity | null): SrsAssessmentItem => ({
  requirementId, maturity, source: "entered", evidence: null, owner: "", dueDate: null, linkedActionId: null, priority: null, version: 1,
});
const assessment = (items: SrsAssessmentItem[], status: "draft" | "complete" = "draft"): SrsAssessment => ({
  assessmentId: "a1", clientId: "c1", frameworkId: framework.frameworkId, frameworkVersion: 2, status,
  startedOn: "2026-09-01", assessedOn: status === "complete" ? "2026-10-01" : null, assessedBy: "Ada", completedAt: status === "complete" ? "2026-10-01" : null,
  notes: "", sectorKey: null, benchmarkPercentile: null, benchmarkSource: null, version: 3, items,
});
const allowed = { state: "allowed" as const };
const render = (a: SrsAssessment, startAt: string | null = null, access: import("../app/lib/useEditAccess").EditAccess = allowed) =>
  renderToStaticMarkup(createElement(SrsWizard, { framework, assessment: a, startAt, access, plan: [], closeRef: { current: null }, onClose: () => {}, onBridge: () => {}, onCompleted: () => {} }));
const completeButton = (html: string) => html.match(/<button[^>]*>Complete assessment<\/button>/)?.[0] ?? "";
const everyItem = (maturity: SrsMaturity | null) => framework.requirements.map((r) => item(r.id, maturity));

describe("the wizard's rules", () => {
  const steps = wizardSteps(framework);

  it("walks every active requirement, one step each, grouped by pillar in the framework's order", () => {
    assert.deepEqual(steps.map((s) => s.requirement.id), ["g1", "g2", "s1", "s2", "r1", "m1"]);
    assert.deepEqual(steps.map((s) => [s.indexInPillar, s.pillarSize]), [[0, 2], [1, 2], [0, 2], [1, 2], [0, 1], [0, 1]]);
  });

  it("resumes on the first requirement with no maturity — and a zero is an answer, not a gap", () => {
    assert.equal(resumeIndex(steps, maturityMap([item("g1", 0), item("g2", 3), item("s1", null)])), 2);
    assert.equal(resumeIndex(steps, maturityMap([item("g1", 0), item("g2", 1)])), 2, "an unanswered requirement with no item at all");
    assert.equal(resumeIndex(steps, maturityMap(everyItem(2))), 0, "everything answered lands on the first question");
  });

  it("completes only when every requirement has a maturity", () => {
    assert.equal(canComplete(steps, maturityMap(everyItem(null))), false);
    assert.equal(canComplete(steps, maturityMap([...everyItem(1).slice(0, 5), item("m1", null)])), false);
    assert.equal(canComplete(steps, maturityMap(everyItem(0))), true, "Not started is an answer");
    assert.equal(addressedCount(steps, maturityMap(everyItem(1))), 6);
  });

  it("marks the step into a new pillar, and only that one", () => {
    assert.deepEqual(steps.map((_, i) => i < steps.length - 1 && entersNewPillar(steps, i, i + 1)), [false, true, false, true, true, false]);
  });

  it("summarises a pillar for its header: step, average, addressed — or says it is not assessed", () => {
    assert.equal(pillarSummary(framework, "governance", [item("g1", 2), item("g2", 3)]).text, "Advanced · avg 2.5 · 2/2 addressed");
    assert.equal(pillarSummary(framework, "strategy", [item("s1", 2)]).text, "Developing · avg 1.0 · 1/2 addressed");
    assert.equal(pillarSummary(framework, "risk", []).text, "Not yet assessed · 0/1 addressed");
  });
});

describe("the wizard screen", () => {
  it("shows one question at a time, with its pillar and standard, progress, and a jump-to-section menu of the pillars", () => {
    const html = render(assessment([item("g1", 2), item("g2", 2)]));
    assert.match(html, /Strategy · S2/, "opens on the first unaddressed question — s1, under Strategy");
    assert.match(html, /<h3>Requirement s1<\/h3>/);
    assert.equal((html.match(/<h3>/g) ?? []).length, 1, "one question on screen");
    assert.doesNotMatch(html, /Requirement s2|Requirement g1|Requirement m1/);
    assert.match(html, /<b>3 of 6<\/b>/);
    const jump = html.match(/<select[^>]*aria-label="Jump to section"[\s\S]*?<\/select>/)?.[0] ?? "";
    for (const pillar of ["Governance", "Strategy", "Risk management", "Metrics &amp; targets"]) assert.match(jump, new RegExp(pillar));
  });

  it("carries every field inline: maturity 0–4, evidence, priority, owner, target date, gap → action", () => {
    const html = render(assessment([]), "g1");
    for (const rung of ["0 · Not started", "1 · Developing", "2 · Established", "3 · Advanced", "4 · Verified"]) assert.match(html, new RegExp(rung));
    for (const field of [">Kind<", ">Priority<", ">Owner<", ">Target date<", ">Gap → action<"]) assert.match(html, new RegExp(field));
    assert.match(html, /<option value="high">High<\/option><option value="medium">Medium<\/option><option value="low">Low<\/option>/);
    assert.match(html, /SRS expects <b>Established<\/b>/, "the target maturity");
  });

  it("lands on a requested question (a register row's Edit)", () => {
    assert.match(render(assessment(everyItem(2)), "r1"), /<h3>Requirement r1<\/h3>/);
  });

  it("keeps Complete disabled until every requirement has a maturity", () => {
    assert.match(completeButton(render(assessment(everyItem(null)))), /aria-disabled="true"/);
    assert.match(completeButton(render(assessment([...everyItem(2).slice(0, 5)]))), /aria-disabled="true"/, "one still unanswered");
    assert.doesNotMatch(completeButton(render(assessment(everyItem(2)))), /aria-disabled/);
    assert.doesNotMatch(completeButton(render(assessment(everyItem(0)))), /aria-disabled/, "Not started everywhere is still every requirement answered");
  });

  it("is read-only once the assessment is complete: locked, inputs disabled, no Complete", () => {
    const html = render(assessment(everyItem(3), "complete"));
    assert.match(html, /Scores locked/);
    assert.doesNotMatch(html, /Complete assessment/);
    assert.doesNotMatch(html, /<input type="radio"(?![^>]*disabled)/);
    assert.match(html, /<select class="nz-sel" disabled=""[^>]*>/);
  });

  it("is read-only, with the reason, for someone without srs.manage", () => {
    const html = render(assessment(everyItem(null)), null, { state: "denied", reason: "You need srs.manage." });
    assert.match(html, /You need srs\.manage\./);
    assert.match(html, /<input type="radio"[^>]*disabled/);
  });
});

describe("the review page", () => {
  const area = read("app/clients/[clientId]/SrsArea.tsx");

  it("no longer has the 'Every requirement, by pillar' card grid", () => {
    assert.doesNotMatch(area, /Every requirement, by pillar/);
    assert.doesNotMatch(area, /SrsHeatmap|groupByPillar/);
  });

  it("cuts the register into collapsible pillar sections whose header carries the rollup, collapsed by default", () => {
    assert.match(area, /<Collapsible key=\{pillar\.key\} title=\{pillar\.label\} count=\{pillarSummary\(/);
    assert.doesNotMatch(area, /<Collapsible[^>]*defaultOpen/);
    assert.equal((area.match(/Requirement register/g) ?? []).length, 1, "one title for the card; the sections carry the rollup, not a second title");
  });

  it("scores nothing inline: Edit and View open the wizard at that question", () => {
    assert.match(area, /onWizard\(assessment\.assessmentId, requirement\.id\)/);
    assert.doesNotMatch(area, /kind: "srs-item"|kind: "srs-assess"/);
  });

  it("opens the wizard from Continue assessment, and straight after a start", () => {
    assert.match(area, /onClick=\{\(\) => onWizard\(current\.assessmentId\)\}>Continue assessment/);
    assert.match(area, /openOnArrival/);
    assert.match(area, /onStarted\(\);/);
  });

  it("shows scores locked with the date and result, and Reopen to correct calls srs.assessment.reopen", () => {
    assert.match(area, /scores locked · overall \{model\.overall\.stepName\}/);
    assert.match(area, />\{reopening \? "Reopening…" : "Reopen to correct"\}</);
    assert.match(area, /patchBrowserCommand\(`\/api\/isolated\/srs-assessments\/\$\{encodeURIComponent\(assessment\.assessmentId\)\}`,\s*\{ expectedVersion: assessment\.version \}/);
    assert.match(read("app/api/isolated/srs-assessments/[assessmentId]/route.ts"), /export async function PATCH[\s\S]*"srs\.assessment\.reopen"/);
  });

  it("completes in the wizard only: the page has no second Complete path", () => {
    assert.doesNotMatch(area, /Complete assessment/);
    assert.match(read("app/clients/[clientId]/SrsAssessmentForms.tsx"), /Complete assessment/);
  });

  it("keeps the 0–4 ladder and the pre-fill override inside the wizard", () => {
    const forms = read("app/clients/[clientId]/SrsAssessmentForms.tsx");
    assert.match(forms, /framework\.maturityLevels\.map/);
    assert.match(forms, /Override it if the disclosure needs something different/);
    assert.match(forms, /srs\.assessment\.item\.set|putBrowserCommand/);
    assert.match(forms, /expectedVersion: versions\.current\[requirement\.id\] \?\? 0/);
  });
});
