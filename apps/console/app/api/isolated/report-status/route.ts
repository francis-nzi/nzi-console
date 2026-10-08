import {listReportStatusRegister,requireCapability,withTenantRead} from "@nzi/isolated-backend";
import {currentStaff} from "../../../lib/staffSession";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {authFailure} from "../../../lib/authResponse";
/** R-ST1: every live CRP job's derived report status. Read-only oversight — nothing here writes. */
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const principal=await currentStaff(request);requireCapability(principal,"report.view");const jobs=await withTenantRead(isolatedPool(),principal.organisationId,listReportStatusRegister);return Response.json({jobs,viewerUserId:principal.userId},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
