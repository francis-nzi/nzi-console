import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The action-lever library. The rules worth holding: the catalogue is Admin-managed and the
 * plan is not; removing keeps history; the plan is the PLAN half of a CRP and never borrows
 * the authority of the measurement half; and nothing fabricates a reduction figure.
 */
describe("action-lever library", () => {
  const migration = read("packages/isolated-backend/migrations/0075_action_lever_library.sql");
  const backend = read("packages/isolated-backend/src/actionLevers.ts");
  const commands = read("packages/contracts/src/commands.ts");
  const area = read("apps/console/app/clients/[clientId]/ActionsArea.tsx");
  const forms = read("apps/console/app/clients/[clientId]/ActionForms.tsx");

  it("keeps the catalogue Admin-managed and the plan consultant-managed", () => {
    // A consultant assembles a plan from the library but does not get to redefine the
    // library while doing it — the two are different jobs with different blast radii.
    for (const key of ["action.lever.upsert", "action.lever.deactivate"]) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "admin\\.lookups"`), key);
    }
    for (const key of ["client.action.assign", "client.action.update", "client.action.remove"]) {
      assert.match(commands, new RegExp(`"${key}": \\{ key: "${key}"[^}]*permission: "actions\\.manage"`), key);
    }
    // Admin holds everything; consultant holds actions.manage but not admin.lookups.
    const permissions = read("packages/contracts/src/permissions.ts");
    const consultant = /consultant: \{([\s\S]*?)\n  \},/.exec(permissions)?.[1] ?? "";
    assert.ok(consultant.includes("actions.manage"), "a consultant builds the plan");
    assert.ok(!consultant.includes("admin.lookups"), "and does not edit the catalogue");
  });

  it("deactivates rather than deletes, everywhere", () => {
    for (const table of ["action_levers", "client_actions"]) {
      assert.match(migration, new RegExp(`REVOKE DELETE ON nzi_console\\.${table}`), table);
    }
    assert.match(migration, /ADD COLUMN|active boolean NOT NULL DEFAULT true/);
    assert.match(backend, /SET active=false/);
    // Removing an action carries a reason: what a client intended is part of the record.
    assert.match(commands, /"client\.action\.remove"[^}]*reasonRequired: true/);
    assert.match(commands, /"action\.lever\.deactivate"[^}]*reasonRequired: true/);
  });

  it("keeps a withdrawn lever on the plans that already hold it", () => {
    assert.match(backend, /WITHDRAWN/, "it cannot be newly assigned");
    assert.match(forms, /Withdrawn from the catalogue — kept because this client holds it/);
  });

  it("holds one meaning of done, in the database and in the form", () => {
    // A complete action at 60%, or a 100% action still in progress, is a plan disagreeing
    // with itself in front of the client.
    assert.match(migration, /CONSTRAINT client_actions_complete_is_100 CHECK \(\(status = 'complete'\) = \(progress_pct = 100\)\)/);
    assert.match(commands, /A complete action is at 100%, and an action at 100% is complete/);
    assert.match(forms, /actionProgressForStatus|actionStatusForProgress/);
  });

  it("refuses the same lever twice on one plan", () => {
    assert.match(migration, /CREATE UNIQUE INDEX client_actions_one_live_per_lever_idx[\s\S]*?WHERE lever_id IS NOT NULL AND active/);
    assert.match(backend, /ALREADY_ASSIGNED/);
  });

  it("takes a catalogue action's wording from the catalogue, not a stale copy", () => {
    // An Admin correcting a lever should correct it everywhere, rather than leaving every
    // plan holding whatever the title was on the day it was assigned.
    assert.match(backend, /LEFT JOIN nzi_console\.action_levers l ON \(l\.organisation_id, l\.lever_id\) = \(a\.organisation_id, a\.lever_id\)/);
    assert.match(backend, /title: row\.lever_title \?\? row\.bespoke_title/);
    // Bespoke columns exist only because a bespoke action has no lever to read from.
    assert.match(migration, /CONSTRAINT client_actions_lever_or_bespoke CHECK/);
  });

  it("never fabricates a reduction figure", () => {
    // The Stage 2 slot exists so adding impact is a backfill rather than a reshape, and is
    // constrained to require a basis so a number cannot appear unsourced.
    assert.match(migration, /CONSTRAINT action_levers_modelled_impact_sourced\s*\n?\s*CHECK \(modelled_tco2e_per_year IS NULL OR nullif\(trim\(modelled_impact_basis\), ''\) IS NOT NULL\)/);
    // Nothing is seeded with one.
    const seed = /INSERT INTO nzi_console\.action_levers[\s\S]*?ON CONFLICT DO NOTHING;/.exec(migration)?.[0] ?? "";
    assert.ok(seed.length > 0, "the catalogue is seeded");
    assert.ok(!seed.includes("modelled_tco2e_per_year"), "and no seeded lever claims an impact");
    assert.match(area, /Stage 2, and nothing on this screen estimates it/);
    assert.match(area, /progress is what the client reports, not a modelled reduction/);
  });

  it("keeps the plan distinct from the measurement", () => {
    assert.match(area, /PLAN half of a CRP/);
    // The plan must not reach for a scope row, a factor or a quality tier. Comments are
    // stripped: both files explain the separation on purpose, which is not the same as
    // reaching across it.
    const strip = (text: string) => text.replace(/^\s*--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(strip(backend), /scope_rows|factor_id|quality_tier/);
    assert.doesNotMatch(strip(migration), /scope_rows|factor_id|quality_tier/);
  });

  it("uses the curated icon set, not the prototype's emoji", () => {
    assert.match(area, /NziIcon/);
    assert.doesNotMatch(area, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji as iconography");
    assert.doesNotMatch(forms, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    // The seeded icon keys are NziIcon names, so every catalogue row renders in print.
    const iconFile = read("packages/ui/src/NziIcon.tsx");
    const seeded = [...migration.matchAll(/'(energy|solar|vehicle|tools|waste|handshake|policy|package|flight|bus|recycle|document)'/g)].map(([, key]) => key);
    assert.ok(seeded.length > 0);
    for (const key of new Set(seeded)) assert.match(iconFile, new RegExp(`\\b${key}:`), `${key} must exist in NziIcon`);
  });

  it("renders as a real area rather than the unavailable placeholder", () => {
    const areas = read("apps/console/app/clients/[clientId]/clientAreas.ts");
    assert.match(areas, /BUILT_AREAS[\s\S]*?"actions"/);
    const view = read("apps/console/app/clients/[clientId]/ClientWorkspaceView.tsx");
    assert.match(view, /area === "actions" \? <ActionsArea/);
    assert.match(view, /useEditAccess\("actions\.manage", writeEnabled\)/);
  });

  it("says an empty plan is empty rather than showing a zeroed summary", () => {
    assert.match(area, /summary\.total === 0/);
    assert.match(area, /This client has no reduction plan yet/);
  });
});
