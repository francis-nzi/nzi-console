import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type LibraryStrategy, type SrsFramework, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { withTenantRead } from "../src/postgres";
import { getPortalClientReadiness } from "../src/portalReadiness";
import { listClientStrategies, listLibraryStrategies } from "../src/reductionStrategies";
import { bridgeSrsGap, exportSrsReport, listSrsGapSuggestions, recordSrsGapSuggestions, withdrawSrsGapSuggestion } from "../src/srsBridging";
import { completeSrsAssessment, getSrsAssessment, getSrsFramework, setSrsAssessmentItem, startSrsAssessment } from "../src/srsReadiness";
import { getSrsReport } from "../src/srsReport";
import { srsSuggestionInputFor } from "../src/srsSuggestions";

/**
 * SRS S3 against a real database (0189): a gap bridged from the library (matched by alignment) or in the consultant's own
 * words, as an `srs_gap` action on the plan, linked from an assessment still in progress and never changing a completed
 * one; AI ideas stored as shown, re-asked and withdrawn, held to "no figure" by the command and by the table, shown to
 * the client without who asked or the request; the boundary of what is sent to the model; the report from a completed
 * assessment only, with no staff field, note or name; and every act gated and audited — the AI by reference.
 */

const ORG = "s3-org";
const A = "client-a";
const B = "client-b";
let keys = 0;
const context = (role: StaffRole = "admin"): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: "staff-ada", principal: "staff", idempotencyKey: `s3-${keys}`, correlationId: `corr-s3-${keys}`, grant: commandGrantForRole(role, ORG, "staff-ada") };
};
const refused = (code: string) => (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.some((issue) => issue.code === code) === true;
const unauthorised = (error: Error) => error.name === "AuthorizationError";
const SHA = "a".repeat(64);
const idea = (title: string) => ({ title, how: "One or two sentences on how this moves the requirement on to the step expected of it." });

describe("SRS S3 — gaps bridged, AI ideas, the report (0189), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let framework: SrsFramework;
  let library: LibraryStrategy[];
  let completed = "", draft = "";
  let aligned: LibraryStrategy, gapRequirement = "", otherGap = "";
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const read = <T>(work: Parameters<typeof withTenantRead<T>>[2]) => withTenantRead(database.pool, ORG, work);
  const holder = (role: StaffRole = "admin") => ({ organisationId: ORG, userId: "staff-ada", capabilities: commandGrantForRole(role, ORG, "staff-ada").capabilities });

  /** Open an assessment for A and answer every active requirement at Developing (1) — a gap wherever more is expected. */
  const assess = async (complete: boolean) => {
    const { assessmentId } = (await startSrsAssessment(database.pool, { clientId: A }, context())).data;
    for (const requirement of framework.requirements.filter((entry) => entry.active)) {
      const held = (await read((db) => getSrsAssessment(db, assessmentId)))!.items.find((item) => item.requirementId === requirement.id);
      await setSrsAssessmentItem(database.pool, { assessmentId, requirementId: requirement.id, maturity: 1, evidenceKind: "note", evidenceNote: "Consultant: client slow to engage",
        owner: "Ada Admin", dueDate: "2027-03-31", expectedVersion: held?.version ?? 0 }, context());
    }
    if (complete) await completeSrsAssessment(database.pool, { assessmentId, expectedVersion: (await read((db) => getSrsAssessment(db, assessmentId)))!.version }, context());
    return assessmentId;
  };

  before(async () => {
    database = (await createDisposableDatabase("srss3"))!;
    admin = await database.admin();
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'S3 Org')`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'staff-ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, sector) VALUES ($1, $2, 'Harbourside Foods', 'active', 'Food manufacturing'), ($1, $3, 'Client B', 'active', NULL)`, [ORG, A, B]);
    framework = (await read((db) => getSrsFramework(db)))!;
    library = await read((db) => listLibraryStrategies(db));
    completed = await assess(true);
    draft = await assess(false);
    // A library action whose alignment names a requirement that is a gap (target above 1).
    const targets = new Map(framework.requirements.filter((entry) => entry.active).map((entry) => [entry.id, entry.targetMaturity]));
    aligned = library.find((entry) => entry.active && entry.defaultSrsRequirementIds.some((id) => (targets.get(id) ?? 0) > 1))!;
    gapRequirement = aligned.defaultSrsRequirementIds.find((id) => (targets.get(id) ?? 0) > 1)!;
    otherGap = [...targets].find(([id, target]) => target > 1 && id !== gapRequirement && !aligned.defaultSrsRequirementIds.includes(id))![0];
  });
  after(async () => { await admin?.end(); await database?.end(); });

  describe("bridging a gap (R1)", () => {
    it("bridges from the library — matched by alignment — as an srs_gap action, without changing a completed assessment", async () => {
      const result = await bridgeSrsGap(database.pool, { assessmentId: completed, requirementId: gapRequirement, strategyId: aligned.id }, context());
      assert.equal(result.data.linked, false, "a completed assessment is a record");
      const action = (await read((db) => listClientStrategies(db, A))).find((entry) => entry.id === result.data.clientStrategyId)!;
      assert.deepEqual([action.origin, action.originSrsRequirementId, action.strategyId, action.status], ["srs_gap", gapRequirement, aligned.id, "proposed"]);
      assert.ok(action.srsRequirementIds.includes(gapRequirement));
      const item = (await read((db) => getSrsAssessment(db, completed)))!.items.find((entry) => entry.requirementId === gapRequirement)!;
      assert.equal(item.linkedActionId, null);
      await assert.rejects(bridgeSrsGap(database.pool, { assessmentId: completed, requirementId: gapRequirement, strategyId: aligned.id }, context()), refused("ALREADY_ON_PLAN"));
      await assert.rejects(bridgeSrsGap(database.pool, { assessmentId: completed, requirementId: otherGap, strategyId: aligned.id }, context()), refused("NOT_ALIGNED"));
    });

    it("bridges in the consultant's words on an assessment in progress, and links it; a requirement already met is not a gap", async () => {
      const result = await bridgeSrsGap(database.pool, { assessmentId: draft, requirementId: otherGap, bespoke: { title: "Name a board sponsor for climate", scope: "governance", controlLevel: "direct_control" } }, context());
      assert.equal(result.data.linked, true);
      const item = (await read((db) => getSrsAssessment(db, draft)))!.items.find((entry) => entry.requirementId === otherGap)!;
      assert.equal(item.linkedActionId, result.data.clientStrategyId);
      const met = framework.requirements.find((entry) => entry.active && entry.id !== otherGap)!;
      const held = (await read((db) => getSrsAssessment(db, draft)))!.items.find((entry) => entry.requirementId === met.id)!;
      await setSrsAssessmentItem(database.pool, { assessmentId: draft, requirementId: met.id, maturity: 4, expectedVersion: held.version }, context());
      await assert.rejects(bridgeSrsGap(database.pool, { assessmentId: draft, requirementId: met.id, bespoke: { title: "Not needed here", scope: "governance", controlLevel: "direct_control" } }, context()), refused("NOT_A_GAP"));
    });

    it("is srs.manage's: a viewer is refused", async () => {
      await assert.rejects(bridgeSrsGap(database.pool, { assessmentId: draft, requirementId: otherGap, bespoke: { title: "Viewer try", scope: "governance", controlLevel: "direct_control" } }, context("viewer")), unauthorised);
    });
  });

  describe("AI ideas (R2–R4, R8)", () => {
    it("tells the model the gap, the sector and yes/no facts — not the client's name, a person, or a figure", async () => {
      const { clientId, input } = await read((db) => srsSuggestionInputFor(db, { assessmentId: completed, requirementId: otherGap }));
      assert.equal(clientId, A);
      const sent = JSON.stringify(input);
      assert.equal(input.sector, "Food manufacturing");
      assert.doesNotMatch(sent, /Harbourside|Ada|slow to engage|2027/, "no name, no person, no note, no date");
      await assert.rejects(read((db) => srsSuggestionInputFor(db, { assessmentId: draft, requirementId: framework.requirements.find((entry) => entry.active && entry.id !== otherGap)!.id })), refused("NOT_A_GAP"));
    });

    it("stores ideas as shown, re-asking withdraws the last ones, and a figure is refused by the command and by the table", async () => {
      const first = await recordSrsGapSuggestions(database.pool, { assessmentId: completed, requirementId: otherGap, suggestions: [idea("Name a board sponsor"), idea("Map climate risks")], model: "claude-opus-5-5", promptSha256: SHA }, context());
      assert.equal(first.data.suggestionIds.length, 2);
      const again = await recordSrsGapSuggestions(database.pool, { assessmentId: completed, requirementId: otherGap, suggestions: [idea("Hold a scenario workshop")], model: "claude-opus-5-5", promptSha256: "b".repeat(64) }, context());
      assert.equal(again.data.withdrawn, 2);
      assert.deepEqual((await read((db) => listSrsGapSuggestions(db, A))).map((entry) => entry.title), ["Hold a scenario workshop"]);
      await assert.rejects(recordSrsGapSuggestions(database.pool, { assessmentId: completed, requirementId: otherGap, suggestions: [{ title: "Cut emissions by 40%", how: "An invented target that must never reach a client as if it were fact." }], model: "m", promptSha256: SHA }, context()), refused("UNGROUNDED"));
      await assert.rejects(q(`INSERT INTO nzi_console.srs_gap_suggestions (organisation_id, suggestion_id, client_id, assessment_id, requirement_id, title, how, model, prompt_sha256, created_by)
        VALUES ($1, 'sneak', $2, $3, $4, 'Spend £10k on meters', 'A figure slipped past the command into the table directly.', 'm', $5, 'x')`, [ORG, A, completed, otherGap, SHA]), /srs_gap_suggestions_no_figures/);
    });

    it("audits the request by reference — the model, the prompt hash, the count — never the ideas' words", async () => {
      const rows = await q<{ after_json: Record<string, unknown> }>(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'srs_gap_suggestions_recorded' ORDER BY occurred_at`, [ORG]);
      assert.ok(rows.length >= 2);
      const last = JSON.stringify(rows.at(-1)!.after_json);
      assert.match(last, /"promptSha256":"b{64}"/);
      assert.match(last, /"model":"claude-opus-5-5"/);
      assert.doesNotMatch(last, /scenario workshop/i, "the audit trail names the request, not the content");
    });

    it("shows the client the ideas for their gaps — labelled as data only: no model, no hash, no who", async () => {
      const portal = await read((db) => getPortalClientReadiness(db, { clientId: A, organisationShortName: "NZI" }));
      if (portal.state !== "assessed") assert.fail("A is assessed");
      assert.deepEqual(portal.ideas, [{ requirementId: otherGap, title: "Hold a scenario workshop", how: idea("x").how }]);
      const payload = JSON.stringify(portal.ideas);
      assert.doesNotMatch(payload, /claude|b{64}|staff-ada|Ada Admin/);
    });

    it("turns an idea into an action only through a person — in their own words — and a withdrawn idea leaves the client's view", async () => {
      const shown = (await read((db) => listSrsGapSuggestions(db, A)))[0]!;
      await assert.rejects(bridgeSrsGap(database.pool, { assessmentId: completed, requirementId: gapRequirement, suggestionId: shown.id, bespoke: { title: shown.title, scope: "governance", controlLevel: "direct_control" } }, context()), refused("NOT_SHOWN"));
      const bridged = await bridgeSrsGap(database.pool, { assessmentId: completed, requirementId: otherGap, suggestionId: shown.id, bespoke: { title: shown.title, scope: "governance", controlLevel: "direct_control" } }, context());
      const action = (await read((db) => listClientStrategies(db, A))).find((entry) => entry.id === bridged.data.clientStrategyId)!;
      assert.match(action.notes, /^From an AI idea: /, "where it came from, in the consultant's note — not the client's");
      await withdrawSrsGapSuggestion(database.pool, { assessmentId: completed, suggestionId: shown.id }, context());
      const portal = await read((db) => getPortalClientReadiness(db, { clientId: A, organisationShortName: "NZI" }));
      if (portal.state !== "assessed") assert.fail("A is assessed");
      assert.deepEqual(portal.ideas, []);
      const status = await q(`SELECT status FROM nzi_console.srs_gap_suggestions WHERE suggestion_id = $1`, [shown.id]);
      assert.deepEqual(status, [{ status: "withdrawn" }], "withdrawn, never deleted");
    });
  });

  describe("the report (R5, R6, R8)", () => {
    it("draws the latest completed assessment on the UK SRS template — no staff field, no note, no person; the firm prepared it", async () => {
      const report = await read((db) => getSrsReport(db, holder(), { clientId: A, templateKey: "uk-srs" }));
      if (report.state !== "ready") assert.fail(report.reason);
      assert.equal(report.assessment.id, completed);
      assert.equal(report.template.key, "uk-srs");
      assert.ok(report.narrative[0]!.startsWith("Harbourside Foods has reached step"));
      assert.equal(report.dashboard.benchmark.state, "future");
      const payload = JSON.stringify(report);
      assert.doesNotMatch(payload, /Ada Admin|staff-ada|slow to engage|2027-03-31|"owner"|"dueDate"|"linkedActionId"/);
      assert.ok(report.preparedBy.length > 0);
    });

    it("says so rather than drawing a draft, an unknown template, or a client it cannot see", async () => {
      assert.equal((await read((db) => getSrsReport(db, holder(), { clientId: B, templateKey: "uk-srs" }))).state, "none");
      assert.equal((await read((db) => getSrsReport(db, holder(), { clientId: A, assessmentId: draft, templateKey: "uk-srs" }))).state, "none");
      assert.equal((await read((db) => getSrsReport(db, holder(), { clientId: A, templateKey: "evergreen" }))).state, "none");
      await assert.rejects(read((db) => getSrsReport(db, holder("viewer"), { clientId: A, templateKey: "uk-srs" })), unauthorised);
    });

    it("puts every export on the record, and refuses one from an assessment not complete", async () => {
      const exported = await exportSrsReport(database.pool, { assessmentId: completed, templateKey: "uk-srs" }, context());
      assert.deepEqual([exported.data.templateKey, exported.data.templateVersion], ["uk-srs", 1]);
      await assert.rejects(exportSrsReport(database.pool, { assessmentId: draft, templateKey: "uk-srs" }, context()), refused("NOT_ASSESSED"));
      const audited = await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'srs_report_exported'`, [ORG]);
      assert.deepEqual(audited, [{ n: 1 }]);
    });
  });
});
