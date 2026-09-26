import { randomUUID } from "node:crypto";
import { isStaffRole, type StaffRole } from "@nzi/contracts";
import type { StaffPrincipal } from "./auth";
import { requireCapability } from "./auth";
import { mailDelivery, smtpSettingsFrom, type MailDelivery, type Mailer } from "./mailer";
import { smtpMailer } from "./smtpMailer";
import type { PoolLike } from "./postgres";
import { withTenantRead, withTenantWrite } from "./postgres";
import { issueStaffEnrolmentInvitation, revokeStaffEnrolmentInvitation, StaffEnrolmentError } from "./staffEnrolment";

/**
 * Staff invitations issued from the console's admin (matrix v8, `staff.invite`).
 *
 * Not a second enrolment path: every invitation is issued by `issueStaffEnrolmentInvitation` (0129) — the same
 * single-use, expiring, hashed token and the same `staff.enrolment.issue` event — and redeemed on `/enrol` by the same
 * two steps. So every enrolment property holds unchanged: the admin never sees the person's password or authenticator,
 * the credential is written only on a proved code, five wrong codes end the link, and working sign-in is never replaced.
 *
 * What the admin receives depends on mail. While mail is suppressed (always, on the isolated service), they receive
 * the link — carrying its token in the URL fragment — to deliver privately. Once mail may be sent, the link goes
 * straight to the member's work address and the admin receives only that it was sent: they never hold the token.
 */

export type StaffInviteDeps = {
  /** The console's own origin, which the link points at. */
  consoleOrigin: string;
  /** From `mailDelivery(env)` — the isolation rule decides, never this call. */
  mail: MailDelivery;
  mailer?: Mailer;
};

export type StaffInviteResult =
  | { delivery: "link"; invitationId: string; expiresAt: string; link: string }
  | { delivery: "email"; invitationId: string; expiresAt: string; sentTo: string };

/**
 * How an invitation leaves, decided by the service's own isolation rule (`mailDelivery`) — never by the request. On the
 * isolated service this is always "suppress", so the admin is handed the link.
 */
export function staffInviteDeliveryFromEnv(env: Record<string, string | undefined>): Pick<StaffInviteDeps, "mail" | "mailer"> {
  const mail = mailDelivery({ mailMode: env.NZI_MAIL_MODE, appEnv: env.NEXT_PUBLIC_APP_ENV, boundaryToken: env.NZI_DATABASE_BOUNDARY });
  return mail.mode === "send" ? { mail, mailer: smtpMailer(smtpSettingsFrom(env)) } : { mail };
}

export const enrolmentLink = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/enrol#token=${token}`;

export async function inviteStaffMember(
  pool: PoolLike, principal: StaffPrincipal, input: { userId: string }, deps: StaffInviteDeps, now = new Date(),
): Promise<StaffInviteResult> {
  requireCapability(principal, "staff.invite");
  const userId = input.userId.trim();
  if (!userId) throw new StaffEnrolmentError("Choose a member of the team to invite.");
  if (userId === principal.userId) throw new StaffEnrolmentError("You cannot issue your own enrolment link.");
  let origin: URL;
  try { origin = new URL(deps.consoleOrigin); } catch { throw new StaffEnrolmentError("The console's own address is not configured."); }
  if (deps.mail.mode === "send" && !deps.mailer) throw new StaffEnrolmentError("Mail is enabled but no mailer is configured.");

  const email = deps.mail.mode === "send" ? await withTenantRead(pool, principal.organisationId, async (db) =>
    (await db.query<{ email: string | null }>(`SELECT email FROM nzi_console.memberships WHERE user_id=$1`, [userId])).rows[0]?.email?.trim() ?? null) : null;

  const issued = await issueStaffEnrolmentInvitation(pool, {
    organisationId: principal.organisationId, userId, actorId: principal.userId, principalType: "staff",
    delivery: deps.mail.mode === "send" ? "email" : "admin-link",
  }, now);
  const link = enrolmentLink(origin.origin, issued.token);

  if (deps.mail.mode !== "send") return { delivery: "link", invitationId: issued.invitationId, expiresAt: issued.expiresAt, link };

  try {
    if (!email) throw new Error("no address");
    await deps.mailer!.send({
      to: email,
      subject: "Set up your NZ Insights Pro sign-in",
      body: [
        "You have been invited to the NZ Insights Pro staff console.",
        "",
        "Set your own password and connect your authenticator here:",
        link,
        "",
        `This link works once and expires at ${issued.expiresAt}. Nobody at NZI sees your password or your authenticator.`,
        "If you were not expecting this, ignore it — nothing happens unless the link is used.",
      ].join("\n"),
    });
  } catch {
    // A link that was issued but never reached anyone is withdrawn, not left live.
    await revokeStaffEnrolmentInvitation(pool, { organisationId: principal.organisationId, userId, actorId: principal.userId }, now);
    throw new StaffEnrolmentError("The invitation email could not be sent, so the link was withdrawn. Try again.");
  }
  return { delivery: "email", invitationId: issued.invitationId, expiresAt: issued.expiresAt, sentTo: email };
}

export type StaffEnrolmentRosterEntry = {
  userId: string; displayName: string; email: string | null; role: string;
  /**
   * What the invitations table knows — not whether the person can sign in: the admin's role cannot read credentials,
   * and a credential can exist without an invitation (an account provisioned before 0129).
   */
  invitation: { state: "open" | "enrolled" | "revoked" | "expired"; at: string } | null;
};

/** Active members, each with their most recent invitation's state, for the invite picker. */
export async function listStaffEnrolmentRoster(pool: PoolLike, principal: StaffPrincipal, now = new Date()): Promise<StaffEnrolmentRosterEntry[]> {
  requireCapability(principal, "staff.invite");
  return withTenantRead(pool, principal.organisationId, async (db) => {
    const { rows } = await db.query<{
      user_id: string; display_name: string | null; email: string | null; role_id: string;
      expires_at: Date | string | null; consumed_at: Date | string | null; revoked_at: Date | string | null; created_at: Date | string | null;
    }>(
      `SELECT m.user_id, m.display_name, m.email, m.role_id, i.expires_at, i.consumed_at, i.revoked_at, i.created_at
         FROM nzi_console.memberships m
         LEFT JOIN LATERAL (
           SELECT expires_at, consumed_at, revoked_at, created_at FROM nzi_console.staff_enrolment_invitations
            WHERE user_id = m.user_id ORDER BY created_at DESC, invitation_id DESC LIMIT 1) i ON true
        WHERE m.status = 'active'
        ORDER BY coalesce(m.display_name, m.user_id)`);
    const iso = (value: Date | string) => new Date(value).toISOString();
    return rows.map((row) => ({
      userId: row.user_id, displayName: row.display_name?.trim() || row.user_id, email: row.email, role: row.role_id,
      invitation: row.created_at === null ? null
        : row.consumed_at ? { state: "enrolled" as const, at: iso(row.consumed_at) }
        : row.revoked_at ? { state: "revoked" as const, at: iso(row.revoked_at) }
        : new Date(row.expires_at!) <= now ? { state: "expired" as const, at: iso(row.expires_at!) }
        : { state: "open" as const, at: iso(row.expires_at!) },
    }));
  });
}

/**
 * Change a member's role — an operator act in the Render Shell, audited, with a reason. The bootstrap for the first
 * admin: the roster creates everyone at the least-privilege role, so somebody has to be made Admin before anyone can
 * invite from the console. There is deliberately no console route to this; role administration in the UI is its own
 * build, behind its own capability.
 */
export async function assignStaffRole(
  pool: PoolLike, input: { organisationId: string; userId: string; role: string; actorId: string; reason: string },
): Promise<{ from: string; to: StaffRole }> {
  const userId = input.userId.trim(), actorId = input.actorId.trim(), reason = input.reason.trim();
  if (!isStaffRole(input.role)) throw new StaffEnrolmentError(`${input.role} is not a staff role.`);
  if (!userId || !actorId) throw new StaffEnrolmentError("A member and the operator making the change are required.");
  if (reason.length < 8) throw new StaffEnrolmentError("A role change needs a reason.");
  const role = input.role;
  return withTenantWrite(pool, input.organisationId, async (db) => {
    const found = await db.query<{ role_id: string; status: string }>(`SELECT role_id, status FROM nzi_console.memberships WHERE user_id=$1 FOR UPDATE`, [userId]);
    const member = found.rows[0];
    if (!member) throw new StaffEnrolmentError(`${userId} is not a member of ${input.organisationId}.`);
    if (member.status !== "active") throw new StaffEnrolmentError(`${userId}'s membership is ${member.status}, not active.`);
    if (member.role_id === role) throw new StaffEnrolmentError(`${userId} already has the ${role} role.`);
    await db.query(`UPDATE nzi_console.memberships SET role_id=$2 WHERE user_id=$1`, [userId, role]);
    const eventId = `audit-${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,before_json,after_json)
       VALUES ($1,$2,$3,'system','staff.role.assign','membership',$4,$2,$5,$6::jsonb,$7::jsonb)`,
      [input.organisationId, eventId, actorId, userId, reason, JSON.stringify({ role: member.role_id }), JSON.stringify({ role })]);
    return { from: member.role_id, to: role };
  });
}
