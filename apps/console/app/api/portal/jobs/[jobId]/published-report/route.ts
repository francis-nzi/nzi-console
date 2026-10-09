import {getPortalReportApproval,listGrantedPublishedCrpReports,withTenantRead} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUserForData} from "../../../../../lib/portalSession";
import {isPortalReportApproval,isPublishedCrpReport} from "../../../../../portal/jobs/[jobId]/publishedReportValidation";
/**
 * Portal v1 (S-1, ruled): a grant sees every published scoped report for its job. `report` is the one asked for by
 * `?reportVersionId=`, else the default — the whole-client report, then the most recently published; its approval is this
 * user's approval of that report. `reports` lists every published scope for the switcher.
 */
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUserForData(request),{jobId}=await params;const wanted=new URL(request.url).searchParams.get("reportVersionId");const result=await withTenantRead(isolatedPool(),user.organisationId,async db=>{const reports=await listGrantedPublishedCrpReports(db,{portalUserId:user.userId,clientId:user.clientId,jobId});const report=wanted?reports.find(item=>item.reportVersionId===wanted)??null:reports[0]??null;return report?{report,approval:await getPortalReportApproval(db,{portalUserId:user.userId,reportVersionId:report.reportVersionId}),reports:reports.map(item=>({reportVersionId:item.reportVersionId,scope:item.scope,scopeLabel:item.scopeLabel,publishedAt:item.publishedAt}))}:null});if(!result)return Response.json({code:"NOT_FOUND",message:"No published report is available."},{status:404});if(!isPublishedCrpReport(result.report,jobId)||result.approval!==null&&!isPortalReportApproval(result.approval,result.report.reportVersionId))return Response.json({code:"INVALID_PUBLISHED_EVIDENCE",message:"The published report evidence could not be verified."},{status:502,headers:{"Cache-Control":"private, no-store"}});return Response.json(result,{headers:{"Cache-Control":"private, no-store"}});}catch(error){return portalAuthFailure(error);}}
