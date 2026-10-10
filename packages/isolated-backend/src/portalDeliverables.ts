import {isReportGap,type PublishedCrpReportReadModel,type ReportComposition} from "@nzi/contracts";
import {createHash} from "node:crypto";
import type {Queryable} from "./postgres";
import {getGrantedPortalReport} from "./portalComposition";

export type PortalDeliverableKind="report"|"certificate"|"methodology";
export type PortalDeliverableRecord={documentId:string;kind:PortalDeliverableKind;title:string;filename:string;contentType:"application/pdf";reportVersionId:string;snapshotId:string;evidenceHash:string;publishedAt:string};
/** F-4a (D5): `basis` — the frozen composition (its scope) or, for a version issued before compositions, the snapshot. `scopeLabel` names the view; a site view states what it leaves out. */
export type PortalPublicationEvidence={reportVersionId:string;snapshotId:string;evidenceHash:string;manifestVersion:number;publishedAt:string;jobNumber:string;client:string;reportingYear:number;scopeTotals:Array<{scope:"1"|"2"|"3";tco2e:number}>;measurements:Array<{rowId:string;scopeCode:string;sourceLabel:string;tco2e:number;factorSet:string}>;basis:"composition"|"snapshot";scopeLabel:string;unallocatedStatement:string|null};

const labels:Record<PortalDeliverableKind,{title:string;stem:string}>={report:{title:"Published Carbon Reduction Plan",stem:"carbon-reduction-plan"},certificate:{title:"Emissions certificate",stem:"emissions-certificate"},methodology:{title:"Methodology statement",stem:"methodology-statement"}};
export const portalDeliverableKinds=(value:string):value is PortalDeliverableKind=>value==="report"||value==="certificate"||value==="methodology";
export function portalDeliverableRecords(report:PublishedCrpReportReadModel):PortalDeliverableRecord[]{return (["report","certificate","methodology"] as const).map(kind=>({documentId:`${report.reportVersionId}:${kind}`,kind,title:labels[kind].title,filename:`${report.snapshot.jobNumber}-${labels[kind].stem}-${report.reportVersionId}.pdf`,contentType:"application/pdf",reportVersionId:report.reportVersionId,snapshotId:report.snapshot.id,evidenceHash:report.dataHash,publishedAt:report.publishedAt}));}
/**
 * What a document says it rests on. With a frozen composition (D5) it is the composition's view: a site report's documents
 * carry only that report's sites — the snapshot's rows at those sites, the same filter the composition was frozen from (R-S1
 * (A′)) — and the totals are checked against the composition's own, so a document can never disagree with the report it is
 * for. A version issued before compositions (D1) keeps the whole snapshot, as it was issued.
 */
export function portalPublicationEvidence(report:PublishedCrpReportReadModel,composition:ReportComposition|null=null):PortalPublicationEvidence{
  if(report.dataHash!==report.snapshot.dataHash)throw new Error("Publication and reviewed snapshot evidence hashes do not match.");
  if(composition&&composition.snapshotDataHash!==report.dataHash)throw new Error("The frozen composition and the publication rest on different evidence.");
  const scope=composition?.scope;
  const sites=scope?.kind==="sites"?new Set(scope.siteIds):null;
  const rows=sites?report.snapshot.measurements.filter(row=>row.siteId!=null&&sites.has(row.siteId)):report.snapshot.measurements;
  const totals=new Map<"1"|"2"|"3",number>([["1",0],["2",0],["3",0]]);
  for(const row of rows)totals.set(row.scope,(totals.get(row.scope)??0)+row.tco2e);
  const emissions=composition&&!isReportGap(composition.emissions)?composition.emissions:null;
  if(emissions){
    for(const [key,tco2e] of totals){const frozen=emissions.byScope.find(entry=>entry.scope===key)?.tco2e??0;if(Math.abs(frozen-tco2e)>0.0005)throw new Error(`Scope ${key} in the documents (${tco2e}) differs from the frozen report (${frozen}).`);}
  }
  return{reportVersionId:report.reportVersionId,snapshotId:report.snapshot.id,evidenceHash:report.dataHash,manifestVersion:report.manifestVersion,publishedAt:report.publishedAt,jobNumber:report.snapshot.jobNumber,client:report.snapshot.client,reportingYear:report.snapshot.reportingYear,scopeTotals:[...totals].map(([scope,tco2e])=>({scope,tco2e})),measurements:rows.map(row=>({rowId:row.rowId,scopeCode:row.scopeCode??row.scope,sourceLabel:row.sourceLabel,tco2e:row.tco2e,factorSet:row.factorSet})),basis:composition?"composition":"snapshot",scopeLabel:report.scopeLabel??"Whole client",unallocatedStatement:emissions?.unallocated?.statement??null};
}
export function portalDeliverableHeaders(record:PortalDeliverableRecord,content:Uint8Array){const digest=createHash("sha256").update(content).digest("base64"),etag=`"sha256-${digest}"`;return{"Content-Type":record.contentType,"Content-Disposition":`attachment; filename="${record.filename}"`,"Content-Length":String(content.byteLength),"Content-Digest":`sha-256=:${digest}:`,ETag:etag,"X-Content-Type-Options":"nosniff","X-NZI-Document-Id":record.documentId,"X-NZI-Report-Version":record.reportVersionId,"X-NZI-Snapshot-Id":record.snapshotId,"X-NZI-Evidence-Hash":record.evidenceHash,"Cache-Control":"private, no-store"};}
/** F-4a (D5): the documents of the report named (else the default), with its frozen composition when it has one. */
export async function getGrantedPortalDeliverables(db:Queryable,input:{portalUserId:string;clientId:string;jobId:string;reportVersionId?:string|null}){const view=await getGrantedPortalReport(db,input);return view?{report:view.report,composition:view.state==="composed"?view.composition:null,documents:portalDeliverableRecords(view.report)}:null;}
