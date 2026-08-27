import type {PublishedCrpReportReadModel} from "@nzi/contracts";
import type {Queryable} from "./postgres";
import {getGrantedPublishedCrpReport} from "./readModels";

export type PortalDeliverableKind="report"|"certificate"|"methodology";
export type PortalDeliverableRecord={documentId:string;kind:PortalDeliverableKind;title:string;filename:string;contentType:"application/pdf";reportVersionId:string;snapshotId:string;evidenceHash:string;publishedAt:string};

const labels:Record<PortalDeliverableKind,{title:string;stem:string}>={report:{title:"Published Carbon Reduction Plan",stem:"carbon-reduction-plan"},certificate:{title:"Emissions certificate",stem:"emissions-certificate"},methodology:{title:"Methodology statement",stem:"methodology-statement"}};
export const portalDeliverableKinds=(value:string):value is PortalDeliverableKind=>value==="report"||value==="certificate"||value==="methodology";
export function portalDeliverableRecords(report:PublishedCrpReportReadModel):PortalDeliverableRecord[]{return (["report","certificate","methodology"] as const).map(kind=>({documentId:`${report.reportVersionId}:${kind}`,kind,title:labels[kind].title,filename:`${report.snapshot.jobNumber}-${labels[kind].stem}-${report.reportVersionId}.pdf`,contentType:"application/pdf",reportVersionId:report.reportVersionId,snapshotId:report.snapshot.id,evidenceHash:report.dataHash,publishedAt:report.publishedAt}));}
export async function getGrantedPortalDeliverables(db:Queryable,input:{portalUserId:string;clientId:string;jobId:string}){const report=await getGrantedPublishedCrpReport(db,input);return report?{report,documents:portalDeliverableRecords(report)}:null;}
