import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmProposal, type EntryProposal } from "../src/aiAssist";
import { readEntryOrigin } from "../src/entryProvenance";

/**
 * The confirm boundary, and the two provenance keys (NZC-111).
 *
 * The boundary's whole job is that it is the *only* way a proposal becomes anything writable, so
 * these assertions are about shape rather than cleverness: what it refuses, what it settles, and
 * what it writes down about the human's part in it.
 */

const proposal = (over: Partial<EntryProposal> = {}): EntryProposal => ({
  categoryCode: "1.company-vehicles", scope: "1", sourceLabel: "Diesel — LGV",
  quantity: 1200, unit: "litres", datasetId: "ds-1", factorId: "f-diesel", gaps: [],
  ...over,
});

test("a complete proposal confirms into ordinary write fields", () => {
  const outcome = confirmProposal(proposal(), {}, "console");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.entry, {
    categoryCode: "1.company-vehicles", scope: "1", sourceLabel: "Diesel — LGV",
    quantity: 1200, unit: "litres", datasetId: "ds-1", factorId: "f-diesel",
  });
  // Nothing about the entry says it is special. It is the same shape a typed entry produces, which
  // is what lets it go through the same command.
  assert.equal(outcome.record.capturedVia, "ai-assisted");
  assert.deepEqual(outcome.record.changed, [], "a proposal accepted as-is was changed in no way");
});

test("an incomplete proposal refuses and names what is missing", () => {
  // The assistant not knowing is a state to resolve, never a blank to commit.
  const outcome = confirmProposal(proposal({ quantity: null, factorId: null }), {}, "console");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.deepEqual(outcome.missing.sort(), ["factorId", "quantity"]);
});

test("a person's edits win, and are written down as theirs", () => {
  const outcome = confirmProposal(proposal(), { quantity: 1500, sourceLabel: "Depot fleet" }, "console");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.entry.quantity, 1500);
  assert.equal(outcome.entry.sourceLabel, "Depot fleet");
  // In field order, so the record reads the same way twice for the same edits.
  assert.deepEqual(outcome.record.changed, [
    { field: "sourceLabel", proposed: "Diesel — LGV", confirmed: "Depot fleet" },
    { field: "quantity", proposed: 1200, confirmed: 1500 },
  ]);
});

test("re-entering the same value is not a change", () => {
  // Honesty about the human's part: "what they changed" must mean changed, or the record overstates
  // how much was reviewed.
  const outcome = confirmProposal(proposal(), { quantity: 1200 }, "console");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.record.changed, []);
});

test("an edit can complete a proposal the assistant could not", () => {
  const outcome = confirmProposal(proposal({ quantity: null }), { quantity: 900 }, "portal");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.entry.quantity, 900);
  assert.deepEqual(outcome.record.changed, [{ field: "quantity", proposed: null, confirmed: 900 }]);
  assert.equal(outcome.record.surface, "portal");
});

test("the record carries the structured proposal and nothing a person wrote in prose", () => {
  // The rule: structured only. It cannot carry a registration, a name or an address, because it
  // carries no free text at all — there is no field for it.
  const outcome = confirmProposal(proposal(), { quantity: 5 }, "portal");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(Object.keys(outcome.record).sort(), ["capturedVia", "changed", "proposed", "surface"]);
  const serialised = JSON.stringify(outcome.record);
  assert.ok(!/AB12|text|prompt/i.test(serialised));
});

test("blank and whitespace are missing, not values", () => {
  const outcome = confirmProposal(proposal({ sourceLabel: "   " }), {}, "console");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.deepEqual(outcome.missing, ["sourceLabel"]);
});

test("an absent capturedVia reads as manual, because the assisted path did not exist", () => {
  assert.equal(readEntryOrigin({}).via, "manual");
  assert.equal(readEntryOrigin({ capturedVia: "ai-assisted" }).via, "ai-assisted");
  assert.equal(readEntryOrigin(undefined).via, "manual");
  // Anything unrecognised is manual too: the assisted claim has to be made explicitly.
  assert.equal(readEntryOrigin({ capturedVia: "something-else" }).via, "manual");
});

test("an absent capturedAs stays unknown rather than being guessed", () => {
  assert.equal(readEntryOrigin({}).as, null);
  assert.equal(readEntryOrigin({ capturedAs: "staff" }).as, "staff");
  assert.equal(readEntryOrigin({ capturedAs: "client-portal" }).as, "client-portal");
  // The older spelling on the portal-acceptance path still answers, so rows written before the key
  // existed are not treated as unknown when they are not.
  assert.equal(readEntryOrigin({ source: "client-portal" }).as, "client-portal");
});
