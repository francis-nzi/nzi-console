import {getGrantedPublishedCrpReport,getPortalReportApproval,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../../../lib/portalSession";
import {isPublishedCrpReport} from "../../../../../portal/jobs/[jobId]/publishedReportValidation";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUser(request),{jobId}=await params;const result=await withTenantRead(isolatedPool(),user.organisationId,async db=>{const report=await getGrantedPublishedCrpReport(db,{portalUserId:user.userId,clientId:user.clientId,jobId});return report?{report,approval:await getPortalReportApproval(db,{portalUserId:user.userId,reportVersionId:report.reportVersionId})}:null});if(!result)return Response.json({code:"NOT_FOUND",message:"No published report is available."},{status:404});if(!isPublishedCrpReport(result.report,jobId))return Response.json({code:"INVALID_PUBLISHED_EVIDENCE",message:"The published report evidence could not be verified."},{status:502,headers:{"Cache-Control":"private, no-store"}});return Response.json(result,{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
