import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {changePortalPassword,changeStaffPassword,completePortalMfa,completeStaffMfa,encryptTotpSecret,hashPassword,InvalidLoginError,LoginLockedError,revokePortalSession,startPortalLogin,startStaffLogin,totpCode} from "../src/index";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const secret = "JBSWY3DPEHPK3PXP";
const now = new Date("2026-08-25T12:00:00.000Z");

async function loginPool() {
  const password = await hashPassword("correct horse battery staple");
  const encrypted = encryptTotpSecret(secret, encryptionKey);
  const credential = { organisation_id: "demo-nzi-console", user_id: "demo-admin", password_salt: password.salt, password_hash: password.hash, totp_ciphertext: encrypted.ciphertext, totp_iv: encrypted.iv, totp_tag: encrypted.tag, enabled: true, failed_attempts: 0, locked_until: null };
  let challenge: { challenge_id: string; token_hash: string; attempts: number; expires_at: string; consumed_at: null } | undefined;
  let sessionCount = 0;
  let failedAttempts = 0;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      if (sql.includes("FROM nzi_console.staff_credentials c") && sql.includes("FOR UPDATE OF c")) return { rows: [credential] };
      if (sql.includes("SET failed_attempts=$3")) failedAttempts = Number(values?.[2]);
      if (sql.includes("INSERT INTO nzi_console.staff_login_challenges")) challenge = { challenge_id: String(values?.[1]), token_hash: String(values?.[3]), attempts: 0, expires_at: new Date(now.getTime() + 300_000).toISOString(), consumed_at: null };
      if (sql.includes("FROM nzi_console.staff_login_challenges ch")) return { rows: challenge ? [{ ...credential, ...challenge }] : [] };
      if (sql.includes("INSERT INTO nzi_console.staff_sessions")) sessionCount += 1;
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, state: () => ({ challenge, sessionCount, failedAttempts }) };
}

describe("staff login service", () => {
  it("creates a one-time MFA challenge and a revocable session", async () => {
    const test = await loginPool();
    const started = await startStaffLogin(test.pool, { organisationId: "demo-nzi-console", email: "staff@example.invalid", password: "correct horse battery staple" }, now);
    const session = await completeStaffMfa(test.pool, { organisationId: "demo-nzi-console", challengeToken: started.challengeToken, code: totpCode(secret, now.getTime()) }, encryptionKey, now);
    assert.equal(session.userId, "demo-admin");
    assert.equal(session.expiresAt - session.issuedAt, 8 * 60 * 60);
    assert.equal(test.state().sessionCount, 1);
  });

  it("persists a failed password attempt without issuing a challenge", async () => {
    const test = await loginPool();
    await assert.rejects(() => startStaffLogin(test.pool, { organisationId: "demo-nzi-console", email: "staff@example.invalid", password: "incorrect password value" }, now), InvalidLoginError);
    assert.equal(test.state().failedAttempts, 1);
    assert.equal(test.state().challenge, undefined);
  });
});

describe("staff password lifecycle",()=>{
  it("changes a verified password and revokes other staff sessions",async()=>{const old=await hashPassword("correct horse battery staple"),calls:string[]=[];const client={async query(sql:string){calls.push(sql);if(sql.includes("SELECT password_salt"))return{rows:[{password_salt:old.salt,password_hash:old.hash,enabled:true}]};return{rows:[]}},release(){}};await changeStaffPassword({connect:async()=>client} as never,{organisationId:"org-a",userId:"staff-a",sessionId:"session-a",issuedAt:1,expiresAt:2},{currentPassword:"correct horse battery staple",newPassword:"a completely new secure password"},now);assert.ok(calls.some(sql=>sql.includes("staff_credentials SET password_salt")));assert.ok(calls.some(sql=>sql.includes("staff_sessions SET revoked_at")&&sql.includes("session_id<>$3")));});
  it("does not change staff credentials when the current password is wrong",async()=>{const old=await hashPassword("correct horse battery staple"),calls:string[]=[];const client={async query(sql:string){calls.push(sql);if(sql.includes("SELECT password_salt"))return{rows:[{password_salt:old.salt,password_hash:old.hash,enabled:true}]};return{rows:[]}},release(){}};await assert.rejects(()=>changeStaffPassword({connect:async()=>client} as never,{organisationId:"org-a",userId:"staff-a",sessionId:"session-a",issuedAt:1,expiresAt:2},{currentPassword:"incorrect current password",newPassword:"a completely new secure password"},now),InvalidLoginError);assert.equal(calls.some(sql=>sql.includes("password_changed_at")),false);assert.equal(calls.some(sql=>sql.includes("staff_sessions SET revoked_at")),false);});
});

describe("client portal login service",()=>{it("creates an MFA-backed session scoped to one client",async()=>{const password=await hashPassword("correct horse battery staple"),encrypted=encryptTotpSecret(secret,encryptionKey),credential={organisation_id:"demo-nzi-console",portal_user_id:"portal-a",client_id:"client-a",display_name:"Synthetic User",password_salt:password.salt,password_hash:password.hash,totp_ciphertext:encrypted.ciphertext,totp_iv:encrypted.iv,totp_tag:encrypted.tag,enabled:true,failed_attempts:0,locked_until:null};let challenge:{challenge_id:string;token_hash:string;attempts:number;expires_at:string;consumed_at:null}|undefined;const client={async query(sql:string,values?:readonly unknown[]){if(sql.includes("FROM nzi_console.portal_credentials c")&&sql.includes("FOR UPDATE OF c"))return{rows:[credential]};if(sql.includes("INSERT INTO nzi_console.portal_login_challenges")){challenge={challenge_id:String(values?.[1]),token_hash:String(values?.[3]),attempts:0,expires_at:new Date(now.getTime()+300_000).toISOString(),consumed_at:null};return{rows:[]}}if(sql.includes("FROM nzi_console.portal_login_challenges ch"))return{rows:challenge?[{...credential,...challenge}]:[]};return{rows:[]}},release(){}};const pool={connect:async()=>client} as never,started=await startPortalLogin(pool,{organisationId:"demo-nzi-console",email:"portal@example.invalid",password:"correct horse battery staple"},now),session=await completePortalMfa(pool,{organisationId:"demo-nzi-console",challengeToken:started.challengeToken,code:totpCode(secret,now.getTime())},encryptionKey,now);assert.equal(session.principal,"portal");assert.equal(session.clientId,"client-a");assert.equal(session.userId,"portal-a");});});

it("locks portal password sign-in for 15 minutes on the fifth failed attempt",async()=>{const password=await hashPassword("correct horse battery staple"),calls:Array<{sql:string;values?:readonly unknown[]}>=[],credential={organisation_id:"org-a",portal_user_id:"portal-a",client_id:"client-a",display_name:"Portal User",password_salt:password.salt,password_hash:password.hash,totp_ciphertext:"",totp_iv:"",totp_tag:"",enabled:true,failed_attempts:4,locked_until:null},client={async query(sql:string,values?:readonly unknown[]){calls.push({sql,values});if(sql.includes("FROM nzi_console.portal_credentials c"))return{rows:[credential]};return{rows:[]}},release(){}};await assert.rejects(()=>startPortalLogin({connect:async()=>client} as never,{organisationId:"org-a",email:"portal@example.invalid",password:"incorrect password value"},now),LoginLockedError);const lock=calls.find(call=>call.sql.includes("locked_until=CASE"));assert.equal(lock?.values?.[2],5);assert.ok(lock?.sql.includes("interval '15 minutes'"));assert.equal(calls.some(call=>call.sql.includes("INSERT INTO nzi_console.portal_login_challenges")),false);});

it("does not verify a password or issue a challenge while portal sign-in is locked",async()=>{const calls:string[]=[],credential={organisation_id:"org-a",portal_user_id:"portal-a",client_id:"client-a",display_name:"Portal User",password_salt:"unused",password_hash:"unused",totp_ciphertext:"",totp_iv:"",totp_tag:"",enabled:true,failed_attempts:5,locked_until:new Date(now.getTime()+60_000).toISOString()},client={async query(sql:string){calls.push(sql);if(sql.includes("FROM nzi_console.portal_credentials c"))return{rows:[credential]};return{rows:[]}},release(){}};await assert.rejects(()=>startPortalLogin({connect:async()=>client} as never,{organisationId:"org-a",email:"portal@example.invalid",password:"any password value"},now),LoginLockedError);assert.equal(calls.some(sql=>sql.includes("INSERT INTO nzi_console.portal_login_challenges")),false);});

it("allows a verified retry after the lockout period and resets the failure state",async()=>{const password=await hashPassword("correct horse battery staple"),calls:string[]=[],credential={organisation_id:"org-a",portal_user_id:"portal-a",client_id:"client-a",display_name:"Portal User",password_salt:password.salt,password_hash:password.hash,totp_ciphertext:"",totp_iv:"",totp_tag:"",enabled:true,failed_attempts:5,locked_until:new Date(now.getTime()-1).toISOString()},client={async query(sql:string){calls.push(sql);if(sql.includes("FROM nzi_console.portal_credentials c"))return{rows:[credential]};return{rows:[]}},release(){}};const result=await startPortalLogin({connect:async()=>client} as never,{organisationId:"org-a",email:"portal@example.invalid",password:"correct horse battery staple"},now);assert.ok(result.challengeToken);assert.ok(calls.some(sql=>sql.includes("failed_attempts=0,locked_until=NULL")));assert.ok(calls.some(sql=>sql.includes("INSERT INTO nzi_console.portal_login_challenges")));});

it("rejects expired and exhausted MFA challenges without creating a portal session",async()=>{for(const challenge of [{expires_at:new Date(now.getTime()-1).toISOString(),attempts:0},{expires_at:new Date(now.getTime()+60_000).toISOString(),attempts:5}]){const calls:string[]=[],client={async query(sql:string){calls.push(sql);if(sql.includes("FROM nzi_console.portal_login_challenges ch"))return{rows:[{organisation_id:"org-a",portal_user_id:"portal-a",client_id:"client-a",display_name:"Portal User",enabled:true,challenge_id:"challenge-a",consumed_at:null,...challenge}]};return{rows:[]}},release(){}};await assert.rejects(()=>completePortalMfa({connect:async()=>client} as never,{organisationId:"org-a",challengeToken:"challenge-token",code:"000000"},encryptionKey,now),InvalidLoginError);assert.equal(calls.some(sql=>sql.includes("INSERT INTO nzi_console.portal_sessions")),false);}});

it("revokes only the current tenant-bound portal session on logout",async()=>{const calls:Array<{sql:string;values?:readonly unknown[]}>=[],client={async query(sql:string,values?:readonly unknown[]){calls.push({sql,values});return{rows:[]}},release(){}};await revokePortalSession({connect:async()=>client} as never,{principal:"portal",organisationId:"org-a",userId:"portal-a",clientId:"client-a",sessionId:"session-a",issuedAt:1,expiresAt:2},now);const revoke=calls.find(call=>call.sql.includes("portal_sessions SET revoked_at"));assert.deepEqual(revoke?.values?.slice(0,4),["org-a","session-a","portal-a","client-a"]);});
describe("portal password lifecycle",()=>{it("changes a verified password and revokes other sessions",async()=>{const old=await hashPassword("correct horse battery staple"),calls:string[]=[];const client={async query(sql:string){calls.push(sql);if(sql.includes("SELECT password_salt"))return{rows:[{password_salt:old.salt,password_hash:old.hash,enabled:true}]};return{rows:[]}},release(){}};await changePortalPassword({connect:async()=>client} as never,{principal:"portal",organisationId:"org-a",userId:"portal-a",clientId:"client-a",sessionId:"session-a",issuedAt:1,expiresAt:2},{currentPassword:"correct horse battery staple",newPassword:"a completely new secure password"},now);assert.ok(calls.some(sql=>sql.includes("password_changed_at")));assert.ok(calls.some(sql=>sql.includes("session_id<>$3")));});});
it("does not change credentials or revoke sessions when the current portal password is wrong",async()=>{const old=await hashPassword("correct horse battery staple"),calls:string[]=[];const client={async query(sql:string){calls.push(sql);if(sql.includes("SELECT password_salt"))return{rows:[{password_salt:old.salt,password_hash:old.hash,enabled:true}]};return{rows:[]}},release(){}};await assert.rejects(()=>changePortalPassword({connect:async()=>client} as never,{principal:"portal",organisationId:"org-a",userId:"portal-a",clientId:"client-a",sessionId:"session-a",issuedAt:1,expiresAt:2},{currentPassword:"incorrect current password",newPassword:"a completely new secure password"},now),InvalidLoginError);assert.equal(calls.some(sql=>sql.includes("password_changed_at")),false);assert.equal(calls.some(sql=>sql.includes("portal_sessions SET revoked_at")),false);});
