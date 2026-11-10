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
import {
  listSrsFrameworkHistory, listSrsFrameworkSnapshots, listSrsFrameworkStates, lockSrsFramework, srsWorkingDefinitionId, unlockSrsFramework, updateSrsMaturityLevel, upsertSrsPillar, upsertSrsRequirement,
} from "../src/srsFramework";
import { completeSrsAssessment, getSrsAssessment, getSrsFramework, listSrsAssessments, reopenSrsAssessment, setSrsAssessmentItem, setSrsAssessmentNotes, startSrsAssessment } from "../src/srsReadiness";

/**
 * SRS S1 against a real database (0187 on 0070): the framework managed as versions — a draft copied, edited, published
 * to supersede, a published version never changing — and the consultant-led assessment dated on completion: opened,
 * pre-filled from the client's own NZI data, answered on the 0–4 ladder, refused completion until every requirement is
 * addressed, rolled up by weight, reassessed into a trend, with a truthful "Future" benchmark and the gap→action link
 * held to the client's own plan. Two clients come out different; nothing is fabricated.
 */

const ORG = "srs-org";
const LEGACY_ORG = "srs-legacy-draft-org";
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
        // A draft version open from the old "start a new version" flow, in an organisation of its own, before 0222.
        if (filename.startsWith("0221_")) {
          await client.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, 'Legacy Draft Org')`, [LEGACY_ORG]);
          await client.query(`SELECT set_config('app.organisation_id', $1, false)`, [LEGACY_ORG]);
          await client.query(`INSERT INTO nzi_console.srs_frameworks (organisation_id, framework_id, version, label, status, published_by, published_at)
            VALUES ($1, 'legacy-v2', 2, 'Draft', 'draft', 'bea', '2026-10-01T09:00:00Z')`, [LEGACY_ORG]);
          return;
        }
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

    it("reopens a completed assessment to correct it — same assessment, dates cleared, no new trend point — and re-completes it (B1)", async () => {
      const id = (await read((db) => listSrsAssessments(db, B))).find((entry) => entry.status === "complete")!.assessmentId;
      const done = await assessment(id);
      const before = (await read((db) => listSrsAssessments(db, B))).length;
      const requirement = v1.requirements.find((entry) => entry.active)!;
      const held = done.items.find((item) => item.requirementId === requirement.id)!;
      await assert.rejects(reopenSrsAssessment(database.pool, { assessmentId: id, expectedVersion: done.version }, context("viewer")), /srs\.manage|permission|not allowed/i);
      await assert.rejects(reopenSrsAssessment(database.pool, { assessmentId: id, expectedVersion: done.version + 1 }, context()), /version|conflict/i);
      // A client with an assessment already in progress cannot also reopen one: A's third is a draft.
      const aDone = (await read((db) => listSrsAssessments(db, A))).find((entry) => entry.status === "complete")!;
      await assert.rejects(reopenSrsAssessment(database.pool, { assessmentId: aDone.assessmentId, expectedVersion: aDone.version }, context()), refused("ASSESSMENT_OPEN"));

      const reopened = await reopenSrsAssessment(database.pool, { assessmentId: id, expectedVersion: done.version }, context());
      assert.equal(reopened.data.version, done.version + 1);
      const draft = await assessment(id);
      assert.deepEqual([draft.status, draft.assessedOn], ["draft", null]);
      assert.equal((await q(`SELECT completed_at FROM nzi_console.srs_assessments WHERE assessment_id = $1`, [id]))[0]!.completed_at, null);
      assert.equal((await read((db) => listSrsAssessments(db, B))).length, before, "reopening adds no assessment");
      assert.equal(readinessTrend(v1, await read((db) => listSrsAssessments(db, B))).length, 0, "while reopened it is off the trend");
      await assert.rejects(reopenSrsAssessment(database.pool, { assessmentId: id, expectedVersion: draft.version }, context()), refused("NOT_COMPLETE"));

      // It takes answers again, and completing it dates it afresh.
      await setSrsAssessmentItem(database.pool, { assessmentId: id, requirementId: requirement.id, maturity: 3, expectedVersion: held.version }, context());
      await completeSrsAssessment(database.pool, { assessmentId: id, expectedVersion: (await assessment(id)).version }, context());
      const again = await assessment(id);
      assert.deepEqual([again.status, again.assessedOn, again.items.find((item) => item.requirementId === requirement.id)!.maturity], ["complete", todayInLondon(), 3]);
      assert.equal(readinessTrend(v1, await read((db) => listSrsAssessments(db, B))).length, 1);
    });

    it("reopens only the latest assessment: with two completed, the older is refused NOT_LATEST and the latest reopens (B1)", async () => {
      const [older] = (await read((db) => listSrsAssessments(db, B))).filter((entry) => entry.status === "complete");
      await q(`UPDATE nzi_console.srs_assessments SET started_on = started_on - 30, assessed_on = assessed_on - 30 WHERE assessment_id = $1`, [older!.assessmentId]);
      const second = (await startSrsAssessment(database.pool, { clientId: B }, context())).data.assessmentId;
      await answerAll(second, v1, () => 2);
      await completeSrsAssessment(database.pool, { assessmentId: second, expectedVersion: (await assessment(second)).version }, context());
      const olderNow = await assessment(older!.assessmentId), latest = await assessment(second);
      await assert.rejects(reopenSrsAssessment(database.pool, { assessmentId: older!.assessmentId, expectedVersion: olderNow.version }, context()), refused("NOT_LATEST"));
      assert.equal((await assessment(older!.assessmentId)).status, "complete", "the refused reopen changed nothing");
      await reopenSrsAssessment(database.pool, { assessmentId: second, expectedVersion: latest.version }, context());
      assert.equal((await assessment(second)).status, "draft");
      await completeSrsAssessment(database.pool, { assessmentId: second, expectedVersion: (await assessment(second)).version }, context()); // leave the client with none in progress
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

    it("carries a priority on the item — high, medium, low or unset — and nothing else (0211)", async () => {
      const draft = (await read((db) => listSrsAssessments(db, A))).find((entry) => entry.status === "draft")!;
      const requirement = v1.requirements.filter((entry) => entry.active)[1]!;
      const item = async () => (await assessment(draft.assessmentId)).items.find((entry) => entry.requirementId === requirement.id);
      assert.equal(await item(), undefined, "nothing answered yet, so nothing set");
      await setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, priority: "high", expectedVersion: 0 }, context());
      assert.equal((await item())!.priority, "high");
      await setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, priority: "low", expectedVersion: 1 }, context());
      assert.equal((await item())!.priority, "low");
      await setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, expectedVersion: 2 }, context());
      assert.equal((await item())!.priority, null, "unset is null");
      // Outside the vocabulary: refused by the command, and by the database underneath it.
      await assert.rejects(setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, priority: "urgent" as never, expectedVersion: 3 }, context()), refused("INVALID"));
      await assert.rejects(q(`UPDATE nzi_console.srs_assessment_items SET priority = 'urgent' WHERE assessment_id = $1`, [draft.assessmentId]), /check constraint/);
      // The audit payload carries it.
      await setSrsAssessmentItem(database.pool, { assessmentId: draft.assessmentId, requirementId: requirement.id, maturity: 1, priority: "medium", expectedVersion: 3 }, context());
      const audited = await q<{ after_json: { priority: string | null } }>(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'srs_assessment_item_set' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [`${draft.assessmentId}:${requirement.id}`]);
      assert.equal(audited[0]!.after_json.priority, "medium");
      // A pre-filled answer carries none until a consultant sets one.
      assert.ok((await assessment(first)).items.filter((entry) => entry.source === "auto").every((entry) => entry.priority === null));
    });

    it("sets the assessment's context note on a draft — versioned, audited, srs.manage, refused once complete (B3)", async () => {
      const draft = (await read((db) => listSrsAssessments(db, A))).find((entry) => entry.status === "draft")!;
      const note = "Board paper due in March; finance lead is the contact.";
      await assert.rejects(setSrsAssessmentNotes(database.pool, { assessmentId: draft.assessmentId, notes: note, expectedVersion: draft.version }, context("viewer")), /srs.manage|permission|not allowed/i);
      await assert.rejects(setSrsAssessmentNotes(database.pool, { assessmentId: draft.assessmentId, notes: note, expectedVersion: draft.version + 1 }, context()), /version|conflict/i);
      assert.equal((await assessment(draft.assessmentId)).notes, "", "the refused writes changed nothing");

      const saved = await setSrsAssessmentNotes(database.pool, { assessmentId: draft.assessmentId, notes: note, expectedVersion: draft.version }, context());
      assert.equal(saved.data.version, draft.version + 1);
      const read1 = await assessment(draft.assessmentId);
      assert.deepEqual([read1.notes, read1.version], [note, draft.version + 1], "the note round-trips through the read model");
      await setSrsAssessmentNotes(database.pool, { assessmentId: draft.assessmentId, notes: "", expectedVersion: saved.data.version }, context());
      assert.equal((await assessment(draft.assessmentId)).notes, "", "it can be cleared");

      const audited = await q<{ after_json: { notes: string } }>(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'srs_assessment_notes_set' AND entity_id = $1 ORDER BY occurred_at ASC LIMIT 1`, [draft.assessmentId]);
      assert.equal(audited[0]!.after_json.notes, note);

      const done = await assessment(first);
      assert.equal(done.status, "complete");
      await assert.rejects(setSrsAssessmentNotes(database.pool, { assessmentId: done.assessmentId, notes: note, expectedVersion: done.version }, context()), refused("ASSESSMENT_COMPLETE"));
    });

    it("is srs.manage: a viewer cannot assess, and every start, answer and completion is audited", async () => {
      await assert.rejects(startSrsAssessment(database.pool, { clientId: "legacy-client" }, context("viewer")), /srs\.manage|permission|not allowed/i);
      const actions = (await q<{ action: string }>(`SELECT DISTINCT action FROM nzi_console.audit_events WHERE action LIKE 'srs_assessment_%'`)).map((row) => row.action).sort();
      assert.deepEqual(actions, ["srs_assessment_completed", "srs_assessment_item_set", "srs_assessment_notes_set", "srs_assessment_reopened", "srs_assessment_started"]);
    });
  });

  describe("the frameworks locked and unlocked, edited only while unlocked, with stamped history (0222; R1, R5)", () => {
    const state = async (key: string) => (await read(listSrsFrameworkStates)).find((framework) => framework.key === key)!;
    const history = () => read((db) => listSrsFrameworkHistory(db));
    const working = async () => (await read(async (db) => getSrsFramework(db, (await srsWorkingDefinitionId(db))!)))!;
    let pinnedAssessment = "";
    let pinnedTitles: Array<[string, string, number]> = [];

    it("0222 seeds each framework locked at the snapshot in force, stamped by its publisher, with its lock in the history", async () => {
      const states = await read(listSrsFrameworkStates);
      assert.deepEqual(states.map((s) => [s.key, s.locked, s.changedBy, s.snapshotVersion, s.version]), [["S2", true, "migration:0070", v1.version, 1], ["S1", true, "migration:0070", v1.version, 1]]);
      const seeded = (await history()).filter((entry) => entry.event === "locked").map((entry) => [entry.frameworkKey, entry.snapshotVersion, entry.actorId]).sort();
      assert.deepEqual(seeded, [["S1", v1.version, "migration:0070"], ["S2", v1.version, "migration:0070"]]);
      assert.equal(await read(srsWorkingDefinitionId), null, "no working definition until the first unlock");
    });

    it("0222 turns a draft left open by the old flow into the working definition, its frameworks unlocked by whoever started it", async () => {
      const rows = await q(`SELECT framework_key, locked, changed_by FROM nzi_console.srs_framework_locks WHERE organisation_id = $1 ORDER BY framework_key`, [LEGACY_ORG]);
      assert.deepEqual(rows, [{ framework_key: "S1", locked: false, changed_by: "bea" }, { framework_key: "S2", locked: false, changed_by: "bea" }]);
      const events = (await q(`SELECT event, framework_key, actor_id FROM nzi_console.srs_framework_history WHERE organisation_id = $1 ORDER BY event, framework_key`, [LEGACY_ORG]))
        .map((row) => [row.event, row.framework_key, row.actor_id]);
      assert.deepEqual(events, [["locked", "S1", "migration:0070"], ["locked", "S2", "migration:0070"], ["unlocked", "S1", "bea"], ["unlocked", "S2", "bea"]]);
    });

    it("a locked framework is read-only: an edit, a pillar and the ladder are refused while every framework is locked", async () => {
      const requirement = v1.requirements.find((r) => r.standardKey === "S2" && r.active)!;
      await assert.rejects(upsertSrsRequirement(database.pool, { ...reqInput(requirement), title: "Rewrite" }, context()), refused("LOCKED"));
      await assert.rejects(upsertSrsPillar(database.pool, { label: "Transition" }, context()), refused("LOCKED"));
      await assert.rejects(updateSrsMaturityLevel(database.pool, { level: 2, label: "X", definition: "Y" }, context()), refused("LOCKED"));
      await assert.rejects(lockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 1 }, context()), refused("LOCKED"), "already locked");
    });

    it("unlocking is stamped, opens the working definition as a full copy of the snapshot in force, warns of pinned assessments, and stops new assessments", async () => {
      await assert.rejects(unlockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 0 }, context()), /version|conflict/i);
      const unlocked = await unlockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 1 }, context());
      assert.deepEqual([unlocked.data.version, unlocked.data.reopenedFrom], [2, v1.version]);
      assert.ok(unlocked.data.assessmentsPinned > 0, "the unlock reports the assessments pinned to their snapshots");
      const s2 = await state("S2");
      assert.deepEqual([s2.locked, s2.changedBy, s2.changedByName], [false, "ada", "Ada Admin"]);
      assert.equal((await state("S1")).locked, true, "unlocking one framework leaves the other locked");
      const definition = await working();
      assert.equal(definition.status, "draft");
      assert.deepEqual(definition.requirements.map((r) => [r.id, r.title, r.weight]), v1.requirements.map((r) => [r.id, r.title, r.weight]), "a full copy, carried by id");
      const [latest] = await history();
      assert.deepEqual([latest!.event, latest!.frameworkKey, latest!.actorId, latest!.snapshotVersion], ["unlocked", "S2", "ada", v1.version]);
      await assert.rejects(unlockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 2 }, context()), refused("UNLOCKED"));
      await assert.rejects(startSrsAssessment(database.pool, { clientId: B }, context()), refused("FRAMEWORK_UNLOCKED"), "no assessing an unlocked framework");
    });

    it("an unlocked framework is edited — reword, reweight, retire, add — each stamped; a locked one is refused in the command and the database", async () => {
      const [reworded, retired] = v1.requirements.filter((r) => r.standardKey === "S2" && r.active && r.source === "entered");
      await upsertSrsRequirement(database.pool, { ...reqInput(reworded!), title: "Board oversight of climate risk, minuted quarterly", weight: 3 }, context());
      await upsertSrsRequirement(database.pool, { ...reqInput(retired!), active: false }, context());
      const added = await upsertSrsRequirement(database.pool, { frameworkKey: "S2", pillarKey: "metrics", code: "S2 M99", title: "Transition-plan metrics", weight: 1, targetMaturity: 2, active: true }, context());
      const definition = await working();
      assert.equal(definition.requirements.find((r) => r.id === reworded!.id)!.weight, 3);
      assert.equal(definition.requirements.find((r) => r.id === retired!.id)!.active, false);
      assert.ok(definition.requirements.some((r) => r.id === added.data.requirementId && r.code === "S2 M99"));
      await assert.rejects(upsertSrsRequirement(database.pool, { ...reqInput(reworded!), code: "S2 X1" }, context()), refused("FIXED"));

      const stamped = (await history()).filter((entry) => entry.actorId === "ada" && entry.event.startsWith("requirement_"));
      assert.deepEqual(stamped.map((entry) => [entry.event, entry.subject, entry.frameworkKey]).sort(),
        [["requirement_added", added.data.requirementId, "S2"], ["requirement_edited", reworded!.id, "S2"], ["requirement_retired", retired!.id, "S2"]].sort());
      const edit = stamped.find((entry) => entry.event === "requirement_edited")!;
      assert.deepEqual([edit.before?.weight, edit.after?.weight, edit.actorName], [reworded!.weight, 3, "Ada Admin"]);

      // S1 is still locked: refused by the command, and by the database underneath it.
      const s1 = v1.requirements.find((r) => r.standardKey === "S1" && r.active)!;
      await assert.rejects(upsertSrsRequirement(database.pool, { ...reqInput(s1), title: "Rewrite" }, context()), refused("LOCKED"));
      await assert.rejects(q(`UPDATE nzi_console.srs_requirements SET title = 'Rewrite' WHERE framework_id = $1 AND requirement_id = $2`, [definition.frameworkId, s1.id]), /is locked/);
      // Pillars and the ladder are shared: refused while S1 is locked.
      await assert.rejects(upsertSrsPillar(database.pool, { label: "Transition" }, context()), refused("SHARED_LOCKED"));
      await assert.rejects(updateSrsMaturityLevel(database.pool, { level: 2, label: "X", definition: "Y" }, context()), refused("SHARED_LOCKED"));
      await assert.rejects(q(`UPDATE nzi_console.srs_pillars SET label = 'X' WHERE framework_id = $1 AND pillar_key = 'governance'`, [definition.frameworkId]), /shared/);
      // A published snapshot is never edited.
      await assert.rejects(q(`UPDATE nzi_console.srs_requirements SET title = 'Rewrite history' WHERE framework_id = $1 AND requirement_id = $2`, [v1.frameworkId, reworded!.id]), /never edited/);
    });

    it("locking makes the next snapshot: in force, read-only, the one before superseded, the library's alignment carried — and assessing resumes against it", async () => {
      const locked = await lockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 2 }, context());
      assert.deepEqual([locked.data.snapshotVersion, locked.data.superseded, locked.data.version], [v1.version + 1, v1.frameworkId, 3]);
      assert.ok(locked.data.libraryAlignmentsCarried > 0, "Add from library keeps pre-filling what a strategy advances");
      const snapshots = await read(listSrsFrameworkSnapshots);
      assert.deepEqual(snapshots.map((s) => [s.version, s.status]), [[v1.version + 1, "active"], [v1.version, "superseded"]], "the working definition is not a snapshot");
      assert.equal((await state("S2")).locked, true);
      const [latest] = await history();
      assert.deepEqual([latest!.event, latest!.frameworkKey, latest!.snapshotVersion, latest!.actorId], ["locked", "S2", v1.version + 1, "ada"]);
      // Read-only again — in the command and in the working definition underneath it.
      const requirement = (await working()).requirements.find((r) => r.standardKey === "S2" && r.active)!;
      await assert.rejects(upsertSrsRequirement(database.pool, { ...reqInput(requirement), title: "Rewrite" }, context()), refused("LOCKED"));
      await assert.rejects(q(`UPDATE nzi_console.srs_requirements SET title = 'Rewrite' WHERE framework_id = $1 AND requirement_id = $2`, [(await working()).frameworkId, requirement.id]), /is locked/);
      await assert.rejects(q(`UPDATE nzi_console.srs_frameworks SET status = 'active' WHERE framework_id = $1`, [v1.frameworkId]), /never back/);

      // A new assessment binds to the new snapshot; an earlier one keeps its own.
      pinnedAssessment = (await startSrsAssessment(database.pool, { clientId: B }, context())).data.assessmentId;
      assert.equal((await assessment(pinnedAssessment)).frameworkVersion, v1.version + 1);
      assert.equal((await assessment("legacy-draft")).frameworkVersion, v1.version, "an assessment keeps the snapshot it was made against");
      const v2 = (await read((db) => getSrsFramework(db)))!;
      assert.equal(srsCompletion(v2, []).total, v1.requirements.filter((r) => r.active).length - 1 + 1, "one retired, one added");
      pinnedTitles = v2.requirements.map((r) => [r.id, r.title, r.weight]);
      const old = (await read((db) => getSrsFramework(db, v1.frameworkId)))!;
      assert.deepEqual(old.requirements.map((r) => [r.id, r.title, r.weight]), v1.requirements.map((r) => [r.id, r.title, r.weight]), "the superseded snapshot reads exactly as it did");
    });

    it("locks one framework without the other's half-finished edits, changes pillars and the ladder only with every framework unlocked, and never moves a pinned assessment's basis", async () => {
      const s1 = v1.requirements.find((r) => r.standardKey === "S1" && r.active)!;
      const s2 = v1.requirements.filter((r) => r.standardKey === "S2" && r.active && r.source === "entered")[2]!;
      await unlockSrsFramework(database.pool, { frameworkKey: "S1", expectedVersion: 1 }, context());
      await upsertSrsRequirement(database.pool, { ...reqInput(s1), title: "Half-finished S1 wording" }, context());
      await unlockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 3 }, context());
      await upsertSrsRequirement(database.pool, { ...reqInput(s2), title: "Finished S2 wording" }, context());
      // Both unlocked: the shared parts can change, stamped as shared (no framework).
      const pillar = await upsertSrsPillar(database.pool, { label: "Transition planning", description: "The transition plan and its delivery." }, context());
      await upsertSrsPillar(database.pool, { pillarKey: "risk", label: "Risk" }, context());
      await updateSrsMaturityLevel(database.pool, { level: 2, label: "Established", definition: "Documented, operating and owned." }, context());
      await assert.rejects(upsertSrsPillar(database.pool, { label: "transition planning" }, context()), refused("DUPLICATE"));
      const shared = (await history()).filter((entry) => entry.frameworkKey === null && entry.actorId === "ada").map((entry) => [entry.event, entry.subject]).sort();
      assert.deepEqual(shared, [["ladder_reworded", "2"], ["pillar_added", pillar.data.pillarKey], ["pillar_renamed", "risk"]]);

      const s2Locked = await lockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 4 }, context());
      const v3 = (await read((db) => getSrsFramework(db)))!;
      assert.equal(v3.version, s2Locked.data.snapshotVersion);
      assert.equal(v3.requirements.find((r) => r.id === s2.id)!.title, "Finished S2 wording", "the locked framework's edits are in the snapshot");
      assert.equal(v3.requirements.find((r) => r.id === s1.id)!.title, s1.title, "the unlocked framework goes in as its last snapshot held it");
      assert.equal((await working()).requirements.find((r) => r.id === s1.id)!.title, "Half-finished S1 wording", "and its edits carry on in the working definition");

      const s1Locked = await lockSrsFramework(database.pool, { frameworkKey: "S1", expectedVersion: 2 }, context());
      const v4 = (await read((db) => getSrsFramework(db)))!;
      assert.equal(v4.version, s1Locked.data.snapshotVersion);
      assert.deepEqual([v4.requirements.find((r) => r.id === s1.id)!.title, v4.requirements.find((r) => r.id === s2.id)!.title], ["Half-finished S1 wording", "Finished S2 wording"]);
      assert.deepEqual([v4.pillars.find((p) => p.key === "risk")!.label, v4.pillars.some((p) => p.key === pillar.data.pillarKey), v4.maturityLevels[2]!.definition],
        ["Risk", true, "Documented, operating and owned."]);
      assert.ok((await read(listSrsFrameworkStates)).every((framework) => framework.locked));

      // The assessment pinned to snapshot 2 reads exactly as it did, through every unlock, edit and lock since.
      const pinned = await assessment(pinnedAssessment);
      assert.equal(pinned.frameworkVersion, v1.version + 1);
      const basis = (await read((db) => getSrsFramework(db, pinned.frameworkId)))!;
      assert.deepEqual(basis.requirements.map((r) => [r.id, r.title, r.weight]), pinnedTitles);
      const states = (await q(`SELECT count(*)::int AS n FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status = 'draft'`, [ORG]))[0]!.n;
      assert.equal(states, 1, "one working definition, kept");
    });

    it("keeps the history append-only — no update, no delete, even by the owner", async () => {
      await assert.rejects(q(`UPDATE nzi_console.srs_framework_history SET actor_id = 'someone-else' WHERE organisation_id = $1`, [ORG]), /append-only/);
      await assert.rejects(q(`DELETE FROM nzi_console.srs_framework_history WHERE organisation_id = $1`, [ORG]), /append-only/);
      const grants = await q(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'nzi_console_app' AND table_name = 'srs_framework_history' ORDER BY privilege_type`);
      assert.deepEqual(grants.map((row) => row.privilege_type), ["INSERT", "SELECT"]);
    });

    it("is admin.lookups: a consultant cannot lock, unlock or edit, and every step is audited as well as in the history", async () => {
      await assert.rejects(unlockSrsFramework(database.pool, { frameworkKey: "S2", expectedVersion: 5 }, context("consultant")), /admin\.lookups|permission|not allowed/i);
      await assert.rejects(upsertSrsPillar(database.pool, { label: "Nope" }, context("consultant")), /admin\.lookups|permission|not allowed/i);
      const actions = (await q<{ action: string }>(`SELECT DISTINCT action FROM nzi_console.audit_events WHERE action LIKE 'srs_framework_%' AND actor_id <> 'migration:0208'`)).map((row) => row.action).sort();
      assert.deepEqual(actions, ["srs_framework_locked", "srs_framework_maturity_updated", "srs_framework_pillar_upserted", "srs_framework_requirement_upserted", "srs_framework_unlocked"]);
      const audited = (await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action IN ('srs_framework_locked', 'srs_framework_unlocked')`))[0]!.n;
      const stamped = (await history()).filter((entry) => entry.actorId === "ada" && (entry.event === "locked" || entry.event === "unlocked")).length;
      assert.deepEqual([audited, stamped], [6, 6], "every lock and unlock, in the audit log and the history alike");
    });
  });
});

const reqInput = (requirement: SrsFramework["requirements"][number]) => ({
  frameworkKey: requirement.standardKey, requirementId: requirement.id, pillarKey: requirement.pillarKey, code: requirement.code,
  title: requirement.title, helpText: requirement.helpText, weight: requirement.weight, targetMaturity: requirement.targetMaturity, active: requirement.active,
});
