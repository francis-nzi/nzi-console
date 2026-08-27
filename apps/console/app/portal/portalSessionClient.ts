export async function redirectIfPortalSessionEnded(response:Response){
  if(response.status!==401)return false;
  let code="";
  try{code=(await response.clone().json() as {code?:unknown}).code as string}catch{}
  if(code!=="PORTAL_SESSION_ENDED"&&code!=="AUTHENTICATION_REQUIRED")return false;
  const next=`${window.location.pathname}${window.location.search}`,target=new URL("/portal/session-ended",window.location.origin);
  target.searchParams.set("next",next);
  window.location.assign(target.toString());
  return true;
}
