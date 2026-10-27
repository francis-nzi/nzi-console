import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, overallReadiness, srsDashboard, type CommandContext, type SrsFramework, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { withTenantRead } from "../src/postgres";
import { getPortalClientReadiness } from "../src/portalReadiness";
import { assignClientStrategy } from "../src/reductionStrategies";
import { completeSrsAssessment, getSrsAssessment, getSrsFramework, listSrsAssessments, setSrsAssessmentItem, startSrsAssessment } from "../src/srsReadiness";

/**
 * SRS S2 against a real database: the client portal's readiness read model carries the dashboard — the same model the
 * CRM dashboard renders — built from the latest **completed** assessment only (a draft in progress never reaches the
 * client), with each requirement's evidence and history but none of the staff working fields (owner, due date, the
 * action link; NZC-110), and nothing that is not the client's own. Two clients come out different. S2 writes nothing.
 */

const ORG = "srs2-org";
const A = "client-a";
const B = "client-b";
const C = "client-c";
let keys = 0;
const context = (role: StaffRole = "admin"): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `s2-${keys}`, correlationId: `corr-s2-${keys}`, grant: commandGrantForRole(role, ORG, "ada") };
};

describe("SRS S2 — the portal's readiness dashboard, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let framework: SrsFramework;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const read = <T>(work: Parameters<typeof withTenantRead<T>>[2]) => withTenantRead(database.pool, ORG, work);
  const portal = (clientId: string) => read((db) => getPortalClientReadiness(db, { clientId, organisationShortName: "NZI" }));

  /** Open an assessment for `clientId` and answer every active requirement with `pick`; complete it unless told not to. */
  const assess = async (clientId: string, pick: (index: number) => number, options: { complete?: boolean; working?: (requirementId: string) => Record<string, unknown> } = {}) => {
    const { assessmentId } = (await startSrsAssessment(database.pool, { clientId }, context())).data;
    const active = framework.requirements.filter((requirement) => requirement.active);
    for (const [index, requirement] of active.entries()) {
      const held = (await read((db) => getSrsAssessment(db, assessmentId)))!.items.find((item) => item.requirementId === requirement.id);
      await setSrsAssessmentItem(database.pool, {
        assessmentId, requirementId: requirement.id, maturity: pick(index), evidenceKind: "document", evidenceRef: `Evidence ${requirement.code}`, evidenceNote: "Seen in workshop",
        expectedVersion: held?.version ?? 0, ...(options.working?.(requirement.id) ?? {}),
      }, context());
    }
    if (options.complete !== false) {
      await completeSrsAssessment(database.pool, { assessmentId, expectedVersion: (await read((db) => getSrsAssessment(db, assessmentId)))!.version }, context());
    }
    return assessmentId;
  };

  before(async () => {
    database = (await createDisposableDatabase("srss2"))!;
    admin = await database.admin();
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'SRS2 Org')`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Client A', 'active'), ($1, $3, 'Client B', 'active'), ($1, $4, 'Client C', 'active')`, [ORG, A, B, C]);
    framework = (await read((db) => getSrsFramework(db)))!;

    // A: assessed twice, then a reassessment in progress pushed to the top of the ladder — which the client must not see.
    const strategy = (await assignClientStrategy(database.pool, {
      clientId: A, bespoke: { title: "Board climate oversight", scope: "governance", controlLevel: "direct_control" }, srsRequirementIds: [framework.requirements.find((requirement) => requirement.active)!.id],
    }, context())).data.clientStrategyId;
    const earlier = await assess(A, () => 1);
    // Completed today by the command; dated back so the second is unambiguously the latest (the database's own history).
    await q(`UPDATE nzi_console.srs_assessments SET started_on = '2026-03-01', assessed_on = '2026-03-02' WHERE assessment_id = $1`, [earlier]);
    await assess(A, (index) => index % 2 === 0 ? 3 : 2, { working: () => ({ owner: "Ada Admin", dueDate: "2027-03-31", linkedActionId: strategy }) });
    await assess(A, () => 4, { complete: false });
    // B: one completed assessment, lower.
    await assess(B, () => 0);
    // C: only a draft.
    await assess(C, () => 2, { complete: false });
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("builds the client's dashboard from the latest completed assessment — never the draft in progress", async () => {
    const assessments = await read((db) => listSrsAssessments(db, A));
    const completed = assessments.filter((entry) => entry.status === "complete");
    const draft = assessments.find((entry) => entry.status === "draft")!;
    const model = await portal(A);
    assert.equal(model.state, "assessed");
    if (model.state !== "assessed") return;
    const { dashboard } = model;
    assert.equal(dashboard.assessment.provisional, false);
    assert.notEqual(dashboard.assessment.id, draft.assessmentId);
    assert.ok(completed.some((entry) => entry.assessmentId === dashboard.assessment.id));
    assert.ok(dashboard.overall.level < 4, "the draft's top-of-the-ladder scores do not reach the client");
    // The same figures the CRM's dashboard reads for that assessment — one model, two surfaces.
    const chosen = completed.find((entry) => entry.assessmentId === dashboard.assessment.id)!;
    assert.equal(dashboard.overall.level, overallReadiness(framework, chosen.items).level);
    const crm = srsDashboard(framework, chosen, assessments);
    assert.deepEqual(dashboard.pillars, crm.pillars);
    assert.deepEqual(dashboard.trend, crm.trend);
    assert.equal(dashboard.trend.overall.length, 2, "the trend is the two completed assessments — not the draft");
    assert.equal(dashboard.overall.step, Math.floor(dashboard.overall.level));
  });

  it("carries each question's evidence and history, and none of the staff working fields (NZC-110)", async () => {
    const model = await portal(A);
    if (model.state !== "assessed") assert.fail("A is assessed");
    const assessments = await read((db) => listSrsAssessments(db, A));
    const held = assessments.find((entry) => entry.assessmentId === model.dashboard.assessment.id)!;
    // The assessment the client sees is the one the consultant gave an owner, a due date and an action link to.
    assert.ok(held.items.length > 0 && held.items.every((item) => item.owner === "Ada Admin" && item.dueDate === "2027-03-31" && item.linkedActionId !== null));
    for (const requirement of model.dashboard.requirements) {
      for (const field of ["owner", "dueDate", "linkedActionId"]) assert.ok(!(field in requirement), `${requirement.code} carries no ${field}`);
      assert.equal(requirement.evidence?.ref, `Evidence ${requirement.code}`);
      // The S2 review: kind and reference only — the consultant's free-text note stays staff-side.
      assert.deepEqual([requirement.evidence?.kind, requirement.evidence?.note], ["document", ""]);
      assert.equal(requirement.history.length, 2);
    }
    const payload = JSON.stringify(model);
    assert.doesNotMatch(payload, /Ada Admin|2027-03-31/, "the owner and due date never cross, though both are set");
    assert.doesNotMatch(payload, /"assessedBy"|"notes"/, "nor the assessor or the assessment's notes");
    assert.doesNotMatch(payload, /Seen in workshop/, "nor any evidence note, though every item has one");
  });

  it("two clients come out different, each only their own", async () => {
    const a = await portal(A), b = await portal(B);
    if (a.state !== "assessed" || b.state !== "assessed") assert.fail("both are assessed");
    assert.notEqual(a.dashboard.overall.level, b.dashboard.overall.level);
    assert.equal(b.dashboard.trend.overall.length, 1, "B has one completed assessment — one point");
    assert.equal(b.dashboard.overall.delta, null, "and nothing earlier to compare");
    assert.notEqual(a.dashboard.assessment.id, b.dashboard.assessment.id);
  });

  it("a client with only a draft sees that it is in progress — not a provisional score", async () => {
    const model = await portal(C);
    assert.equal(model.state, "none");
    assert.ok(!("dashboard" in model));
    if (model.state === "none") assert.match(model.reason, /in progress/);
  });

  it("reading the portal writes nothing", async () => {
    const before = await q(`SELECT (SELECT count(*) FROM nzi_console.srs_assessments)::int AS a, (SELECT count(*) FROM nzi_console.srs_assessment_items)::int AS i,
      (SELECT max(updated_at) FROM nzi_console.srs_assessment_items)::text AS t`);
    await portal(A); await portal(B); await portal(C);
    const afterRead = await q(`SELECT (SELECT count(*) FROM nzi_console.srs_assessments)::int AS a, (SELECT count(*) FROM nzi_console.srs_assessment_items)::int AS i,
      (SELECT max(updated_at) FROM nzi_console.srs_assessment_items)::text AS t`);
    assert.deepEqual(afterRead, before);
  });
});
