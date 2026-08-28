import {changeStaffPassword,InvalidLoginError} from "@nzi/isolated-backend";
import {authFailure} from "../../../lib/authResponse";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {currentStaff,requireAuthOrigin} from "../../../lib/staffSession";

export const dynamic="force-dynamic";
export async function POST(request:Request){try{requireAuthOrigin(request);const staff=await currentStaff(request),body=await request.json() as {currentPassword?:unknown;newPassword?:unknown};if(typeof body.currentPassword!=="string"||typeof body.newPassword!=="string")return Response.json({code:"INVALID_PASSWORD_CHANGE",message:"Current and new passwords are required."},{status:422});if(body.newPassword.length<12)return Response.json({code:"INVALID_NEW_PASSWORD",message:"The new password must contain at least 12 characters."},{status:422});await changeStaffPassword(isolatedPool(),staff,{currentPassword:body.currentPassword,newPassword:body.newPassword});return Response.json({changed:true},{headers:{"Cache-Control":"no-store"}});}catch(error){if(error instanceof InvalidLoginError)return Response.json({code:"INVALID_CURRENT_PASSWORD",message:"The current password is incorrect."},{status:401,headers:{"Cache-Control":"no-store"}});return authFailure(error);}}
