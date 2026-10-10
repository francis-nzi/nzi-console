import {getGrantedPortalDeliverables,withTenantRead} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUserForData} from "../../../../../lib/portalSession";
export const dynamic="force-dynamic";
// F-4a (D5): the documents of the report the switcher names (`?reportVersionId=`), else the default — never the default's
// documents for another scope's report.
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUserForData(request),{jobId}=await params,reportVersionId=new URL(request.url).searchParams.get("reportVersionId"),result=await withTenantRead(isolatedPool(),user.organisationId,db=>getGrantedPortalDeliverables(db,{portalUserId:user.userId,clientId:user.clientId,jobId,reportVersionId}));if(!result)return Response.json({code:"NOT_FOUND",message:"No published deliverables are available."},{status:404});return Response.json({reportVersionId:result.report.reportVersionId,documents:result.documents},{headers:{"Cache-Control":"private, no-store"}})}catch(error){return portalAuthFailure(error)}}
