import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { approveScopeRow, CommandValidationError, createReviewedCrpSnapshot, rejectScopeRow, resolveAssuranceGap } from "../src/postgresCommands";
import { getAssuranceScreen, getScopeQaReadiness } from "../src/readModels";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction } from "../src/v7Reingest";
import { attestReingestRows, planReingestAttestation, previewReingestAttestation, REINGEST_ATTESTATION, type ReingestAttestationPlan } from "../src/reingestAttest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * RULING-reingest-bulk-attest against a real database: `scope.review.attest_reingest` — one staff reviewer's attestation over a
 * re-ingest run's pending rows, each recorded as that reviewer's own approval, with only the record-of-account gaps resolved.
 * The eligibility matrix, reviewer ≠ preparer, all-or-nothing on anything that moved since the preview, never overwriting a
 * resolution — and J000663's end state: one act, 0 awaiting review, 0 open row gaps, the freeze gate open.
 */
const ORG = "v7-attest";
const REVIEWER = "staff-reviewer";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const record = (over: Record<string, unknown>) => ({ qty: 0, uom: "kWh", factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: 0, data_source: "Company Data", enabled: true, ...over });
type V7 = { id: string; scope: string; label: string; qty: number; unit: string; reported: number; months?: Array<number | null> };
const gasRow = (id: string, label: string, qty: number, reported: number): [V7, V7ReingestPlanRow] => [
  { id, scope: "1", label, qty, unit: "kWh", reported },
  { v7RowId: id, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: label, quantity: qty, unit: "kWh",
    datasetId: "v7-vintage-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: reported, rule: "S1-GAS" },
];
const waterRow = (id: string): [V7, V7ReingestPlanRow] => [
  { id, scope: "3", label: "Water Supply", qty: 10, unit: "cubic metres", reported: 0.0015 },
  { v7RowId: id, disposition: "RE-INGEST", categoryCode: "3.5", scope: "3.5", sourceLabel: "Water Supply", quantity: 10, unit: "m3",
    datasetId: "v7-vintage-2025", factorId: "water", qualityTier: "measured", v7Tco2e: 0.0015, rule: "S3-5" },
];
const refrigerantRow = (id: string): [V7, V7ReingestPlanRow] => [
  { id, scope: "1", label: "Refrigerant", qty: 2.19, unit: "tCO2e", reported: 2.19 },
  { v7RowId: id, disposition: "REPORTED-TOTAL", categoryCode: "1.refrigerants", scope: "1", sourceLabel: "Refrigerant", quantity: null, unit: null,
    qualityTier: "estimated", v7Tco2e: 2.19, rule: "T1" },
];

describe("scope.review.attest_reingest, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (actorId: string, principal: "staff" | "system", reason = "attested after reviewing the reconciliation"): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId, principal, idempotencyKey: `${actorId}-${keys}`, correlationId: `corr-${keys}`, reason, grant: commandGrantForRole("admin", ORG, actorId) };
  };
  const reviewer = () => context(REVIEWER, "staff");
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const preview = (job: string, ctx = reviewer()) => previewReingestAttestation(database.pool, job, ctx);
  // The reviewer acknowledges what the preview flagged, unless a case says otherwise (RULING-v7-book-runner R3).
  const act = (job: string, plan: ReingestAttestationPlan, ctx = reviewer(), acknowledgedDeltas = plan.deltas?.flagged ?? []) => attestReingestRows(database.pool,
    { jobId: job, runId: plan.runId!, rows: plan.attest.map((row) => ({ rowId: row.rowId, expectedReviewVersion: row.version })), gapKeys: plan.gaps.map((gap) => gap.gapKey), acknowledgedDeltas }, ctx);
  const live = async (job: string, v7: string) => (await db.query(
    `SELECT scope_row_id AS id, version, review_status, reviewed_by, reviewer_note FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled AND reingested_from_row_id=$2`, [job, v7])).rows[0]!;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const attestedHistory = (job: string) => count(`SELECT count(*) AS n FROM nzi_console.scope_row_review_history WHERE job_id=$1 AND reviewer_note LIKE $2`, [job, `${REINGEST_ATTESTATION}%`]);
  const resolution = async (job: string, key: string) => (await db.query(`SELECT reason, resolved_by, version FROM nzi_console.gap_resolutions WHERE job_id=$1 AND gap_key=$2`, [job, key])).rows[0] ?? null;

  async function seedJob(job: string, sequence: number, rows: Array<[V7, V7ReingestPlanRow]>) {
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id)
      VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4)`, [ORG, job, sequence, String(sequence)]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, job]);
    for (const [v7] of rows) {
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
        VALUES ($1,$2,$3,$4,$5,$5,'v7','v7',$6,$7,$8,'pending',true,'migrated',$9::jsonb,'nzi-pro-v7',$2)`,
        [ORG, v7.id, job, v7.scope, v7.label, v7.qty, v7.unit, v7.reported, JSON.stringify(record({ qty: v7.qty, uom: v7.unit, reported_tco2e: v7.reported, ...(v7.months ? { months: v7.months } : {}) }))]);
    }
    const input: V7ReingestJobInput = { jobId: job, runId: `v7-reingest-${randomUUID()}`, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA,
      vintageDatasetIds: ["v7-vintage-2025"], rows: rows.map(([, plan]) => plan) };
    await withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, input, context(V7_REINGEST_ACTOR, "system", "v7 re-ingest (test)")));
    return input.runId;
  }

  before(async () => {
    database = (await createDisposableDatabase("v7attest"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','EFF Test','active'), ($1,'c2','Second Test','active')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [ORG]);
    for (const [id, label, unit, kg, scope] of [["gas", "Natural gas", "kWh", 0.2, "1"], ["water", "Water supply", "m3", 0.15, "3"]] as const) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025',$2,$3,$4,$5,ARRAY[$6])`,
        [ORG, id, label, unit, kg, scope]);
    }
  });
  after(async () => { await db?.end(); await database?.end(); });

  describe("the eligibility matrix", () => {
    const JOB = "matrix-job";
    let runId = "";
    before(async () => {
      runId = await seedJob(JOB, 1, [
        gasRow("v7-gas", "Natural gas", 1000, 0.2), waterRow("v7-water"),
        gasRow("v7-zero", "Standby boiler", 0, 0), gasRow("v7-zero-done", "Spare boiler", 0, 0),
        refrigerantRow("v7-refrigerant"), gasRow("v7-reject", "Second meter", 500, 0.1),
      ]);
      // Before the act: one row approved by hand, one rejected by hand.
      const done = await live(JOB, "v7-zero-done");
      await approveScopeRow(database.pool, { jobId: JOB, rowIds: [done.id], expectedReviewVersion: done.version }, reviewer());
      const rejected = await live(JOB, "v7-reject");
      await rejectScopeRow(database.pool, { jobId: JOB, rowIds: [rejected.id], expectedReviewVersion: rejected.version, reviewerNote: "meter doubtful" }, reviewer());
    });

    it("the preview: pending rows attested; approved skipped; rejected excluded; only the record-of-account gaps", async () => {
      const plan = await preview(JOB);
      assert.equal(plan.runId, runId);
      assert.equal(plan.reviewerRefusal, null);
      const ids = Object.fromEntries(await Promise.all(["v7-gas", "v7-water", "v7-zero", "v7-refrigerant", "v7-zero-done", "v7-reject"].map(async (v7) => [v7, (await live(JOB, v7)).id])));
      assert.deepEqual(plan.attest.map((row) => row.rowId).sort(), [ids["v7-gas"], ids["v7-water"], ids["v7-zero"], ids["v7-refrigerant"]].sort());
      assert.equal(plan.skippedApproved, 1, "already approved: skipped, never re-approved");
      assert.deepEqual(plan.excludedRejected.map((row) => row.rowId), [ids["v7-reject"]], "a rejection is a human finding: excluded");
      assert.deepEqual(plan.blocked, []);
      assert.deepEqual(plan.gaps.map((gap) => gap.gapKey).sort(),
        [`unmapped:${ids["v7-refrigerant"]}`, `zero_blank:${ids["v7-zero"]}`, `zero_blank:${ids["v7-zero-done"]}`].sort(),
        "unmapped on the reported total; zero_blank on rows whose v7 figure is 0 and which reproduce 0 — the approved one's too");
    });

    it("reviewer ≠ preparer: the re-ingest's principal is refused, in the preview and the act, and nothing is written", async () => {
      const plan = await preview(JOB);
      assert.ok((await preview(JOB, context(V7_REINGEST_ACTOR, "system"))).reviewerRefusal);
      await assert.rejects(act(JOB, plan, context(V7_REINGEST_ACTOR, "system")), (error) => codes(error).includes("REVIEWER_IS_PREPARER"));
      await assert.rejects(act(JOB, plan, context(V7_REINGEST_ACTOR, "staff")), (error) => codes(error).includes("REVIEWER_IS_PREPARER"), "its actor id from a staff session is still the preparer");
      assert.equal(await attestedHistory(JOB), 0);
    });

    it("an existing resolution is never overwritten: a gap a person resolved is skipped, their reason kept", async () => {
      const refrigerant = await live(JOB, "v7-refrigerant");
      await resolveAssuranceGap(database.pool, { jobId: JOB, gapKey: `unmapped:${refrigerant.id}`, flagType: "unmapped", scopeRowId: refrigerant.id,
        reason: "checked against the F-gas log", expectedVersion: 0 }, reviewer());
      const plan = await preview(JOB);
      assert.ok(!plan.gaps.some((gap) => gap.gapKey === `unmapped:${refrigerant.id}`));
      assert.equal(plan.skippedResolvedGaps, 1);
    });

    it("a non-reported-total `unmapped` and a `zero_blank` whose v7 figure is not 0 are not resolved by the act: they stay open", async () => {
      const water = await live(JOB, "v7-water"), gas = await live(JOB, "v7-gas");
      // (Written directly, as a stand-in: the guard stops any command editing a re-ingested row.)
      await db.query(`UPDATE nzi_console.job_scope_rows SET factor_id = NULL, version = version + 1 WHERE scope_row_id = $1`, [water.id]);
      await db.query(`UPDATE nzi_console.job_scope_rows SET quantity = NULL, override_tco2e = 0.2, override_reason = 'meter estimate', version = version + 1 WHERE scope_row_id = $1`, [gas.id]);
      const plan = await preview(JOB);
      assert.ok(!plan.gaps.some((gap) => gap.gapKey === `unmapped:${water.id}` || gap.gapKey === `zero_blank:${gas.id}`));
      assert.ok(plan.otherOpenGaps.some((gap) => gap.gapKey === `unmapped:${water.id}`), "a missing factor on an ordinary row is a judgment");
      assert.ok(plan.otherOpenGaps.some((gap) => gap.gapKey === `zero_blank:${gas.id}`), "a blank quantity where v7 had a figure is a judgment");
    });

    it("D7.2 at the moment of attesting (R2): a row whose input has left v7's refuses the whole act; a figure that moved is a delta to acknowledge (R3)", async () => {
      // The gas row's quantity was blanked by the case before: it no longer carries v7's input, so it blocks the act.
      const gas = await live(JOB, "v7-gas"), zero = await live(JOB, "v7-zero");
      let plan = await preview(JOB);
      assert.deepEqual(plan.blocked.map((row) => row.rowId), [gas.id]);
      assert.match(plan.blocked[0]!.reasons.join(" "), /its quantity none is no longer v7's 1000 \(D7\.2\)/);
      await assert.rejects(act(JOB, plan), (error) => codes(error).includes("ATTEST_BLOCKED"));
      assert.equal(await attestedHistory(JOB), 0, "nothing written");
      await db.query(`UPDATE nzi_console.job_scope_rows SET quantity = 1000, override_tco2e = NULL, override_reason = NULL, version = version + 1 WHERE scope_row_id = $1`, [gas.id]);

      // The zero row's figure drifts while its input stays v7's: not blocked — flagged, as a 0 → non-zero move.
      await db.query(`UPDATE nzi_console.job_scope_rows SET calculated_tco2e = 0.5, version = version + 1 WHERE scope_row_id = $1`, [zero.id]);
      plan = await preview(JOB);
      assert.deepEqual(plan.blocked, [], "the calc is authoritative: a moved figure never blocks a row that carries v7's input");
      assert.deepEqual(plan.deltas!.flagged, ["job", "v7-zero"], "the row, and the job it moves > 5%");
      assert.equal(plan.deltas!.rows.find((row) => row.v7RowId === "v7-zero")!.flag, "zero-base");
      assert.equal(plan.deltaLabels["v7-zero"], "Standby boiler");
      assert.ok(!plan.gaps.some((gap) => gap.gapKey === `zero_blank:${zero.id}`), "v7 recorded 0 but the row no longer holds 0: not swept up");
      // Unacknowledged, or acknowledged in part, the act refuses and writes nothing.
      await assert.rejects(act(JOB, plan, reviewer(), []), (error) => codes(error).includes("DELTAS_NOT_ACKNOWLEDGED"));
      await assert.rejects(act(JOB, plan, reviewer(), ["v7-zero"]), (error) => codes(error).includes("DELTAS_NOT_ACKNOWLEDGED"));
      await assert.rejects(act(JOB, plan, reviewer(), ["job", "v7-zero", "v7-gas"]), (error) => codes(error).includes("DELTAS_NOT_ACKNOWLEDGED"), "no more than is flagged");
      assert.equal(await attestedHistory(JOB), 0, "nothing written");
      await db.query(`UPDATE nzi_console.job_scope_rows SET calculated_tco2e = 0, version = version + 1 WHERE scope_row_id = $1`, [zero.id]);
      assert.deepEqual((await preview(JOB)).deltas!.flagged, [], "back to v7's figure: nothing flagged");
    });

    it("D7.2 accepts a months-derived quantity within rounding of v7's (9.9996 against 10), and still refuses a moved input", async () => {
      const JOB_R = "attest-rounding";
      const months = [10, null, null, null, null, null, null, null, null, null, null, null];
      await seedJob(JOB_R, 9, [[{ id: "r-round", scope: "1", label: "Gas", qty: 9.9996, unit: "kWh", reported: 0.002, months }, { v7RowId: "r-round", disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "Gas", quantity: 9.9996, unit: "kWh",
        datasetId: "v7-vintage-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: 0.002, rule: "S1-GAS" }]]);
      const row = await live(JOB_R, "r-round");
      assert.equal(Number((await db.query(`SELECT quantity::text AS q FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [row.id])).rows[0]!.q), 10, "the live quantity is the months' sum");
      assert.deepEqual((await preview(JOB_R)).blocked, [], "within rounding of v7's quantity, on a row that carries months: not blocked");
      await db.query(`UPDATE nzi_console.job_scope_rows SET quantity = 11, version = version + 1 WHERE scope_row_id = $1`, [row.id]);
      assert.equal((await preview(JOB_R)).blocked.length, 1, "a quantity that moved beyond rounding blocks");
    });

    it("all or nothing: a row or a gap that moved since the preview refuses the act — CHANGED_SINCE_PREVIEW — and nothing is written", async () => {
      const stale = await preview(JOB);
      const water = await live(JOB, "v7-water");
      await approveScopeRow(database.pool, { jobId: JOB, rowIds: [water.id], expectedReviewVersion: water.version }, reviewer());
      await assert.rejects(act(JOB, stale), (error) => codes(error).includes("CHANGED_SINCE_PREVIEW"));
      const stale2 = await preview(JOB);
      const zero = await live(JOB, "v7-zero");
      await resolveAssuranceGap(database.pool, { jobId: JOB, gapKey: `zero_blank:${zero.id}`, flagType: "zero_blank", scopeRowId: zero.id, reason: "boiler decommissioned", expectedVersion: 0 }, reviewer());
      await assert.rejects(act(JOB, stale2), (error) => codes(error).includes("CHANGED_SINCE_PREVIEW"));
      assert.equal(await attestedHistory(JOB), 0);
      assert.equal((await resolution(JOB, `zero_blank:${zero.id}`))!.reason, "boiler decommissioned");
    });

    it("the act: each attested row its own approval in review history; only the planned gaps resolved; one audit event; the rest untouched", async () => {
      const plan = await preview(JOB);
      const before = { reject: await live(JOB, "v7-reject"), done: await live(JOB, "v7-zero-done") };
      const refrigerant = await live(JOB, "v7-refrigerant");
      const ctx = reviewer();
      const outcome = await act(JOB, plan, ctx);
      assert.deepEqual([outcome.data.approved, outcome.data.gapsResolved, outcome.data.skippedApproved, outcome.data.excludedRejected],
        [plan.attest.length, plan.gaps.length, plan.skippedApproved, 1]);
      for (const row of plan.attest) {
        const entries = (await db.query(`SELECT decision, reviewer_id, row_version, reviewer_note FROM nzi_console.scope_row_review_history WHERE scope_row_id=$1 AND reviewer_note LIKE $2`, [row.rowId, `${REINGEST_ATTESTATION}%`])).rows;
        assert.equal(entries.length, 1, "exactly one attestation entry per row");
        const history = entries[0]!;
        assert.deepEqual([history.decision, history.reviewer_id, history.row_version], ["approved", REVIEWER, row.version]);
        assert.match(history.reviewer_note, new RegExp(`^${REINGEST_ATTESTATION} \\(run ${plan.runId}\\) — attested after reviewing the reconciliation$`));
        const now = (await db.query(`SELECT review_status, reviewed_by, reviewed_row_version, version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [row.rowId])).rows[0]!;
        assert.deepEqual([now.review_status, now.reviewed_by, now.reviewed_row_version, now.version], ["approved", REVIEWER, row.version, row.version + 1]);
      }
      assert.equal(await attestedHistory(JOB), plan.attest.length, "one history entry per attested row");
      for (const gap of plan.gaps) assert.deepEqual(await resolution(JOB, gap.gapKey), { reason: gap.reason, resolved_by: REVIEWER, version: 1 });
      assert.deepEqual(await live(JOB, "v7-reject"), before.reject, "the rejected row is untouched");
      assert.deepEqual(await live(JOB, "v7-zero-done"), before.done, "the already-approved row is untouched");
      assert.equal((await resolution(JOB, `unmapped:${refrigerant.id}`))!.reason, "checked against the F-gas log", "a person's resolution stands");
      const audit = (await db.query(`SELECT action, after_json::text AS j FROM nzi_console.audit_events WHERE correlation_id=$1`, [ctx.correlationId])).rows;
      assert.deepEqual(audit.map((event) => event.action), ["scope_rows_reingest_attested"], "one audit event for the act");
      assert.doesNotMatch(audit[0]!.j, /GBP|£|kWh|quantity|kgco2e|price|cost/i, "NZC-120: ids and counts, no money");
      const screen = (await withTenantRead(database.pool, ORG, (client) => getAssuranceScreen(client, JOB)))!;
      const open = screen.gaps.gaps.filter((gap) => !gap.resolved).map((gap) => gap.key);
      const water = await live(JOB, "v7-water");
      assert.ok(open.includes(`unmapped:${water.id}`), "the judgment gap is still open, for its own Resolve");
    });

    it("a replay is the same outcome; nothing is left to attest afterwards", async () => {
      const plan = await preview(JOB);
      assert.deepEqual([plan.attest.length, plan.gaps.length], [0, 0]);
      await assert.rejects(attestReingestRows(database.pool, { jobId: JOB, runId: plan.runId!, rows: [{ rowId: "x", expectedReviewVersion: 1 }], gapKeys: [] }, reviewer()),
        (error) => codes(error).includes("CHANGED_SINCE_PREVIEW"));
    });
  });

  describe("J000663's end state: one act opens the freeze gate", () => {
    const JOB = "end-state-job";
    it("approves the pending rows and resolves the zero gaps; skips the approved row and the resolved reported total; 0 awaiting, 0 open", async () => {
      await seedJob(JOB, 2, [gasRow("e-gas", "Natural gas", 1000, 0.2), waterRow("e-water"), gasRow("e-zero-1", "Boiler A", 0, 0),
        gasRow("e-zero-2", "Boiler B", 0, 0), gasRow("e-zero-done", "Boiler C", 0, 0), refrigerantRow("e-refrigerant")]);
      const done = await live(JOB, "e-zero-done");
      await approveScopeRow(database.pool, { jobId: JOB, rowIds: [done.id], expectedReviewVersion: done.version }, reviewer());
      const refrigerant = await live(JOB, "e-refrigerant");
      await resolveAssuranceGap(database.pool, { jobId: JOB, gapKey: `unmapped:${refrigerant.id}`, flagType: "unmapped", scopeRowId: refrigerant.id,
        reason: "v7 reported total, no activity data (record of account)", expectedVersion: 0 }, reviewer());
      const readiness = () => withTenantRead(database.pool, ORG, (client) => getScopeQaReadiness(client, JOB));
      assert.equal((await readiness()).readyForReporting, false);

      const plan = await preview(JOB);
      assert.deepEqual([plan.attest.length, plan.skippedApproved, plan.gaps.length, plan.skippedResolvedGaps, plan.otherOpenGaps.length], [5, 1, 3, 1, 0]);
      const outcome = await act(JOB, plan);
      assert.deepEqual([outcome.data.approved, outcome.data.gapsResolved], [5, 3]);

      const after = await readiness();
      assert.deepEqual([after.independentReviewPending, after.readyForReporting], [0, true], "0 awaiting review");
      const screen = (await withTenantRead(database.pool, ORG, (client) => getAssuranceScreen(client, JOB)))!;
      assert.equal(screen.gaps.gaps.filter((gap) => !gap.resolved).length, 0, "0 open gaps");
      // The freeze gate: through the real snapshot command, which now has nothing to refuse on review, gaps or v7 rows.
      const snapshot = await createReviewedCrpSnapshot(database.pool, { jobId: JOB, expectedJobVersion: 1 }, reviewer());
      assert.ok(snapshot.data.snapshotId, "the freeze gate is open");
    });
  });
});

describe("plan with no completed run", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  it("a job without a completed run plans nothing (the preview is empty, never an error)", async () => {
    // Pure plan shape check on a non-existent job, inside a throwaway transaction on the test database.
    const database = (await createDisposableDatabase("v7attestempty"))!;
    try {
      const plan = await withTenantRead(database.pool, "none", (client) => planReingestAttestation(client, { organisationId: "none", actorId: REVIEWER, principal: "staff" }, "no-job"));
      assert.deepEqual([plan.runId, plan.attest.length, plan.gaps.length], [null, 0, 0]);
    } finally { await database.end(); }
  });
});
