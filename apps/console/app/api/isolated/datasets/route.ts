import {listDatasetRegistry,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../lib/authResponse";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {currentStaff} from "../../../lib/staffSession";

export const dynamic="force-dynamic";
export async function GET(request:Request){try{const principal=await currentStaff(request),data=await withTenantRead(isolatedPool(),principal.organisationId,listDatasetRegistry);return Response.json(data,{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
