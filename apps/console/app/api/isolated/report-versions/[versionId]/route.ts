import {getCrpReportVersion,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../../lib/authResponse";
import {isolatedPool} from "../../../../lib/isolatedDatabase";
import {currentStaff} from "../../../../lib/staffSession";

export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{versionId:string}>}){try{const principal=await currentStaff(request),{versionId}=await params,report=await withTenantRead(isolatedPool(),principal.organisationId,db=>getCrpReportVersion(db,versionId));if(!report)return Response.json({code:"NOT_FOUND",message:"The immutable report version was not found."},{status:404});return Response.json({report},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
