import {startPortalLogin} from "@nzi/isolated-backend";
import {authFailure} from "../../../../lib/authResponse";
import {isolatedPool} from "../../../../lib/isolatedDatabase";
import {requirePortalAuthEnabled,requirePortalOrigin} from "../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{requirePortalAuthEnabled();requirePortalOrigin(request);const body=await request.json() as {email?:unknown;password?:unknown};if(typeof body.email!=="string"||typeof body.password!=="string")return Response.json({code:"INVALID_LOGIN",message:"Invalid email, password, or MFA code."},{status:401});const result=await startPortalLogin(isolatedPool(),{organisationId:process.env.NZI_DEMO_ORGANISATION_ID??"",email:body.email,password:body.password});return Response.json({mfaRequired:true,challengeToken:result.challengeToken},{headers:{"Cache-Control":"no-store"}});}catch(error){return authFailure(error);}}
