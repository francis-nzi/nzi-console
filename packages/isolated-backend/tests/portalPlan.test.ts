import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPortalClientStrategies } from "../src/portalStrategies";

/**
 * The client-facing plan on the portal.
 *
 * The properties worth holding: it shows only what the consultant marked client-facing, it
 * is **live** rather than frozen, it carries nothing internal, and it invents no date.
 *
 * Driven through a fake `Queryable` that answers by statement, so what is asserted is what
 * the resolver does with real row shapes rather than what a stub was told to return.
 */

const TODAY = "2026-09-15";

type Row = Record<string, unknown>;
type World = { strategies: Row[]; levers: Row[]; library: Row[]; requirements: Row[] };

/** One mutable world, so a test can edit the plan and read it again — the live property. */
const world = (over: Partial<World> = {}): World => ({
  levers: [
    { lever_id: "lever-energy", lever_key: "energy", title: "Energy", icon_key: "energy", ordering: 1, active: true },
    { lever_id: "lever-travel", lever_key: "travel", title: "Travel", icon_key: "travel", ordering: 2, active: true },
    { lever_id: "lever-gone", lever_key: "gone", title: "Withdrawn theme", icon_key: "x", ordering: 3, active: false },
  ],
  library: [
    {
      strategy_id: "lib-solar", strategy_key: "solar", title: "Rooftop solar",
      description: "Install rooftop photovoltaics at the largest site.",
      scope: "2", category: "Energy", control_level: "direct_control", icon_key: "energy",
      active: true, version: 1, modelled_tco2e_per_year: null, modelled_impact_basis: null,
      lever_ids: ["lever-energy"], srs_requirement_ids: ["req-metrics"],
    },
  ],
  requirements: [
    { requirement_id: "req-metrics", code: "S2 M2", title: "Climate-related metrics" },
    { requirement_id: "req-gov", code: "S1 G1", title: "Board oversight of sustainability" },
  ],
  strategies: [],
  ...over,
});

const strategy = (over: Row = {}): Row => ({
  client_strategy_id: "cs-1", client_id: "client-a", strategy_id: "lib-solar",
  bespoke_title: null, bespoke_scope: null, bespoke_category: null,
  bespoke_control_level: null, bespoke_icon_key: null,
  status: "in_progress", owner: "mosei", target_date: "2026-11-30", progress_pct: 40,
  notes: "Client is hesitant on capex — do not raise before the March review.",
  active: true, version: 1, include_in_report: true,
  strategy_title: "Rooftop solar", strategy_scope: "2", strategy_category: "Energy",
  strategy_control_level: "direct_control", strategy_icon: "energy",
  lever_ids: ["lever-energy"], srs_requirement_ids: ["req-metrics"],
  ...over,
});

const dbFor = (state: World) => ({
  async query(sql: string) {
    // The client's plan is matched before the library: both statements name
    // `reduction_strategies`, and only this one joins it as `l` behind `client_strategies a`.
    if (sql.includes("FROM nzi_console.client_strategies a")) return { rows: state.strategies };
    if (sql.includes("FROM nzi_console.levers")) return { rows: state.levers };
    if (sql.includes("FROM nzi_console.reduction_strategies s")) return { rows: state.library };
    if (sql.includes("FROM nzi_console.srs_requirements")) return { rows: state.requirements };
    return { rows: [] };
  },
});

const read = (state: World, today = TODAY) =>
  getPortalClientStrategies(dbFor(state) as never, { clientId: "client-a", today });

const titles = (model: Awaited<ReturnType<typeof read>>) =>
  model.plan.flatMap((group) => group.strategies.map((entry) => entry.title));

describe("the portal plan view", () => {
  it("shows the client's plan grouped by lever", async () => {
    const state = world({ strategies: [strategy()] });
    const model = await read(state);
    assert.equal(model.total, 1);
    assert.deepEqual(model.plan.map((group) => group.label), ["Energy"]);
    assert.deepEqual(titles(model), ["Rooftop solar"]);
  });

  it("hides a strategy the consultant held back", async () => {
    // include_in_report is the single client-facing gate. A held-back strategy may be
    // unagreed or commercially sensitive, so it is absent — not greyed out, not a
    // placeholder, which would leak the fact that something was withheld.
    const state = world({ strategies: [strategy(), strategy({ client_strategy_id: "cs-2", include_in_report: false, strategy_title: "Held back" })] });
    const model = await read(state);
    assert.deepEqual(titles(model), ["Rooftop solar"]);
    assert.equal(model.total, 1, "and it is not counted either");
    assert.ok(!JSON.stringify(model).includes("Held back"), "nothing about it reaches the client");
  });

  it("reflects a workspace edit on the next load — it is live, not frozen", async () => {
    // The whole point of the exemption from the published-snapshot rule. The same resolver,
    // the same client, a changed record: the second read must differ from the first.
    const state = world({ strategies: [strategy()] });
    const before = await read(state);
    assert.deepEqual(titles(before), ["Rooftop solar"]);
    assert.equal(before.plan[0]!.strategies[0]!.progressPct, 40);

    // The consultant progresses it and adds a second action.
    state.strategies = [
      strategy({ progress_pct: 75 }),
      strategy({ client_strategy_id: "cs-2", strategy_title: "Rail over air", strategy_category: "Travel", lever_ids: ["lever-travel"], target_date: null, status: "planned", progress_pct: 0 }),
    ];
    const after = await read(state);
    assert.equal(after.plan[0]!.strategies[0]!.progressPct, 75, "the edit is visible without a republish");
    assert.deepEqual(after.plan.map((group) => group.label), ["Energy", "Travel"]);
    assert.equal(after.total, 2);
  });

  it("drops a held-back strategy off the portal on the next load", async () => {
    const state = world({ strategies: [strategy()] });
    assert.equal((await read(state)).total, 1);
    state.strategies = [strategy({ include_in_report: false })];
    const after = await read(state);
    assert.equal(after.total, 0, "clearing the flag removes it from the client's view");
    assert.deepEqual(after.plan, []);
  });

  it("keeps a strategy whose only lever was withdrawn, under Other", async () => {
    // A plan that quietly shortens itself because the catalogue moved on is not the plan
    // the client agreed to.
    const state = world({ strategies: [strategy({ lever_ids: ["lever-gone"] })] });
    const model = await read(state);
    assert.deepEqual(model.plan.map((group) => group.label), ["Other"]);
    assert.deepEqual(titles(model), ["Rooftop solar"]);
  });

  it("says nothing at all when the client has no plan yet", async () => {
    const model = await read(world());
    assert.equal(model.total, 0);
    assert.deepEqual(model.plan, []);
    assert.deepEqual(model.highlights, []);
  });

  it("carries no owner and no consultant notes to the client", async () => {
    // `owner` is an internal handle and `notes` is the consultant's working note. Both are
    // kept off the wire rather than merely unrendered: an unused field in a JSON response
    // is still a field the client can read.
    const state = world({ strategies: [strategy()] });
    const payload = JSON.stringify(await read(state));
    assert.ok(!payload.includes("mosei"), "no owner handle");
    assert.ok(!payload.includes("hesitant on capex"), "no consultant notes");
    assert.ok(!payload.includes("\"owner\""), "and no owner field at all");
  });

  it("describes a strategy from the catalogue, and a bespoke one not at all", async () => {
    const state = world({ strategies: [
      strategy(),
      strategy({ client_strategy_id: "cs-2", strategy_id: null, strategy_title: null, bespoke_title: "Board carbon literacy",
        strategy_scope: null, bespoke_scope: "governance", strategy_category: null, bespoke_category: "Governance",
        strategy_control_level: null, bespoke_control_level: "direct_control", lever_ids: [], notes: "Internal only." }),
    ] });
    const model = await read(state);
    const all = model.plan.flatMap((group) => group.strategies);
    assert.equal(all.find((entry) => entry.title === "Rooftop solar")?.description, "Install rooftop photovoltaics at the largest site.");
    // A bespoke strategy has no catalogue entry, so it has no description. It must not fall
    // back to `notes`, which is where the private working note lives.
    assert.equal(all.find((entry) => entry.title === "Board carbon literacy")?.description, "");
  });

  it("names the SRS requirements a strategy advances, in words", async () => {
    const state = world({ strategies: [strategy({ srs_requirement_ids: ["req-gov", "req-metrics"] })] });
    const model = await read(state);
    assert.deepEqual(model.plan[0]!.strategies[0]!.srsRequirements, [
      { code: "S1 G1", title: "Board oversight of sustainability" },
      { code: "S2 M2", title: "Climate-related metrics" },
    ]);
  });

  it("invents no date, and agrees with the deadline signals about the ones it has", async () => {
    const state = world({ strategies: [
      strategy({ target_date: null }),
      strategy({ client_strategy_id: "cs-2", strategy_title: "Overdue one", target_date: "2026-08-01" }),
    ] });
    const model = await read(state);
    const all = model.plan.flatMap((group) => group.strategies);
    const undated = all.find((entry) => entry.title === "Rooftop solar")!;
    assert.equal(undated.targetDate, null);
    assert.equal(undated.deadline.state, "none", "no date raises nothing");

    const late = all.find((entry) => entry.title === "Overdue one")!;
    assert.equal(late.deadline.state, "overdue");
    // The same derivation the #164 signals use, so the panel above and the row below cannot
    // disagree about whether the client is late.
    assert.equal(model.overdue, 1);
    assert.equal(model.highlights[0]?.title, "Overdue one");
    assert.deepEqual(model.highlights[0]?.deadline, late.deadline);
  });

  it("gives the client words rather than raw enums", async () => {
    const state = world({ strategies: [strategy()] });
    const entry = (await read(state)).plan[0]!.strategies[0]!;
    assert.equal(entry.scopeLabel, "Scope 2");
    assert.equal(entry.statusLabel, "In progress");
    assert.ok(entry.controlLevelLabel.length > 0);
    assert.ok(!entry.controlLevelLabel.includes("_"), "never the underlying key");
  });
});
