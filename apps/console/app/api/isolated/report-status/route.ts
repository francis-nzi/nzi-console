import {listReportStatusRegister,requireCapability,withTenantRead} from "@nzi/isolated-backend";
import {currentStaff} from "../../../lib/staffSession";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {authFailure} from "../../../lib/authResponse";
/**
 * R-ST1: every live CRP job's derived report status. Read-only oversight — nothing here writes.
 * Track A: `?jobId=` narrows it to one job — the job page's report link reads its own row through the same read model.
 */
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const principal=await currentStaff(request);requireCapability(principal,"report.view");const jobId=new URL(request.url).searchParams.get("jobId");const jobs=await withTenantRead(isolatedPool(),principal.organisationId,(db)=>listReportStatusRegister(db,{jobId}));return Response.json({jobs,viewerUserId:principal.userId},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
