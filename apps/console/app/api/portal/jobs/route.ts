import {listGrantedPortalJobs,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../lib/authResponse";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const user=await currentPortalUser(request),jobs=await withTenantRead(isolatedPool(),user.organisationId,db=>listGrantedPortalJobs(db,{portalUserId:user.userId,clientId:user.clientId}));return Response.json({jobs},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
