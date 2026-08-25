import {approveGrantedPublishedReport} from "@nzi/isolated-backend";
import {authFailure} from "../../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../../lib/isolatedDatabase";
import {currentPortalUser,requirePortalOrigin} from "../../../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{requirePortalOrigin(request);const user=await currentPortalUser(request),{jobId}=await params,body=await request.json() as {reportVersionId?:unknown};if(typeof body.reportVersionId!=="string"||!body.reportVersionId.trim())return Response.json({code:"INVALID_REPORT_APPROVAL",message:"A published report version is required."},{status:422});const approval=await approveGrantedPublishedReport(isolatedPool(),user,{jobId,reportVersionId:body.reportVersionId});return Response.json({approval},{headers:{"Cache-Control":"no-store"}});}catch(error){return authFailure(error);}}
