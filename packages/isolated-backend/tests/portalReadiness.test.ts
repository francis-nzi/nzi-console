import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPortalClientReadiness } from "../src/portalReadiness";

/**
 * The client portal's readiness statement.
 *
 * The properties worth holding: it is **live**, it shows only a completed assessment, it
 * maps each gap to what the client is actually doing about it, and it carries nothing from
 * the consultant's working record.
 *
 * Driven through a fake `Queryable` answering by statement, so the assertions are about what
 * the resolver does with real row shapes.
 */

type Row = Record<string, unknown>;
type World = {
  framework: Row[]; standards: Row[]; pillars: Row[]; levels: Row[]; requirements: Row[];
  assessments: Row[]; items: Row[]; strategies: Row[];
};

const requirement = (id: string, pillarKey: string, over: Row = {}): Row => ({
  requirement_id: id, framework_id: "fw-1", standard_key: "S2", pillar_key: pillarKey,
  code: id.toUpperCase(), title: `Requirement ${id}`, help_text: "", weight: 1,
  source: "entered", nzi_source_key: null, target_maturity: 3, ordering: 1, active: true, ...over,
});

const world = (over: Partial<World> = {}): World => ({
  framework: [{ framework_id: "fw-1", version: 2, label: "UK SRS", status: "active", effective_from: "2026-02-25", notes: null }],
  standards: [{ framework_id: "fw-1", standard_key: "S2", label: "UK SRS S2 — Climate", description: "", climate_led: true, ordering: 1 }],
  pillars: [
    { framework_id: "fw-1", pillar_key: "governance", label: "Governance", description: "", ordering: 1 },
    { framework_id: "fw-1", pillar_key: "metrics", label: "Metrics & targets", description: "", ordering: 2 },
  ],
  levels: [0, 1, 2, 3, 4].map((level) => ({ framework_id: "fw-1", level, level_key: `l${level}`, label: `Level ${level}`, definition: "" })),
  requirements: [requirement("g1", "governance"), requirement("m1", "metrics")],
  assessments: [{
    assessment_id: "a-1", client_id: "client-a", framework_id: "fw-1", framework_version: 2,
    status: "complete", assessed_on: "2026-06-30", assessed_by: "M. Osei", completed_at: "2026-07-01T00:00:00Z",
    notes: "Client is weak on board reporting — do not put this in writing to them.",
    version: 1, sector_key: null, benchmark_percentile: null, benchmark_source: null,
  }],
  items: [],
  strategies: [],
  ...over,
});

const item = (requirementId: string, maturity: number | null, over: Row = {}): Row => ({
  assessment_id: "a-1", requirement_id: requirementId, maturity, source: "entered",
  evidence_kind: null, evidence_ref: null, evidence_note: "", owner: "internal-handle-mosei",
  due_date: null, linked_action_id: null, version: 1, ...over,
});

const strategy = (id: string, requirementIds: string[], over: Row = {}): Row => ({
  client_strategy_id: id, client_id: "client-a", strategy_id: null,
  bespoke_title: `Strategy ${id}`, bespoke_scope: "2", bespoke_category: "Energy",
  bespoke_control_level: "direct_control", bespoke_icon_key: "energy",
  status: "in_progress", owner: "internal-handle-mosei", target_date: null, progress_pct: 40,
  notes: "Internal only — client has not agreed the capex.", active: true, version: 1, include_in_report: true,
  strategy_title: null, strategy_scope: null, strategy_category: null,
  strategy_control_level: null, strategy_icon: null,
  lever_ids: [], srs_requirement_ids: requirementIds, ...over,
});

const dbFor = (state: World) => ({
  async query(sql: string) {
    if (sql.includes("FROM nzi_console.client_strategies a")) return { rows: state.strategies };
    if (sql.includes("nzi_console.srs_frameworks")) return { rows: state.framework };
    if (sql.includes("nzi_console.srs_standards")) return { rows: state.standards };
    if (sql.includes("nzi_console.srs_pillars")) return { rows: state.pillars };
    if (sql.includes("nzi_console.srs_maturity_levels")) return { rows: state.levels };
    if (sql.includes("nzi_console.srs_requirements")) return { rows: state.requirements };
    if (sql.includes("nzi_console.srs_assessment_items")) return { rows: state.items };
    if (sql.includes("nzi_console.srs_assessments")) return { rows: state.assessments };
    return { rows: [] };
  },
});

const read = (state: World) => getPortalClientReadiness(dbFor(state) as never, { clientId: "client-a" });

describe("the portal readiness statement", () => {
  it("shows the current completed assessment", async () => {
    const model = await read(world({ items: [item("g1", 2), item("m1", 1)] }));
    assert.equal(model.state, "assessed");
    if (model.state !== "assessed") return;
    assert.equal(model.assessedOn, "2026-06-30");
    assert.equal(model.frameworkVersion, 2);
    assert.deepEqual(model.pillars.map((pillar) => pillar.label), ["Governance", "Metrics & targets"]);
  });

  it("reflects a re-assessment on the next load — it is live, not frozen", async () => {
    const state = world({ items: [item("g1", 1), item("m1", 1)] });
    const before = await read(state);
    assert.equal(before.state, "assessed");
    if (before.state !== "assessed") return;
    const wasPct = before.overallPct;

    // The consultant reassesses and completes a newer one.
    state.items = [item("g1", 3, { assessment_id: "a-2" }), item("m1", 3, { assessment_id: "a-2" })];
    state.assessments = [{ ...state.assessments[0]!, assessment_id: "a-2", assessed_on: "2026-09-20" }];
    const after = await read(state);
    assert.equal(after.state, "assessed");
    if (after.state !== "assessed") return;
    assert.ok(after.overallPct > wasPct, "the new assessment is what the client sees");
    assert.equal(after.assessedOn, "2026-09-20");
  });

  it("holds a draft back rather than showing provisional scoring as a finding", async () => {
    const state = world({ items: [item("g1", 1)] });
    state.assessments = [{ ...state.assessments[0]!, status: "draft" }];
    const model = await read(state);
    assert.equal(model.state, "none");
    if (model.state !== "none") return;
    assert.match(model.reason, /in progress/);
  });

  it("says there is no assessment rather than showing nothing as zero", async () => {
    const model = await read(world({ assessments: [] }));
    assert.equal(model.state, "none");
    // A 0% would read as a score the client had been given.
    assert.ok(!JSON.stringify(model).includes("overallPct"));
  });

  it("maps each gap to the strategies addressing it, worst first", async () => {
    // g1 at 2 is 1 short; m1 at 0 is 3 short, so metrics leads.
    const model = await read(world({
      items: [item("g1", 2), item("m1", 0)],
      strategies: [strategy("s-1", ["g1"], { bespoke_title: "Board oversight" })],
    }));
    assert.equal(model.state, "assessed");
    if (model.state !== "assessed") return;
    assert.deepEqual(model.roadmap.pillars.map((pillar) => pillar.label), ["Metrics & targets", "Governance"]);
    const governance = model.roadmap.pillars.find((pillar) => pillar.label === "Governance")!;
    assert.deepEqual(governance.gaps[0]!.strategies.map((entry) => entry.title), ["Board oversight"]);
  });

  it("says honestly when nothing on the plan addresses a gap", async () => {
    const model = await read(world({ items: [item("g1", 2), item("m1", 2)], strategies: [strategy("s-1", ["g1"])] }));
    assert.equal(model.state, "assessed");
    if (model.state !== "assessed") return;
    const metrics = model.roadmap.pillars.find((pillar) => pillar.label === "Metrics & targets")!;
    assert.deepEqual(metrics.gaps[0]!.strategies, [], "and the view renders its honest marker");
    assert.equal(model.roadmap.unaddressedCount, 1);
  });

  it("excludes a withdrawn strategy, so no gap looks answered by abandoned work", async () => {
    const model = await read(world({
      items: [item("g1", 2)],
      strategies: [strategy("s-gone", ["g1"], { active: false, bespoke_title: "Abandoned" })],
    }));
    assert.equal(model.state, "assessed");
    if (model.state !== "assessed") return;
    const governance = model.roadmap.pillars.find((pillar) => pillar.label === "Governance")!;
    assert.deepEqual(governance.gaps[0]!.strategies, []);
    assert.ok(!JSON.stringify(model).includes("Abandoned"));
  });

  it("excludes a strategy held back from the client", async () => {
    // The same client-facing gate the portal plan applies: a strategy the client is not
    // shown must not appear here as the thing closing their gap.
    const model = await read(world({
      items: [item("g1", 2)],
      strategies: [strategy("s-hidden", ["g1"], { include_in_report: false, bespoke_title: "Held back" })],
    }));
    assert.equal(model.state, "assessed");
    if (model.state !== "assessed") return;
    assert.ok(!JSON.stringify(model).includes("Held back"));
  });

  it("carries nothing from the consultant's working record", async () => {
    const model = await read(world({
      items: [item("g1", 2)],
      strategies: [strategy("s-1", ["g1"])],
    }));
    const payload = JSON.stringify(model);
    assert.ok(!payload.includes("do not put this in writing"), "no assessment notes");
    assert.ok(!payload.includes("internal-handle-mosei"), "no owner handle");
    assert.ok(!payload.includes("has not agreed the capex"), "no strategy notes");
    assert.ok(!payload.includes("linkedActionId"), "no internal linkage field");
  });
});
