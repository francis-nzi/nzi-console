import {PortalInvitationError,startPortalInvitationSetup} from "@nzi/isolated-backend";
import {isolatedPool} from "../../../../lib/isolatedDatabase";
import {requirePortalAuthEnabled,requirePortalOrigin} from "../../../../lib/portalSession";
import {authFailure} from "../../../../lib/authResponse";
export async function POST(request:Request){try{requirePortalAuthEnabled();requirePortalOrigin(request);const body=await request.json() as {token?:unknown;password?:unknown};if(typeof body.token!=="string"||typeof body.password!=="string")throw new PortalInvitationError();const setup=await startPortalInvitationSetup(isolatedPool(),{token:body.token,password:body.password},process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY??"");return Response.json({setup},{headers:{"Cache-Control":"no-store"}});}catch(error){if(error instanceof PortalInvitationError)return Response.json({code:"INVALID_INVITATION",message:error.message},{status:422});return authFailure(error);}}
