import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolLike } from "./postgres";
import { withAuthTransaction } from "./postgres";
import { decryptTotpSecret, encryptTotpSecret, hashPassword, verifyPassword, verifyTotp } from "./credentials";
import type { StaffSession } from "./auth";
import type {PortalSession} from "./auth";

export class InvalidLoginError extends Error { constructor() { super("Invalid email, password, or MFA code."); this.name = "InvalidLoginError"; } }
export class LoginLockedError extends Error { constructor() { super("Sign-in is temporarily locked. Try again later."); this.name = "LoginLockedError"; } }
type CredentialRow = { organisation_id: string; user_id: string; password_salt: string; password_hash: string; totp_ciphertext: string; totp_iv: string; totp_tag: string; enabled: boolean; failed_attempts: number; locked_until: Date | string | null };
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const DUMMY_PASSWORD_HASH = Buffer.alloc(64).toString("base64url");

export async function provisionStaffCredential(pool: PoolLike, input: { organisationId: string; userId: string; email: string; password: string; totpSecret: string }, encryptionKey: string): Promise<void> {
  const password = await hashPassword(input.password);
  const totp = encryptTotpSecret(input.totpSecret, encryptionKey);
  await withAuthTransaction(pool, "write", async (db) => {
    await db.query(`INSERT INTO nzi_console.staff_credentials
      (organisation_id,user_id,email_normalized,password_salt,password_hash,totp_ciphertext,totp_iv,totp_tag)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (organisation_id,user_id) DO UPDATE SET email_normalized=EXCLUDED.email_normalized,
        password_salt=EXCLUDED.password_salt,password_hash=EXCLUDED.password_hash,
        totp_ciphertext=EXCLUDED.totp_ciphertext,totp_iv=EXCLUDED.totp_iv,totp_tag=EXCLUDED.totp_tag,
        enabled=true,failed_attempts=0,locked_until=NULL,password_changed_at=now()`,
      [input.organisationId, input.userId, input.email.trim().toLowerCase(), password.salt, password.hash, totp.ciphertext, totp.iv, totp.tag]);
  });
}

export async function startStaffLogin(pool: PoolLike, input: { organisationId: string; email: string; password: string }, now = new Date()) {
  const result = await withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<CredentialRow>(`SELECT c.* FROM nzi_console.staff_credentials c
      JOIN nzi_console.memberships m ON (m.organisation_id,m.user_id)=(c.organisation_id,c.user_id)
      WHERE c.organisation_id=$1 AND c.email_normalized=$2 AND c.enabled=true AND m.status='active' FOR UPDATE OF c`,
      [input.organisationId.trim(), input.email.trim().toLowerCase()]);
    const credential = found.rows[0];
    if (!credential) { await verifyPassword(input.password, "nzi-console-missing-credential", DUMMY_PASSWORD_HASH); return { state: "invalid" as const }; }
    if (credential.locked_until && new Date(credential.locked_until) > now) return { state: "locked" as const };
    if (!(await verifyPassword(input.password, credential.password_salt, credential.password_hash))) {
      const attempts = credential.failed_attempts + 1;
      await db.query(`UPDATE nzi_console.staff_credentials SET failed_attempts=$3,
        locked_until=CASE WHEN $3 >= 5 THEN $4::timestamptz + interval '15 minutes' ELSE NULL END
        WHERE organisation_id=$1 AND user_id=$2`, [credential.organisation_id, credential.user_id, attempts, now.toISOString()]);
      return attempts >= 5 ? { state: "locked" as const } : { state: "invalid" as const };
    }
    const challengeId = randomUUID();
    const challengeToken = randomBytes(32).toString("base64url");
    await db.query(`UPDATE nzi_console.staff_credentials SET failed_attempts=0, locked_until=NULL WHERE organisation_id=$1 AND user_id=$2`, [credential.organisation_id, credential.user_id]);
    await db.query(`INSERT INTO nzi_console.staff_login_challenges
      (organisation_id,challenge_id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5::timestamptz + interval '5 minutes')`,
      [credential.organisation_id, challengeId, credential.user_id, tokenHash(challengeToken), now.toISOString()]);
    return { state: "challenge" as const, challengeToken };
  });
  if (result.state === "invalid") throw new InvalidLoginError();
  if (result.state === "locked") throw new LoginLockedError();
  return result;
}

export async function completeStaffMfa(pool: PoolLike, input: { organisationId: string; challengeToken: string; code: string }, encryptionKey: string, now = new Date()): Promise<StaffSession> {
  const result = await withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<CredentialRow & { challenge_id: string; attempts: number; expires_at: Date | string; consumed_at: Date | string | null }>(`SELECT c.*, ch.challenge_id, ch.attempts, ch.expires_at, ch.consumed_at
      FROM nzi_console.staff_login_challenges ch JOIN nzi_console.staff_credentials c
      ON (c.organisation_id,c.user_id)=(ch.organisation_id,ch.user_id)
      WHERE ch.organisation_id=$1 AND ch.token_hash=$2 FOR UPDATE OF ch`, [input.organisationId.trim(), tokenHash(input.challengeToken)]);
    const row = found.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) <= now || row.attempts >= 5 || !row.enabled) return { state: "invalid" as const };
    const secret = decryptTotpSecret({ ciphertext: row.totp_ciphertext, iv: row.totp_iv, tag: row.totp_tag }, encryptionKey);
    if (!verifyTotp(input.code, secret, now.getTime())) {
      await db.query(`UPDATE nzi_console.staff_login_challenges SET attempts=attempts+1 WHERE organisation_id=$1 AND challenge_id=$2`, [row.organisation_id, row.challenge_id]);
      return { state: "invalid" as const };
    }
    const sessionId = randomUUID();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + 8 * 60 * 60;
    await db.query(`UPDATE nzi_console.staff_login_challenges SET consumed_at=$3 WHERE organisation_id=$1 AND challenge_id=$2`, [row.organisation_id, row.challenge_id, now.toISOString()]);
    await db.query(`UPDATE nzi_console.staff_credentials SET last_login_at=$3 WHERE organisation_id=$1 AND user_id=$2`, [row.organisation_id, row.user_id, now.toISOString()]);
    await db.query(`INSERT INTO nzi_console.staff_sessions (organisation_id,session_id,user_id,expires_at,last_seen_at)
      VALUES ($1,$2,$3,to_timestamp($4),$5)`, [row.organisation_id, sessionId, row.user_id, expiresAt, now.toISOString()]);
    return { state: "success" as const, session: { sessionId, userId: row.user_id, organisationId: row.organisation_id, issuedAt, expiresAt } };
  });
  if (result.state === "invalid") throw new InvalidLoginError();
  return result.session;
}

export async function revokeStaffSession(pool: PoolLike, session: StaffSession, now = new Date()): Promise<void> {
  await withAuthTransaction(pool, "write", async (db) => {
    await db.query(`UPDATE nzi_console.staff_sessions SET revoked_at=$4 WHERE organisation_id=$1 AND session_id=$2 AND user_id=$3 AND revoked_at IS NULL`, [session.organisationId, session.sessionId, session.userId, now.toISOString()]);
  });
}

export async function changeStaffPassword(pool:PoolLike,session:StaffSession,input:{currentPassword:string;newPassword:string},now=new Date()):Promise<void>{await withAuthTransaction(pool,"write",async db=>{const found=await db.query<{password_salt:string;password_hash:string;enabled:boolean}>(`SELECT password_salt,password_hash,enabled FROM nzi_console.staff_credentials WHERE organisation_id=$1 AND user_id=$2 FOR UPDATE`,[session.organisationId,session.userId]),credential=found.rows[0];if(!credential?.enabled||!(await verifyPassword(input.currentPassword,credential.password_salt,credential.password_hash)))throw new InvalidLoginError();const next=await hashPassword(input.newPassword);await db.query(`UPDATE nzi_console.staff_credentials SET password_salt=$3,password_hash=$4,password_changed_at=$5,failed_attempts=0,locked_until=NULL WHERE organisation_id=$1 AND user_id=$2`,[session.organisationId,session.userId,next.salt,next.hash,now.toISOString()]);await db.query(`UPDATE nzi_console.staff_sessions SET revoked_at=$4 WHERE organisation_id=$1 AND user_id=$2 AND session_id<>$3 AND revoked_at IS NULL`,[session.organisationId,session.userId,session.sessionId,now.toISOString()]);});}

type PortalCredentialRow={organisation_id:string;portal_user_id:string;password_salt:string;password_hash:string;totp_ciphertext:string;totp_iv:string;totp_tag:string;enabled:boolean;failed_attempts:number;locked_until:Date|string|null;client_id:string;display_name:string};
export async function startPortalLogin(pool:PoolLike,input:{organisationId:string;email:string;password:string},now=new Date()){const result=await withAuthTransaction(pool,"write",async db=>{const found=await db.query<PortalCredentialRow>(`SELECT c.*,u.client_id,u.display_name FROM nzi_console.portal_credentials c JOIN nzi_console.portal_users u ON (u.organisation_id,u.portal_user_id)=(c.organisation_id,c.portal_user_id) WHERE c.organisation_id=$1 AND u.email_normalized=$2 AND c.enabled=true AND u.status='active' FOR UPDATE OF c`,[input.organisationId.trim(),input.email.trim().toLowerCase()]);const credential=found.rows[0];if(!credential){await verifyPassword(input.password,"nzi-console-missing-portal-credential",DUMMY_PASSWORD_HASH);return{state:"invalid" as const};}if(credential.locked_until&&new Date(credential.locked_until)>now)return{state:"locked" as const};if(!(await verifyPassword(input.password,credential.password_salt,credential.password_hash))){const attempts=credential.failed_attempts+1;await db.query(`UPDATE nzi_console.portal_credentials SET failed_attempts=$3,locked_until=CASE WHEN $3>=5 THEN $4::timestamptz+interval '15 minutes' ELSE NULL END WHERE organisation_id=$1 AND portal_user_id=$2`,[credential.organisation_id,credential.portal_user_id,attempts,now.toISOString()]);return attempts>=5?{state:"locked" as const}:{state:"invalid" as const};}const challengeId=randomUUID(),challengeToken=randomBytes(32).toString("base64url");await db.query(`UPDATE nzi_console.portal_credentials SET failed_attempts=0,locked_until=NULL WHERE organisation_id=$1 AND portal_user_id=$2`,[credential.organisation_id,credential.portal_user_id]);await db.query(`INSERT INTO nzi_console.portal_login_challenges(organisation_id,challenge_id,portal_user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5::timestamptz+interval '5 minutes')`,[credential.organisation_id,challengeId,credential.portal_user_id,tokenHash(challengeToken),now.toISOString()]);return{state:"challenge" as const,challengeToken};});if(result.state==="invalid")throw new InvalidLoginError();if(result.state==="locked")throw new LoginLockedError();return result;}

export async function completePortalMfa(pool:PoolLike,input:{organisationId:string;challengeToken:string;code:string},encryptionKey:string,now=new Date()):Promise<PortalSession>{const result=await withAuthTransaction(pool,"write",async db=>{const found=await db.query<PortalCredentialRow&{challenge_id:string;attempts:number;expires_at:Date|string;consumed_at:Date|string|null}>(`SELECT c.*,u.client_id,u.display_name,ch.challenge_id,ch.attempts,ch.expires_at,ch.consumed_at FROM nzi_console.portal_login_challenges ch JOIN nzi_console.portal_credentials c ON (c.organisation_id,c.portal_user_id)=(ch.organisation_id,ch.portal_user_id) JOIN nzi_console.portal_users u ON (u.organisation_id,u.portal_user_id)=(c.organisation_id,c.portal_user_id) WHERE ch.organisation_id=$1 AND ch.token_hash=$2 FOR UPDATE OF ch`,[input.organisationId.trim(),tokenHash(input.challengeToken)]);const row=found.rows[0];if(!row||row.consumed_at||new Date(row.expires_at)<=now||row.attempts>=5||!row.enabled)return{state:"invalid" as const};const secret=decryptTotpSecret({ciphertext:row.totp_ciphertext,iv:row.totp_iv,tag:row.totp_tag},encryptionKey);if(!verifyTotp(input.code,secret,now.getTime())){await db.query(`UPDATE nzi_console.portal_login_challenges SET attempts=attempts+1 WHERE organisation_id=$1 AND challenge_id=$2`,[row.organisation_id,row.challenge_id]);return{state:"invalid" as const};}const sessionId=randomUUID(),issuedAt=Math.floor(now.getTime()/1000),expiresAt=issuedAt+8*60*60;await db.query(`UPDATE nzi_console.portal_login_challenges SET consumed_at=$3 WHERE organisation_id=$1 AND challenge_id=$2`,[row.organisation_id,row.challenge_id,now.toISOString()]);await db.query(`UPDATE nzi_console.portal_credentials SET last_login_at=$3 WHERE organisation_id=$1 AND portal_user_id=$2`,[row.organisation_id,row.portal_user_id,now.toISOString()]);await db.query(`INSERT INTO nzi_console.portal_sessions(organisation_id,session_id,portal_user_id,client_id,expires_at,last_seen_at) VALUES($1,$2,$3,$4,to_timestamp($5),$6)`,[row.organisation_id,sessionId,row.portal_user_id,row.client_id,expiresAt,now.toISOString()]);return{state:"success" as const,session:{principal:"portal" as const,sessionId,userId:row.portal_user_id,clientId:row.client_id,organisationId:row.organisation_id,issuedAt,expiresAt}};});if(result.state==="invalid")throw new InvalidLoginError();return result.session;}

export async function revokePortalSession(pool:PoolLike,session:PortalSession,now=new Date()):Promise<void>{await withAuthTransaction(pool,"write",db=>db.query(`UPDATE nzi_console.portal_sessions SET revoked_at=$5 WHERE organisation_id=$1 AND session_id=$2 AND portal_user_id=$3 AND client_id=$4 AND revoked_at IS NULL`,[session.organisationId,session.sessionId,session.userId,session.clientId,now.toISOString()]).then(()=>undefined));}

export async function changePortalPassword(pool:PoolLike,session:PortalSession,input:{currentPassword:string;newPassword:string},now=new Date()):Promise<void>{await withAuthTransaction(pool,"write",async db=>{const found=await db.query<{password_salt:string;password_hash:string;enabled:boolean}>(`SELECT password_salt,password_hash,enabled FROM nzi_console.portal_credentials WHERE organisation_id=$1 AND portal_user_id=$2 FOR UPDATE`,[session.organisationId,session.userId]),credential=found.rows[0];if(!credential?.enabled||!(await verifyPassword(input.currentPassword,credential.password_salt,credential.password_hash)))throw new InvalidLoginError();const next=await hashPassword(input.newPassword);await db.query(`UPDATE nzi_console.portal_credentials SET password_salt=$3,password_hash=$4,password_changed_at=$5,failed_attempts=0,locked_until=NULL WHERE organisation_id=$1 AND portal_user_id=$2`,[session.organisationId,session.userId,next.salt,next.hash,now.toISOString()]);await db.query(`UPDATE nzi_console.portal_sessions SET revoked_at=$4 WHERE organisation_id=$1 AND portal_user_id=$2 AND session_id<>$3 AND revoked_at IS NULL`,[session.organisationId,session.userId,session.sessionId,now.toISOString()]);});}
