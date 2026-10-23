import {getPortalReportApproval,listGrantedPublishedCrpReports,portalPublishedReportOf,withTenantRead} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUserForData} from "../../../../../lib/portalSession";
import {isPortalReportApproval,isPublishedCrpReport} from "../../../../../portal/jobs/[jobId]/publishedReportValidation";
/**
 * Portal v1 (S-1, ruled): a grant sees every published scoped report for its job. `report` is the one asked for by
 * `?reportVersionId=`, else the default — the whole-client report, then the most recently published; its approval is this
 * user's approval of that report. `reports` lists every published scope for the switcher.
 *
 * F-4b (ruled): the client's copy — `clientFacingPublishedReport` takes out every staff identity (who prepared, approved,
 * reviewed or last edited it) before it is checked and sent, so none reaches the client's browser. The selection and the copy
 * are `portalPublishedReportOf`, which the staff preview shares; only the approval is this user's.
 */
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUserForData(request),{jobId}=await params;const wanted=new URL(request.url).searchParams.get("reportVersionId");const result=await withTenantRead(isolatedPool(),user.organisationId,async db=>{const selected=portalPublishedReportOf(await listGrantedPublishedCrpReports(db,{portalUserId:user.userId,clientId:user.clientId,jobId}),wanted);return selected?{report:selected.report,approval:await getPortalReportApproval(db,{portalUserId:user.userId,reportVersionId:selected.report.reportVersionId}),reports:selected.reports}:null});if(!result)return Response.json({code:"NOT_FOUND",message:"No published report is available."},{status:404});if(!isPublishedCrpReport(result.report,jobId)||result.approval!==null&&!isPortalReportApproval(result.approval,result.report.reportVersionId))return Response.json({code:"INVALID_PUBLISHED_EVIDENCE",message:"The published report evidence could not be verified."},{status:502,headers:{"Cache-Control":"private, no-store"}});return Response.json(result,{headers:{"Cache-Control":"private, no-store"}});}catch(error){return portalAuthFailure(error);}}
