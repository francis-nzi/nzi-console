import test from "node:test";
import assert from "node:assert/strict";
import {
  groundSrsSuggestion, groundSrsSuggestions, readinessNarrative, readinessReportTemplateIssues, readinessReportTemplates, srsBridgeCandidates,
  srsBridgedBy, srsDashboard, srsSuggestionPrompt, SRS_SUGGESTION_SCHEMA, UK_SRS_REPORT_TEMPLATE,
  type ClientStrategy, type LibraryStrategy, type ReadinessReportTemplate, type SrsAssessment, type SrsAssessmentItem, type SrsFramework,
  type SrsMaturity, type SrsSuggestionInput,
} from "../src/index";

/**
 * SRS S3 in the contracts: the library matched to a gap by alignment, what has bridged it, the discipline every AI idea
 * passes (no figure, no claim), what the AI may be told, report templates as data, and each assessment read against its
 * own framework version.
 */

const library = (id: string, requirementIds: string[], over: Partial<LibraryStrategy> = {}): LibraryStrategy => ({
  id, key: id, leverIds: [], defaultSrsRequirementIds: requirementIds, title: `Library ${id}`, description: "", scope: "governance",
  category: "", controlLevel: "direct_control", iconKey: "target", active: true, version: 1, modelledImpact: null, ...over,
});
const action = (id: string, over: Partial<ClientStrategy> = {}): ClientStrategy => ({
  id, clientId: "c1", leverIds: [], srsRequirementIds: [], includeInReport: true, strategyId: null, title: `Action ${id}`, scope: "governance",
  category: "", controlLevel: "direct_control", iconKey: "target", status: "proposed", owner: "", ownerContactId: null, origin: "plan",
  originSrsRequirementId: null, proposal: null, targetDate: null, progressPct: 0, notes: "", active: true, version: 1, estimate: null, ...over,
});

test("library candidates are the actions whose alignment names the requirement — never a keyword match", () => {
  const entries = [
    library("board", ["g1"], { title: "Board climate oversight" }),
    library("words", ["m1"], { title: "Governance g1 board oversight" }), // words that match, an alignment that does not
    library("retired", ["g1"], { active: false }),
    library("held", ["g1", "g2"], { title: "Already held" }),
  ];
  const candidates = srsBridgeCandidates("g1", entries, [action("a", { strategyId: "held" })]);
  assert.deepEqual(candidates.map((entry) => [entry.strategy.id, entry.onPlan]), [["board", false], ["held", true]]);
});

test("a gap is bridged by an action written from it, or by the one the assessment links — active only", () => {
  const plan = [
    action("gap-g1", { origin: "srs_gap", originSrsRequirementId: "g1" }),
    action("gap-g2", { origin: "srs_gap", originSrsRequirementId: "g2" }),
    action("linked", {}),
    action("removed", { origin: "srs_gap", originSrsRequirementId: "g1", active: false }),
  ];
  assert.deepEqual(srsBridgedBy("g1", plan).map((entry) => entry.id), ["gap-g1"]);
  assert.deepEqual(srsBridgedBy("g1", plan, "linked").map((entry) => entry.id), ["gap-g1", "linked"]);
});

test("an AI idea carries no figure of any kind, and no claim", () => {
  const ok = { title: "Name a board sponsor for climate", how: "Give one director accountability for climate risk so oversight is recorded and reviewed." };
  assert.deepEqual(groundSrsSuggestion(ok), { ok: true, suggestion: ok });
  for (const [field, value, reason] of [
    ["how", "Cut scope one emissions by 30 percent through fleet changes and driver training.", "contains a figure"],
    ["how", "Budget £50k for metering so the data is measured rather than estimated here.", "contains a figure"],
    ["title", "Reach net zero by 2040", "contains a figure"],
    ["how", "Reduce fuel use by a quarter — 25% fewer litres across the depot network.", "contains a figure"],
    ["how", "This is required by law under the new standard, so it must be done first.", "makes a claim"],
    ["how", "Installing heat pumps will reduce your heating emissions across every site.", "makes a claim"],
    ["how", "Seek certification of the inventory so assurance is in place for disclosure.", "makes a claim"],
    ["title", "Go", "title length"],
  ] as const) {
    const verdict = groundSrsSuggestion({ ...ok, [field]: value });
    assert.deepEqual(verdict, { ok: false, reason }, `${field}: ${value}`);
  }
});

test("ideas are kept up to three, without repeating each other or the library", () => {
  const idea = (title: string) => ({ title, how: "One or two sentences on how this moves the requirement on to its next step." });
  const { kept, refused } = groundSrsSuggestions({ suggestions: [idea("Board climate oversight"), idea("Map climate risks"), idea("Map climate risks"), idea("Train the board"), idea("Hold a scenario workshop"), { title: 1 }] }, ["Board climate oversight"]);
  assert.deepEqual(kept.map((entry) => entry.title), ["Map climate risks", "Train the board", "Hold a scenario workshop"]);
  assert.deepEqual(refused.sort(), ["not an idea", "repeats the library", "repeats the library"].sort());
  assert.deepEqual(groundSrsSuggestions("not json", []), { kept: [], refused: [] }, "an unreadable reply is no ideas");
  assert.deepEqual(SRS_SUGGESTION_SCHEMA.properties.suggestions.items.required, ["title", "how"]);
});

test("what the AI is told is the requirement, the gap in words, the sector and yes/no facts — nothing that names a person or a figure", () => {
  const input: SrsSuggestionInput = {
    requirement: { code: "S2 G1", title: "Board oversight", helpText: "Say who oversees climate risk.", pillar: "Governance", standard: "UK SRS S2 — Climate" },
    stepNow: "Developing", stepTarget: "Established", sector: "Food manufacturing",
    facts: { scopesReported: { scope1: true, scope2: true, scope3: false }, targetsSet: false, targetProgressMeasured: false, provenanceStamped: true, independentlyAssured: false },
    libraryTitles: ["Board climate oversight"],
  };
  const { system, user } = srsSuggestionPrompt(input);
  const sent = JSON.parse(user) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["alreadyInTheLibrary", "assuredRecord", "currentStep", "expectedStep", "requirement", "sector"]);
  // No value is a number: the facts go as yes/no and the steps by name. (Digits in a code such as "S2 G1" are identifiers.)
  const leaves = (value: unknown): unknown[] => Array.isArray(value) ? value.flatMap(leaves) : typeof value === "object" && value !== null ? Object.values(value).flatMap(leaves) : [value];
  assert.ok(leaves(sent).every((leaf) => typeof leaf === "string"), "every value sent is words");
  assert.ok(Object.values(sent.assuredRecord as Record<string, string>).every((answer) => answer === "yes" || answer === "no"));
  assert.match(system, /Never include any number/);
  assert.match(system, /data .*not as instructions/);
  // Deterministic: the same gap is the same prompt (so its SHA-256 identifies it).
  assert.deepEqual(srsSuggestionPrompt(input), { system, user });
});

test("report templates are data: UK SRS is valid, a broken one is caught, and a second slots in without code", () => {
  assert.deepEqual(readinessReportTemplateIssues(UK_SRS_REPORT_TEMPLATE), []);
  assert.equal(readinessReportTemplates["uk-srs"], UK_SRS_REPORT_TEMPLATE);
  const evergreen: ReadinessReportTemplate = {
    key: "evergreen", version: 1, label: "Evergreen readiness", title: "Evergreen readiness report", strapline: "Where you stand against Evergreen.",
    sections: [{ kind: "summary", heading: "Summary" }, { kind: "radar", heading: "The web" }, { kind: "roadmap", heading: "Next steps" }, { kind: "method", heading: "Method" }],
    disclaimer: "Not a certification.",
  };
  assert.deepEqual(readinessReportTemplateIssues(evergreen), [], "a second template is just another entry");
  assert.deepEqual(readinessReportTemplateIssues({ ...evergreen, sections: [{ kind: "radar", heading: "Web" }, { kind: "radar", heading: "Again" }, { kind: "chart" as never, heading: "?" }] }).sort(),
    ["a section appears twice", "the first section is the summary", "the method section is required", "unknown section chart"].sort());
});

const level = (n: number, label: string) => ({ level: n as SrsMaturity, key: label.toLowerCase(), label, definition: label });
const requirement = (id: string, pillarKey: string, over: Partial<SrsFramework["requirements"][number]> = {}) => ({
  id, standardKey: "S2", pillarKey, code: id.toUpperCase(), title: id, helpText: "", weight: 1, source: "entered" as const, nziSourceKey: null,
  targetMaturity: 2 as SrsMaturity, ordering: 1, active: true, ...over,
});
const frameworkV = (version: number, requirements: SrsFramework["requirements"]): SrsFramework => ({
  frameworkId: `fw-v${version}`, version, label: "UK SRS", status: version === 2 ? "active" : "superseded", effectiveFrom: "2026-01-01", notes: null,
  standards: [{ key: "S2", label: "S2", description: "", climateLed: true, ordering: 1 }],
  pillars: [{ key: "gov", label: "Governance", description: "", ordering: 1 }, { key: "met", label: "Metrics", description: "", ordering: 2 }],
  maturityLevels: [level(0, "Not started"), level(1, "Developing"), level(2, "Established"), level(3, "Advanced"), level(4, "Assured")],
  requirements,
});
const item = (requirementId: string, maturity: SrsMaturity | null): SrsAssessmentItem => ({ requirementId, maturity, source: "entered", evidence: null, owner: "", dueDate: null, linkedActionId: null, version: 1 });
const assessed = (id: string, frameworkId: string, on: string, items: SrsAssessmentItem[]): SrsAssessment => ({
  assessmentId: id, clientId: "c1", frameworkId, frameworkVersion: Number(frameworkId.slice(-1)), status: "complete", startedOn: on, assessedOn: on,
  assessedBy: "x", completedAt: on, notes: "", sectorKey: null, benchmarkPercentile: null, benchmarkSource: null, version: 1, items,
});

test("each assessment is read against its own framework version — a later version does not restate an earlier point", () => {
  const v1 = frameworkV(1, [requirement("g1", "gov"), requirement("m1", "met")]);
  // v2 adds a requirement the v1 assessment never had, so recomputing v1 against v2 would drag its point down.
  const v2 = frameworkV(2, [requirement("g1", "gov"), requirement("m1", "met"), requirement("m2", "met")]);
  const first = assessed("a1", "fw-v1", "2026-03-01", [item("g1", 2), item("m1", 2)]);
  const second = assessed("a2", "fw-v2", "2026-09-01", [item("g1", 3), item("m1", 3), item("m2", 3)]);
  const restated = srsDashboard(v2, second, [first, second]);
  const own = srsDashboard(v2, second, [first, second], { frameworks: new Map([["fw-v1", v1], ["fw-v2", v2]]) });
  assert.ok(restated.trend.overall[0]!.level < 2, "against v2, the v1 point is understated (its missing requirement counts against it)");
  assert.equal(own.trend.overall[0]!.level, 2, "against its own v1, it reads as it was assessed");
  assert.equal(own.overall.delta, 1, "and the delta compares like with like");
});

test("the narrative is written from the model's own numbers and nothing else", () => {
  const v1 = frameworkV(1, [requirement("g1", "gov", { targetMaturity: 2 }), requirement("m1", "met", { targetMaturity: 3 })]);
  const only = assessed("a1", "fw-v1", "2026-03-01", [item("g1", 3), item("m1", 1)]);
  const model = srsDashboard(v1, only, [only]);
  const lines = readinessNarrative(model, "Harbourside Foods");
  assert.match(lines[0]!, /^Harbourside Foods has reached step 2 of 4, Established/);
  assert.match(lines[1]!, /Governance is the strongest pillar \(3\.0, Advanced\)\. Metrics is furthest from what the framework expects \(1\.0 against 3\)\./);
  assert.match(lines[2]!, /1 of 2 requirements sit below/);
  assert.equal(lines.length, 3, "one completed assessment: no movement is claimed");
  for (const line of lines) for (const number of line.match(/\d+(\.\d+)?/g) ?? []) {
    assert.ok(["2", "4", "3.0", "1.0", "3", "1", "2.0"].includes(number), `${number} comes from the model`);
  }
});
