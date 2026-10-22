import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commandDefinitions } from "../src/commands";
import { commandGrantForRole } from "../src/permissions";
import {
  categoryShown, offeredPortalProfile, PORTAL_PROFILE_DEFAULT, PORTAL_PROFILE_KEYS, PORTAL_PROFILE_LABELS, PORTAL_PROFILE_VALUES,
  portalProfileDifferences, resolvePortalProfile, type PortalProfileStaffView,
} from "../src/portalProfile";

/**
 * The portal profile's shared definitions (portal data-entry phase 1): the org default, each key's value set, the overlay,
 * the portal's reading, the scope AND category rule, and the two commands' validation. The real-database half — the table,
 * the commands, the outbox topics — is `clientPortalProfileReal`.
 */
const context = { organisationId: "org", actorId: "a", principal: "staff" as const, idempotencyKey: "k", correlationId: "c", grant: commandGrantForRole("admin", "org", "a") };

test("the default is the ruled one, every key has a value set, a label and a default inside its set", () => {
  assert.deepEqual(PORTAL_PROFILE_DEFAULT, {
    setup: "hidden", time: "hidden", datasets: "hidden", milestones: "view", entryDrawer: "simple",
    evidenceProvenance: "hidden", factorCalculation: "hidden", dataQuality: "hidden", sourceDetail: "hidden", deactivate: "disabled",
  });
  for (const key of PORTAL_PROFILE_KEYS) {
    assert.ok((PORTAL_PROFILE_VALUES[key] as readonly string[]).includes(PORTAL_PROFILE_DEFAULT[key]), key);
    assert.ok(PORTAL_PROFILE_LABELS[key].label, key);
  }
  assert.ok(!(PORTAL_PROFILE_KEYS as readonly string[]).includes("history"), "history is not a setting: always visible");
  assert.ok(!(PORTAL_PROFILE_VALUES.milestones as readonly string[]).includes("edit"), "milestones is never edit");
});

test("0176's CHECK holds exactly the contract's value sets", () => {
  const sql = readFileSync(new URL("../../isolated-backend/migrations/0176_client_portal_profile.sql", import.meta.url), "utf8");
  const check = sql.slice(sql.indexOf("CONSTRAINT client_portal_profile_decisions_value"), sql.indexOf(");", sql.indexOf("CONSTRAINT client_portal_profile_decisions_value")));
  const fromSql = new Map<string, string[]>();
  const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  for (const clause of check.split(/\bOR\b/)) {
    const keys = quoted(clause.match(/profile_key\s*(?:IN\s*\(([^)]*)\)|=\s*('[^']+'))/)![0]!);
    const values = quoted(clause.match(/value IN \(([^)]*)\)/)![1]!);
    for (const key of keys) fromSql.set(key, values);
  }
  assert.deepEqual(Object.fromEntries([...fromSql].sort()), Object.fromEntries(PORTAL_PROFILE_KEYS.map((key) => [key, [...PORTAL_PROFILE_VALUES[key]]]).sort()));
});

test("decisions overlay the default; one the key does not understand is ignored, never guessed", () => {
  const profile = resolvePortalProfile([{ profileKey: "time", value: "visible" }, { profileKey: "milestones", value: "edit" }, { profileKey: "history", value: "hidden" }]);
  assert.equal(profile.time, "visible");
  assert.equal(profile.milestones, "view", "edit is not a value milestones takes");
  assert.deepEqual({ ...profile, time: "hidden" }, PORTAL_PROFILE_DEFAULT);
});

test("the portal's reading says what is offered, never what is not", () => {
  assert.deepEqual(offeredPortalProfile(PORTAL_PROFILE_DEFAULT), { areas: ["milestones"], entryDrawer: "simple", rowSections: [], actions: [] });
  const open = offeredPortalProfile(resolvePortalProfile([
    { profileKey: "setup", value: "visible" }, { profileKey: "milestones", value: "hidden" }, { profileKey: "sourceDetail", value: "visible" },
    { profileKey: "deactivate", value: "enabled" }, { profileKey: "entryDrawer", value: "detailed" },
  ]));
  assert.deepEqual(open, { areas: ["setup"], entryDrawer: "detailed", rowSections: ["sourceDetail"], actions: ["deactivate"] });
  assert.doesNotMatch(JSON.stringify(open), /hidden|disabled|withheld/);
});

test("a category is shown only when its scope is on AND it is on itself", () => {
  const none = { scopes: new Set<string>(), categories: new Set<string>() };
  const category = { categoryCode: "3.6", scope: "3" };
  assert.equal(categoryShown(category, none), true);
  assert.equal(categoryShown(category, { ...none, scopes: new Set(["3"]) }), false, "a hidden scope hides its categories");
  assert.equal(categoryShown(category, { ...none, categories: new Set(["3.6"]) }), false);
  assert.equal(categoryShown(category, { ...none, scopes: new Set(["1"]) }), true, "another scope's switch is not this one's");
});

test("the differences from the default, in words, for the staff preview", () => {
  const view: PortalProfileStaffView = {
    clientId: "c",
    profile: [
      { key: "time", group: "areas", label: "Time", hint: "", values: ["visible", "hidden"], defaultValue: "hidden", effectiveValue: "visible", decision: null },
      { key: "setup", group: "areas", label: "Setup", hint: "", values: ["visible", "hidden"], defaultValue: "hidden", effectiveValue: "hidden", decision: null },
    ],
    scopes: [
      { scope: "1", label: "Scope 1 — direct", effectiveVisible: false, decision: null, categories: [{ categoryCode: "1", name: "Fuel", shown: false, hiddenBy: "scope", decision: null }] },
      { scope: "3", label: "Scope 3 — value chain", effectiveVisible: true, decision: null, categories: [{ categoryCode: "3.6", name: "Business travel", shown: false, hiddenBy: "category", decision: null }] },
    ],
  };
  assert.deepEqual(portalProfileDifferences(view), ["Time: Shown (default Hidden)", "Scope 1 — direct: hidden, with every category in it", "Business travel: hidden"]);
});

test("the commands validate as the contract defines — milestones as edit is refused by name", () => {
  const profile = (input: Record<string, unknown>) => commandDefinitions["client.portal.profile.set"].validate({ clientId: "c", profileKey: "setup", value: "visible", ...input } as never, context);
  assert.deepEqual(profile({}), []);
  assert.deepEqual(profile({ value: null }), [], "null withdraws");
  assert.equal(profile({ profileKey: "history" })[0]?.code, "UNKNOWN");
  assert.equal(profile({ value: "view" })[0]?.code, "INVALID");
  assert.equal(profile({ profileKey: "milestones", value: "edit" })[0]?.code, "MILESTONES_VIEW_ONLY");
  assert.equal(profile({ note: "x".repeat(501) })[0]?.code, "TOO_LONG");
  assert.equal(commandDefinitions["client.portal.profile.set"].permission, "portal.admin");
  const scope = (input: Record<string, unknown>) => commandDefinitions["client.portal.scope.visibility.set"].validate({ clientId: "c", scope: "2", visible: false, ...input } as never, context);
  assert.deepEqual(scope({}), []);
  assert.deepEqual(scope({ visible: null }), []);
  assert.equal(scope({ scope: "3.1" })[0]?.code, "UNKNOWN");
  assert.equal(commandDefinitions["client.portal.scope.visibility.set"].permission, "category.visibility", "the same disclosure capability as the category switch (NZC-110)");
});
