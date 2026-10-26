import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  benchmark, commandGrantForRole, overallReadiness, pillarReadiness, readinessTrend, srsCompletion, todayInLondon,
  type CommandContext, type SrsAssessment, type SrsFramework, type StaffRole,
} from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { withTenantRead } from "../src/postgres";
import { assignClientStrategy, removeClientStrategy } from "../src/reductionStrategies";
import { createSrsFrameworkDraft, listSrsFrameworkVersions, publishSrsFramework, updateSrsMaturityLevel, upsertSrsRequirement } from "../src/srsFramework";
import { completeSrsAssessment, getSrsAssessment, getSrsFramework, listSrsAssessments, setSrsAssessmentItem, startSrsAssessment } from "../src/srsReadiness";

/**
 * SRS S1 against a real database (0187 on 0070): the framework managed as versions — a draft copied, edited, published
 * to supersede, a published version never changing — and the consultant-led assessment dated on completion: opened,
 * pre-filled from the client's own NZI data, answered on the 0–4 ladder, refused completion until every requirement is
 * addressed, rolled up by weight, reassessed into a trend, with a truthful "Future" benchmark and the gap→action link
 * held to the client's own plan. Two clients come out different; nothing is fabricated.
 */

const ORG = "srs-org";
const A = "client-a";
const B = "client-b";
let keys = 0;
const context = (role: StaffRole = "admin", reason?: string): CommandContext => {
  keys += 1;
  return { organisationId: ORG, actorId: "ada", principal: "staff", idempotencyKey: `s1-${keys}`, correlationId: `corr-s1-${keys}`,
    grant: commandGrantForRole(role, ORG, "ada"), ...(reason ? { reason } : {}) };
};
const refused = (code: string) => (error: Error & { issues?: Array<{ code: string }> }) => error.issues?.some((issue) => issue.code === code) === true;

describe("SRS S1 — the framework as versions, and the assessment dated on completion (0187), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let admin: pg.Client;
  let v1: SrsFramework;
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const read = <T>(work: Parameters<typeof withTenantRead<T>>[2]) => withTenantRead(database.pool, ORG, work);
  const assessment = async (id: string) => (await read((db) => getSrsAssessment(db, id)))!;
  /** Answer every active requirement of `framework` not yet answered — `pick` chooses the maturity. */
  const answerAll = async (id: string, framework: SrsFramework, pick: (requirementId: string, index: number) => number) => {
    const current = await assessment(id);
    const versions = new Map(current.items.map((item) => [item.requirementId, item]));
    let index = 0;
    for (const requirement of framework.requirements.filter((entry) => entry.active)) {
      const held = versions.get(requirement.id);
      if (held?.maturity !== null && held !== undefined) { index += 1; continue; }
      await setSrsAssessmentItem(database.pool, { assessmentId: id, requirementId: requirement.id, maturity: pick(requirement.id, index), evidenceKind: "note", evidenceNote: "Workshop", expectedVersion: held?.version ?? 0 }, context());
      index += 1;
    }
  };

  before(async () => {
    database = (await createDisposableDatabase("srss1", {
      // Assessments as they stood before 0187: a draft and a completed one, each with the date typed in at start.
      onMigration: async (filename, client) => {
        if (!filename.startsWith("0186_")) return;
        await client.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'SRS Org')`, [ORG]);
        await client.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
        await client.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'legacy-client', 'Legacy', 'active')`, [ORG]);
        await client.query(`INSERT INTO nzi_console.srs_assessments (organisation_id, assessment_id, client_id, framework_id, framework_version, status, assessed_on, assessed_by, completed_at)
          VALUES ($1, 'legacy-done', 'legacy-client', 'uk-srs-2026', 1, 'complete', '2025-12-01', 'v7', '2025-12-02T10:00:00Z'),
                 ($1, 'legacy-draft', 'legacy-client', 'uk-srs-2026', 1, 'draft', '2026-01-15', 'v7', NULL)`, [ORG]);
      },
    }))!;
    admin = await database.admin();
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, 'Client A', 'active'), ($1, $3, 'Client B', 'active')`, [ORG, A, B]);
    // Client A holds forward targets — the assured record the Metrics & targets pillar reads instead of asking.
    await q(`INSERT INTO nzi_console.client_targets (organisation_id, client_id, version, near_term_year, near_term_pct, net_zero_year, net_zero_pct,
               benchmark_year, benchmark_total_tco2e, benchmark_source, set_by, correlation_id)
             VALUES ($1, $2, 1, 2030, 42, 2050, 90, 2024, 1000, 'client-record', 'seed', 'seed')`, [ORG, A]);
    v1 = (await read((db) => getSrsFramework(db)))!;
  });
  after(async () => { await admin?.end(); await database?.end(); });

  it("0187 moves a draft's typed date to started_on and clears its assessed date; a completed assessment keeps its own", async () => {
    const rows = await q(`SELECT assessment_id, status, started_on::text, assessed_on::text FROM nzi_console.srs_assessments WHERE client_id = 'legacy-client' ORDER BY assessment_id`);
    assert.deepEqual(rows, [
      { assessment_id: "legacy-done", status: "complete", started_on: "2025-12-01", assessed_on: "2025-12-01" },
      { assessment_id: "legacy-draft", status: "draft", started_on: "2026-01-15", assessed_on: null },
    ]);
    await assert.rejects(q(`UPDATE nzi_console.srs_assessments SET status = 'complete', completed_at = now() WHERE assessment_id = 'legacy-draft'`), /check constraint/, "complete without an assessed date");
  });

  describe("the assessment (R2–R4, R6)", () => {
    let first = "";

    it("opens dated started today, stamped with the framework version, with nothing assessed yet — and only one at a time", async () => {
      const started = await startSrsAssessment(database.pool, { clientId: A, prefillFromNziData: true }, context());
      first = started.data.assessmentId;
      const opened = await assessment(first);
      assert.deepEqual([opened.status, opened.startedOn, opened.assessedOn, opened.frameworkVersion], ["draft", todayInLondon(), null, v1.version]);
      await assert.rejects(startSrsAssessment(database.pool, { clientId: A }, context()), refused("ASSESSMENT_OPEN"));
      await assert.rejects(q(`INSERT INTO nzi_console.srs_assessments (organisation_id, assessment_id, client_id, framework_id, framework_version, status, started_on, assessed_by)
        VALUES ($1, 'second-draft', $2, $3, 1, 'draft', current_date, 'x')`, [ORG, A, v1.frameworkId]), /srs_assessments_one_draft/, "and the database holds it");
    });

    it("pre-fills Metrics & targets from the client's own assured record — marked auto, with its evidence — not re-keyed", async () => {
      const opened = await assessment(first);
      const targets = v1.requirements.find((requirement) => requirement.nziSourceKey === "targets.model")!;
      const item = opened.items.find((entry) => entry.requirementId === targets.id)!;
      assert.deepEqual([item.maturity, item.source, item.evidence?.kind], [3, "auto", "data"]);
      assert.equal(targets.pillarKey, "metrics");
      // Nothing it cannot see: no footprint snapshot exists, so no footprint requirement is answered.
      const footprint = v1.requirements.filter((requirement) => requirement.nziSourceKey?.startsWith("footprint."));
      assert.ok(footprint.every((requirement) => !opened.items.some((entry) => entry.requirementId === requirement.id && entry.maturity !== null)));
    });

    it("refuses completion until every requirement is addressed — Not started counts, no answer does not", async () => {
      await assert.rejects(completeSrsAssessment(database.pool, { assessmentId: first, expectedVersion: (await assessment(first)).version }, context()), refused("INCOMPLETE"));
      // One heavy requirement at Assured, everything else Established — and one left unanswered.
      const heavy = v1.requirements.find((requirement) => requirement.active && requirement.weight > 1) ?? v1.requirements[0]!;
      const last = v1.requirements.filter((requirement) => requirement.active).at(-1)!;
      await answerAll(first, { ...v1, requirements: v1.requirements.filter((requirement) => requirement.id !== last.id) }, (id) => id === heavy.id ? 4 : 2);
      assert.equal(srsCompletion(v1, (await assessment(first)).items).missing.length, 1);
      await assert.rejects(completeSrsAssessment(database.pool, { assessmentId: first, expectedVersion: (await assessment(first)).version }, context()), refused("INCOMPLETE"));
      await setSrsAssessmentItem(database.pool, { assessmentId: first, requirementId: last.id, maturity: 0, expectedVersion: 0 }, context());
      const done = await completeSrsAssessment(database.pool, { assessmentId: first, expectedVersion: (await assessment(first)).version }, context());
      assert.deepEqual([done.data.assessed, done.data.total, done.data.assessedOn], [v1.requirements.filter((r) => r.active).length, v1.requirements.filter((r) => r.active).length, todayInLondon()]);
      const completed = await assessment(first);
      assert.deepEqual([completed.status, completed.assessedOn], ["complete", todayInLondon()]);
      await assert.rejects(setSrsAssessmentItem(database.pool, { assessmentId: first, requirementId: last.id, maturity: 1, expectedVersion: 1 }, context()), refused("ASSESSMENT_COMPLETE"));
    });

    it("rolls up requirement → pillar → overall by weight, on the 0–4 ladder", async () => {
      const completed = await assessment(first);
      const items = new Map(completed.items.map((item) => [item.requirementId, item.maturity ?? 0]));
      const active = v1.requirements.filter((requirement) => requirement.active);
      const expected = (100 * active.reduce((sum, r) => sum + r.weight * (items.get(r.id)! / 4), 0)) / active.reduce((sum, r) => sum + r.weight, 0);
      // Σ(weight × maturity/4) / Σ(weight), as a percentage to one decimal place.
      assert.equal(overallReadiness(v1, completed.items).percent, Math.round(expected * 10) / 10);
      const pillars = pillarReadiness(v1, completed.items);
      assert.deepEqual(pillars.map((pillar) => pillar.pillarKey), ["governance", "strategy", "risk", "metrics"]);
      assert.ok(pillars.every((pillar) => pillar.overall.level >= 0 && pillar.overall.level <= 4), "no /3 anywhere: the ladder tops out at 4");
    });

    it("reassesses into a trend of completed assessments only; a reassessment in progress is not a point on it", async () => {
      const second = (await startSrsAssessment(database.pool, { clientId: A }, context())).data.assessmentId;
      await answerAll(second, v1, () => 3);
      await completeSrsAssessment(database.pool, { assessmentId: second, expectedVersion: (await assessment(second)).version }, context());
      await startSrsAssessment(database.pool, { clientId: A }, context()); // a third, left in progress
      const all = await read((db) => listSrsAssessments(db, A));
      assert.equal(all.length, 3);
      const trend = readinessTrend(v1, all);
      assert.equal(trend.length, 2, "the draft is not on the trend");
      assert.ok(trend[1]!.value > trend[0]!.value || trend[1]!.value !== trend[0]!.value);
    });

    it("assesses a second client differently, and renders the benchmark as Future — no invented peer figure", async () => {
      const id = (await startSrsAssessment(database.pool, { clientId: B, prefillFromNziData: true }, context())).data.assessmentId;
      const opened = await assessment(id);
      assert.equal(opened.items.filter((item) => item.source === "auto").length, 0, "client B holds no targets, so nothing is pre-filled");
      await answerAll(id, v1, (_id, index) => index % 5);
      await completeSrsAssessment(database.pool, { assessmentId: id, expectedVersion: (await assessment(id)).version }, context());
      const [a, b] = await read(async (db) => [(await listSrsAssessments(db, A)).find((x) => x.status === "complete")!, (await listSrsAssessments(db, B))[0]!] as const);
      assert.notEqual(overallReadiness(v1, a.items).percent, overallReadiness(v1, b.items).percent);
      for (const entry of [a, b] as SrsAssessment[]) {
        assert.equal(benchmark(entry).state, "future");
        assert.deepEqual([entry.sectorKey, entry.benchmarkPercentile, entry.benchmarkSource], [null, null, null]);
      }
    });

    it("links a gap to an action on this client's plan only — the Actions spine (R7)", async () => {
      const draft = (await read((db) => listSrsAssessments(db, A))).find((entry) => entry.status === "draft")!;
      const requirement = v1.requirements.find((entry) => entry.active)!;
      const plan = async (clientId: string) => (await assignClientStrategy(database.pool, {
        clientId, bespoke: { title: `Board oversight ${clientId}`, scope: "governance", controlLevel: "direct_control" }, srsRequirementIds: [requirement.id],
        origin: "srs_gap", originSrsRequirementId: requirement.id,
      }, context())).data.clientStrategyId;
      const own = await plan(A), other = await plan(B);
      await setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, linkedActionId: own, expectedVersion: 0 }, context());
      assert.equal((await assessment(draft.assessmentId)).items.find((item) => item.requirementId === requirement.id)!.linkedActionId, own);
      await assert.rejects(setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, linkedActionId: other, expectedVersion: 1 }, context()), refused("NOT_THIS_CLIENTS"));
      await removeClientStrategy(database.pool, { clientStrategyId: own, expectedVersion: 1, reason: "test" }, context("admin", "test"));
      await assert.rejects(setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, linkedActionId: own, expectedVersion: 1 }, context()), refused("REMOVED"));
      await assert.rejects(q(`UPDATE nzi_console.srs_assessment_items SET linked_action_id = 'no-such-action' WHERE assessment_id = $1`, [draft.assessmentId]), /foreign key/);
    });

    it("is srs.manage: a viewer cannot assess, and every start, answer and completion is audited", async () => {
      await assert.rejects(startSrsAssessment(database.pool, { clientId: "legacy-client" }, context("viewer")), /srs\.manage|permission|not allowed/i);
      const actions = (await q<{ action: string }>(`SELECT DISTINCT action FROM nzi_console.audit_events WHERE action LIKE 'srs_assessment_%'`)).map((row) => row.action).sort();
      assert.deepEqual(actions, ["srs_assessment_completed", "srs_assessment_item_set", "srs_assessment_started"]);
    });
  });

  describe("the framework as versions (R1, R5)", () => {
    let draftId = "";

    it("starts a draft as a full copy of the version in force — one draft at a time", async () => {
      const created = await createSrsFrameworkDraft(database.pool, {}, context());
      draftId = created.data.frameworkId;
      assert.deepEqual([created.data.version, created.data.copiedFrom, created.data.requirements], [v1.version + 1, v1.frameworkId, v1.requirements.length]);
      const draft = (await read((db) => getSrsFramework(db, draftId)))!;
      assert.deepEqual([draft.status, draft.maturityLevels.length, draft.pillars.length, draft.standards.length], ["draft", 5, 4, 2]);
      assert.deepEqual(draft.requirements.map((r) => r.id).sort(), v1.requirements.map((r) => r.id).sort(), "the same requirements, carried over by id");
      await assert.rejects(createSrsFrameworkDraft(database.pool, {}, context()), refused("DRAFT_OPEN"));
    });

    it("edits only the draft: reword, reweight, retire, add — and a published version is refused, in the command and the database", async () => {
      const [reworded, retired] = v1.requirements.filter((r) => r.active && r.source === "entered");
      await upsertSrsRequirement(database.pool, { ...reqInput(draftId, reworded!), title: "Board oversight of climate risk, minuted quarterly", weight: 3 }, context());
      await upsertSrsRequirement(database.pool, { ...reqInput(draftId, retired!), active: false }, context());
      const added = await upsertSrsRequirement(database.pool, { frameworkId: draftId, standardKey: "S2", pillarKey: "metrics", code: "S2 M99", title: "Transition-plan metrics", weight: 1, targetMaturity: 2, active: true }, context());
      const draft = (await read((db) => getSrsFramework(db, draftId)))!;
      assert.equal(draft.requirements.find((r) => r.id === reworded!.id)!.weight, 3);
      assert.equal(draft.requirements.find((r) => r.id === retired!.id)!.active, false);
      assert.ok(draft.requirements.some((r) => r.id === added.data.requirementId && r.code === "S2 M99"));
      await assert.rejects(upsertSrsRequirement(database.pool, { ...reqInput(draftId, reworded!), code: "S2 X1" }, context()), refused("FIXED"));
      await assert.rejects(upsertSrsRequirement(database.pool, { ...reqInput(v1.frameworkId, reworded!), title: "Rewrite history" }, context()), refused("PUBLISHED"));
      await assert.rejects(q(`UPDATE nzi_console.srs_requirements SET title = 'Rewrite history' WHERE framework_id = $1 AND requirement_id = $2`, [v1.frameworkId, reworded!.id]), /never edited/);
      await updateSrsMaturityLevel(database.pool, { frameworkId: draftId, level: 2, label: "Established", definition: "Documented, operating and owned." }, context());
      await assert.rejects(updateSrsMaturityLevel(database.pool, { frameworkId: draftId, level: 5, label: "Beyond", definition: "x" }, context()), refused("INVALID"), "five fixed steps");
      await assert.rejects(q(`UPDATE nzi_console.srs_maturity_levels SET label = 'X' WHERE framework_id = $1 AND level = 1`, [v1.frameworkId]), /never edited/);
    });

    it("publishes: the draft comes into force, the version before is superseded, the library's alignment is carried, and nothing goes back", async () => {
      const published = await publishSrsFramework(database.pool, { frameworkId: draftId, effectiveFrom: "2027-01-01" }, context());
      assert.equal(published.data.superseded, v1.frameworkId);
      const versions = await read(listSrsFrameworkVersions);
      assert.deepEqual(versions.map((v) => [v.version, v.status]), [[v1.version + 1, "active"], [v1.version, "superseded"]]);
      assert.ok(published.data.libraryAlignmentsCarried > 0, "Add from library keeps pre-filling what a strategy advances");
      await assert.rejects(q(`UPDATE nzi_console.srs_frameworks SET status = 'active' WHERE framework_id = $1`, [v1.frameworkId]), /never back/);
      // A new assessment stamps the new version; an earlier one keeps its own, unchanged.
      const id = (await startSrsAssessment(database.pool, { clientId: B }, context())).data.assessmentId;
      assert.equal((await assessment(id)).frameworkVersion, v1.version + 1, "a new assessment is made against the version in force");
      const legacyDraft = await assessment("legacy-draft");
      assert.equal(legacyDraft.frameworkVersion, v1.version, "an assessment keeps the version it was made against");
      // The retired requirement leaves new assessments; completing B's needs only the new version's active set.
      const v2 = (await read((db) => getSrsFramework(db)))!;
      assert.equal(srsCompletion(v2, []).total, v1.requirements.filter((r) => r.active).length - 1 + 1, "one retired, one added");
      const old = (await read((db) => getSrsFramework(db, v1.frameworkId)))!;
      assert.deepEqual(old.requirements.map((r) => [r.id, r.title, r.weight]), v1.requirements.map((r) => [r.id, r.title, r.weight]), "the superseded version reads exactly as it did");
    });

    it("is admin.lookups: a consultant cannot version the framework, and every step is audited", async () => {
      await assert.rejects(createSrsFrameworkDraft(database.pool, {}, context("consultant")), /admin\.lookups|permission|not allowed/i);
      const actions = (await q<{ action: string }>(`SELECT DISTINCT action FROM nzi_console.audit_events WHERE action LIKE 'srs_framework_%'`)).map((row) => row.action).sort();
      assert.deepEqual(actions, ["srs_framework_draft_created", "srs_framework_maturity_updated", "srs_framework_published", "srs_framework_requirement_upserted"]);
    });
  });
});

const reqInput = (frameworkId: string, requirement: SrsFramework["requirements"][number]) => ({
  frameworkId, requirementId: requirement.id, standardKey: requirement.standardKey, pillarKey: requirement.pillarKey, code: requirement.code,
  title: requirement.title, helpText: requirement.helpText, weight: requirement.weight, targetMaturity: requirement.targetMaturity, active: requirement.active,
});
