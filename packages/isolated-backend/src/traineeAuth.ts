import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AuthenticationError } from "./auth";
import { InvalidLoginError, LoginLockedError } from "./login";
import { decryptTotpSecret, encryptTotpSecret, generateTotpSecret, hashPassword, verifyPassword, verifyTotp } from "./credentials";
import { withAuthTransaction, type PoolLike } from "./postgres";

/**
 * The trainee identity realm — the third alongside staff and the client portal.
 *
 * It mirrors the portal's construction deliberately: the same signed-session shape, the
 * same idle window, the same lockout, the same rule that NZI never enters a person's
 * password (they set it from an invitation and enrol their own MFA), and the same
 * separation where only the auth role can read a credential or write a session.
 *
 * One structural difference, and it is the point of the whole design: a trainee is **not
 * scoped to a client**. A portal session carries a clientId and every query re-checks a
 * grant for it; a trainee session carries a traineeId, and what it authorises is "the rows
 * that are about this person" — across every employer they have ever had. The employer
 * attribution lives on each booking and is deliberately *not* used to scope what the
 * person themselves can see.
 */

export type TraineeSession = {
  principal: "trainee";
  sessionId: string;
  traineeId: string;
  organisationId: string;
  issuedAt: number;
  expiresAt: number;
};
export type TraineePrincipal = TraineeSession & {
  fullName: string;
  email: string;
  idleLimitMinutes: number;
};

export const TRAINEE_IDLE_LIMIT_DEFAULT_MINUTES = 30;
const SESSION_HOURS = 8;
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const CHALLENGE_MINUTES = 5;
const INVITATION_HOURS = 72;
const MIN_PASSWORD_LENGTH = 12;
/** Equalises the timing of "no such person" against a real password check. */
const DUMMY_PASSWORD_HASH = "0".repeat(128);

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const sign = (payload: string, secret: string) => createHash("sha256").update(`${payload}.${secret}`).digest("base64url");
const requireSecret = (secret: string | undefined) => {
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) throw new AuthenticationError("Trainee session secret is not configured.");
  return secret;
};
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const normaliseEmail = (email: string) => email.trim().toLowerCase();

export function issueTraineeSession(session: TraineeSession, secret: string): string {
  const payload = encode(JSON.stringify(session));
  return `${payload}.${sign(payload, requireSecret(secret))}`;
}

export function verifyTraineeSession(token: string | undefined, secret: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): TraineeSession {
  if (!token) throw new AuthenticationError("Trainee authentication is required.");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new AuthenticationError("Invalid trainee session.");
  const expected = sign(payload, requireSecret(secret));
  const actualBuffer = Buffer.from(signature), expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new AuthenticationError("Invalid trainee session.");
  let session: TraineeSession;
  try { session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TraineeSession; }
  catch { throw new AuthenticationError("Invalid trainee session."); }
  if (session.principal !== "trainee" || !session.sessionId?.trim() || !session.traineeId?.trim() || !session.organisationId?.trim()
    || !Number.isInteger(session.issuedAt) || !Number.isInteger(session.expiresAt)) throw new AuthenticationError("Invalid trainee session.");
  if (session.issuedAt > nowSeconds + 60 || session.expiresAt <= nowSeconds) throw new AuthenticationError("Trainee session has expired.");
  return session;
}

/**
 * The single request-time resolve every trainee route goes through. An idle session is
 * refused server-side, so a closed laptop self-heals, and activity slides the window
 * (throttled to one write every 30 seconds).
 */
export async function resolveTraineePrincipal(pool: PoolLike, session: TraineeSession, options?: { idleLimitMinutes?: number }): Promise<TraineePrincipal> {
  const idleLimitMinutes = Number.isFinite(options?.idleLimitMinutes) && (options?.idleLimitMinutes ?? 0) > 0
    ? Math.floor(options!.idleLimitMinutes!) : TRAINEE_IDLE_LIMIT_DEFAULT_MINUTES;
  return withAuthTransaction(pool, "write", async (db) => {
    const result = await db.query<{ full_name: string; personal_email: string }>(
      `SELECT t.full_name, t.personal_email
       FROM nzi_console.trainee_sessions s
       JOIN nzi_console.trainees t ON (t.organisation_id, t.trainee_id) = (s.organisation_id, s.trainee_id)
       WHERE s.organisation_id=$1 AND s.session_id=$2 AND s.trainee_id=$3
         AND s.revoked_at IS NULL AND s.expires_at > now()
         AND t.status = 'active'
         AND s.last_seen_at > now() - ($4 || ' minutes')::interval`,
      [session.organisationId, session.sessionId, session.traineeId, String(idleLimitMinutes)]);
    const trainee = result.rows[0];
    if (!trainee) throw new AuthenticationError("No active trainee session exists.");
    await db.query(
      `UPDATE nzi_console.trainee_sessions SET last_seen_at=now()
       WHERE organisation_id=$1 AND session_id=$2 AND last_seen_at < now() - interval '30 seconds'`,
      [session.organisationId, session.sessionId]);
    return { ...session, fullName: trainee.full_name, email: trainee.personal_email, idleLimitMinutes };
  });
}

/* ── Signing in ─────────────────────────────────────────────────────────────────────── */

export type TraineeLoginChallenge = { state: "challenge"; challengeToken: string };

/**
 * Password step. A missing credential still runs a password verification against a dummy
 * hash so the response time does not reveal whether the email is known, and five failures
 * lock the account for fifteen minutes.
 */
export async function startTraineeLogin(pool: PoolLike, input: { organisationId: string; email: string; password: string }, now = new Date()): Promise<TraineeLoginChallenge> {
  const email = normaliseEmail(input.email);
  return withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<{ trainee_id: string; password_salt: string; password_hash: string; enabled: boolean; failed_attempts: number; locked_until: Date | null; status: string }>(
      `SELECT c.trainee_id, c.password_salt, c.password_hash, c.enabled, c.failed_attempts, c.locked_until, t.status
       FROM nzi_console.trainee_credentials c
       JOIN nzi_console.trainees t ON (t.organisation_id, t.trainee_id) = (c.organisation_id, c.trainee_id)
       WHERE c.organisation_id=$1 AND t.personal_email=$2
       FOR UPDATE OF c`,
      [input.organisationId, email]);
    const credential = found.rows[0];
    if (!credential) {
      await verifyPassword(input.password, "0".repeat(32), DUMMY_PASSWORD_HASH);
      throw new InvalidLoginError();
    }
    if (credential.locked_until && credential.locked_until > now) throw new LoginLockedError();
    if (!credential.enabled || credential.status !== "active") throw new InvalidLoginError();

    const ok = await verifyPassword(input.password, credential.password_salt, credential.password_hash);
    if (!ok) {
      const attempts = credential.failed_attempts + 1;
      await db.query(
        `UPDATE nzi_console.trainee_credentials SET failed_attempts=$3, locked_until=$4
         WHERE organisation_id=$1 AND trainee_id=$2`,
        [input.organisationId, credential.trainee_id, attempts,
          attempts >= LOCKOUT_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MINUTES * 60000) : null]);
      throw new InvalidLoginError();
    }

    await db.query(
      `UPDATE nzi_console.trainee_credentials SET failed_attempts=0, locked_until=NULL WHERE organisation_id=$1 AND trainee_id=$2`,
      [input.organisationId, credential.trainee_id]);
    const challengeToken = newToken();
    await db.query(
      `INSERT INTO nzi_console.trainee_login_challenges (organisation_id, challenge_id, trainee_id, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.organisationId, randomUUID(), credential.trainee_id, tokenHash(challengeToken), new Date(now.getTime() + CHALLENGE_MINUTES * 60000)]);
    return { state: "challenge", challengeToken };
  });
}

/** Second factor. Success is the only thing that mints a session. */
export async function completeTraineeMfa(pool: PoolLike, input: { organisationId: string; challengeToken: string; code: string }, encryptionKey: string, now = new Date()): Promise<TraineeSession> {
  return withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<{ challenge_id: string; trainee_id: string; expires_at: Date; consumed_at: Date | null; attempts: number; totp_ciphertext: string | null; totp_iv: string | null; totp_tag: string | null; enabled: boolean }>(
      `SELECT ch.challenge_id, ch.trainee_id, ch.expires_at, ch.consumed_at, ch.attempts,
              c.totp_ciphertext, c.totp_iv, c.totp_tag, c.enabled
       FROM nzi_console.trainee_login_challenges ch
       JOIN nzi_console.trainee_credentials c ON (c.organisation_id, c.trainee_id) = (ch.organisation_id, ch.trainee_id)
       WHERE ch.organisation_id=$1 AND ch.token_hash=$2
       FOR UPDATE OF ch`,
      [input.organisationId, tokenHash(input.challengeToken)]);
    const challenge = found.rows[0];
    if (!challenge || challenge.consumed_at || challenge.expires_at <= now || challenge.attempts >= LOCKOUT_ATTEMPTS || !challenge.enabled) throw new InvalidLoginError();
    if (!challenge.totp_ciphertext || !challenge.totp_iv || !challenge.totp_tag) throw new InvalidLoginError();

    const secret = decryptTotpSecret({ ciphertext: challenge.totp_ciphertext, iv: challenge.totp_iv, tag: challenge.totp_tag }, encryptionKey);
    if (!verifyTotp(input.code, secret, now.getTime())) {
      await db.query(`UPDATE nzi_console.trainee_login_challenges SET attempts=attempts+1 WHERE organisation_id=$1 AND challenge_id=$2`,
        [input.organisationId, challenge.challenge_id]);
      throw new InvalidLoginError();
    }

    await db.query(`UPDATE nzi_console.trainee_login_challenges SET consumed_at=now() WHERE organisation_id=$1 AND challenge_id=$2`,
      [input.organisationId, challenge.challenge_id]);
    await db.query(`UPDATE nzi_console.trainee_credentials SET last_login_at=now() WHERE organisation_id=$1 AND trainee_id=$2`,
      [input.organisationId, challenge.trainee_id]);

    const sessionId = randomUUID();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + SESSION_HOURS * 3600;
    await db.query(
      `INSERT INTO nzi_console.trainee_sessions (organisation_id, session_id, trainee_id, expires_at, last_seen_at)
       VALUES ($1,$2,$3,$4,now())`,
      [input.organisationId, sessionId, challenge.trainee_id, new Date(expiresAt * 1000)]);
    return { principal: "trainee", sessionId, traineeId: challenge.trainee_id, organisationId: input.organisationId, issuedAt, expiresAt };
  });
}

export async function revokeTraineeSession(pool: PoolLike, session: TraineeSession, now = new Date()): Promise<void> {
  await withAuthTransaction(pool, "write", async (db) => {
    await db.query(
      `UPDATE nzi_console.trainee_sessions SET revoked_at=$4
       WHERE organisation_id=$1 AND session_id=$2 AND trainee_id=$3 AND revoked_at IS NULL`,
      [session.organisationId, session.sessionId, session.traineeId, now]);
  });
}

/* ── Enrolment: the person sets their own password and enrols their own MFA ──────────── */

export class TraineeInvitationError extends Error {
  constructor(message: string) { super(message); this.name = "TraineeInvitationError"; }
}

/** Issued by staff; the raw token is returned once and only its hash is stored. */
export async function createTraineeInvitation(pool: PoolLike, input: { organisationId: string; traineeId: string; createdBy: string }, now = new Date()): Promise<{ token: string; expiresAt: string }> {
  return withAuthTransaction(pool, "write", async (db) => {
    const trainee = await db.query<{ status: string }>(
      `SELECT status FROM nzi_console.trainees WHERE organisation_id=$1 AND trainee_id=$2`, [input.organisationId, input.traineeId]);
    if (!trainee.rows[0]) throw new TraineeInvitationError("That trainee does not exist.");
    // A new invitation closes any still open, so only one link is ever live.
    await db.query(
      `UPDATE nzi_console.trainee_invitations SET consumed_at=now()
       WHERE organisation_id=$1 AND trainee_id=$2 AND consumed_at IS NULL`,
      [input.organisationId, input.traineeId]);
    const token = newToken();
    const expiresAt = new Date(now.getTime() + INVITATION_HOURS * 3600000);
    await db.query(
      `INSERT INTO nzi_console.trainee_invitations (organisation_id, invitation_id, trainee_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.organisationId, randomUUID(), input.traineeId, tokenHash(token), expiresAt, input.createdBy]);
    return { token, expiresAt: expiresAt.toISOString() };
  });
}

/** Step one of enrolment: the person chooses a password and is handed a TOTP secret. */
export async function startTraineeInvitationSetup(pool: PoolLike, input: { organisationId: string; token: string; password: string }, encryptionKey: string, now = new Date()): Promise<{ traineeId: string; fullName: string; email: string; totpSecret: string }> {
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new TraineeInvitationError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  return withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<{ invitation_id: string; trainee_id: string; full_name: string; personal_email: string; expires_at: Date; consumed_at: Date | null }>(
      `SELECT i.invitation_id, i.trainee_id, t.full_name, t.personal_email, i.expires_at, i.consumed_at
       FROM nzi_console.trainee_invitations i
       JOIN nzi_console.trainees t ON (t.organisation_id, t.trainee_id) = (i.organisation_id, i.trainee_id)
       WHERE i.organisation_id=$1 AND i.token_hash=$2
       FOR UPDATE OF i`,
      [input.organisationId, tokenHash(input.token)]);
    const invitation = found.rows[0];
    if (!invitation || invitation.consumed_at || invitation.expires_at <= now) throw new TraineeInvitationError("This invitation is no longer valid. Ask NZI for a new one.");

    const { salt, hash } = await hashPassword(input.password);
    const totpSecret = generateTotpSecret();
    const encrypted = encryptTotpSecret(totpSecret, encryptionKey);
    // The credential stays disabled until the second factor is proved.
    await db.query(
      `INSERT INTO nzi_console.trainee_credentials (organisation_id, trainee_id, password_salt, password_hash, totp_ciphertext, totp_iv, totp_tag, enabled, password_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,now())
       ON CONFLICT (organisation_id, trainee_id) DO UPDATE
       SET password_salt=$3, password_hash=$4, totp_ciphertext=$5, totp_iv=$6, totp_tag=$7, enabled=false,
           failed_attempts=0, locked_until=NULL, password_changed_at=now()`,
      [input.organisationId, invitation.trainee_id, salt, hash, encrypted.ciphertext, encrypted.iv, encrypted.tag]);
    await db.query(`UPDATE nzi_console.trainee_invitations SET setup_started_at=now() WHERE organisation_id=$1 AND invitation_id=$2`,
      [input.organisationId, invitation.invitation_id]);
    return { traineeId: invitation.trainee_id, fullName: invitation.full_name, email: invitation.personal_email, totpSecret };
  });
}

/** Step two: the code proves the authenticator, and only then can the person sign in. */
export async function completeTraineeInvitationSetup(pool: PoolLike, input: { organisationId: string; token: string; code: string }, encryptionKey: string, now = new Date()): Promise<{ traineeId: string }> {
  return withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<{ invitation_id: string; trainee_id: string; expires_at: Date; consumed_at: Date | null; totp_ciphertext: string | null; totp_iv: string | null; totp_tag: string | null }>(
      `SELECT i.invitation_id, i.trainee_id, i.expires_at, i.consumed_at, c.totp_ciphertext, c.totp_iv, c.totp_tag
       FROM nzi_console.trainee_invitations i
       LEFT JOIN nzi_console.trainee_credentials c ON (c.organisation_id, c.trainee_id) = (i.organisation_id, i.trainee_id)
       WHERE i.organisation_id=$1 AND i.token_hash=$2
       FOR UPDATE OF i`,
      [input.organisationId, tokenHash(input.token)]);
    const invitation = found.rows[0];
    if (!invitation || invitation.consumed_at || invitation.expires_at <= now) throw new TraineeInvitationError("This invitation is no longer valid. Ask NZI for a new one.");
    if (!invitation.totp_ciphertext || !invitation.totp_iv || !invitation.totp_tag) throw new TraineeInvitationError("Set a password before confirming your authenticator.");

    const secret = decryptTotpSecret({ ciphertext: invitation.totp_ciphertext, iv: invitation.totp_iv, tag: invitation.totp_tag }, encryptionKey);
    if (!verifyTotp(input.code, secret, now.getTime())) throw new TraineeInvitationError("That code did not match. Try the next one your authenticator shows.");

    await db.query(`UPDATE nzi_console.trainee_credentials SET enabled=true WHERE organisation_id=$1 AND trainee_id=$2`,
      [input.organisationId, invitation.trainee_id]);
    await db.query(`UPDATE nzi_console.trainees SET status='active', updated_at=now(), updated_by='trainee:self' WHERE organisation_id=$1 AND trainee_id=$2 AND status <> 'deactivated'`,
      [input.organisationId, invitation.trainee_id]);
    await db.query(`UPDATE nzi_console.trainee_invitations SET consumed_at=now() WHERE organisation_id=$1 AND invitation_id=$2`,
      [input.organisationId, invitation.invitation_id]);
    return { traineeId: invitation.trainee_id };
  });
}

/* ── Changing the login email (the "on leave" path) ──────────────────────────────────── */

/**
 * A change of login email is proposed, not applied. The new address must be proved before
 * it becomes the sign-in, so a typo cannot lock someone out of their own training record,
 * and the old address keeps working until then.
 */
export async function requestTraineeEmailChange(pool: PoolLike, input: { organisationId: string; traineeId: string; newEmail: string }, now = new Date()): Promise<{ token: string; newEmail: string; expiresAt: string }> {
  const newEmail = normaliseEmail(input.newEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) throw new TraineeInvitationError("That does not look like an email address.");
  return withAuthTransaction(pool, "write", async (db) => {
    const current = await db.query<{ personal_email: string }>(
      `SELECT personal_email FROM nzi_console.trainees WHERE organisation_id=$1 AND trainee_id=$2`, [input.organisationId, input.traineeId]);
    const trainee = current.rows[0];
    if (!trainee) throw new TraineeInvitationError("That trainee does not exist.");
    if (trainee.personal_email === newEmail) throw new TraineeInvitationError("That is already your sign-in address.");

    const taken = await db.query<{ trainee_id: string }>(
      `SELECT trainee_id FROM nzi_console.trainees WHERE organisation_id=$1 AND personal_email=$2`, [input.organisationId, newEmail]);
    if (taken.rows[0]) throw new TraineeInvitationError("That address is already used by another trainee account.");

    await db.query(
      `UPDATE nzi_console.trainee_email_changes SET cancelled_at=now()
       WHERE organisation_id=$1 AND trainee_id=$2 AND confirmed_at IS NULL AND cancelled_at IS NULL`,
      [input.organisationId, input.traineeId]);
    const token = newToken();
    const expiresAt = new Date(now.getTime() + INVITATION_HOURS * 3600000);
    await db.query(
      `INSERT INTO nzi_console.trainee_email_changes (organisation_id, change_id, trainee_id, current_email, new_email, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.organisationId, randomUUID(), input.traineeId, trainee.personal_email, newEmail, tokenHash(token), expiresAt]);
    return { token, newEmail, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * Confirming the new address switches the login and revokes every existing session, so the
 * change takes effect everywhere at once. Past bookings are untouched: who employed the
 * person and who paid for their training are historical facts, not profile fields.
 */
export async function confirmTraineeEmailChange(pool: PoolLike, input: { organisationId: string; token: string }, now = new Date()): Promise<{ traineeId: string; email: string }> {
  return withAuthTransaction(pool, "write", async (db) => {
    const found = await db.query<{ change_id: string; trainee_id: string; new_email: string; expires_at: Date; confirmed_at: Date | null; cancelled_at: Date | null }>(
      `SELECT change_id, trainee_id, new_email, expires_at, confirmed_at, cancelled_at
       FROM nzi_console.trainee_email_changes WHERE organisation_id=$1 AND token_hash=$2 FOR UPDATE`,
      [input.organisationId, tokenHash(input.token)]);
    const change = found.rows[0];
    if (!change || change.confirmed_at || change.cancelled_at || change.expires_at <= now) {
      throw new TraineeInvitationError("This verification link is no longer valid. Request the change again from your details.");
    }
    const taken = await db.query<{ trainee_id: string }>(
      `SELECT trainee_id FROM nzi_console.trainees WHERE organisation_id=$1 AND personal_email=$2 AND trainee_id <> $3`,
      [input.organisationId, change.new_email, change.trainee_id]);
    if (taken.rows[0]) throw new TraineeInvitationError("That address has been taken since the change was requested.");

    await db.query(
      `UPDATE nzi_console.trainees SET personal_email=$3, version=version+1, updated_at=now(), updated_by='trainee:self'
       WHERE organisation_id=$1 AND trainee_id=$2`,
      [input.organisationId, change.trainee_id, change.new_email]);
    await db.query(`UPDATE nzi_console.trainee_email_changes SET confirmed_at=now() WHERE organisation_id=$1 AND change_id=$2`,
      [input.organisationId, change.change_id]);
    await db.query(
      `UPDATE nzi_console.trainee_sessions SET revoked_at=now() WHERE organisation_id=$1 AND trainee_id=$2 AND revoked_at IS NULL`,
      [input.organisationId, change.trainee_id]);
    return { traineeId: change.trainee_id, email: change.new_email };
  });
}

/* ── Maintaining your own record ─────────────────────────────────────────────────────── */

export type TraineeSelfUpdate = {
  fullName?: string;
  phone?: string;
  /** Where they work now, in their own words. Never retro-applied to past bookings. */
  currentEmployerName?: string;
  marketingConsent?: "granted" | "declined";
};

/**
 * A person maintaining their own details.
 *
 * Everything here is about *who they are*, never about what they did. The email is
 * deliberately absent — changing the sign-in address goes through
 * `requestTraineeEmailChange` and needs the new address verified first. And updating the
 * current employer changes only where they say they work now: past training stays
 * attributed to whoever arranged it, because that is a historical fact about the training,
 * not a field on the person.
 *
 * The consent version is stamped alongside the answer, so a recorded consent always says
 * what was agreed to.
 */
export async function updateTraineeDetails(
  pool: PoolLike,
  input: { organisationId: string; traineeId: string; update: TraineeSelfUpdate; consentVersion: string },
): Promise<{ traineeId: string; version: number }> {
  const fullName = input.update.fullName?.trim();
  if (fullName !== undefined && fullName === "") throw new TraineeInvitationError("Your name cannot be blank.");

  return withAuthTransaction(pool, "write", async (db) => {
    const current = await db.query<{ marketing_consent: string }>(
      `SELECT marketing_consent FROM nzi_console.trainees
       WHERE organisation_id=$1 AND trainee_id=$2 AND status='active' FOR UPDATE`,
      [input.organisationId, input.traineeId]);
    if (!current.rows[0]) throw new TraineeInvitationError("That trainee account is not active.");

    const consent = input.update.marketingConsent;
    const consentChanged = consent !== undefined && consent !== current.rows[0].marketing_consent;
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.trainees SET
         full_name = coalesce($3, full_name),
         phone = coalesce($4, phone),
         current_employer_name = coalesce($5, current_employer_name),
         -- Naming a new employer in free text clears the client link rather than leaving a
         -- stale one: saying "I work at Acme now" must not keep them attached to the last
         -- client we happened to know.
         current_employer_client_id = CASE WHEN $5::text IS NULL THEN current_employer_client_id ELSE NULL END,
         marketing_consent = coalesce($6, marketing_consent),
         consent_version = CASE WHEN $7 THEN $8 ELSE consent_version END,
         consent_recorded_at = CASE WHEN $7 THEN now() ELSE consent_recorded_at END,
         version = version + 1, updated_at = now(), updated_by = 'trainee:self'
       WHERE organisation_id=$1 AND trainee_id=$2
       RETURNING version`,
      [
        input.organisationId, input.traineeId,
        fullName ?? null, input.update.phone?.trim() ?? null,
        input.update.currentEmployerName?.trim() ?? null,
        consent ?? null, consentChanged, input.consentVersion,
      ]);
    return { traineeId: input.traineeId, version: saved.rows[0]!.version };
  });
}
