import { createHmac, timingSafeEqual } from "node:crypto";
import type { Capability, CapabilityGrant, CapabilityScope, CommandGrant, CommandKey, StaffRole } from "@nzi/contracts";
import { commandDefinitions, grantFor, isCapability, isStaffRole } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { withAuthTransaction } from "./postgres";

export type { StaffRole };
export type StaffSession = { sessionId: string; userId: string; organisationId: string; issuedAt: number; expiresAt: number };
export type PortalSession = { principal:"portal";sessionId:string;userId:string;clientId:string;organisationId:string;issuedAt:number;expiresAt:number };
export type PortalPrincipal=PortalSession&{displayName:string;email:string;idleLimitMinutes:number;termsVersion:string;mustAcceptTerms:boolean};
export const PORTAL_IDLE_LIMIT_DEFAULT_MINUTES=30;
/** NZC-022 — the role and the capabilities it resolves to in the current permission-matrix version. */
export type StaffPrincipal = StaffSession & { role: StaffRole; matrixVersion: number; capabilities: readonly CapabilityGrant[] };

export class AuthenticationError extends Error { constructor(message = "Staff authentication is required.") { super(message); this.name = "AuthenticationError"; } }
/** `permission` is the capability refused (a PERMISSION_MATRIX.md name), or `tenant` for a record outside the caller's organisation. */
export class AuthorizationError extends Error { constructor(readonly permission: string, message = "Permission denied.") { super(message); this.name = "AuthorizationError"; } }

const encode = (value: string) => Buffer.from(value).toString("base64url");
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");
const requireSecret = (secret: string | undefined) => {
  if (!secret || Buffer.byteLength(secret) < 32) throw new AuthenticationError("A dedicated session secret of at least 32 bytes is required.");
  return secret;
};

export function issueStaffSession(session: StaffSession, secret: string): string {
  const payload = encode(JSON.stringify(session));
  return `${payload}.${sign(payload, requireSecret(secret))}`;
}

export function verifyStaffSession(token: string | undefined, secret: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): StaffSession {
  if (!token) throw new AuthenticationError();
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new AuthenticationError("Invalid staff session.");
  const expected = sign(payload, requireSecret(secret));
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new AuthenticationError("Invalid staff session.");
  let session: StaffSession;
  try { session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession; } catch { throw new AuthenticationError("Invalid staff session."); }
  if (!session.sessionId?.trim() || !session.userId?.trim() || !session.organisationId?.trim() || !Number.isInteger(session.issuedAt) || !Number.isInteger(session.expiresAt)) throw new AuthenticationError("Invalid staff session.");
  if (session.issuedAt > nowSeconds + 60 || session.expiresAt <= nowSeconds) throw new AuthenticationError("Staff session has expired.");
  return session;
}

export function issuePortalSession(session:PortalSession,secret:string):string{const payload=encode(JSON.stringify(session));return `${payload}.${sign(payload,requireSecret(secret))}`;}
export function verifyPortalSession(token:string|undefined,secret:string|undefined,nowSeconds=Math.floor(Date.now()/1000)):PortalSession{if(!token)throw new AuthenticationError("Client portal authentication is required.");const [payload,signature,extra]=token.split(".");if(!payload||!signature||extra)throw new AuthenticationError("Invalid client portal session.");const expected=sign(payload,requireSecret(secret)),actualBuffer=Buffer.from(signature),expectedBuffer=Buffer.from(expected);if(actualBuffer.length!==expectedBuffer.length||!timingSafeEqual(actualBuffer,expectedBuffer))throw new AuthenticationError("Invalid client portal session.");let session:PortalSession;try{session=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as PortalSession;}catch{throw new AuthenticationError("Invalid client portal session.");}if(session.principal!=="portal"||!session.sessionId?.trim()||!session.userId?.trim()||!session.clientId?.trim()||!session.organisationId?.trim()||!Number.isInteger(session.issuedAt)||!Number.isInteger(session.expiresAt))throw new AuthenticationError("Invalid client portal session.");if(session.issuedAt>nowSeconds+60||session.expiresAt<=nowSeconds)throw new AuthenticationError("Client portal session has expired.");return session;}

// P1 (Portal Phase 2) — idle-session enforcement lives here, at the single
// request-time resolve every portal API route already goes through: a session
// whose `last_seen_at` is older than the idle limit is rejected server-side
// (so a closed laptop or a killed client JS still self-heals), and a live
// session's activity slides the window forward (throttled to one write / 30s).
export async function resolvePortalPrincipal(pool:PoolLike,session:PortalSession,options?:{idleLimitMinutes?:number;termsVersion?:string}):Promise<PortalPrincipal>{
  const idleLimitMinutes=Number.isFinite(options?.idleLimitMinutes)&&(options?.idleLimitMinutes??0)>0?Math.floor(options!.idleLimitMinutes!):PORTAL_IDLE_LIMIT_DEFAULT_MINUTES;
  const termsVersion=(options?.termsVersion??"").trim();
  return withAuthTransaction(pool,"write",async db=>{
    // P2b — `must_accept_tac`: when a terms version is configured, the session is
    // still resolved, but flagged `mustAcceptTerms` until an acceptance row for
    // THAT version exists (so a re-issued version re-gates existing users).
    const result=await db.query<{display_name:string;email_normalized:string;terms_ok:boolean}>(`SELECT u.display_name,u.email_normalized,($6='' OR EXISTS(SELECT 1 FROM nzi_console.portal_terms_acceptances t WHERE (t.organisation_id,t.portal_user_id)=(s.organisation_id,s.portal_user_id) AND t.terms_version=$6)) AS terms_ok FROM nzi_console.portal_sessions s JOIN nzi_console.portal_users u ON (u.organisation_id,u.portal_user_id,u.client_id)=(s.organisation_id,s.portal_user_id,s.client_id) WHERE s.organisation_id=$1 AND s.session_id=$2 AND s.portal_user_id=$3 AND s.client_id=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' AND s.last_seen_at > now() - ($5 || ' minutes')::interval`,[session.organisationId,session.sessionId,session.userId,session.clientId,String(idleLimitMinutes),termsVersion]);
    const user=result.rows[0];
    if(!user)throw new AuthenticationError("No active client portal session exists.");
    await db.query(`UPDATE nzi_console.portal_sessions SET last_seen_at=now() WHERE organisation_id=$1 AND session_id=$2 AND last_seen_at < now() - interval '30 seconds'`,[session.organisationId,session.sessionId]);
    return{...session,displayName:user.display_name,email:user.email_normalized,idleLimitMinutes,termsVersion,mustAcceptTerms:termsVersion!==""&&!user.terms_ok};
  });
}

/**
 * The membership's role, then that role's rows in the current (highest) version of
 * the migration-owned matrix. A role with no rows resolves to no capabilities —
 * fail closed, never a default grant.
 */
export async function resolveStaffPrincipal(pool: PoolLike, session: StaffSession): Promise<StaffPrincipal> {
  return withAuthTransaction(pool, "read", async (db: Queryable) => {
    const result = await db.query<{ role_id: string }>(`SELECT m.role_id FROM nzi_console.staff_sessions s
      JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (s.organisation_id, s.user_id)
      WHERE s.organisation_id=$1 AND s.session_id=$2 AND s.user_id=$3 AND s.revoked_at IS NULL
        AND s.expires_at > now() AND m.status='active'`, [session.organisationId, session.sessionId, session.userId]);
    const role = result.rows[0]?.role_id;
    if (!isStaffRole(role)) throw new AuthenticationError("No active staff membership exists.");
    const matrix = await db.query<{ matrix_version: number; capability: string; scope: string }>(`SELECT r.matrix_version, r.capability, r.scope
      FROM nzi_console.staff_role_capabilities r
      WHERE r.role_id=$1 AND r.matrix_version=(SELECT max(matrix_version) FROM nzi_console.staff_capability_matrix_versions)
      ORDER BY r.capability`, [role]);
    return { ...session, role, ...capabilitiesFromRows(matrix.rows) };
  });
}

/** Rows naming a capability outside the enum are ignored (the enum is exhaustive), never widened. */
export function capabilitiesFromRows(rows: ReadonlyArray<{ matrix_version: number; capability: string; scope: string }>): { matrixVersion: number; capabilities: CapabilityGrant[] } {
  const capabilities = rows
    .filter((row): row is { matrix_version: number; capability: Capability; scope: CapabilityScope } => isCapability(row.capability) && (row.scope === "all" || row.scope === "own_clients"))
    .map((row) => ({ capability: row.capability, scope: row.scope }));
  return { matrixVersion: rows[0]?.matrix_version ?? 0, capabilities };
}

/** The grant a command context carries — the resolved principal, nothing added. */
export function commandGrant(principal: StaffPrincipal): CommandGrant {
  return { organisationId: principal.organisationId, userId: principal.userId, role: principal.role, matrixVersion: principal.matrixVersion, capabilities: principal.capabilities };
}

export function principalHas(principal: Pick<StaffPrincipal, "capabilities">, capability: Capability): boolean {
  return grantFor(principal.capabilities, capability) !== null;
}

/** A route-level pre-check that the role holds the capability at all; scope and tenant are checked again, authoritatively, in the command runner. */
export function requireCapability(principal: Pick<StaffPrincipal, "capabilities">, capability: Capability): void {
  if (!principalHas(principal, capability)) throw new AuthorizationError(capability);
}

export function authorizeCommand(principal: StaffPrincipal, key: CommandKey): void {
  requireCapability(principal, commandDefinitions[key].permission);
}

export function assertSameOrigin(origin: string | null, configuredBaseUrl: string | undefined): void {
  if (!origin || !configuredBaseUrl) throw new AuthenticationError("A trusted request origin is required.");
  if (new URL(origin).origin !== new URL(configuredBaseUrl).origin) throw new AuthenticationError("Request origin is not trusted.");
}
