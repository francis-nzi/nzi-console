import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolLike, Queryable } from "./postgres";
import { withAuthTransaction, withTenantWrite } from "./postgres";
import { decryptTotpSecret, encryptTotpSecret, generateTotpSecret, hashPassword, verifyTotp } from "./credentials";

/**
 * Staff self-enrolment (0129): an operator issues a single-use invitation for a member of an organisation; the person
 * sets their own password and enrols their own authenticator; the credential is written only when they confirm a code.
 *
 * The properties that make it safe for a real person, each held by more than one thing:
 *
 * - **The operator never holds either factor.** The password is typed by the person and stored hashed; the TOTP secret
 *   is generated on the server and shown only to the browser that set the password. The operator's role cannot read
 *   the pending columns at all (column grants, 0129).
 * - **The token is a bearer credential for one enrolment, and nothing is stored that could replay it**: only its
 *   SHA-256. It expires, it is single-use, and issuing another revokes it.
 * - **Nothing can sign in until the authenticator is proved.** Setup holds the password hash and encrypted secret on
 *   the invitation; only a correct code writes `staff_credentials`. Five wrong codes revoke the invitation.
 * - **It cannot take over a working account.** A person with an enabled credential is refused; recovery is its own act.
 * - **Every step is audited**, atomically with the step.
 */

export const ENROLMENT_TTL_HOURS = 72;
export const MAX_CODE_ATTEMPTS = 5;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;

export class StaffEnrolmentError extends Error {
  constructor(message = "This enrolment link is invalid or has expired.") { super(message); this.name = "StaffEnrolmentError"; }
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

type AuditInput = { organisationId: string; actorId: string; principalType: "staff" | "system"; action: string; invitationId: string; after: Record<string, unknown> };
const audit = (db: Queryable, input: AuditInput) => db.query(
  `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,after_json)
   VALUES ($1,$2,$3,$4,$5,'staff_enrolment_invitation',$6,$2,$7::jsonb)`,
  [input.organisationId, `audit-${randomUUID()}`, input.actorId, input.principalType, input.action, input.invitationId, JSON.stringify(input.after)]);

// ── The operator's side: issue and revoke ──────────────────────────────────────────────────────────────────

/**
 * Issue an invitation for an existing, active member with a work address. Any open invitation for them is revoked in
 * the same transaction. Returns the token once — it is stored nowhere — for the operator to pass to the person.
 */
export async function issueStaffEnrolmentInvitation(
  pool: PoolLike,
  input: {
    organisationId: string; userId: string; actorId: string; ttlHours?: number;
    /** Who issued it: an operator in the Render Shell (`system`), or a signed-in admin (`staff`, via inviteStaffMember). */
    principalType?: "staff" | "system";
    /** How the link reaches the person — recorded on the issue event. */
    delivery?: "operator-link" | "admin-link" | "email";
  },
  now = new Date(),
): Promise<{ invitationId: string; token: string; expiresAt: string }> {
  const principalType = input.principalType ?? "system", delivery = input.delivery ?? "operator-link";
  const userId = input.userId.trim(), actorId = input.actorId.trim();
  const ttlHours = input.ttlHours ?? ENROLMENT_TTL_HOURS;
  if (!userId || !actorId) throw new StaffEnrolmentError("A member and the issuing operator are required.");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 7 * 24) throw new StaffEnrolmentError("An invitation lasts between a moment and seven days.");
  return withTenantWrite(pool, input.organisationId, async (db) => {
    const member = await db.query<{ status: string; email: string | null }>(
      `SELECT status, email FROM nzi_console.memberships WHERE user_id = $1 FOR UPDATE`, [userId]);
    const row = member.rows[0];
    if (!row) throw new StaffEnrolmentError(`${userId} is not a member of ${input.organisationId}.`);
    if (row.status !== "active") throw new StaffEnrolmentError(`${userId}'s membership is ${row.status}, not active.`);
    if (!row.email?.trim()) throw new StaffEnrolmentError(`${userId} has no work address to sign in with.`);

    const revoked = await db.query<{ invitation_id: string }>(
      `UPDATE nzi_console.staff_enrolment_invitations
          SET revoked_at = $2, pending_password_salt = NULL, pending_password_hash = NULL,
              pending_totp_ciphertext = NULL, pending_totp_iv = NULL, pending_totp_tag = NULL
        WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING invitation_id`, [userId, now.toISOString()]);
    for (const previous of revoked.rows) {
      await audit(db, { organisationId: input.organisationId, actorId, principalType, action: "staff.enrolment.revoke",
        invitationId: previous.invitation_id, after: { userId, reason: "superseded by a new invitation" } });
    }

    const invitationId = randomUUID(), token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO nzi_console.staff_enrolment_invitations (organisation_id,invitation_id,user_id,token_hash,expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`, [input.organisationId, invitationId, userId, tokenHash(token), expiresAt, actorId]);
    await audit(db, { organisationId: input.organisationId, actorId, principalType, action: "staff.enrolment.issue",
      invitationId, after: { userId, expiresAt, delivery } });
    return { invitationId, token, expiresAt };
  });
}

/** Revoke a member's open invitation, clearing anything it held. Returns whether there was one. */
export async function revokeStaffEnrolmentInvitation(
  pool: PoolLike, input: { organisationId: string; userId: string; actorId: string }, now = new Date(),
): Promise<boolean> {
  return withTenantWrite(pool, input.organisationId, async (db) => {
    const revoked = await db.query<{ invitation_id: string }>(
      `UPDATE nzi_console.staff_enrolment_invitations
          SET revoked_at = $2, pending_password_salt = NULL, pending_password_hash = NULL,
              pending_totp_ciphertext = NULL, pending_totp_iv = NULL, pending_totp_tag = NULL
        WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING invitation_id`, [input.userId.trim(), now.toISOString()]);
    for (const row of revoked.rows) {
      await audit(db, { organisationId: input.organisationId, actorId: input.actorId.trim(), principalType: "system",
        action: "staff.enrolment.revoke", invitationId: row.invitation_id, after: { userId: input.userId.trim(), reason: "revoked by operator" } });
    }
    return revoked.rows.length > 0;
  });
}

// ── The person's side: set up, then confirm ────────────────────────────────────────────────────────────────

type OpenInvitation = {
  organisation_id: string; invitation_id: string; user_id: string; expires_at: Date | string; consumed_at: Date | string | null;
  revoked_at: Date | string | null; setup_started_at: Date | string | null; failed_code_attempts: number;
  pending_password_salt: string | null; pending_password_hash: string | null;
  pending_totp_ciphertext: string | null; pending_totp_iv: string | null; pending_totp_tag: string | null;
};

async function openInvitation(db: Queryable, token: string, now: Date): Promise<OpenInvitation> {
  if (!token.trim()) throw new StaffEnrolmentError();
  const found = await db.query<OpenInvitation>(
    `SELECT * FROM nzi_console.staff_enrolment_invitations WHERE token_hash = $1 FOR UPDATE`, [tokenHash(token)]);
  const row = found.rows[0];
  if (!row || row.consumed_at || row.revoked_at || new Date(row.expires_at) <= now) throw new StaffEnrolmentError();
  return row;
}

async function hasWorkingSignIn(db: Queryable, organisationId: string, userId: string): Promise<boolean> {
  const found = await db.query(`SELECT 1 FROM nzi_console.staff_credentials WHERE organisation_id=$1 AND user_id=$2 AND enabled`, [organisationId, userId]);
  return found.rows.length > 0;
}

const ALREADY_ENROLLED = "This account already has working sign-in. Ask an administrator for account recovery instead.";

/**
 * Step 1: the person's own password. Generates their authenticator secret and returns it to their browser — the only
 * place it is ever shown. Repeating this step starts it again with a new secret; failed codes are not forgiven.
 */
export async function startStaffEnrolment(
  pool: PoolLike, input: { token: string; password: string }, encryptionKey: string, now = new Date(),
): Promise<{ email: string; displayName: string | null; totpSecret: string; otpauthUri: string }> {
  if (input.password.length < MIN_PASSWORD) throw new StaffEnrolmentError(`Password must contain at least ${MIN_PASSWORD} characters.`);
  if (input.password.length > MAX_PASSWORD) throw new StaffEnrolmentError(`Password must contain at most ${MAX_PASSWORD} characters.`);
  const password = await hashPassword(input.password);
  const secret = generateTotpSecret();
  const totp = encryptTotpSecret(secret, encryptionKey);
  return withAuthTransaction(pool, "write", async (db) => {
    const invitation = await openInvitation(db, input.token, now);
    const member = await db.query<{ email: string | null; display_name: string | null; status: string }>(
      `SELECT email, display_name, status FROM nzi_console.memberships WHERE organisation_id=$1 AND user_id=$2`,
      [invitation.organisation_id, invitation.user_id]);
    const email = member.rows[0]?.email?.trim().toLowerCase();
    if (!email || member.rows[0]!.status !== "active") throw new StaffEnrolmentError();
    if (await hasWorkingSignIn(db, invitation.organisation_id, invitation.user_id)) throw new StaffEnrolmentError(ALREADY_ENROLLED);
    await db.query(
      `UPDATE nzi_console.staff_enrolment_invitations
          SET pending_password_salt=$3, pending_password_hash=$4, pending_totp_ciphertext=$5, pending_totp_iv=$6, pending_totp_tag=$7,
              setup_started_at=$8
        WHERE organisation_id=$1 AND invitation_id=$2`,
      [invitation.organisation_id, invitation.invitation_id, password.salt, password.hash, totp.ciphertext, totp.iv, totp.tag, now.toISOString()]);
    await audit(db, { organisationId: invitation.organisation_id, actorId: invitation.user_id, principalType: "staff",
      action: "staff.enrolment.setup", invitationId: invitation.invitation_id, after: { restarted: invitation.setup_started_at !== null } });
    const label = encodeURIComponent(`NZ Insights Pro:${email}`);
    return { email, displayName: member.rows[0]!.display_name, totpSecret: secret,
      otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("NZ Insights Pro")}&algorithm=SHA1&digits=6&period=30` };
  });
}

/**
 * Step 2: a code from the authenticator. Only now is the credential written — enabled, at the member's work address —
 * and the invitation consumed, its secrets moved rather than kept. A wrong code is counted and audited, and the count
 * is committed even though the call fails; the fifth revokes the invitation.
 */
export async function completeStaffEnrolment(
  pool: PoolLike, input: { token: string; code: string }, encryptionKey: string, now = new Date(),
): Promise<{ enrolled: true }> {
  const outcome = await withAuthTransaction(pool, "write", async (db) => {
    const invitation = await openInvitation(db, input.token, now);
    if (!invitation.setup_started_at || !invitation.pending_totp_ciphertext) throw new StaffEnrolmentError();
    const secret = decryptTotpSecret({ ciphertext: invitation.pending_totp_ciphertext, iv: invitation.pending_totp_iv!, tag: invitation.pending_totp_tag! }, encryptionKey);
    const base = { organisationId: invitation.organisation_id, actorId: invitation.user_id, principalType: "staff" as const, invitationId: invitation.invitation_id };

    if (!verifyTotp(input.code.trim(), secret, now.getTime())) {
      const attempts = invitation.failed_code_attempts + 1;
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await db.query(
          `UPDATE nzi_console.staff_enrolment_invitations
              SET failed_code_attempts=$3, revoked_at=$4, pending_password_salt=NULL, pending_password_hash=NULL,
                  pending_totp_ciphertext=NULL, pending_totp_iv=NULL, pending_totp_tag=NULL
            WHERE organisation_id=$1 AND invitation_id=$2`, [invitation.organisation_id, invitation.invitation_id, attempts, now.toISOString()]);
        await audit(db, { ...base, action: "staff.enrolment.locked", after: { failedCodeAttempts: attempts } });
        return "locked" as const;
      }
      await db.query(`UPDATE nzi_console.staff_enrolment_invitations SET failed_code_attempts=$3 WHERE organisation_id=$1 AND invitation_id=$2`,
        [invitation.organisation_id, invitation.invitation_id, attempts]);
      await audit(db, { ...base, action: "staff.enrolment.code_rejected", after: { failedCodeAttempts: attempts } });
      return "rejected" as const;
    }

    if (await hasWorkingSignIn(db, invitation.organisation_id, invitation.user_id)) throw new StaffEnrolmentError(ALREADY_ENROLLED);
    const member = await db.query<{ email: string | null; status: string }>(
      `SELECT email, status FROM nzi_console.memberships WHERE organisation_id=$1 AND user_id=$2`, [invitation.organisation_id, invitation.user_id]);
    const email = member.rows[0]?.email?.trim().toLowerCase();
    if (!email || member.rows[0]!.status !== "active") throw new StaffEnrolmentError();

    // A disabled credential (a suspended sign-in) is replaced; an enabled one was refused above and cannot be reached.
    const written = await db.query(
      `INSERT INTO nzi_console.staff_credentials
         (organisation_id,user_id,email_normalized,password_salt,password_hash,totp_ciphertext,totp_iv,totp_tag,enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (organisation_id,user_id) DO UPDATE SET email_normalized=EXCLUDED.email_normalized,
         password_salt=EXCLUDED.password_salt, password_hash=EXCLUDED.password_hash, totp_ciphertext=EXCLUDED.totp_ciphertext,
         totp_iv=EXCLUDED.totp_iv, totp_tag=EXCLUDED.totp_tag, enabled=true, failed_attempts=0, locked_until=NULL,
         password_changed_at=now()
       WHERE NOT nzi_console.staff_credentials.enabled
       RETURNING user_id`,
      [invitation.organisation_id, invitation.user_id, email, invitation.pending_password_salt, invitation.pending_password_hash,
        invitation.pending_totp_ciphertext, invitation.pending_totp_iv, invitation.pending_totp_tag]);
    if (written.rows.length !== 1) throw new StaffEnrolmentError(ALREADY_ENROLLED);
    await db.query(
      `UPDATE nzi_console.staff_enrolment_invitations
          SET consumed_at=$3, pending_password_salt=NULL, pending_password_hash=NULL,
              pending_totp_ciphertext=NULL, pending_totp_iv=NULL, pending_totp_tag=NULL
        WHERE organisation_id=$1 AND invitation_id=$2`, [invitation.organisation_id, invitation.invitation_id, now.toISOString()]);
    await audit(db, { ...base, action: "staff.enrolment.complete", after: { failedCodeAttempts: invitation.failed_code_attempts } });
    return "enrolled" as const;
  });
  if (outcome === "locked") throw new StaffEnrolmentError("Too many incorrect codes. This link no longer works; ask an administrator for a new one.");
  if (outcome === "rejected") throw new StaffEnrolmentError("The authenticator code is incorrect.");
  return { enrolled: true };
}
