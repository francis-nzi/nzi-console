import {completePortalInvitationSetup,PortalInvitationError} from "@nzi/isolated-backend";
import {isolatedPool} from "../../../../lib/isolatedDatabase";
import {requirePortalAuthEnabled,requirePortalOrigin} from "../../../../lib/portalSession";
import {authFailure} from "../../../../lib/authResponse";
export async function POST(request:Request){try{requirePortalAuthEnabled();requirePortalOrigin(request);const body=await request.json() as {token?:unknown;code?:unknown};if(typeof body.token!=="string"||typeof body.code!=="string")throw new PortalInvitationError();const result=await completePortalInvitationSetup(isolatedPool(),{token:body.token,code:body.code},process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY??"");return Response.json(result,{headers:{"Cache-Control":"no-store"}});}catch(error){if(error instanceof PortalInvitationError)return Response.json({code:"INVALID_INVITATION",message:error.message},{status:422});return authFailure(error);}}
