import {computeLcaScenarioComparison,withTenantRead} from "@nzi/isolated-backend";
import {apiFailure,requireIsolatedApiContext} from "../../../../../../../../lib/isolatedDatabase";

// Track C — L5 scenario comparison: the baseline + every scenario's result,
// computed on demand (what-ifs are never stored).
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const {jobId,assessmentId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json(await withTenantRead(pool,organisationId,db=>computeLcaScenarioComparison(db,organisationId,jobId,assessmentId)));}catch(error){return apiFailure(error);}}
