import {changePortalPassword} from "@nzi/isolated-backend";
import {portalAuthFailure} from "../../../../lib/authResponse";
import {isolatedPool} from "../../../../lib/isolatedDatabase";
import {currentPortalUser,requirePortalOrigin} from "../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{requirePortalOrigin(request);const user=await currentPortalUser(request),body=await request.json() as {currentPassword?:unknown;newPassword?:unknown};if(typeof body.currentPassword!=="string"||typeof body.newPassword!=="string")return Response.json({code:"INVALID_PASSWORD_CHANGE",message:"Current and new passwords are required."},{status:422});if(body.newPassword.length<12)return Response.json({code:"INVALID_NEW_PASSWORD",message:"The new password must contain at least 12 characters."},{status:422});await changePortalPassword(isolatedPool(),user,{currentPassword:body.currentPassword,newPassword:body.newPassword});return Response.json({changed:true},{headers:{"Cache-Control":"no-store"}});}catch(error){return portalAuthFailure(error);}}
