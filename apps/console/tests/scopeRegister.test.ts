import assert from "node:assert/strict";
import { it } from "node:test";
import type { ScopeRowReadModel } from "@nzi/contracts";
import { filterRowsBySite, filterScopeRows, resolveCaptureDrawer, resolveSelectedScopeRow, scopeRowNeedsAttention } from "../app/jobs/scopeRegister";

const row=(overrides:Partial<ScopeRowReadModel>={}):ScopeRowReadModel=>({id:"row-a",jobId:"job-a",scope:"1",sourceLabel:"Gas",reportLabel:"Gas",notes:null,categoryPath:["Scope 1","Direct emissions"],monthlyActivity:[],quantity:10,unit:"kWh",datasetId:"dataset-a",factorId:"factor-a",factorVersion:"v1",factorLabel:"Gas factor",qualityTier:"measured",calculatedTco2e:1,overrideTco2e:null,overrideReason:null,reviewStatus:"approved",reviewedRowVersion:1,reviewedBy:"reviewer",reviewedAt:"2026-08-29",reviewerNote:null,version:2,enabled:true,provenance:{},lineage:[],...overrides});

it("defaults attention to enabled rows with a calculation, quality, or review exception",()=>{const rows=[row(),row({id:"calc",calculatedTco2e:null}),row({id:"quality",qualityTier:null}),row({id:"review",reviewStatus:"pending"}),row({id:"disabled",enabled:false,calculatedTco2e:null})];assert.deepEqual(filterScopeRows(rows,"attention").map(item=>item.id),["calc","quality","review"]);assert.equal(scopeRowNeedsAttention(rows[0]!),false);});
it("supports exact click-through register filters",()=>{const rows=[row({id:"calc",calculatedTco2e:null}),row({id:"rejected",reviewStatus:"rejected"}),row({id:"disabled",enabled:false})];assert.deepEqual(filterScopeRows(rows,"calculation").map(item=>item.id),["calc"]);assert.deepEqual(filterScopeRows(rows,"rejected").map(item=>item.id),["rejected"]);assert.equal(filterScopeRows(rows,"all").length,3);});

it("resolveSelectedScopeRow opens a row that is filtered out of the flat register (data-entry UX review item 1)",()=>{
  const healthy=row({id:"healthy"}),needsCalc=row({id:"needs-calc",calculatedTco2e:null});
  const rows=[healthy,needsCalc];
  const visible=filterScopeRows(rows,"attention"); // -> [needs-calc] only
  // clicking the healthy row from the accordion must open the healthy row, not visible[0]
  assert.equal(resolveSelectedScopeRow(rows,visible,"healthy")?.id,"healthy");
  // Nothing selected opens nothing. This used to fall back to the first visible row and then the first
  // row, which is what put a detail drawer on screen the moment Data entry loaded — describing a row the
  // user had never clicked. The fallback read as helpful and was the "drawer open at rest" bug.
  assert.equal(resolveSelectedScopeRow(rows,visible,""),undefined,"an empty selection opens no drawer");
  assert.equal(resolveSelectedScopeRow(rows,[],""),undefined);
  assert.equal(resolveSelectedScopeRow(rows,visible,"no-such-row"),undefined,"and neither does an unknown one");
  assert.equal(resolveSelectedScopeRow([],[],"anything"),undefined);
});

it("filterRowsBySite narrows to one site, and keeps unplaced rows out of it",()=>{
  const here=row({id:"here",siteId:"site-a"}),there=row({id:"there",siteId:"site-b"}),unplaced=row({id:"unplaced",siteId:null});
  const rows=[here,there,unplaced];
  // All sites is every row, including the ones belonging to no site.
  assert.deepEqual(filterRowsBySite(rows,null).map(r=>r.id),["here","there","unplaced"]);
  // A site shows its own rows only. An unplaced row is not shown under a particular site: it belongs to
  // the job rather than a place, and putting it under one would claim something nobody recorded.
  assert.deepEqual(filterRowsBySite(rows,"site-a").map(r=>r.id),["here"]);
  assert.deepEqual(filterRowsBySite(rows,"site-b").map(r=>r.id),["there"]);
  // Non-vacuous: the narrowed view really is smaller than the whole.
  assert.ok(filterRowsBySite(rows,"site-a").length < filterRowsBySite(rows,null).length);
});

it("the capture drawer is closed at rest, and opens only on a deliberate act (v2)",()=>{
  const gas=row({id:"gas"}),needsCalc=row({id:"needs-calc",calculatedTco2e:null});
  const rows=[gas,needsCalc];

  // At rest. Nothing added, nothing selected — and note that `needs-calc` exists and would have been
  // chosen by the old seeding, so this assertion is about the behaviour and not about an empty fixture.
  assert.deepEqual(resolveCaptureDrawer(null,rows,""),{kind:"closed"},
    "opening Data entry must not show a detail drawer for a row nobody clicked");

  // Clicking a row opens that row.
  assert.deepEqual(resolveCaptureDrawer(null,rows,"gas"),{kind:"detail",row:gas});
  // Including one the current lens filters out, which is the part worth keeping from the old resolver.
  assert.deepEqual(resolveCaptureDrawer(null,rows,"needs-calc"),{kind:"detail",row:needsCalc});
  // An id that is not there opens nothing rather than something else.
  assert.deepEqual(resolveCaptureDrawer(null,rows,"ghost"),{kind:"closed"});

  // "+ Add entry" opens the quick-add for that category.
  assert.deepEqual(resolveCaptureDrawer("1.natural-gas",rows,""),{kind:"quick-add",categoryCode:"1.natural-gas"});
  // Asked for while a row happened to be selected, the thing just asked for wins.
  assert.deepEqual(resolveCaptureDrawer("1.natural-gas",rows,"gas"),{kind:"quick-add",categoryCode:"1.natural-gas"});

  // The lifecycle: save clears the category and sets the new row's id, so the detail drawer stays open on
  // what was just created rather than closing and making the user find it again.
  assert.deepEqual(resolveCaptureDrawer(null,rows,"gas"),{kind:"detail",row:gas});
});
