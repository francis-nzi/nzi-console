import {getGrantedPublishedCrpReport,getPortalReportApproval,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUser(request),{jobId}=await params;const result=await withTenantRead(isolatedPool(),user.organisationId,async db=>{const report=await getGrantedPublishedCrpReport(db,{portalUserId:user.userId,clientId:user.clientId,jobId});return report?{report,approval:await getPortalReportApproval(db,{portalUserId:user.userId,reportVersionId:report.reportVersionId})}:null});return result?Response.json(result,{headers:{"Cache-Control":"private, no-store"}}):Response.json({code:"NOT_FOUND",message:"No published report is available."},{status:404});}catch(error){return authFailure(error);}}
