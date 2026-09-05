import {createLcaResultSnapshot,listLcaResultSnapshots,withTenantRead} from "@nzi/isolated-backend";
import {requireCommandPrincipal} from "../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../lib/commandResponse";
import {apiFailure,isolatedPool,requireIsolatedApiContext} from "../../../../../../../lib/isolatedDatabase";

// Track C — L4 content-addressed result snapshots. GET the freeze history;
// POST freezes the current (approved) result into an immutable snapshot.
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const {assessmentId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({snapshots:await withTenantRead(pool,organisationId,db=>listLcaResultSnapshots(db,assessmentId))});}catch(error){return apiFailure(error);}}

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.assessment.snapshot.create"),{jobId,assessmentId}=await params,body=await request.json() as {expectedVersion:number};return commandSuccess(await createLcaResultSnapshot(isolatedPool(),{jobId,assessmentId,expectedVersion:body.expectedVersion},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
