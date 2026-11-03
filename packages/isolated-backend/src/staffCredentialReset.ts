import { randomUUID } from "node:crypto";
import type { StaffPrincipal } from "./auth";
import { requireCapability } from "./auth";
import type { PoolLike } from "./postgres";
import { withTenantWrite } from "./postgres";
import { issueStaffEnrolmentInvitationIn, StaffEnrolmentError } from "./staffEnrolment";
import { enrolmentLink, expiryForPeople, type StaffInviteDelivery, type StaffInviteDeps } from "./staffInvitations";
import { sendTemplatedEmail } from "./templatedEmail";

/**
 * Reset an enrolled member's sign-in (matrix v11, `staff.credential.reset`): the Admin recovery path for a lost authenticator
 * or password.
 *
 * In **one tenant transaction**: the credential is disabled (kept, never deleted), every session and pending sign-in ends, unused
 * recovery codes are revoked (all through the confined `reset_staff_credential`, 0203), a fresh single-use invitation is issued
 * through the one enrolment path, and its email is queued — or, for `delivery: "link"`, the link is returned once. Either
 * everything happens or nothing does: a member is never left reset without a way back, nor sent a link for a reset that rolled back.
 *
 * Refused: yourself (a second pair of eyes), a member who is not active or not enrolled (invite them instead), and, for an admin,
 * a reset that would leave no other active admin. A reason is required and recorded on the audit event, which names ids and
 * counts only. The person then re-enrols password **and** authenticator on `/enrol`; the admin never holds either.
 * `staff.invite` is unchanged and still cannot reach an enrolled member.
 */

export type StaffResetResult = (
  | { delivery: "email"; sentTo: string; emailMessageId: string }
  | { delivery: "link"; link: string }
) & { invitationId: string; expiresAt: string; sessionsEnded: number; challengesEnded: number; recoveryCodesRevoked: number };

type Counts = { credentialsRetired: number; sessionsEnded: number; challengesEnded: number; recoveryCodesRevoked: number };

export async function resetStaffSignIn(
  pool: PoolLike, principal: StaffPrincipal, input: { userId: string; reason: string; delivery?: StaffInviteDelivery }, deps: StaffInviteDeps, now = new Date(),
): Promise<StaffResetResult> {
  requireCapability(principal, "staff.credential.reset");
  const userId = input.userId.trim(), reason = input.reason.trim();
  const delivery = input.delivery ?? "email";
  if (!userId) throw new StaffEnrolmentError("Choose a member of the team to reset.");
  if (reason.length < 8) throw new StaffEnrolmentError("Say why their sign-in is being reset (at least a few words) — it is recorded.");
  if (reason.length > 500) throw new StaffEnrolmentError("Keep the reason under 500 characters.");
  if (delivery !== "email" && delivery !== "link") throw new StaffEnrolmentError("The new invitation is emailed, or issued as a link to copy.");
  if (userId === principal.userId) throw new StaffEnrolmentError("You cannot reset your own sign-in — ask another admin, so the change has a second pair of eyes.");
  let origin: URL;
  try { origin = new URL(deps.consoleOrigin); } catch { throw new StaffEnrolmentError("The console's own address is not configured."); }

  return withTenantWrite(pool, principal.organisationId, async (db) => {
    const org = principal.organisationId;
    // The organisation's active admins first, then the person — the order the roster commands use, so none can deadlock.
    const { rows: admins } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM nzi_console.memberships WHERE organisation_id = $1 AND role_id = 'admin' AND status = 'active' ORDER BY user_id FOR UPDATE`, [org]);
    const { rows: [member] } = await db.query<{ role_id: string; status: string; email: string | null }>(
      `SELECT role_id, status, email FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2 FOR UPDATE`, [org, userId]);
    if (!member) throw new StaffEnrolmentError(`${userId} is not a member of this organisation.`);
    if (member.status !== "active") throw new StaffEnrolmentError("Only an active member's sign-in can be reset.");
    if (!member.email?.trim()) throw new StaffEnrolmentError("They have no work address to send a new invitation to.");
    if (member.role_id === "admin" && !admins.some((row) => row.user_id !== userId)) {
      throw new StaffEnrolmentError("This is the organisation's only active admin. Make someone else an admin first — the organisation must never be left without one.");
    }

    const { rows: [done] } = await db.query<{ result: Counts }>(`SELECT nzi_console.reset_staff_credential($1, $2, $3) AS result`, [org, userId, now.toISOString()]);
    const counts = done!.result;
    if (counts.credentialsRetired !== 1) throw new StaffEnrolmentError("They have not enrolled yet, so there is no sign-in to reset. Invite them instead.");

    const issued = await issueStaffEnrolmentInvitationIn(db, {
      organisationId: org, userId, actorId: principal.userId, principalType: "staff", delivery: delivery === "email" ? "email" : "admin-link", recovery: true,
    }, now);
    await db.query(
      `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,after_json)
       VALUES ($1,$2,$3,'staff','staff.credential.reset','membership',$4,$5,$6,$7::jsonb)`,
      [org, `audit-${randomUUID()}`, principal.userId, userId, issued.invitationId, reason,
        JSON.stringify({ userId, invitationId: issued.invitationId, delivery, sessionsEnded: counts.sessionsEnded, challengesEnded: counts.challengesEnded, recoveryCodesRevoked: counts.recoveryCodesRevoked })]);

    const link = enrolmentLink(origin.origin, issued.token);
    const base = { invitationId: issued.invitationId, expiresAt: issued.expiresAt, sessionsEnded: counts.sessionsEnded, challengesEnded: counts.challengesEnded, recoveryCodesRevoked: counts.recoveryCodesRevoked };
    if (delivery === "link") return { delivery: "link", ...base, link };
    const sentTo = member.email.trim().toLowerCase();
    try {
      const queued = await sendTemplatedEmail(db, org, {
        templateCode: "staff.invitation", to: sentTo, consoleOrigin: origin.origin,
        vars: { inviteLink: link, expiresAt: expiryForPeople(issued.expiresAt) },
        correlationId: issued.invitationId, idempotencyKey: `staff.invitation:${issued.invitationId}`,
      });
      return { delivery: "email", ...base, sentTo, emailMessageId: queued.emailMessageId };
    } catch (error) {
      // Thrown inside the transaction: the reset rolls back with it, so nobody is reset without the email that carries their way back.
      throw new StaffEnrolmentError(`The new invitation could not be queued, so nothing was reset: ${error instanceof Error ? error.message : "the email was refused"}`);
    }
  });
}
