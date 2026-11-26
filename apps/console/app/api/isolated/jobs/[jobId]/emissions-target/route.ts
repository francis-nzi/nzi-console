import { CommandValidationError, getJobPathwayTarget, withTenantRead } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandFailure } from "../../../../../lib/commandResponse";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";

// Addendum A (ruled 25 Nov 2026): one baseline, on the client. The job's pathway target is read from the client's baseline and
// targets — `target` is what the report chart draws (null while the baseline's figures are pending), `pathway` what the panel
// shows — and it is no longer a separate entry, so a write here is refused and pointed at the client.
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){
  try{
    const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();
    const pathway=await withTenantRead(pool,organisationId,db=>getJobPathwayTarget(db,jobId));
    return Response.json({target:pathway?.target??null,pathway});
  }catch(error){return apiFailure(error);}
}
export async function PUT(request:Request){
  try{
    await requireCommandPrincipal(request,"emissions.target.upsert");
    throw new CommandValidationError([{field:"jobId",code:"MOVED_TO_CLIENT",message:"The reduction pathway target is the client's now — set the baseline and targets on the client's Carbon tab."}]);
  }catch(error){return commandFailure(error);}
}
