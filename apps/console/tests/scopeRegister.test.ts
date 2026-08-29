import assert from "node:assert/strict";
import { it } from "node:test";
import type { ScopeRowReadModel } from "@nzi/contracts";
import { filterScopeRows, scopeRowNeedsAttention } from "../app/jobs/scopeRegister";

const row=(overrides:Partial<ScopeRowReadModel>={}):ScopeRowReadModel=>({id:"row-a",jobId:"job-a",scope:"1",sourceLabel:"Gas",reportLabel:"Gas",notes:null,categoryPath:["Scope 1","Direct emissions"],monthlyActivity:[],quantity:10,unit:"kWh",datasetId:"dataset-a",factorId:"factor-a",factorVersion:"v1",factorLabel:"Gas factor",qualityTier:"measured",calculatedTco2e:1,overrideTco2e:null,overrideReason:null,reviewStatus:"approved",reviewedRowVersion:1,reviewedBy:"reviewer",reviewedAt:"2026-08-29",reviewerNote:null,version:2,enabled:true,provenance:{},lineage:[],...overrides});

it("defaults attention to enabled rows with a calculation, quality, or review exception",()=>{const rows=[row(),row({id:"calc",calculatedTco2e:null}),row({id:"quality",qualityTier:null}),row({id:"review",reviewStatus:"pending"}),row({id:"disabled",enabled:false,calculatedTco2e:null})];assert.deepEqual(filterScopeRows(rows,"attention").map(item=>item.id),["calc","quality","review"]);assert.equal(scopeRowNeedsAttention(rows[0]!),false);});
it("supports exact click-through register filters",()=>{const rows=[row({id:"calc",calculatedTco2e:null}),row({id:"rejected",reviewStatus:"rejected"}),row({id:"disabled",enabled:false})];assert.deepEqual(filterScopeRows(rows,"calculation").map(item=>item.id),["calc"]);assert.deepEqual(filterScopeRows(rows,"rejected").map(item=>item.id),["rejected"]);assert.equal(filterScopeRows(rows,"all").length,3);});
