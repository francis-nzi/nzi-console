import assert from "node:assert/strict";
import test from "node:test";
import { commandDefinitions } from "../src/commands";
import { SRS_ASSESSMENT_NOTES_MAX } from "../src/srsReadiness";
import { srsPortalDashboard } from "../src/srsDashboard";

/** The assessment's context note: a consultant's working record, set while the assessment is in progress. */
const context = { organisationId: "o", actorId: "a", principal: "staff", idempotencyKey: "k", correlationId: "c" } as never;
const definition = commandDefinitions["srs.assessment.notes.set"];
const validate = (input: Record<string, unknown>) => (definition.validate as (i: unknown, c: unknown) => Array<{ field: string; code: string }>)({ assessmentId: "a", notes: "n", expectedVersion: 0, ...input }, context);

test("srs.assessment.notes.set is gated on srs.manage and audited as its own action", () => {
  assert.equal(definition.permission, "srs.manage");
  assert.equal(definition.auditAction, "srs_assessment_notes_set");
});

test("accepts text up to the cap (and an empty one, to clear it); refuses anything else", () => {
  assert.deepEqual(validate({}), []);
  assert.deepEqual(validate({ notes: "" }), []);
  assert.deepEqual(validate({ notes: "x".repeat(SRS_ASSESSMENT_NOTES_MAX) }), []);
  assert.deepEqual(validate({ notes: "x".repeat(SRS_ASSESSMENT_NOTES_MAX + 1) }).map((i) => i.code), ["TOO_LONG"]);
  assert.deepEqual(validate({ notes: 5 }).map((i) => i.code), ["INVALID"]);
  assert.deepEqual(validate({ notes: null }).map((i) => i.code), ["INVALID"]);
});

test("needs the assessment and a non-negative integer version", () => {
  assert.deepEqual(validate({ assessmentId: "" }).map((i) => i.field), ["assessmentId"]);
  for (const bad of [-1, 1.5, "1"]) assert.deepEqual(validate({ expectedVersion: bad }).map((i) => i.field), ["expectedVersion"], String(bad));
});

test("the note never crosses to the client: the portal dashboard model carries no assessment note", () => {
  const source = srsPortalDashboard.toString();
  assert.doesNotMatch(source, /\.notes\b/);
  const model = srsPortalDashboard({ frameworkId: "f", version: 1, label: "F", status: "active", effectiveFrom: null, notes: null, standards: [], pillars: [], maturityLevels: [], requirements: [] } as never, [{
    assessmentId: "a", clientId: "c", frameworkId: "f", frameworkVersion: 1, status: "complete", startedOn: "2026-01-01", assessedOn: "2026-01-02", assessedBy: "x", completedAt: "2026-01-02",
    notes: "client slow to engage", sectorKey: null, benchmarkPercentile: null, benchmarkSource: null, version: 1, items: [],
  }] as never);
  assert.doesNotMatch(JSON.stringify(model), /client slow to engage/);
});
