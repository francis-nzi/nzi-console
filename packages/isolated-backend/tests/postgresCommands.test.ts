import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addManualDataset,approveScopeRow, changeJobStage, CommandValidationError, createJob,createReviewedCrpSnapshot, createScopeRow, IdempotencyConflictError,publishCrpReport,rejectScopeRow, runPostgresCommand, updateScopeRow,validateCrpReport, VersionConflictError } from "../src/index";

const context = { organisationId: "org-a", actorId: "staff-a", principal: "staff" as const, idempotencyKey: "create-job-1", correlationId: "corr-create-job-1" };
const input = { clientId: "client-a", family: "crp" as const, title: "Synthetic CRP", workflowStage: "Setup", owner: "A. Owner", startDate: "2026-08-25", dueDate: "2026-12-31", reportingYear: 2026 };

function commandPool() {
  const calls: string[] = [];
  let stored: { request_hash: string; outcome_json: Record<string, unknown> } | undefined;
  let auditCount = 0;
  let outboxCount = 0;
  let allocationCount = 0;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push(sql);
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: stored ? [stored] : [] };
      if (sql.includes("allocate_job_sequence")) { allocationCount += 1; return { rows: [{ sequence: 717 }] }; }
      if (sql.includes("INSERT INTO nzi_console.jobs")) return { rows: [{ job_number: "J000717" }] };
      if (sql.includes("INSERT INTO nzi_console.audit_events")) auditCount += 1;
      if (sql.includes("INSERT INTO nzi_console.transactional_outbox")) outboxCount += 1;
      if (sql.includes("INSERT INTO nzi_console.command_idempotency")) stored = { request_hash: String(values?.[3]), outcome_json: JSON.parse(String(values?.[4])) as Record<string, unknown> };
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); },
  };
  return { pool: { connect: async () => client } as never, calls, metrics: () => ({ auditCount, outboxCount, allocationCount }) };
}

describe("Postgres command boundary", () => {
  it("creates and numbers a job once, then replays the stored outcome", async () => {
    const state = commandPool();
    const first = await createJob(state.pool, input, context);
    const replay = await createJob(state.pool, input, context);
    assert.equal(first.data.jobNumber, "J000717");
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.jobNumber, "J000717");
    assert.deepEqual(state.metrics(), { auditCount: 1, outboxCount: 1, allocationCount: 1 });
  });

  it("rejects reuse of an idempotency key with a different request", async () => {
    const state = commandPool();
    await createJob(state.pool, input, context);
    await assert.rejects(() => createJob(state.pool, { ...input, title: "Different" }, context), IdempotencyConflictError);
  });

  it("rolls back the whole command when its handler fails", async () => {
    const state = commandPool();
    await assert.rejects(() => runPostgresCommand(state.pool, "client.create", { name: "Synthetic", status: "active", sector: "Services", location: "London", owner: "A. Owner" }, context, async () => { throw new Error("forced failure"); }));
    assert.ok(state.calls.includes("ROLLBACK"));
    assert.equal(state.calls.includes("COMMIT"), false);
    assert.deepEqual(state.metrics(), { auditCount: 0, outboxCount: 0, allocationCount: 0 });
  });

  it("moves a job one adjacent stage and records history in the same transaction", async () => {
    const calls: string[] = [];
    const client = { async query(sql: string) {
      calls.push(sql);
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("SELECT job_family")) return { rows: [{ job_family: "crp", workflow_stage: "Data entry", version: 3 }] };
      if (sql.includes("UPDATE nzi_console.jobs SET workflow_stage")) return { rows: [{ version: 4 }] };
      return { rows: [] };
    }, release() {} };
    const result = await changeJobStage({ connect: async () => client } as never, { jobId: "712", fromStage: "Data entry", toStage: "Factor mapping", expectedVersion: 3, note: "Data collection complete" }, { ...context, idempotencyKey: "stage-1" });
    assert.equal(result.data.version, 4);
    assert.equal(result.data.toStage, "Factor mapping");
    assert.ok(calls.some((sql) => sql.includes("INSERT INTO nzi_console.job_stage_history")));
    assert.ok(calls.some((sql) => sql.includes("INSERT INTO nzi_console.audit_events")));
    assert.ok(calls.some((sql) => sql.includes("COMMIT")));
  });

  it("rejects stale versions and skipped stages", async () => {
    const poolFor = (version: number) => ({ connect: async () => ({ async query(sql: string) {
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("SELECT job_family")) return { rows: [{ job_family: "crp", workflow_stage: "Data entry", version }] };
      return { rows: [] };
    }, release() {} }) }) as never;
    await assert.rejects(() => changeJobStage(poolFor(4), { jobId: "712", fromStage: "Data entry", toStage: "Factor mapping", expectedVersion: 3 }, { ...context, idempotencyKey: "stage-stale" }), VersionConflictError);
    await assert.rejects(() => changeJobStage(poolFor(3), { jobId: "712", fromStage: "Data entry", toStage: "Report & publish", expectedVersion: 3 }, { ...context, idempotencyKey: "stage-skip" }), CommandValidationError);
  });

  it("creates and version-updates canonical scope rows while invalidating stale calculations", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = { async query(sql: string, values?: readonly unknown[]) { calls.push({ sql, values }); if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] }; if (sql.includes("SELECT job_family FROM")) return { rows: [{ job_family: "crp" }] }; if (sql.includes("UPDATE nzi_console.job_scope_rows")) return { rows: [{ version: 2 }] }; return { rows: [] }; }, release() {} };
    const pool = { connect: async () => client } as never;
    const fields = { scope: "3.1", sourceLabel: "Synthetic purchased goods", quantity: 1200, unit: "GBP", datasetId: "dataset-a", factorId: "factor-a", factorVersion: "2026 v1", factorLabel: "Synthetic factor", qualityTier: "spend-based" as const };
    const created = await createScopeRow(pool, { jobId: "job-a", ...fields }, { ...context, idempotencyKey: "scope-create" });
    const updated = await updateScopeRow(pool, { jobId: "job-a", rowId: created.data.rowId, expectedVersion: 1, enabled: true, ...fields, quantity: 1400 }, { ...context, idempotencyKey: "scope-update" });
    assert.equal(updated.data.version, 2);
    const updateSql = calls.find((call) => call.sql.includes("UPDATE nzi_console.job_scope_rows"))?.sql ?? "";
    assert.match(updateSql, /calculated_tco2e=NULL/); assert.match(updateSql, /review_status='pending'/);assert.match(updateSql,/reviewed_by=NULL/);
    assert.ok(calls.filter((call) => call.sql.includes("INSERT INTO nzi_console.audit_events")).length >= 2);
  });

  it("derives annual activity from reporting-period monthly slots",async()=>{const calls:Array<{sql:string;values?:readonly unknown[]}>=[];const client={async query(sql:string,values?:readonly unknown[]){calls.push({sql,values});if(sql.includes("FROM nzi_console.command_idempotency"))return{rows:[]};if(sql.includes("SELECT job_family FROM"))return{rows:[{job_family:"crp"}]};if(sql.includes("SELECT reporting_from"))return{rows:[{reporting_from:"2026-01-01",reporting_to:"2026-02-28"}]};return{rows:[]};},release(){}};await createScopeRow({connect:async()=>client} as never,{jobId:"job-a",scope:"1",sourceLabel:"Gas",quantity:999,unit:"kWh",datasetId:"dataset-a",factorId:"factor-a",factorVersion:"v1",factorLabel:"Gas factor",qualityTier:"measured",monthlyActivity:[{month:"2026-01",quantity:10},{month:"2026-02",quantity:20}]},{...context,idempotencyKey:"monthly-create"});const insert=calls.find(call=>call.sql.includes("INSERT INTO nzi_console.job_scope_rows"));assert.equal(insert?.values?.[7],30);assert.deepEqual(JSON.parse(String(insert?.values?.[21])),[{month:"2026-01",quantity:10},{month:"2026-02",quantity:20}]);});

  it("records warned manual dataset exceptions with their dedicated audit reason", async () => {
    const calls:Array<{sql:string;values?:readonly unknown[]}>=[];
    const client={async query(sql:string,values?:readonly unknown[]){calls.push({sql,values});if(sql.includes("FROM nzi_console.command_idempotency"))return{rows:[]};if(sql.includes("SELECT job_family FROM"))return{rows:[{job_family:"crp"}]};if(sql.includes("FROM nzi_console.emission_factor_datasets d"))return{rows:[{valid_from:"2026-01-01",valid_to:"2026-12-31",dataset_country:"US",status:"active",reporting_from:"2026-01-01",reporting_to:"2026-12-31",job_country:"GB"}]};if(sql.includes("INSERT INTO nzi_console.job_dataset_selections"))return{rows:[{dataset_id:"synthetic-us-2026"}]};return{rows:[]};},release(){}};
    const result=await addManualDataset({connect:async()=>client} as never,{jobId:"job-a",scope:"all",datasetId:"synthetic-us-2026",reportingFrom:"2026-01-01",reportingTo:"2026-12-31"},{...context,idempotencyKey:"dataset-manual",reason:"Client methodology exception"});
    assert.match(result.data.warnings[0]??"",/US.*GB/);
    const selection=calls.find(call=>call.sql.includes("INSERT INTO nzi_console.job_dataset_selections"));assert.equal(selection?.values?.[3],"Client methodology exception");
    const audit=calls.find(call=>call.sql.includes("INSERT INTO nzi_console.audit_events"));assert.equal(audit?.values?.[8],"Client methodology exception");
  });
  it("requires independent complete evidence and writes immutable review history",async()=>{const calls:string[]=[];const client={async query(sql:string){calls.push(sql);if(sql.includes("FROM nzi_console.command_idempotency"))return{rows:[]};if(sql.includes("SELECT job_family FROM"))return{rows:[{job_family:"crp"}]};if(sql.includes("SELECT version,enabled"))return{rows:[{version:3,enabled:true,calculated_tco2e:"12.3",override_tco2e:null,quality_tier:"measured",provenance_json:{calculatedBy:"consultant-a"}}]};if(sql.includes("UPDATE nzi_console.job_scope_rows SET review_status"))return{rows:[{version:4}]};return{rows:[]};},release(){}};const result=await approveScopeRow({connect:async()=>client} as never,{jobId:"job-a",rowIds:["row-a"],expectedReviewVersion:3,reviewerNote:"Evidence checked"},{...context,idempotencyKey:"review-a",actorId:"reviewer-a"});assert.equal(result.data.decision,"approved");assert.ok(calls.some(sql=>sql.includes("INSERT INTO nzi_console.scope_row_review_history")));await assert.rejects(()=>approveScopeRow({connect:async()=>client} as never,{jobId:"job-a",rowIds:["row-a"],expectedReviewVersion:3},{...context,idempotencyKey:"review-self",actorId:"consultant-a"}),CommandValidationError);});
  it("requires a note when rejecting",()=>assert.rejects(()=>rejectScopeRow(commandPool().pool,{jobId:"job-a",rowIds:["row-a"],expectedReviewVersion:1,reviewerNote:""},{...context,idempotencyKey:"reject-empty"}),CommandValidationError));
  it("publishes only the exact validated report and supersedes the prior portal version",async()=>{const calls:string[]=[];const client={async query(sql:string){calls.push(sql);if(sql.includes("FROM nzi_console.command_idempotency"))return{rows:[]};if(sql.includes("SELECT job_id,status"))return{rows:[{job_id:"job-a",status:"validated",manifest_version:1,reviewed_snapshot_id:"snapshot-a"}]};if(sql.includes("RETURNING published_at"))return{rows:[{published_at:"2026-08-25T17:00:00.000Z"}]};return{rows:[]};},release(){}};const result=await publishCrpReport({connect:async()=>client} as never,{reportVersionId:"report-a",expectedStatus:"validated",manifestVersion:1,reviewedSnapshotId:"snapshot-a"},{...context,idempotencyKey:"publish-a"});assert.equal(result.data.status,"published");assert.ok(calls.some(sql=>sql.includes("status='superseded'")));assert.ok(calls.some(sql=>sql.includes("status='published'")));});
  it("does not request update-strength locks when reading an immutable reviewed snapshot",()=>{const source=String(validateCrpReport);assert.doesNotMatch(source,/reviewed_crp_snapshots[^`]*FOR SHARE/);});
  it("creates one content-addressed snapshot only from approved evidence",async()=>{const calls:Array<{sql:string;values?:readonly unknown[]}>=[];const client={async query(sql:string,values?:readonly unknown[]){calls.push({sql,values});if(sql.includes("FROM nzi_console.command_idempotency"))return{rows:[]};if(sql.includes("SELECT j.version"))return{rows:[{version:5,job_family:"crp",job_number:"J000717",reporting_year:2026,start_date:"2026-01-01",client_name:"Synthetic Client"}]};if(sql.includes("SELECT scope_row_id"))return{rows:[{scope_row_id:"row-a",version:4,scope:"1",source_label:"Synthetic fuel",calculated_tco2e:"2.5",override_tco2e:null,factor_label:"Demo factor",factor_version:"v1",quality_tier:"measured",review_status:"approved",reviewed_by:"reviewer-a",enabled:true}]};if(sql.includes("SELECT snapshot_id"))return{rows:[]};if(sql.includes("coalesce(max(snapshot_version)"))return{rows:[{version:1}]};return{rows:[]};},release(){}};const result=await createReviewedCrpSnapshot({connect:async()=>client} as never,{jobId:"job-a",expectedJobVersion:5},{...context,idempotencyKey:"snapshot-a",actorId:"reviewer-a"});assert.equal(result.data.version,1);assert.match(result.data.dataHash,/^sha256:[0-9a-f]{64}$/);const insert=calls.find(call=>call.sql.includes("INSERT INTO nzi_console.reviewed_crp_snapshots"));assert.ok(insert);const payload=JSON.parse(String(insert?.values?.[6]));assert.equal(payload.measurements[0].rowVersion,4);assert.equal(payload.measurements[0].reviewedBy,"reviewer-a");});
});
