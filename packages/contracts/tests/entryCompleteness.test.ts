import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DISPLAY_ONLY_CONTROLS, draftIsComplete, entryGaps, requiredFieldsFor } from "../src/entryCompleteness";
import { MAX_ASSIST_ROUNDS, nextAssistTurn, questionFor } from "../src/assistDialogue";
import { assistConfigFor, assistConfigs, CONSOLE_ASSIST, PORTAL_ASSIST } from "../src/assistConfig";
import type { InputSpecCategory } from "../src/inputSpec";

/**
 * The spec decides when an entry is complete — not the model (NZC-112).
 *
 * Read from the seeded spec rather than a hand-made category, so these assertions are about the
 * governed data the product actually ships. A category invented here could be made to prove
 * anything.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SPEC: InputSpecCategory[] = JSON.parse(
  readFileSync(join(ROOT, "apps/console/tests/fixtures/inputSpec.seed.json"), "utf8"));

const ELECTRICITY = SPEC.find((category) => category.categoryCode === "2.purchased-electricity")!;
const VEHICLES = SPEC.find((category) => category.categoryCode === "1.company-vehicles")!;

test("the spec is what is being asked, and it is the shipped one", () => {
  assert.ok(SPEC.length >= 20, "the seeded spec");
  assert.ok(ELECTRICITY && VEHICLES, "both exemplar categories are in it");
});

test("an empty draft is missing exactly the spec's required fields", () => {
  const gaps = entryGaps(ELECTRICITY, "crm", "new", {});
  const required = requiredFieldsFor(ELECTRICITY, "crm", "new");
  assert.deepEqual(gaps.map((gap) => gap.fieldKey), required.map((field) => field.key));
  assert.ok(gaps.length > 0);
});

test("a client is never asked for the factor, because the spec does not render it to them", () => {
  // The conditional-requirement rule doing real work rather than being restated: `factor`,
  // `qualityTier`, `dataConfidence` and `lineage` are consultant-only, so their absence cannot be
  // a gap on the portal. This is the reason gaps are computed from the spec rather than from a
  // model's idea of a complete entry — the answer differs by surface, and the spec knows why.
  const consultant = entryGaps(ELECTRICITY, "crm", "new", {}).map((gap) => gap.fieldKey);
  const client = entryGaps(ELECTRICITY, "portal", "new", {}).map((gap) => gap.fieldKey);
  assert.ok(consultant.includes("factor"), "a consultant is asked for the factor");
  assert.ok(!client.includes("factor"), "a client never is");
  assert.ok(!client.includes("qualityTier") && !client.includes("dataConfidence"));
  // And the client is still asked for the things that are theirs to know.
  assert.ok(client.includes("quantity"));
});

test("an explicitly optional field is never a gap", () => {
  const required = requiredFieldsFor(ELECTRICITY, "crm", "new").map((field) => field.key);
  // `monthly`, `note` and `documents` are marked optional in the spec.
  for (const key of ["monthly", "note", "documents"]) {
    assert.ok(!required.includes(key), `${key} is optional and must not be required`);
  }
});

test("a field that says nothing about itself is required — the reading that fails closed", () => {
  // `quantity` carries no `optional` at all. Treating silence as permission would let an entry
  // commit without the number it is about.
  const quantity = ELECTRICITY.fields.find((field) => field.fieldKey === "quantity")!;
  assert.equal(quantity.optional, null);
  assert.ok(requiredFieldsFor(ELECTRICITY, "crm", "new").some((field) => field.key === "quantity"));
});

test("display-only fields can never be gaps, because they cannot be filled in", () => {
  const gaps = entryGaps(ELECTRICITY, "crm", "new", {}).map((gap) => gap.fieldKey);
  assert.ok(!gaps.includes("siteBanner"), "a banner explains, it does not collect");
  assert.ok(!gaps.includes("lineage"), "a lineage panel displays");
  // Excluded by control rather than by name, so a new banner needs no change here.
  assert.deepEqual([...DISPLAY_ONLY_CONTROLS].sort(), ["banner", "lineage"]);
});

test("filling a field closes its gap and nothing else", () => {
  const before = entryGaps(VEHICLES, "crm", "new", {});
  const after = entryGaps(VEHICLES, "crm", "new", { quantity: 1200 });
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((gap) => gap.fieldKey === "quantity"));
});

test("blank, whitespace and an empty list are not values", () => {
  const draft = { quantity: "", unit: "   ", factor: [] };
  const gaps = entryGaps(VEHICLES, "crm", "new", draft).map((gap) => gap.fieldKey);
  for (const key of ["quantity", "unit", "factor"]) assert.ok(gaps.includes(key), `${key} is still missing`);
  // Zero is a value. A meter that read nothing is a reading.
  assert.ok(!entryGaps(VEHICLES, "crm", "new", { quantity: 0 }).some((gap) => gap.fieldKey === "quantity"));
});

test("complete means the spec says so, for that surface", () => {
  const filled = (audience: "crm" | "portal") => Object.fromEntries(
    requiredFieldsFor(ELECTRICITY, audience, "new").map((field) => [field.key, "x"]));
  assert.equal(draftIsComplete(ELECTRICITY, "crm", "new", filled("crm")), true);
  assert.equal(draftIsComplete(ELECTRICITY, "portal", "new", filled("portal")), true);
  // A draft complete for a client is not thereby complete for a consultant — they are asked more.
  assert.equal(draftIsComplete(ELECTRICITY, "crm", "new", filled("portal")), false);
});

test("the question is the spec's own words, so the form and the conversation agree", () => {
  const [gap] = entryGaps(ELECTRICITY, "portal", "new", {});
  assert.ok(gap);
  const question = questionFor(gap!);
  assert.ok(question.includes(gap!.label), "the label the form shows is the question that is asked");
});

test("the loop asks about the first gap, in the spec's order", () => {
  const turn = nextAssistTurn(ELECTRICITY, "portal", "new", {}, 0);
  assert.equal(turn.kind, "ask");
  if (turn.kind !== "ask") return;
  assert.equal(turn.gap.fieldKey, entryGaps(ELECTRICITY, "portal", "new", {})[0]!.fieldKey);
  assert.equal(turn.remaining, MAX_ASSIST_ROUNDS - 1);
});

test("the loop is ready the moment the spec is satisfied", () => {
  const filled = Object.fromEntries(
    requiredFieldsFor(ELECTRICITY, "portal", "new").map((field) => [field.key, "x"]));
  assert.deepEqual(nextAssistTurn(ELECTRICITY, "portal", "new", filled, 0), { kind: "ready" });
});

test("the loop gives up rather than asking forever", () => {
  // A confused extractor could otherwise trap a person in questions, and from the outside "one more
  // question" is indistinguishable from "this is broken". After the bound it hands over to the form.
  const turn = nextAssistTurn(ELECTRICITY, "portal", "new", {}, MAX_ASSIST_ROUNDS);
  assert.equal(turn.kind, "fallback");
  if (turn.kind !== "fallback") return;
  assert.equal(turn.reason, "rounds-exhausted");
  // Nothing gathered is thrown away: the form opens on what is still missing.
  assert.ok(turn.remainingGaps.length > 0);
  assert.deepEqual(turn.remainingGaps.map((gap) => gap.fieldKey), entryGaps(ELECTRICITY, "portal", "new", {}).map((gap) => gap.fieldKey));
});

test("being ready beats being out of rounds, so a complete entry is never sent to the form", () => {
  const filled = Object.fromEntries(
    requiredFieldsFor(ELECTRICITY, "portal", "new").map((field) => [field.key, "x"]));
  assert.deepEqual(nextAssistTurn(ELECTRICITY, "portal", "new", filled, MAX_ASSIST_ROUNDS + 5), { kind: "ready" });
});

test("the two assistants are keyed and configured apart", () => {
  // Structural, so it cannot quietly become one key later: the values differ and nothing resolves
  // both surfaces to the same configuration.
  assert.notEqual(CONSOLE_ASSIST.keyVariable, PORTAL_ASSIST.keyVariable);
  assert.equal(assistConfigFor("console"), CONSOLE_ASSIST);
  assert.equal(assistConfigFor("portal"), PORTAL_ASSIST);
  const keys = assistConfigs.map((config) => config.keyVariable);
  assert.equal(new Set(keys).size, keys.length, "no two surfaces share a credential");
  // Neither is the staff help system's key, which is a third concern again.
  assert.ok(!keys.includes("ANTHROPIC_API_KEY"));
  // The client-facing surface is held tighter than the consultant one.
  assert.ok(PORTAL_ASSIST.requestsPerMinute < CONSOLE_ASSIST.requestsPerMinute);
});

test("no configuration carries a secret, only the name of where one comes from", () => {
  // The key enters at the composition edge; this says which variable, never the value.
  for (const config of assistConfigs) {
    assert.match(config.keyVariable, /^[A-Z0-9_]+$/, "a variable name, not a credential");
    assert.ok(!("apiKey" in config), "a config object must not be able to hold a key");
  }
});
