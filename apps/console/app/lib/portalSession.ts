import "server-only";
import {assertSameOrigin,issuePortalSession,resolvePortalPrincipal,revokePortalSession,verifyPortalSession} from "@nzi/isolated-backend";
import {isolatedPool} from "./isolatedDatabase";

export const PORTAL_SESSION_COOKIE="nzi_portal_session";
const cookieValue=(header:string|null,name:string)=>header?.split(";").map(item=>item.trim()).find(item=>item.startsWith(`${name}=`))?.slice(name.length+1);
export const portalSessionCookie=(token:string,maxAge:number)=>`${PORTAL_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearPortalSessionCookie=()=>`${PORTAL_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export class PortalAuthDisabledError extends Error{constructor(){super("Client portal authentication is disabled.");this.name="PortalAuthDisabledError";}}
export const requirePortalAuthEnabled=()=>{if(process.env.NZI_PORTAL_AUTH_ENABLED!=="true")throw new PortalAuthDisabledError();};
export const requirePortalOrigin=(request:Request)=>assertSameOrigin(request.headers.get("origin"),process.env.NZI_ISOLATED_API_URL);
export const signPortalSession=(session:Parameters<typeof issuePortalSession>[0])=>issuePortalSession(session,process.env.NZI_PORTAL_SESSION_SECRET??"");
export async function currentPortalUser(request:Request){requirePortalAuthEnabled();const session=verifyPortalSession(cookieValue(request.headers.get("cookie"),PORTAL_SESSION_COOKIE),process.env.NZI_PORTAL_SESSION_SECRET);return resolvePortalPrincipal(isolatedPool(),session);}
export async function endPortalSession(request:Request){const session=verifyPortalSession(cookieValue(request.headers.get("cookie"),PORTAL_SESSION_COOKIE),process.env.NZI_PORTAL_SESSION_SECRET);await revokePortalSession(isolatedPool(),session);}
