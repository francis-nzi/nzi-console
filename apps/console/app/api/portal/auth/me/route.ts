import {portalAuthFailure} from "../../../../lib/authResponse";
import {currentPortalUser} from "../../../../lib/portalSession";
import {isPortalIdentity} from "../../../../portal/portalPortfolioValidation";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const user=await currentPortalUser(request),identity={userId:user.userId,clientId:user.clientId,displayName:user.displayName,email:user.email};if(!isPortalIdentity(identity))return Response.json({code:"INVALID_PORTAL_IDENTITY",message:"The authenticated client identity could not be verified."},{status:502,headers:{"Cache-Control":"no-store"}});return Response.json(identity,{headers:{"Cache-Control":"no-store"}});}catch(error){return portalAuthFailure(error);}}
