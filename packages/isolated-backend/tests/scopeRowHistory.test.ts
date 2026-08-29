import assert from "node:assert/strict";
import { it } from "node:test";
import { listScopeRowAuditEvents } from "../src/scopeRowHistory";

it("binds scope-row history to the requested job and canonical row",async()=>{
  let captured:{sql:string;values?:readonly unknown[]}|undefined;
  const db={query:async(sql:string,values?:readonly unknown[])=>{
    captured={sql,values};
    return{rows:[{audit_event_id:"audit-a",occurred_at:"2026-08-29T10:00:00Z",actor_id:"consultant-a",principal_type:"staff",organisation_id:"org-a",action:"scope_row_updated",entity_type:"scope_row",entity_id:"row-a",correlation_id:"corr-a",reason:null,before_json:null,after_json:{version:2}}]};
  }};
  const events=await listScopeRowAuditEvents(db as never,"job-a","row-a",500);
  assert.match(captured?.sql??"",/JOIN nzi_console\.job_scope_rows/);
  assert.match(captured?.sql??"",/r\.job_id=\$1 AND r\.scope_row_id=\$2/);
  assert.deepEqual(captured?.values,["job-a","row-a",100]);
  assert.equal(events[0]?.entityId,"row-a");
  assert.equal(events[0]?.after,'{"version":2}');
});
