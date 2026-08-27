import {markGrantedReportThreadRead} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../../../lib/isolatedDatabase";
import {currentPortalUser,requirePortalOrigin} from "../../../../../../../lib/portalSession";
import {isThreadReadEvidence} from "../../../../../../../portal/jobs/[jobId]/publishedReportValidation";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{requirePortalOrigin(request);const user=await currentPortalUser(request),{jobId}=await params,body=await request.json() as {reportVersionId?:unknown},reportVersionId=typeof body.reportVersionId==="string"?body.reportVersionId.trim():"";if(!reportVersionId)return Response.json({code:"INVALID_THREAD_READ",message:"A published report version is required."},{status:422});const receipt=await markGrantedReportThreadRead(isolatedPool(),user,{jobId,reportVersionId});if(!isThreadReadEvidence(receipt))return Response.json({code:"INVALID_THREAD_READ_EVIDENCE",message:"The read receipt could not be verified."},{status:502,headers:{"Cache-Control":"no-store"}});return Response.json(receipt,{headers:{"Cache-Control":"no-store"}});}catch(error){return portalAuthFailure(error);}}
