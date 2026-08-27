import {getGrantedPortalDeliverables,withTenantRead} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUser(request),{jobId}=await params,result=await withTenantRead(isolatedPool(),user.organisationId,db=>getGrantedPortalDeliverables(db,{portalUserId:user.userId,clientId:user.clientId,jobId}));if(!result)return Response.json({code:"NOT_FOUND",message:"No published deliverables are available."},{status:404});return Response.json({reportVersionId:result.report.reportVersionId,documents:result.documents},{headers:{"Cache-Control":"private, no-store"}})}catch(error){return portalAuthFailure(error)}}
