import { jobDatasetUpdates,listJobDatasetOptions,listJobFactorOptions,withTenantRead } from "@nzi/isolated-backend";
import { apiFailure,requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}) { try { const {jobId}=await params; const {pool,organisationId}=requireIsolatedApiContext(); return Response.json(await withTenantRead(pool,organisationId,async(db)=>({factors:await listJobFactorOptions(db,jobId),datasets:await listJobDatasetOptions(db,jobId),
  // DATASET-CURRENCY §3, ruling 1: the banner's read is soft — read last, and a failure shows no banner rather than breaking the job.
  updates:await jobDatasetUpdates(db,organisationId,jobId).catch(()=>[])}))); } catch(error){ return apiFailure(error); } }
