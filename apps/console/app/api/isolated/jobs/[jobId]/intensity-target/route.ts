import { getJobIntensityTarget,withTenantRead } from "@nzi/isolated-backend";
import { apiFailure,requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
/** The intensity this job's CRP reports (Phase 3c): the client's target on its first targeted standard metric, with this
 *  job's Value — read only. Setting it is the client's (client.intensityTarget.set) and the job's Value (job.intensityValue.set);
 *  the old per-job PUT (emissions.intensity.upsert) is retired. */
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({target:await withTenantRead(pool,organisationId,db=>getJobIntensityTarget(db,jobId))});}catch(error){return apiFailure(error);}}
