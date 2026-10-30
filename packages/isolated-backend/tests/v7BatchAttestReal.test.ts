import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { approveScopeRow } from "../src/postgresCommands";
import { withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction } from "../src/v7Reingest";
import { REINGEST_ATTESTATION } from "../src/reingestAttest";
import { BATCH_ATTEST_AUDIT_ACTION, batchAttestReingestRuns } from "../src/v7BatchAttest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * The governed batch attest over the committed v7 re-ingest runs, against a real database: one person attests every run with no
 * flagged emission delta through `scope.review.attest_reingest` (each row its own approval, the two record-of-account gaps
 * resolved alongside); a flagged run and a run with an unattestable row are skipped and stay manual; a dry run is the whole act,
 * rolled back; the actor must be an active member whose role holds snapshot.review; a re-run never doubles.
 */
const ORG = "v7-batch-attest";
const PERSON = "francis";
const REASON = "batch attest of the unflagged v7 re-ingest runs after reviewing the book report";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
const record = (over: Record<string, unknown>) => ({ qty: 0, uom: "kWh", factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: 0, data_source: "Company Data", enabled: true, ...over });
type V7 = { id: string; scope: string; label: string; qty: number; unit: string; reported: number };
const gasRow = (id: string, label: string, qty: number, reported: number): [V7, V7ReingestPlanRow] => [
  { id, scope: "1", label, qty, unit: "kWh", reported },
  { v7RowId: id, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: label, quantity: qty, unit: "kWh",
    datasetId: "v7-vintage-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: reported, rule: "S1-GAS" },
];
const refrigerantRow = (id: string): [V7, V7ReingestPlanRow] => [
  { id, scope: "1", label: "Refrigerant", qty: 2.19, unit: "tCO2e", reported: 2.19 },
  { v7RowId: id, disposition: "REPORTED-TOTAL", categoryCode: "1.refrigerants", scope: "1", sourceLabel: "Refrigerant", quantity: null, unit: null,
    qualityTier: "estimated", v7Tco2e: 2.19, rule: "T1" },
];

describe("the batch attest over the committed v7 re-ingest runs, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);
  const approvals = (job: string) => count(`SELECT count(*) AS n FROM nzi_console.scope_row_review_history WHERE job_id=$1 AND decision='approved'`, [job]);
  const pending = (job: string) => count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled AND review_status='pending'`, [job]);
  const resolutions = (job: string) => count(`SELECT count(*) AS n FROM nzi_console.gap_resolutions WHERE job_id=$1`, [job]);
  const live = async (job: string, v7: string) => (await db.query(
    `SELECT scope_row_id AS id, version FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled AND reingested_from_row_id=$2`, [job, v7])).rows[0]!;
  const batch = (over: Partial<Parameters<typeof batchAttestReingestRuns>[1]> = {}) =>
    batchAttestReingestRuns(database.pool, { organisationId: ORG, actorId: PERSON, reason: REASON, commit: false, ...over });
  const reviewerContext = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: PERSON, principal: "staff", idempotencyKey: `hand-${keys}`, correlationId: `corr-${keys}`, reason: "approved by hand", grant: commandGrantForRole("reviewer", ORG, PERSON) };
  };

  async function seedJob(job: string, number: string, sequence: number, rows: Array<[V7, V7ReingestPlanRow]>) {
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31','nzi-pro-v7',$4,$5)`, [ORG, job, sequence, String(sequence), number]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, job]);
    for (const [v7] of rows) {
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
        VALUES ($1,$2,$3,$4,$5,$5,'v7','v7',$6,$7,$8,'pending',true,'migrated',$9::jsonb,'nzi-pro-v7',$2)`,
        [ORG, v7.id, job, v7.scope, v7.label, v7.qty, v7.unit, v7.reported, JSON.stringify(record({ qty: v7.qty, uom: v7.unit, reported_tco2e: v7.reported }))]);
    }
    const input: V7ReingestJobInput = { jobId: job, runId: `v7-reingest-${randomUUID()}`, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA,
      vintageDatasetIds: ["v7-vintage-2025"], rows: rows.map(([, plan]) => plan) };
    keys += 1;
    await withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, input, { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system",
      idempotencyKey: `seed-${keys}`, correlationId: `seed-${keys}`, reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) }));
    return input.runId;
  }

  before(async () => {
    database = (await createDisposableDatabase("v7batch"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','Batch Test','active')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025','gas','Natural gas','kWh',0.2,ARRAY['1'])`, [ORG]);
    for (const [user, role, status] of [[PERSON, "reviewer", "active"], ["a-viewer", "viewer", "active"], ["gone", "reviewer", "suspended"]] as const)
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,$2,$3,$4)`, [ORG, user, role, status]);

    await seedJob("clean-1", "J000001", 1, [gasRow("c1-gas", "Natural gas", 1000, 0.2), gasRow("c1-zero", "Standby boiler", 0, 0), refrigerantRow("c1-ref")]);
    await seedJob("clean-2", "J000002", 2, [gasRow("c2-gas", "Natural gas", 500, 0.1)]);
    await seedJob("flagged", "J000003", 3, [gasRow("f-gas", "Natural gas", 1000, 0.2), gasRow("f-zero", "Standby boiler", 0, 0)]);
    await seedJob("blocked", "J000004", 4, [gasRow("b-gas", "Natural gas", 1000, 0.2), gasRow("b-zero", "Standby boiler", 0, 0)]);
    await seedJob("done", "J000005", 5, [gasRow("d-gas", "Natural gas", 1000, 0.2)]);
    // The flagged run: a zero row whose figure moved off v7's 0 (a 0 → non-zero move). The blocked run: a row's input edited away from v7's.
    const flaggedZero = await live("flagged", "f-zero");
    await db.query(`UPDATE nzi_console.job_scope_rows SET calculated_tco2e = 0.5, version = version + 1 WHERE scope_row_id = $1`, [flaggedZero.id]);
    const blockedGas = await live("blocked", "b-gas");
    await db.query(`UPDATE nzi_console.job_scope_rows SET quantity = 11, version = version + 1 WHERE scope_row_id = $1`, [blockedGas.id]);
    const doneGas = await live("done", "d-gas");
    await approveScopeRow(database.pool, { jobId: "done", rowIds: [doneGas.id], expectedReviewVersion: doneGas.version }, reviewerContext());
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("refuses without a reason, for a non-member, a suspended member, and a role without snapshot.review — before touching a run", async () => {
    await assert.rejects(batch({ reason: "short" }), /^Error: REASON_REQUIRED/);
    await assert.rejects(batch({ actorId: "nobody" }), /^Error: NOT_A_MEMBER/);
    await assert.rejects(batch({ actorId: V7_REINGEST_ACTOR }), /^Error: NOT_A_MEMBER/, "the re-ingest's own principal is not a person");
    await assert.rejects(batch({ actorId: "gone" }), /^Error: NOT_ACTIVE/);
    await assert.rejects(batch({ actorId: "a-viewer" }), /^Error: NO_CAPABILITY/);
    assert.equal(await approvals("clean-1"), 0);
  });

  it("a dry run is every run's whole act, rolled back: the report is real, nothing is written", async () => {
    const report = await batch();
    assert.equal(report.committed, false);
    assert.deepEqual(report.runs.map((run) => [run.jobNumber, run.status]), [["J000001", "ATTESTED"], ["J000002", "ATTESTED"], ["J000003", "SKIPPED_FLAGGED"], ["J000004", "SKIPPED_BLOCKED"], ["J000005", "NOTHING_TO_ATTEST"]]);
    assert.deepEqual([report.approved, report.gapsResolved], [4, 2], "c1: gas + zero + reported total approved, its zero_blank and unmapped gaps resolved; c2: gas");
    assert.equal(report.auditEvents, 2);
    for (const job of ["clean-1", "clean-2", "flagged", "blocked"]) assert.equal(await approvals(job), 0, `${job}: no approval written`);
    assert.equal(await pending("clean-1"), 3);
    assert.equal(await resolutions("clean-1"), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE action IN ($1,'scope_rows_reingest_attested')`, [BATCH_ATTEST_AUDIT_ACTION]), 0);
  });

  it("commit: the unflagged runs are attested as the person; the flagged and the unattestable runs are left exactly as they were", async () => {
    const report = await batch({ commit: true });
    assert.deepEqual(report.tally, { ATTESTED: 2, SKIPPED_FLAGGED: 1, SKIPPED_BLOCKED: 1, NOTHING_TO_ATTEST: 1, REFUSED: 0 });
    assert.deepEqual([report.approved, report.gapsResolved, report.auditEvents], [4, 2, 3]);
    const flagged = report.runs.find((run) => run.jobNumber === "J000003")!, blocked = report.runs.find((run) => run.jobNumber === "J000004")!;
    assert.deepEqual([flagged.flagged, blocked.blocked], [2, 1], "the skipped runs say why, by count");

    // Each row its own approval, by the person, with the reason in the note.
    assert.equal(await approvals("clean-1"), 3);
    assert.equal(await approvals("clean-2"), 1);
    assert.equal(await pending("clean-1") + await pending("clean-2"), 0);
    const notes = (await db.query(`SELECT DISTINCT reviewer_id, reviewer_note FROM nzi_console.scope_row_review_history WHERE job_id IN ('clean-1','clean-2')`)).rows;
    assert.equal(notes.length, 2, "one note per run (it names the run)");
    assert.ok(notes.every((note) => note.reviewer_id === PERSON && note.reviewer_note.startsWith(REINGEST_ATTESTATION) && note.reviewer_note.includes(REASON)));
    assert.equal(await resolutions("clean-1"), 2, "the record-of-account gaps, alongside");

    // The guardrail: nothing on the flagged or blocked run.
    for (const job of ["flagged", "blocked"]) {
      assert.equal(await approvals(job), 0, `${job}: nothing approved`);
      assert.equal(await resolutions(job), 0, `${job}: no gap resolved`);
      assert.equal(await pending(job), 2, `${job}: still awaiting a person's per-job attest`);
    }
    assert.equal(await approvals("done"), 1, "the hand-approved row is not re-approved");
  });

  it("audits by counts and ids: one batch event, one command event per attested run, no label or figure", async () => {
    const batchEvents = (await db.query(`SELECT actor_id, principal_type, reason, after_json FROM nzi_console.audit_events WHERE action=$1`, [BATCH_ATTEST_AUDIT_ACTION])).rows;
    assert.equal(batchEvents.length, 1);
    assert.equal(batchEvents[0]!.actor_id, PERSON);
    assert.equal(batchEvents[0]!.reason, REASON);
    assert.deepEqual(batchEvents[0]!.after_json, { runsConsidered: 5, ATTESTED: 2, SKIPPED_FLAGGED: 1, SKIPPED_BLOCKED: 1, NOTHING_TO_ATTEST: 1, REFUSED: 0, approvedRows: 4, resolvedGaps: 2 });
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE action='scope_rows_reingest_attested'`), 2);
    assert.ok(!/Natural gas|Standby|Refrigerant/.test(JSON.stringify(batchEvents[0]!.after_json)), "no label in the batch event");
  });

  it("a re-run never doubles: every run is now nothing to attest or still skipped", async () => {
    const historyBefore = await count(`SELECT count(*) AS n FROM nzi_console.scope_row_review_history`);
    const report = await batch({ commit: true });
    assert.deepEqual(report.runs.map((run) => run.status), ["NOTHING_TO_ATTEST", "NOTHING_TO_ATTEST", "SKIPPED_FLAGGED", "SKIPPED_BLOCKED", "NOTHING_TO_ATTEST"]);
    assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.scope_row_review_history`), historyBefore);
    assert.equal(await resolutions("clean-1"), 2);
  });

  it("--jobs restricts the act to the named runs, and an unknown job number refuses", async () => {
    const report = await batch({ jobNumbers: ["J000003"] });
    assert.deepEqual(report.runs.map((run) => run.jobNumber), ["J000003"]);
    await assert.rejects(batch({ jobNumbers: ["J000003", "J999999"] }), /^Error: NO_COMPLETED_RUN: J999999 has no completed/);
  });
});
