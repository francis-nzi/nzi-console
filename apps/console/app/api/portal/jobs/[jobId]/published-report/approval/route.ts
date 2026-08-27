import {approveGrantedPublishedReport} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../../lib/isolatedDatabase";
import {currentPortalUser,requirePortalOrigin} from "../../../../../../lib/portalSession";
import {isPortalReportApproval} from "../../../../../../portal/jobs/[jobId]/publishedReportValidation";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{requirePortalOrigin(request);const user=await currentPortalUser(request),{jobId}=await params,body=await request.json() as {reportVersionId?:unknown},reportVersionId=typeof body.reportVersionId==="string"?body.reportVersionId.trim():"";if(!reportVersionId)return Response.json({code:"INVALID_REPORT_APPROVAL",message:"A published report version is required."},{status:422});const approval=await approveGrantedPublishedReport(isolatedPool(),user,{jobId,reportVersionId});if(!isPortalReportApproval(approval,reportVersionId))return Response.json({code:"INVALID_APPROVAL_EVIDENCE",message:"The approval outcome could not be verified."},{status:502,headers:{"Cache-Control":"no-store"}});return Response.json({approval},{headers:{"Cache-Control":"no-store"}});}catch(error){return portalAuthFailure(error);}}
