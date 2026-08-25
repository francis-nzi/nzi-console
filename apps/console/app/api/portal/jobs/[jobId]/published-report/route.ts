import {getGrantedPublishedCrpReport,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUser(request),{jobId}=await params;const report=await withTenantRead(isolatedPool(),user.organisationId,db=>getGrantedPublishedCrpReport(db,{portalUserId:user.userId,clientId:user.clientId,jobId}));return report?Response.json({report},{headers:{"Cache-Control":"private, no-store"}}):Response.json({code:"NOT_FOUND",message:"No published report is available."},{status:404});}catch(error){return authFailure(error);}}
