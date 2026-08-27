import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {it} from "node:test";

const testDirectory=fileURLToPath(new URL(".",import.meta.url));
const repositoryRoot=join(testDirectory,"..","..","..");
const read=(path:string)=>readFileSync(join(repositoryRoot,path),"utf8");
const routeRoot=join(repositoryRoot,"apps","console","app","api","portal");

function routeFiles(directory:string):string[]{
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?routeFiles(path):entry.name==="route.ts"?[path]:[];
  });
}

it("guards every portal mutation endpoint with the configured same-origin policy",()=>{
  const mutations=routeFiles(routeRoot).filter(path=>/export async function (POST|PATCH|DELETE)/.test(readFileSync(path,"utf8")));
  assert.ok(mutations.length>=10,"expected the complete portal mutation surface");
  for(const path of mutations)assert.match(readFileSync(path,"utf8"),/requirePortalOrigin\(request\)/,path);
});

it("binds an active portal session to one organisation, user and client",()=>{
  const auth=read("packages/isolated-backend/src/auth.ts");
  assert.match(auth,/s\.organisation_id=\$1 AND s\.session_id=\$2 AND s\.portal_user_id=\$3 AND s\.client_id=\$4/);
  assert.match(auth,/s\.revoked_at IS NULL AND s\.expires_at>now\(\) AND u\.status='active'/);
  assert.match(auth,/\[session\.organisationId,session\.sessionId,session\.userId,session\.clientId\]/);
});

it("enforces durable login throttling for password and MFA attempts",()=>{
  const login=read("packages/isolated-backend/src/login.ts");
  assert.match(login,/failed_attempts\+1/);
  assert.match(login,/\$3>=5 THEN \$4::timestamptz\+interval '15 minutes'/);
  assert.match(login,/attempts>=5\?\{state:"locked"/);
  assert.match(login,/row\.attempts>=5/);
  assert.match(login,/portal_login_challenges SET attempts=attempts\+1/);
});

it("expires stale browser sessions without caching the failure",()=>{
  const response=read("apps/console/app/lib/authResponse.ts");
  const session=read("apps/console/app/lib/portalSession.ts");
  assert.match(response,/PORTAL_SESSION_ENDED/);
  assert.match(response,/status:401/);
  assert.match(response,/"Set-Cookie":clearPortalSessionCookie\(\)/);
  assert.match(response,/"Cache-Control":"private, no-store"/);
  assert.match(session,/HttpOnly; Secure; SameSite=Strict; Max-Age=0/);
});
