import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {getCrpReportVersion, getCurrentPublishedCrpReport,getGrantedPublishedCrpReport,listAuditEvents,listClients,listDatasetRegistry,listGrantedPortalJobs,listReportVersionRegister,listStaffRoleGovernance, listJobs, listScopeRows, withTenantRead, type Queryable } from "../src/index";

describe("isolated Postgres adapter", () => {
  it("maps canonical client and family-job rows into their screen contracts", async () => {
    const db = {
      query: async (sql: string) => ({ rows: sql.includes("FROM nzi_console.clients")
        ? [{ client_id: "client-a", name: "Synthetic Client", status: "active", sector: "Services", location: "London, UK", owner_name: "A. Owner", member_since: 2026, latest_footprint_tco2e: "1418", yoy_percent: "-7.4", completeness_percent: 92, next_report_due_label: "31 Mar 2027", contact_name: "Synthetic Team", contact_role: "ESG", contact_email: "team@synthetic.invalid", open_jobs: "1", jobs: [{ number: "J000612", year: 2026, status: "Data entry" }], sites: [{ id: "site-a", name: "London HQ" }] }]
        : [{ job_id: "job-a", client_id: "client-a", client_name: "Synthetic Client", sequence: 612, job_number: "J000612", job_family: "crp", title: "Synthetic CRP", reporting_year: 2026, status: "open", workflow_stage: "Data entry", owner_name: "A. Owner", start_date: "2026-01-01", due_date: "2026-03-31", quote_id: null, progress_percent: 66, detail_json: { kind: "crp", reportingPeriod: "2026", includedScopes: ["1", "2", "3"], reviewedRows: 10, totalRows: 15 } }] }),
    } as Queryable;
    assert.equal((await listClients(db))[0]?.latestFootprint, "1,418 tCO₂e");
    assert.deepEqual((await listClients(db))[0]?.sites, [{ id: "site-a", name: "London HQ" }]);
    assert.equal((await listJobs(db))[0]?.header.number, "J000612");
  });

  it("sets the runtime role and tenant context inside a read-only transaction", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = { query: async (sql: string, values?: readonly unknown[]) => { calls.push({ sql, values }); return { rows: [] }; }, release: () => undefined };
    const pool = { connect: async () => client };
    await withTenantRead(pool as never, "org-a", async () => "ok");
    assert.deepEqual(calls.map((call) => call.sql), ["BEGIN READ ONLY", "SET LOCAL ROLE nzi_console_app", "SELECT set_config('app.organisation_id', $1, true)", "COMMIT"]);
    assert.deepEqual(calls[2]?.values, ["org-a"]);
  });

  it("maps canonical scope-row evidence without treating missing calculation as zero", async () => {
    const db = { query: async () => ({ rows: [{ scope_row_id: "row-a", job_id: "job-a", scope: "3.1", source_label: "Purchased goods", quantity: "1250.5", unit: "GBP", dataset_id: "dataset-a", factor_id: "factor-a", factor_version: "2026 v1", factor_label: "Synthetic factor", quality_tier: "spend-based", calculated_tco2e: null, override_tco2e: null, override_reason: null, review_status: "pending", version: 3, enabled: true, provenance_json: { source: "synthetic" }, lineage_json: [{ title: "Captured", detail: "Synthetic" }] }] }) } as Queryable;
    const row = (await listScopeRows(db, "job-a"))[0]!;
    assert.equal(row.quantity, 1250.5); assert.equal(row.calculatedTco2e, null); assert.equal(row.qualityTier, "spend-based"); assert.equal(row.version, 3);
  });

  it("maps governed datasets, provenance usage and explicit selection warnings",async()=>{let call=0;const db={query:async()=>({rows:call++===0?[{dataset_id:"dataset-a",name:"Published factors",version:"2026",valid_from:"2026-01-01",valid_to:"2026-12-31",country_code:"GB",status:"active",source_name:"Publisher",licence:"OGL",synthetic:false,factor_count:"2",job_count:"1",scopes:["1","2"],spend_count:"0",activity_count:"2"}]:[{dataset_id:"dataset-a",job_number:"J000612",warning:"Manual geography exception."}]})} as Queryable,result=await listDatasetRegistry(db);assert.equal(result.datasets[0]?.factorCount,2);assert.deepEqual(result.datasets[0]?.scopes,["1","2"]);assert.equal(result.issues[0]?.jobNumber,"J000612");});

  it("derives staff governance from live membership counts and enforced permissions",async()=>{const db={query:async()=>({rows:[{role_id:"reviewer",members:"3"}]})} as Queryable,roles=await listStaffRoleGovernance(db),reviewer=roles.find(role=>role.id==="reviewer");assert.equal(reviewer?.members,3);assert.ok(reviewer?.permissions.includes("reports.publish"));assert.ok(reviewer?.restricted.includes("finance.manage"));});

  it("loads the current published report from its matching frozen snapshot",async()=>{const db={query:async()=>({rows:[{report_version_id:"report-a",manifest_version:1,report_data_hash:"sha256:abc",published_at:"2026-08-25T18:00:00Z",snapshot_id:"snapshot-a",job_id:"job-a",snapshot_version:2,job_version:8,data_hash:"sha256:abc",payload_json:{jobNumber:"J000612",client:"Synthetic Client",reportingYear:2026,measurements:[]},created_by:"reviewer-a",created_at:"2026-08-25T17:00:00Z"}]})} as Queryable;const report=await getCurrentPublishedCrpReport(db,"job-a");assert.equal(report?.snapshot.jobNumber,"J000612");assert.equal(report?.reportVersionId,"report-a");});
  it("loads one immutable staff report version from its exact matching snapshot",async()=>{const db={query:async()=>({rows:[{report_version_id:"report-a",status:"validated",manifest_version:1,report_data_hash:"sha256:abc",published_at:null,snapshot_id:"snapshot-a",job_id:"job-a",snapshot_version:2,job_version:8,data_hash:"sha256:abc",payload_json:{jobNumber:"J000612",client:"Synthetic Client",reportingYear:2026,measurements:[]},created_by:"reviewer-a",created_at:"2026-08-25T17:00:00Z"}]})} as Queryable,report=await getCrpReportVersion(db,"report-a");assert.equal(report?.status,"validated");assert.equal(report?.publishedAt,null);assert.equal(report?.snapshot.id,"snapshot-a");});
  it("returns no portal report unless the user, client and job grant all match",async()=>{const db={query:async(sql:string)=>({rows:sql.includes("portal_access_grants")?[]:[{report_version_id:"should-not-load"}]})} as Queryable;assert.equal(await getGrantedPublishedCrpReport(db,{portalUserId:"user-a",clientId:"client-a",jobId:"job-a"}),null);});
  it("surfaces approval and unread NZI response state on the portal job list",async()=>{const db={query:async()=>({rows:[{job_id:"job-a",job_number:"J000612",title:"Synthetic CRP",reporting_year:2026,report_version_id:"report-a",approved_at:"2026-08-25T18:00:00Z",has_unread_nzi_response:true}]})} as Queryable;const jobs=await listGrantedPortalJobs(db,{portalUserId:"portal-a",clientId:"client-a"});assert.equal(jobs[0]?.approved,true);assert.equal(jobs[0]?.approvedAt,"2026-08-25T18:00:00Z");assert.equal(jobs[0]?.hasUnreadNziResponse,true);});
  it("maps immutable tenant audit history without inventing denied events",async()=>{const db={query:async()=>({rows:[{audit_event_id:"audit-a",occurred_at:"2026-08-25T20:00:00Z",actor_id:"reviewer-a",principal_type:"staff",organisation_id:"org-a",action:"report.publish",entity_type:"report_version",entity_id:"report-a",correlation_id:"request-a",reason:null,before_json:{status:"validated"},after_json:{status:"published"}}]})} as Queryable;const events=await listAuditEvents(db);assert.equal(events[0]?.result,"allowed");assert.equal(events[0]?.action,"report.publish");assert.equal(events[0]?.after,'{"status":"published"}');});
  it("maps the immutable report register with client review counts",async()=>{const db={query:async()=>({rows:[{report_version_id:"report-a",job_id:"job-a",job_number:"J000612",client_name:"Synthetic Client",reporting_year:2026,status:"published",manifest_version:1,reviewed_snapshot_id:"snapshot-a",data_hash:"sha256:abc",created_at:"2026-08-25T18:00:00Z",published_at:"2026-08-25T19:00:00Z",approval_count:"1",comment_count:"2"}]})} as Queryable;const reports=await listReportVersionRegister(db);assert.equal(reports[0]?.jobNumber,"J000612");assert.equal(reports[0]?.approvalCount,1);assert.equal(reports[0]?.commentCount,2);});

  it("rolls back and releases the connection when a read fails", async () => {
    const calls: string[] = [];
    let released = false;
    const client = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; }, release: () => { released = true; } };
    const pool = { connect: async () => client };
    await assert.rejects(() => withTenantRead(pool as never, "org-a", async () => { throw new Error("forced"); }));
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.equal(released, true);
  });
});
