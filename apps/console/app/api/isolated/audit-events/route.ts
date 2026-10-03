import {auditEventsFor,requireCapability,withTenantRead} from "@nzi/isolated-backend";
import {currentStaff} from "../../../lib/staffSession";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {authFailure} from "../../../lib/authResponse";
export const dynamic="force-dynamic";
/** The audit trail, behind audit.view (PERMISSION_MATRIX.md): 403 without it; own clients only for an own_clients holder. */
export async function GET(request:Request){try{const principal=await currentStaff(request);requireCapability(principal,"audit.view");const events=await withTenantRead(isolatedPool(),principal.organisationId,db=>auditEventsFor(db,principal));return Response.json({events},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
