import { listJobDatasetOptions,listJobFactorOptions,withTenantRead } from "@nzi/isolated-backend";
import { apiFailure,requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}) { try { const {jobId}=await params; const {pool,organisationId}=requireIsolatedApiContext(); return Response.json(await withTenantRead(pool,organisationId,async(db)=>({factors:await listJobFactorOptions(db,jobId),datasets:await listJobDatasetOptions(db,jobId)}))); } catch(error){ return apiFailure(error); } }
