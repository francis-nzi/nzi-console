import {listCurrentPublishedCrpReports,withTenantRead} from "@nzi/isolated-backend";
import {apiFailure,requireIsolatedApiContext} from "../../../../../lib/isolatedDatabase";
import {isPublishedCrpReport} from "../../../../../portal/jobs/[jobId]/publishedReportValidation";

/**
 * A job's published reports (S-1, R-S2 as updated): one per scope, live side by side. `report` is the one asked for by
 * `?reportVersionId=`, else the job's default (whole-client first, then the most recently published); `reports` names every
 * published scope so a reader can switch between them.
 */
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();const wanted=new URL(request.url).searchParams.get("reportVersionId");const reports=await withTenantRead(pool,organisationId,db=>listCurrentPublishedCrpReports(db,jobId));const report=wanted?reports.find(item=>item.reportVersionId===wanted)??null:reports[0]??null;if(!report)return Response.json({code:"NOT_FOUND",message:wanted?"That report is not a current published report for this job.":"No published CRP report is available for this job."},{status:404});if(!isPublishedCrpReport(report,jobId))return Response.json({code:"INVALID_PUBLISHED_EVIDENCE",message:"The published report evidence could not be verified."},{status:502,headers:{"Cache-Control":"no-store"}});return Response.json({report,reports:reports.map(item=>({reportVersionId:item.reportVersionId,scope:item.scope,scopeLabel:item.scopeLabel,publishedAt:item.publishedAt}))},{headers:{"Cache-Control":"no-store"}});}catch(error){return apiFailure(error);}}
