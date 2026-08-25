import {listReportVersionRegister,withTenantRead} from "@nzi/isolated-backend";
import {currentStaff} from "../../../lib/staffSession";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {authFailure} from "../../../lib/authResponse";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const principal=await currentStaff(request),reports=await withTenantRead(isolatedPool(),principal.organisationId,listReportVersionRegister);return Response.json({reports},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
