import {getLcaReport,withTenantRead} from "@nzi/isolated-backend";
import {apiFailure,requireIsolatedApiContext} from "../../../../../../lib/isolatedDatabase";

// Track C — L7: the LCA/PCF family report, built entirely from one frozen
// result snapshot (the artefact L4's sign-off freezes) + its assessment header.
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string;snapshotId:string}>}){try{const {jobId,snapshotId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({report:await withTenantRead(pool,organisationId,db=>getLcaReport(db,jobId,snapshotId))});}catch(error){return apiFailure(error);}}
