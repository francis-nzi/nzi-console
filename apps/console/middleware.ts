import { NextRequest, NextResponse } from "next/server";

// `/verify/<code>` is public by design — a certificate only means something outside NZI if
// someone holding it can confirm it without an account. What that page may return is bounded
// by the `verify_training_certificate` function, not by this list.
const publicPath = (path: string) => path === "/login" || path.startsWith("/api/auth/") || path === "/api/health" || path.startsWith("/_next/") || path === "/favicon.ico" || path.startsWith("/verify/");
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

// The trainee session shape. Deliberately a separate check rather than a parameterised
// one: the `principal` discriminator is verified here, so a portal token cannot be
// replayed into the trainee realm even if both secrets were ever set to the same value.
async function validTraineeSession(token:string|undefined,secret:string|undefined){if(!token||!secret||new TextEncoder().encode(secret).length<32)return false;const [payload,signature,extra]=token.split(".");if(!payload||!signature||extra)return false;try{const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);if(!await crypto.subtle.verify("HMAC",key,decode(signature),new TextEncoder().encode(payload)))return false;const session=JSON.parse(new TextDecoder().decode(decode(payload))) as {principal?:string;sessionId?:string;traineeId?:string;organisationId?:string;expiresAt?:number};return Boolean(session.principal==="trainee"&&session.sessionId&&session.traineeId&&session.organisationId&&session.expiresAt&&session.expiresAt>Math.floor(Date.now()/1000));}catch{return false;}}

export async function middleware(request: NextRequest) {
  if (process.env.NZI_AUTH_REQUIRED !== "true") return NextResponse.next();
  const path=request.nextUrl.pathname,portalAuthPath=path==="/portal/login"||path==="/portal/invite"||path==="/portal/session-ended"||path.startsWith("/api/portal/auth/")||path.startsWith("/api/portal/invitations/"),portalPath=path==="/portal"||path.startsWith("/portal/")||path.startsWith("/api/portal/");
  // The trainee realm, checked against its OWN cookie and secret. Keeping the three realms
  // in separate branches is what stops a session from one ever satisfying another.
  const traineePath=path==="/trainee"||path.startsWith("/trainee/")||path.startsWith("/api/trainee/");
  if(traineePath){
    // Sign-in and the email-verification link are reachable without a session: the second
    // is followed from the NEW address, which by definition is not signed in yet.
    const traineeAuthPath=path==="/trainee/login"||path==="/trainee/verify-email"||path.startsWith("/api/trainee/auth/");
    const authenticated=await validTraineeSession(request.cookies.get("nzi_trainee_session")?.value,process.env.NZI_TRAINEE_SESSION_SECRET);
    if(path==="/trainee/login"&&authenticated)return NextResponse.redirect(new URL("/trainee",request.url));
    // The confirm call itself is part of that link, so it is allowed through unsigned too.
    if(traineeAuthPath||(path==="/api/trainee/email-change"&&request.method==="PUT"))return NextResponse.next();
    if(authenticated)return NextResponse.next();
    if(path.startsWith("/api/"))return Response.json({code:"AUTHENTICATION_REQUIRED",message:"Trainee authentication is required."},{status:401});
    const login=new URL("/trainee/login",request.url);login.searchParams.set("next",path);return NextResponse.redirect(login);
  }
  if(portalPath){const authenticated=await validPortalSession(request.cookies.get("nzi_portal_session")?.value,process.env.NZI_PORTAL_SESSION_SECRET);if(path==="/portal/login"&&authenticated)return NextResponse.redirect(new URL("/portal",request.url));if(portalAuthPath)return NextResponse.next();if(authenticated)return NextResponse.next();if(path.startsWith("/api/"))return Response.json({code:"AUTHENTICATION_REQUIRED",message:"Client portal authentication is required."},{status:401});const login=new URL("/portal/login",request.url);login.searchParams.set("next",path);return NextResponse.redirect(login);}
  const authenticated = await validSession(request.cookies.get("nzi_console_session")?.value, process.env.NZI_CONSOLE_SESSION_SECRET);
  if (request.nextUrl.pathname === "/login" && authenticated) return NextResponse.redirect(new URL("/", request.url));
  if (publicPath(request.nextUrl.pathname)) return NextResponse.next();
  if (authenticated) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) return Response.json({ code: "AUTHENTICATION_REQUIRED", message: "Staff authentication is required." }, { status: 401 });
  const login = new URL("/login", request.url); login.searchParams.set("next", request.nextUrl.pathname); return NextResponse.redirect(login);
}

export const config = { matcher: ["/((?!.*\\..*).*)"] };
