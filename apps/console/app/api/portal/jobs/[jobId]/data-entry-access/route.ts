import {getPortalDataEntryAccess} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../../../lib/portalSession";

export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const user=await currentPortalUser(request),{jobId}=await params,access=await getPortalDataEntryAccess(isolatedPool(),user,jobId);return Response.json({access},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return portalAuthFailure(error);}}
