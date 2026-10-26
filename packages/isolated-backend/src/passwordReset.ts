import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolLike, Queryable } from "./postgres";
import { withAuthTransaction, withTenantWrite } from "./postgres";
import { hashPassword } from "./credentials";
import { sendTemplatedEmail } from "./templatedEmail";

/**
 * Password reset by email, for staff and portal sign-in (email programme phase 4-1; 0181).
 *
 * **Request.** Someone types an address. If it is an enabled sign-in on an active account, a single-use link (an hour,
 * stored only as its sha256) is issued, any earlier one revoked, and the `password.reset.staff` / `.portal` template is
 * queued through `sendTemplatedEmail`. **The caller learns nothing either way**: `requestPasswordReset` returns nothing, and
 * the routes answer every request alike, after a common floor, so neither the answer nor its timing says whether the address
 * has an account (R3). An account may be sent three links an hour; a fourth request is recorded and sends nothing.
 *
 * **Complete.** The link's token and a new password. The password is set, the failed-attempt count and any lockout cleared,
 * the link consumed and any other open one revoked — and **every session and every half-finished sign-in for the account
 * is ended**, so a reset also evicts whoever may have been using the old password. **MFA is unchanged**: a reset proves the
 * inbox, not the authenticator, so signing in still needs both (R3).
 *
 * Neither the token, the password nor the address is ever written to the audit log — only the account's id, what happened
 * and when (R6).
 */

export const RESET_TTL_MINUTES = 60;
export const MAX_RESET_REQUESTS_PER_HOUR = 3;
export const MIN_RESET_PASSWORD = 12;
export const MAX_RESET_PASSWORD = 256;

export type ResetPrincipal = "staff" | "portal";

export class PasswordResetError extends Error {
  constructor(message = "This reset link is invalid or has expired. Request a new one.") { super(message); this.name = "PasswordResetError"; }
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Where each sign-in's link points: the reset page for that sign-in, the token in the fragment so it never reaches a log. */
export const resetLink = (origin: string, principal: ResetPrincipal, token: string) =>
  `${origin.replace(/\/$/, "")}${principal === "staff" ? "/reset-password" : "/portal/reset-password"}#token=${token}`;

const expiryForPeople = (iso: string) => new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
}).format(new Date(iso)) + " (UK time)";

type Account = { subjectId: string; email: string; displayName: string | null };

/** The account behind an address — only an enabled sign-in on an active account counts. */
async function accountFor(db: Queryable, organisationId: string, principal: ResetPrincipal, email: string): Promise<Account | null> {
  const found = principal === "staff"
    ? await db.query<{ subject_id: string; email: string; display_name: string | null }>(
      `SELECT c.user_id AS subject_id, c.email_normalized AS email, m.display_name
         FROM nzi_console.staff_credentials c
         JOIN nzi_console.memberships m ON (m.organisation_id, m.user_id) = (c.organisation_id, c.user_id)
        WHERE c.organisation_id = $1 AND c.email_normalized = $2 AND c.enabled AND m.status = 'active'`, [organisationId, email])
    : await db.query<{ subject_id: string; email: string; display_name: string | null }>(
      `SELECT c.portal_user_id AS subject_id, u.email_normalized AS email, u.display_name
         FROM nzi_console.portal_credentials c
         JOIN nzi_console.portal_users u ON (u.organisation_id, u.portal_user_id) = (c.organisation_id, c.portal_user_id)
        WHERE c.organisation_id = $1 AND u.email_normalized = $2 AND c.enabled AND u.status = 'active'`, [organisationId, email]);
  const row = found.rows[0];
  return row ? { subjectId: row.subject_id, email: row.email, displayName: row.display_name?.trim() || null } : null;
}

const audit = (db: Queryable, input: { organisationId: string; actorId: string; principalType: "staff" | "portal" | "system"; action: string; principal: ResetPrincipal; subjectId: string; correlationId: string; after: Record<string, unknown> }) =>
  db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [input.organisationId, `audit-${randomUUID()}`, input.actorId, input.principalType, input.action,
      input.principal === "staff" ? "staff_credential" : "portal_credential", input.subjectId, input.correlationId,
      JSON.stringify({ principal: input.principal, ...input.after })]);

/**
 * Ask for a reset link. Resolves the same way whether or not the address has an account — callers must not branch on it,
 * and get nothing to branch on. A failure to queue the email withdraws the link it would have carried.
 */
export async function requestPasswordReset(
  pool: PoolLike, input: { organisationId: string; principal: ResetPrincipal; email: string; origin: string }, now = new Date(),
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!email || email.length > 254 || !input.organisationId.trim()) return;
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new PasswordResetError("The console's own address is not configured."); }

  const issued = await withAuthTransaction(pool, "write", async (db) => {
    const account = await accountFor(db, input.organisationId, input.principal, email);
    if (!account) return null;
    const recent = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.password_reset_tokens
        WHERE organisation_id = $1 AND principal = $2 AND subject_id = $3 AND created_at > $4::timestamptz - interval '1 hour'`,
      [input.organisationId, input.principal, account.subjectId, now.toISOString()]);
    const resetId = randomUUID();
    const base = { organisationId: input.organisationId, actorId: "password-reset", principalType: "system" as const, principal: input.principal, subjectId: account.subjectId, correlationId: resetId };
    if (recent.rows[0]!.n >= MAX_RESET_REQUESTS_PER_HOUR) {
      await audit(db, { ...base, action: "password.reset.throttled", after: { recentRequests: recent.rows[0]!.n } });
      return null;
    }
    await db.query(
      `UPDATE nzi_console.password_reset_tokens SET revoked_at = $4
        WHERE organisation_id = $1 AND principal = $2 AND subject_id = $3 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [input.organisationId, input.principal, account.subjectId, now.toISOString()]);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + RESET_TTL_MINUTES * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO nzi_console.password_reset_tokens (organisation_id, reset_id, principal, subject_id, token_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.organisationId, resetId, input.principal, account.subjectId, tokenHash(token), now.toISOString(), expiresAt]);
    await audit(db, { ...base, action: "password.reset.requested", after: { expiresAt } });
    return { account, resetId, token, expiresAt };
  });
  if (!issued) return;

  try {
    // The email is the console role's to queue (it renders the organisation's wording and footer); the token is the
    // authentication role's to hold. Two transactions, so a send that fails withdraws the link below.
    await withTenantWrite(pool, input.organisationId, (db) => sendTemplatedEmail(db, input.organisationId, {
      templateCode: input.principal === "staff" ? "password.reset.staff" : "password.reset.portal",
      to: issued.account.email,
      vars: { displayName: issued.account.displayName ?? "there", resetLink: resetLink(origin.origin, input.principal, issued.token), expiresAt: expiryForPeople(issued.expiresAt) },
      correlationId: issued.resetId, idempotencyKey: `password.reset:${issued.resetId}`,
    }));
  } catch {
    await withAuthTransaction(pool, "write", (db) => db.query(
      `UPDATE nzi_console.password_reset_tokens SET revoked_at = $3 WHERE organisation_id = $1 AND reset_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [input.organisationId, issued.resetId, now.toISOString()]));
    // Still nothing to the caller: a failed send must not answer differently from an unknown address.
  }
}

/**
 * Set a new password from a reset link. Throws {@link PasswordResetError} — one message for every kind of invalid link — or
 * one naming the password rule; otherwise the password is set and every session for the account has ended.
 */
export async function completePasswordReset(
  pool: PoolLike, input: { organisationId: string; principal: ResetPrincipal; token: string; password: string }, now = new Date(),
): Promise<{ sessionsEnded: number }> {
  if (input.password.length < MIN_RESET_PASSWORD) throw new PasswordResetError(`Password must contain at least ${MIN_RESET_PASSWORD} characters.`);
  if (input.password.length > MAX_RESET_PASSWORD) throw new PasswordResetError(`Password must contain at most ${MAX_RESET_PASSWORD} characters.`);
  if (!input.token.trim()) throw new PasswordResetError();
  const next = await hashPassword(input.password);
  return withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<{ organisation_id: string; reset_id: string; subject_id: string; expires_at: Date | string; consumed_at: unknown; revoked_at: unknown }>(
      `SELECT organisation_id, reset_id, subject_id, expires_at, consumed_at, revoked_at FROM nzi_console.password_reset_tokens
        WHERE token_hash = $1 AND principal = $2 FOR UPDATE`, [tokenHash(input.token), input.principal]);
    const reset = found.rows[0];
    if (!reset || reset.organisation_id !== input.organisationId || reset.consumed_at || reset.revoked_at || new Date(reset.expires_at) <= now) throw new PasswordResetError();
    const org = reset.organisation_id, subject = reset.subject_id, at = now.toISOString();

    // Still an enabled sign-in on an active account — a link issued before a suspension does not outlive it.
    const credential = input.principal === "staff"
      ? await db.query(`UPDATE nzi_console.staff_credentials c SET password_salt = $3, password_hash = $4, password_changed_at = $5, failed_attempts = 0, locked_until = NULL
           FROM nzi_console.memberships m
          WHERE c.organisation_id = $1 AND c.user_id = $2 AND c.enabled AND (m.organisation_id, m.user_id) = (c.organisation_id, c.user_id) AND m.status = 'active'
          RETURNING c.user_id`, [org, subject, next.salt, next.hash, at])
      : await db.query(`UPDATE nzi_console.portal_credentials c SET password_salt = $3, password_hash = $4, password_changed_at = $5, failed_attempts = 0, locked_until = NULL
           FROM nzi_console.portal_users u
          WHERE c.organisation_id = $1 AND c.portal_user_id = $2 AND c.enabled AND (u.organisation_id, u.portal_user_id) = (c.organisation_id, c.portal_user_id) AND u.status = 'active'
          RETURNING c.portal_user_id`, [org, subject, next.salt, next.hash, at]);
    if (credential.rows.length !== 1) throw new PasswordResetError();

    await db.query(`UPDATE nzi_console.password_reset_tokens SET consumed_at = $3 WHERE organisation_id = $1 AND reset_id = $2`, [org, reset.reset_id, at]);
    await db.query(
      `UPDATE nzi_console.password_reset_tokens SET revoked_at = $5
        WHERE organisation_id = $1 AND principal = $2 AND subject_id = $3 AND reset_id <> $4 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [org, input.principal, subject, reset.reset_id, at]);
    // Every session, and every sign-in waiting on its MFA code, ends: whoever held the old password is out.
    const [sessions, challenges] = input.principal === "staff" ? ["staff_sessions", "staff_login_challenges"] : ["portal_sessions", "portal_login_challenges"];
    const subjectColumn = input.principal === "staff" ? "user_id" : "portal_user_id";
    const ended = await db.query(
      `UPDATE nzi_console.${sessions} SET revoked_at = $3 WHERE organisation_id = $1 AND ${subjectColumn} = $2 AND revoked_at IS NULL RETURNING session_id`, [org, subject, at]);
    await db.query(
      `UPDATE nzi_console.${challenges} SET consumed_at = $3 WHERE organisation_id = $1 AND ${subjectColumn} = $2 AND consumed_at IS NULL`, [org, subject, at]);
    await audit(db, { organisationId: org, actorId: subject, principalType: input.principal, action: "password.reset.completed",
      principal: input.principal, subjectId: subject, correlationId: reset.reset_id, after: { sessionsEnded: ended.rows.length } });
    return { sessionsEnded: ended.rows.length };
  });
}
