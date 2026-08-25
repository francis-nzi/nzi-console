import {getCurrentPublishedCrpReport,withTenantRead} from "@nzi/isolated-backend";
import {apiFailure,requireIsolatedApiContext} from "../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();const report=await withTenantRead(pool,organisationId,db=>getCurrentPublishedCrpReport(db,jobId));return report?Response.json({report}):Response.json({code:"NOT_FOUND",message:"No published CRP report is available for this job."},{status:404});}catch(error){return apiFailure(error);}}
