import {NextResponse} from "next/server";
import {clearPortalSessionCookie} from "../../lib/portalSession";

export function GET(request:Request){
  const requestUrl=new URL(request.url),next=requestUrl.searchParams.get("next"),login=new URL("/portal/login",request.url);
  if(next?.startsWith("/portal")&&!next.startsWith("//"))login.searchParams.set("next",next);
  login.searchParams.set("reason","session-ended");
  const response=NextResponse.redirect(login,303);
  response.headers.set("Set-Cookie",clearPortalSessionCookie());
  response.headers.set("Cache-Control","private, no-store");
  return response;
}
