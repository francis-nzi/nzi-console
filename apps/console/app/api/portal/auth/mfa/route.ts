import {completePortalMfa} from "@nzi/isolated-backend";
import {authFailure} from "../../../../lib/authResponse";
import {isolatedPool} from "../../../../lib/isolatedDatabase";
import {portalSessionCookie,requirePortalAuthEnabled,requirePortalOrigin,signPortalSession} from "../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{requirePortalAuthEnabled();requirePortalOrigin(request);const body=await request.json() as {challengeToken?:unknown;code?:unknown};if(typeof body.challengeToken!=="string"||typeof body.code!=="string")return Response.json({code:"INVALID_LOGIN",message:"Invalid email, password, or MFA code."},{status:401});const session=await completePortalMfa(isolatedPool(),{organisationId:process.env.NZI_DEMO_ORGANISATION_ID??"",challengeToken:body.challengeToken,code:body.code},process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY??"");return Response.json({authenticated:true},{headers:{"Set-Cookie":portalSessionCookie(signPortalSession(session),session.expiresAt-session.issuedAt),"Cache-Control":"no-store"}});}catch(error){return authFailure(error);}}
