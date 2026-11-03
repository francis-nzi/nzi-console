import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction, type PoolLike, type Queryable } from "./postgres";

/**
 * Every portal sign-in attempt, recorded (RULING-portal-access-model Q4). Written inside the login's own auth transaction — so an
 * attempt and its counters commit together — by the auth role, which can insert and nothing else on this table.
 *
 * What is recorded: the outcome, the time, and who — the portal user when the attempt names one, else a SHA-256 of the lower-cased
 * address (never the address). IP and user-agent are personal data: they are kept 90 days and then nulled
 * (`purgePortalLoginNetworkData`); the outcome, time and user stay for the normal audit horizon.
 *
 * The outcome is for staff. The *response* to a switched-off or expired client is the same as to an unknown user (`invalid`), so
 * recording `client_disabled` here tells the person nothing they could use to probe.
 */
export type PortalLoginOutcome = "success" | "bad_password" | "locked" | "unknown_user" | "user_disabled" | "client_disabled" | "client_expired" | "bad_code" | "invalid_challenge";
export type LoginNetwork = { ip?: string | null; userAgent?: string | null };
export const PORTAL_LOGIN_NETWORK_RETENTION_DAYS = 90;

export const loginEmailHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export async function recordPortalLoginEvent(db: Queryable, event: { organisationId: string; outcome: PortalLoginOutcome; portalUserId?: string | null; clientId?: string | null; email?: string | null; network?: LoginNetwork; now: Date }): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.portal_login_events (organisation_id,event_id,occurred_at,outcome,portal_user_id,client_id,email_hash,ip,user_agent) VALUES ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8,$9)`,
    [event.organisationId, randomUUID(), event.now.toISOString(), event.outcome, event.portalUserId ?? null, event.clientId ?? null,
      event.portalUserId ? null : event.email ? loginEmailHash(event.email) : null, event.network?.ip?.slice(0, 64) ?? null, event.network?.userAgent?.slice(0, 300) ?? null]);
}

/**
 * An attempt that the login query did not match to a signable-in user — recorded with the reason it did not, for staff: an unknown
 * address, a disabled user, or a client switched off or past its expiry. The caller answers all of these identically.
 */
export async function recordUnmatchedLogin(db: Queryable, input: { organisationId: string; email: string; now: Date; network?: LoginNetwork }): Promise<void> {
  const found = (await db.query<{ portal_user_id: string; client_id: string; status: string; credential_enabled: boolean | null; client_enabled: boolean | null; client_expires_at: Date | string | null }>(
    `SELECT u.portal_user_id,u.client_id,u.status,c.enabled AS credential_enabled,a.enabled AS client_enabled,a.expires_at AS client_expires_at
       FROM nzi_console.portal_users u
       LEFT JOIN nzi_console.portal_credentials c ON (c.organisation_id,c.portal_user_id)=(u.organisation_id,u.portal_user_id)
       LEFT JOIN nzi_console.client_portal_access a ON (a.organisation_id,a.client_id)=(u.organisation_id,u.client_id)
      WHERE u.organisation_id=$1 AND u.email_normalized=$2`, [input.organisationId, input.email.trim().toLowerCase()])).rows[0];
  const outcome: PortalLoginOutcome = !found ? "unknown_user"
    : found.client_enabled === false ? "client_disabled"
    : found.client_expires_at && new Date(found.client_expires_at) <= input.now ? "client_expired"
    : "user_disabled";
  await recordPortalLoginEvent(db, { ...input, outcome, portalUserId: found?.portal_user_id ?? null, clientId: found?.client_id ?? null });
}

/** Null the IP and user-agent of events older than the retention. Idempotent; returns how many rows it changed. */
export async function purgePortalLoginNetworkData(pool: PoolLike, organisationId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PORTAL_LOGIN_NETWORK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return withTenantTransaction(pool, organisationId, "nzi_console_worker", "write", async (db) =>
    Number((await db.query<{ purged: number }>(`SELECT nzi_console.purge_portal_login_event_network_data($1,$2::timestamptz) AS purged`, [organisationId, cutoff.toISOString()])).rows[0]!.purged));
}

export type LoginEventRetentionRun = { organisationId: string; cutoff: string } & ({ ok: true; purged: number } | { ok: false; error: string });

/**
 * The worker's daily retention tick: for each organisation the worker serves, null the IP and user-agent of login events older than the
 * 90-day cutoff (`purgePortalLoginNetworkData`). Nothing else on an event changes - outcome, time, user and the address hash stay.
 * One organisation failing is reported against it and never stops the others; a same-day re-run changes nothing (the function only
 * touches rows that still hold network data). The result carries counts and ids, never an address or user-agent.
 */
export async function runLoginEventRetention(pool: PoolLike, organisationIds: readonly string[], now = new Date()): Promise<LoginEventRetentionRun[]> {
  const cutoff = new Date(now.getTime() - PORTAL_LOGIN_NETWORK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const runs: LoginEventRetentionRun[] = [];
  for (const organisationId of new Set(organisationIds)) {
    try { runs.push({ organisationId, cutoff, ok: true, purged: await purgePortalLoginNetworkData(pool, organisationId, now) }); }
    catch (error) { runs.push({ organisationId, cutoff, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return runs;
}
