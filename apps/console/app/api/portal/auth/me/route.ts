import {authFailure} from "../../../../lib/authResponse";
import {currentPortalUser} from "../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const user=await currentPortalUser(request);return Response.json({userId:user.userId,clientId:user.clientId,displayName:user.displayName,email:user.email},{headers:{"Cache-Control":"no-store"}});}catch(error){return authFailure(error);}}
