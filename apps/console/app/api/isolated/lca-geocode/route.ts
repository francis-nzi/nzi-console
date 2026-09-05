import {geocodeTransportLeg} from "@nzi/isolated-backend";
import type {LcaTransportMode} from "@nzi/contracts";
import {lcaTransportModes} from "@nzi/contracts";
import {apiFailure} from "../../../lib/isolatedDatabase";

// Track C — Nominatim geocoding for LCA transport legs (L3). Not job-scoped —
// a stateless external lookup + haversine math, no tenant data read or
// written. Real service; on isolated staging (no override) it returns a
// deterministic stub, mirroring vehicle-lookup's DVLA pattern.
export const dynamic="force-dynamic";

export async function POST(request:Request){
  try{
    const body=await request.json().catch(()=>({})) as {fromQuery?:unknown;toQuery?:unknown;mode?:unknown};
    if(typeof body.fromQuery!=="string"||body.fromQuery.trim()===""||typeof body.toQuery!=="string"||body.toQuery.trim()===""||typeof body.mode!=="string"||!lcaTransportModes.includes(body.mode as LcaTransportMode)){
      return Response.json({code:"GEOCODE_INPUT_REQUIRED",message:"An origin, a destination and a recognised transport mode are required."},{status:400});
    }
    const result=await geocodeTransportLeg(body.fromQuery,body.toQuery,body.mode as LcaTransportMode,{allowStub:process.env.NEXT_PUBLIC_APP_ENV==="staging"});
    if(!result.ok) return Response.json({code:"GEOCODE_FAILED",message:result.message},{status:result.status});
    return Response.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){return apiFailure(error);}
}
