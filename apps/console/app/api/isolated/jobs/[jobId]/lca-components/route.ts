import {listLcaComponentsForJob,listLcaMaterialCategories,withTenantRead} from "@nzi/isolated-backend";
import {apiFailure,requireIsolatedApiContext} from "../../../../../lib/isolatedDatabase";

// Track C — the component library search (client-scoped or global, NZC-053),
// the "reuse the fast-add pattern" quick-add source for the inventory grid.
// Bundled with material categories (both are small pick-lists for the same
// add-line form) — one request, one `lcaComponents` screen contract.
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){
  try{
    const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();
    return Response.json(await withTenantRead(pool,organisationId,async(db)=>({
      components:await listLcaComponentsForJob(db,jobId),
      categories:await listLcaMaterialCategories(db,jobId),
    })));
  }catch(error){return apiFailure(error);}
}
