import {listPortalDataEntryReviewQueue} from "@nzi/isolated-backend";
import {authFailure} from "../../../lib/authResponse";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {currentStaff} from "../../../lib/staffSession";
export async function GET(request:Request){try{const principal=await currentStaff(request),items=await listPortalDataEntryReviewQueue(isolatedPool(),principal);return Response.json({items},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error)}}
