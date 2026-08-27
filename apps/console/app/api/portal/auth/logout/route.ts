import {portalAuthFailure} from "../../../../lib/authResponse";
import {clearPortalSessionCookie,endPortalSession,requirePortalAuthEnabled,requirePortalOrigin} from "../../../../lib/portalSession";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{requirePortalAuthEnabled();requirePortalOrigin(request);await endPortalSession(request);return Response.json({authenticated:false},{headers:{"Set-Cookie":clearPortalSessionCookie(),"Cache-Control":"no-store"}});}catch(error){return portalAuthFailure(error);}}
