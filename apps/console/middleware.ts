import { NextRequest, NextResponse } from "next/server";

const publicPath = (path: string) => path === "/login" || path.startsWith("/api/auth/") || path === "/api/health" || path.startsWith("/_next/") || path === "/favicon.ico";
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
async function validSession(token: string | undefined, secret: string | undefined) {
  if (!token || !secret || new TextEncoder().encode(secret).length < 32) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, decode(signature), new TextEncoder().encode(payload))) return false;
    const session = JSON.parse(new TextDecoder().decode(decode(payload))) as { sessionId?: string; userId?: string; organisationId?: string; expiresAt?: number };
    return Boolean(session.sessionId && session.userId && session.organisationId && session.expiresAt && session.expiresAt > Math.floor(Date.now() / 1000));
  } catch { return false; }
}
async function validPortalSession(token:string|undefined,secret:string|undefined){if(!token||!secret||new TextEncoder().encode(secret).length<32)return false;const [payload,signature,extra]=token.split(".");if(!payload||!signature||extra)return false;try{const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);if(!await crypto.subtle.verify("HMAC",key,decode(signature),new TextEncoder().encode(payload)))return false;const session=JSON.parse(new TextDecoder().decode(decode(payload))) as {principal?:string;sessionId?:string;userId?:string;clientId?:string;organisationId?:string;expiresAt?:number};return Boolean(session.principal==="portal"&&session.sessionId&&session.userId&&session.clientId&&session.organisationId&&session.expiresAt&&session.expiresAt>Math.floor(Date.now()/1000));}catch{return false;}}

export async function middleware(request: NextRequest) {
  if (process.env.NZI_AUTH_REQUIRED !== "true") return NextResponse.next();
  const path=request.nextUrl.pathname,portalAuthPath=path==="/portal/login"||path.startsWith("/api/portal/auth/"),portalPath=path==="/portal"||path.startsWith("/portal/")||path.startsWith("/api/portal/");
  if(portalPath){const authenticated=await validPortalSession(request.cookies.get("nzi_portal_session")?.value,process.env.NZI_PORTAL_SESSION_SECRET);if(path==="/portal/login"&&authenticated)return NextResponse.redirect(new URL("/portal",request.url));if(portalAuthPath)return NextResponse.next();if(authenticated)return NextResponse.next();if(path.startsWith("/api/"))return Response.json({code:"AUTHENTICATION_REQUIRED",message:"Client portal authentication is required."},{status:401});const login=new URL("/portal/login",request.url);login.searchParams.set("next",path);return NextResponse.redirect(login);}
  const authenticated = await validSession(request.cookies.get("nzi_console_session")?.value, process.env.NZI_CONSOLE_SESSION_SECRET);
  if (request.nextUrl.pathname === "/login" && authenticated) return NextResponse.redirect(new URL("/", request.url));
  if (publicPath(request.nextUrl.pathname)) return NextResponse.next();
  if (authenticated) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) return Response.json({ code: "AUTHENTICATION_REQUIRED", message: "Staff authentication is required." }, { status: 401 });
  const login = new URL("/login", request.url); login.searchParams.set("next", request.nextUrl.pathname); return NextResponse.redirect(login);
}

export const config = { matcher: ["/((?!.*\\..*).*)"] };
