import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * Reduction Strategies. The rules worth holding: the library is Admin-managed and the plan
 * is not; levers are a many-to-many categorisation and control level is a separate axis;
 * removing keeps history; the plan never borrows the authority of the measurement half; and
 * nothing fabricates a reduction figure.
 */
describe("Reduction Strategies", () => {
  // 0075 created the model; 0078 restructured it. Constraints live where they were created,
  // so assertions read whichever file actually holds the thing being asserted.
  const created = read("packages/isolated-backend/migrations/0075_action_lever_library.sql");
  const restructured = read("packages/isolated-backend/migrations/0078_reduction_strategies.sql");
  const backend = read("packages/isolated-backend/src/reductionStrategies.ts");
  const contract = read("packages/contracts/src/reductionStrategies.ts");
  const commands = read("packages/contracts/src/commands.ts");
  const area = read("apps/console/app/clients/[clientId]/ReductionStrategiesArea.tsx");
  const forms = read("apps/console/app/clients/[clientId]/StrategyForms.tsx");

  it("keeps the library Admin-managed and the plan consultant-managed", () => {
    // A consultant builds a plan from the library but does not get to redefine the library
    // while doing it — different jobs, different blast radii.
    for (const key of ["strategy.library.upsert", "strategy.library.deactivate"]) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "admin\\.lookups"`), key);
    }
    for (const key of ["client.strategy.assign", "client.strategy.update", "client.strategy.remove"]) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "strategy\\.manage"`), key);
    }
    const permissions = read("packages/contracts/src/permissions.ts");
    const consultant = /consultant: \{([\s\S]*?)\n  \},/.exec(permissions)?.[1] ?? "";
    assert.ok(consultant.includes("strategy.manage"), "a consultant builds the plan");
    assert.ok(!consultant.includes("admin.lookups"), "and does not edit the library");
  });

  it("renames the capability as a new matrix version rather than editing one", () => {
    // A principal resolved against an earlier version must keep meaning what it meant.
    assert.match(read("packages/contracts/src/permissions.ts"), /PERMISSION_MATRIX_VERSION = 3/);
    const v3 = read("packages/isolated-backend/migrations/0079_strategy_capability.sql");
    assert.match(v3, /INSERT INTO nzi_console\.staff_capability_matrix_versions[\s\S]*VALUES \(3,/);
    assert.match(v3, /\(3, 'consultant', 'strategy\.manage', 'all'\)/);
    // The frozen earlier versions still say what they said.
    assert.match(read("packages/isolated-backend/migrations/0073_training_capabilities.sql"), /'actions\.manage'/);
  });

  it("nothing in the app still calls them Actions", () => {
    for (const source of [area, forms, contract, backend]) {
      assert.doesNotMatch(source, /\bactions\.manage\b/);
      assert.doesNotMatch(source, /\bActionsArea\b/);
    }
    assert.match(read("apps/console/app/clients/[clientId]/clientAreas.ts"), /strategies: "Reduction Strategies"/);
    // And it is never bare "Strategies" — `Strategy` is already an SRS pillar.
    assert.match(area, /never bare "Strategies"/);
  });

  it("makes levers a many-to-many categorisation, with control level a separate axis", () => {
    assert.match(restructured, /CREATE TABLE nzi_console\.levers/);
    assert.match(restructured, /CREATE TABLE nzi_console\.strategy_levers/);
    assert.match(restructured, /PRIMARY KEY \(organisation_id, strategy_id, lever_id\)/);
    assert.match(contract, /export type Lever = \{/);
    assert.match(contract, /leverIds: string\[\]/);
    // Control level survives as its own single-value axis.
    assert.match(contract, /export const strategyControlLevels = \["direct_control", "supply_chain", "influence"\]/);
    assert.match(restructured, /Control level stays a \*\*separate single-value axis\*\*/);
  });

  it("shows a strategy under every lever it belongs to", () => {
    // That is what a many-to-many grouping means; hiding it from one of its themes would
    // make the grouping lie.
    assert.match(contract, /strategy\.leverIds\.includes\(lever\.id\)/);
    assert.match(contract, /appears under both/);
  });

  it("never drops a strategy whose lever was withdrawn", () => {
    // A plan grouped by lever would otherwise get quietly shorter than the one agreed.
    assert.match(contract, /export function strategiesWithoutLever/);
    assert.match(area, /strategiesWithoutLever\(plan, levers\)/);
    assert.match(area, /Not yet allocated to a lever/);
  });

  it("collapses lever sections per the collapsible-cards convention", () => {
    assert.match(area, /aria-expanded=\{!collapsed\}/);
    assert.match(area, /aria-controls=\{bodyId\}/);
    assert.match(area, /Open all/);
    assert.match(area, /Collapse all/);
    // A collapsed group still says how much is inside it.
    assert.match(area, /\{strategies\.length\} \{strategies\.length === 1 \? "strategy" : "strategies"\}/);
    // Per-viewer convenience, never load-bearing.
    assert.match(area, /never load-bearing/);
  });

  it("deactivates rather than deletes, everywhere that carries history", () => {
    for (const table of ["reduction_strategies", "client_strategies"]) {
      assert.match(created, new RegExp(`REVOKE DELETE ON nzi_console\\.${table.replace("reduction_strategies", "action_levers").replace("client_strategies", "client_actions")}`), table);
    }
    assert.match(restructured, /REVOKE DELETE ON nzi_console\.levers/);
    assert.match(backend, /SET active=false/);
    assert.match(commands, /"client\.strategy\.remove"[^}]*reasonRequired: true/);
    assert.match(commands, /"strategy\.library\.deactivate"[^}]*reasonRequired: true/);
    // The join is the exception, and says why: re-allocating is an edit, not a record.
    assert.match(restructured, /GRANT SELECT, INSERT, DELETE ON nzi_console\.strategy_levers/);
    assert.match(restructured, /carries no history of its own/);
  });

  it("keeps a withdrawn library strategy on the plans that hold it", () => {
    assert.match(backend, /WITHDRAWN/);
    assert.match(contract, /not offered to anyone new/);
  });

  it("holds one meaning of done, in the database and in the form", () => {
    assert.match(created, /CHECK \(\(status = 'complete'\) = \(progress_pct = 100\)\)/);
    assert.match(commands, /A complete action is at 100%, and an action at 100% is complete/);
    assert.match(forms, /strategyProgressForStatus|strategyStatusForProgress/);
  });

  it("refuses the same library strategy twice on one plan", () => {
    assert.match(created, /CREATE UNIQUE INDEX client_actions_one_live_per_lever_idx/);
    assert.match(restructured, /_one_live_per_lever_', '_one_live_per_strategy_'/);
    assert.match(backend, /ALREADY_ASSIGNED/);
  });

  it("takes a library strategy's wording from the library, not a stale copy", () => {
    assert.match(backend, /LEFT JOIN nzi_console\.reduction_strategies l ON \(l\.organisation_id, l\.strategy_id\) = \(a\.organisation_id, a\.strategy_id\)/);
    assert.match(backend, /title: row\.strategy_title \?\? row\.bespoke_title/);
    assert.match(created, /CONSTRAINT client_actions_lever_or_bespoke CHECK/);
  });

  it("never fabricates a reduction figure", () => {
    assert.match(created, /CONSTRAINT action_levers_modelled_impact_sourced/);
    const seed = /INSERT INTO nzi_console\.action_levers[\s\S]*?ON CONFLICT DO NOTHING;/.exec(created)?.[0] ?? "";
    assert.ok(seed.length > 0 && !seed.includes("modelled_"), "no seeded strategy claims an impact");
    assert.match(area, /Stage 2, and\s*\n?\s*nothing on this screen estimates it/);
    assert.match(area, /not a modelled reduction/);
  });

  it("keeps the plan distinct from the measurement", () => {
    assert.match(area, /PLAN half of a CRP/);
    const strip = (text: string) => text.replace(/^\s*--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(strip(backend), /scope_rows|factor_id|quality_tier/);
    assert.doesNotMatch(strip(restructured), /scope_rows|factor_id|quality_tier/);
  });

  it("uses the curated icon set, not emoji", () => {
    assert.match(area, /NziIcon/);
    for (const source of [area, forms]) {
      assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
    const iconFile = read("packages/ui/src/NziIcon.tsx");
    const seeded = [...restructured.matchAll(/'(energy|building|vehicle|handshake|tools|recycle|policy)'/g)].map(([, key]) => key);
    assert.ok(seeded.length > 0, "levers are seeded with icon keys");
    for (const key of new Set(seeded)) assert.match(iconFile, new RegExp(`\\b${key}:`), `${key} must exist in NziIcon`);
  });

  it("renders as a real area rather than the unavailable placeholder", () => {
    assert.match(read("apps/console/app/clients/[clientId]/clientAreas.ts"), /BUILT_AREAS[\s\S]*?"strategies"/);
    const view = read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    assert.match(view, /area === "strategies" \? <ReductionStrategiesArea/);
    assert.match(view, /useEditAccess\("strategy\.manage", writeEnabled\)/);
  });

  it("leaves 'sphere of influence' to the SBTi framework", () => {
    const mentions = [...contract.matchAll(/sphere/gi)].length;
    assert.equal(mentions, 1, "only the note distinguishing the two concepts may say 'sphere'");
    assert.match(read("packages/contracts/src/portalActions.ts"), /sphere/i, "the SBTi framework still owns the term");
  });

  it("says an empty plan is empty rather than showing a zeroed summary", () => {
    assert.match(area, /summary\.total === 0/);
    assert.match(area, /This client has no reduction plan yet/);
  });
});
