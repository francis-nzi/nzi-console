import assert from "node:assert/strict";
import {describe,it} from "node:test";
import {CommandValidationError,createReviewedCrpSnapshot,publishCrpReport,validateCrpReport} from "../src/index";

type Stored={request_hash:string;outcome_json:Record<string,unknown>};

function lifecyclePool(options:{incomplete?:boolean}={}){
  const idempotency=new Map<string,Stored>(),audits:string[]=[],outbox:string[]=[];
  let snapshot:{id:string;hash:string;payload:Record<string,unknown>;createdAt:string}|undefined,report:{id:string;status:string;manifest:number;snapshotId:string}|undefined;
  const rows=["1","2","3.1"].map((scope,index)=>({scope_row_id:`row-${scope}`,version:4,scope,source_label:`Scope ${scope} evidence`,site_id:null,site_label:null,purchased_goods_category_id:scope==="3.1"?"category-a":null,purchased_goods_category_label:scope==="3.1"?"Purchased materials":null,calculated_tco2e:String((index+1)*10),override_tco2e:null,factor_label:"Governed factor",factor_version:"2026.1",quality_tier:"measured",review_status:options.incomplete&&scope==="3.1"?"pending":"approved",reviewed_by:options.incomplete&&scope==="3.1"?null:"reviewer-a",enabled:true}));
  const client={async query(sql:string,values:readonly unknown[]=[]){
    if(sql.includes("FROM nzi_console.command_idempotency")){const stored=idempotency.get(String(values[1]));return{rows:stored?[stored]:[]};}
    if(sql.includes("INSERT INTO nzi_console.command_idempotency")){idempotency.set(String(values[1]),{request_hash:String(values[3]),outcome_json:JSON.parse(String(values[4]))});return{rows:[]};}
    if(sql.includes("INSERT INTO nzi_console.audit_events")){audits.push(String(values[4]));return{rows:[]};}
    if(sql.includes("INSERT INTO nzi_console.transactional_outbox")){outbox.push(String(values[2]));return{rows:[]};}
    if(sql.includes("SELECT j.version"))return{rows:[{version:5,job_family:"crp",job_number:"J000717",client_id:"client-a",reporting_year:2026,start_date:"2026-01-01",client_name:"Lifecycle Client"}]};
    if(sql.includes("FROM nzi_console.job_emissions_targets"))return{rows:[{job_id:"job-a",baseline_year:2025,baseline_tco2e:"75",interim_year:2030,interim_reduction_percent:"50",net_zero_year:2050,version:1,updated_by:"staff-a",updated_at:"2026-08-28T08:00:00.000Z"}]};
    if(sql.includes("FROM nzi_console.job_intensity_targets"))return{rows:[{job_id:"job-a",metric:"turnover",denominator_unit:"£m revenue",reporting_denominator:"10",baseline_year:2025,baseline_intensity:"7.5",interim_year:2030,interim_reduction_percent:"50",net_zero_year:2050,version:1,updated_by:"staff-a",updated_at:"2026-08-28T08:00:00.000Z"}]};
    if(sql.includes("SELECT scope_row_id"))return{rows};
    if(sql.includes("SELECT DISTINCT ON"))return{rows:[{snapshot_id:"snapshot-2025",data_hash:`sha256:${"a".repeat(64)}`,reporting_year:2025,measurements:[{scope:"1",tco2e:12},{scope:"2",tco2e:18},{scope:"3",tco2e:45}]}]};
    if(sql.includes("SELECT snapshot_id,snapshot_version"))return{rows:[]};
    if(sql.includes("coalesce(max(snapshot_version)"))return{rows:[{version:1}]};
    if(sql.includes("INSERT INTO nzi_console.reviewed_crp_snapshots")){snapshot={id:String(values[1]),hash:String(values[5]),payload:JSON.parse(String(values[6])),createdAt:"2026-08-28T08:10:00.000Z"};return{rows:[]};}
    if(sql.includes("FROM nzi_console.reviewed_crp_snapshots WHERE"))return{rows:snapshot?[{job_id:"job-a",data_hash:snapshot.hash,created_at:snapshot.createdAt,payload_json:snapshot.payload}]:[]};
    if(sql.includes("INSERT INTO nzi_console.report_versions(")){report={id:String(values[1]),status:"validated",manifest:Number(values[3]),snapshotId:String(values[4])};return{rows:[]};}
    if(sql.includes("SELECT job_id,status,manifest_version"))return{rows:report?[{job_id:"job-a",status:report.status,manifest_version:report.manifest,reviewed_snapshot_id:report.snapshotId}]:[]};
    if(sql.includes("SET status='superseded'"))return{rows:[]};
    if(sql.includes("SET status='published'")){if(report?.status!=="validated")return{rows:[]};report.status="published";return{rows:[{published_at:"2026-08-28T08:15:00.000Z"}]};}
    return{rows:[]};
  },release(){}};
  return{pool:{connect:async()=>client} as never,state:()=>({snapshot,report,audits,outbox})};
}

const context=(key:string,actorId="reviewer-a")=>({organisationId:"org-a",actorId,principal:"staff" as const,idempotencyKey:key,correlationId:`corr-${key}`});

describe("canonical CRP lifecycle acceptance",()=>{
  it("freezes approved evidence, validates the shared manifest, and publishes that exact version",async()=>{const state=lifecyclePool(),snapshot=await createReviewedCrpSnapshot(state.pool,{jobId:"job-a",expectedJobVersion:5},context("snapshot")),validated=await validateCrpReport(state.pool,{reviewedSnapshotId:snapshot.data.snapshotId,manifestVersion:1},context("validate")),published=await publishCrpReport(state.pool,{reportVersionId:validated.data.reportVersionId,expectedStatus:"validated",manifestVersion:validated.data.manifestVersion,reviewedSnapshotId:snapshot.data.snapshotId},context("publish"));assert.equal(published.data.status,"published");assert.equal(published.data.reviewedSnapshotId,snapshot.data.snapshotId);assert.equal(state.state().report?.id,validated.data.reportVersionId);assert.deepEqual(state.state().audits,["reviewed_snapshot_created","report_validated","report_published"]);assert.deepEqual(state.state().outbox,["report.snapshot.created","report.validated","portal.report.published"]);});
  it("blocks snapshot creation while enabled evidence is not independently approved",async()=>{await assert.rejects(()=>createReviewedCrpSnapshot(lifecyclePool({incomplete:true}).pool,{jobId:"job-a",expectedJobVersion:5},context("incomplete")),(error:unknown)=>error instanceof CommandValidationError&&error.issues.some(issue=>issue.code==="QA_INCOMPLETE"));});
  it("blocks mismatched evidence and repeat publication",async()=>{const state=lifecyclePool(),snapshot=await createReviewedCrpSnapshot(state.pool,{jobId:"job-a",expectedJobVersion:5},context("snapshot-mismatch")),validated=await validateCrpReport(state.pool,{reviewedSnapshotId:snapshot.data.snapshotId,manifestVersion:1},context("validate-mismatch"));await assert.rejects(()=>publishCrpReport(state.pool,{reportVersionId:validated.data.reportVersionId,expectedStatus:"validated",manifestVersion:1,reviewedSnapshotId:"different-snapshot"},context("publish-mismatch")),CommandValidationError);await publishCrpReport(state.pool,{reportVersionId:validated.data.reportVersionId,expectedStatus:"validated",manifestVersion:1,reviewedSnapshotId:snapshot.data.snapshotId},context("publish-once"));await assert.rejects(()=>publishCrpReport(state.pool,{reportVersionId:validated.data.reportVersionId,expectedStatus:"validated",manifestVersion:1,reviewedSnapshotId:snapshot.data.snapshotId},context("publish-twice")),CommandValidationError);});
});
