import {listScopeRowAuditEvents,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../../../../../lib/authResponse";
import {isolatedPool} from "../../../../../../../lib/isolatedDatabase";
import {currentStaff} from "../../../../../../../lib/staffSession";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{jobId:string;rowId:string}>}){try{const principal=await currentStaff(request),{jobId,rowId}=await params,events=await withTenantRead(isolatedPool(),principal.organisationId,db=>listScopeRowAuditEvents(db,jobId,rowId));return Response.json({events},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
