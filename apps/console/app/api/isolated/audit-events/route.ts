import {listAuditEvents,withTenantRead} from "@nzi/isolated-backend";
import {currentStaff} from "../../../lib/staffSession";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {authFailure} from "../../../lib/authResponse";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const principal=await currentStaff(request),events=await withTenantRead(isolatedPool(),principal.organisationId,db=>listAuditEvents(db));return Response.json({events},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
