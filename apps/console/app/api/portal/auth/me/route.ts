import {getClientBrand,portalUserFirstName,withTenantRead} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../lib/authResponse";
import {isolatedPool} from "../../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../../lib/portalSession";
import {isPortalIdentity} from "../../../../portal/portalPortfolioValidation";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const user=await currentPortalUser(request),identity={userId:user.userId,clientId:user.clientId,displayName:user.displayName,email:user.email};if(!isPortalIdentity(identity))return Response.json({code:"INVALID_PORTAL_IDENTITY",message:"The authenticated client identity could not be verified."},{status:502,headers:{"Cache-Control":"no-store"}});// The client brand (name + logo) for the portal header; the monogram is the fallback. A brand lookup failure never blocks sign-in.
const brand=await withTenantRead(isolatedPool(),user.organisationId,db=>getClientBrand(db,user.clientId)).catch(()=>null);
// How they are greeted (0207): the linked contact's first name, else the first word of their display name. A failed lookup is no name, never a blocked sign-in.
const firstName=await withTenantRead(isolatedPool(),user.organisationId,db=>portalUserFirstName(db,user.organisationId,user.userId)).catch(()=>null);return Response.json({...identity,firstName,clientName:brand?.name??null,clientLogoAssetId:brand?.logoAssetId??null,idleLimitMinutes:user.idleLimitMinutes,termsVersion:user.termsVersion,mustAcceptTerms:user.mustAcceptTerms},{headers:{"Cache-Control":"no-store"}});}catch(error){return portalAuthFailure(error);}}
