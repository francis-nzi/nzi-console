import type { StaffPrincipal } from "./auth";
import { requireCapability } from "./auth";
import type { PoolLike } from "./postgres";
import { withTenantWrite } from "./postgres";
import { issueStaffEnrolmentInvitationIn, StaffEnrolmentError } from "./staffEnrolment";
import { sendTemplatedEmail } from "./templatedEmail";

/**
 * Staff invitations from Admin → Team & access (matrix v8, `staff.invite`; email programme phase 3).
 *
 * Not a second enrolment path: every invitation is issued by the 0129 issue (`issueStaffEnrolmentInvitationIn`) — the same
 * single-use, expiring, hashed token, the same `staff.enrolment.issue` event, any earlier link revoked — and redeemed on
 * `/enrol` by the same two steps, where the person sets their own password and enrols their own authenticator. So every
 * enrolment property holds unchanged: the admin never sees either factor, the credential is written only on a proved
 * code, five wrong codes end the link, and working sign-in is never replaced.
 *
 * **The email is the default (R2).** The link is rendered into the `staff.invitation` template and queued through
 * `sendTemplatedEmail` in the **same transaction** as the issue: a link is never live without its email queued, and an
 * email is never queued for a link that was rolled back. The admin is told it was sent and never holds the token. Whether
 * it reaches the inbox is the email pipe's to say — on the isolated boundary a non-NZI address is stubbed — and the
 * roster shows how the latest invitation's email resolved.
 *
 * **The link is a fallback the admin asks for**, never handed over by default: `delivery: "link"` issues a fresh link
 * (revoking the emailed one) and returns it once, for when the email was stubbed or failed. Audited as `admin-link`.
 *
 * Reinvite is the same act on a member who has had an invitation; an enrolled member is refused, and an admin may send
 * one member at most three in an hour (R5) — both held by the issue, under the member's row lock.
 */

export type StaffInviteDeps = {
  /** The console's own origin, which the link points at. */
  consoleOrigin: string;
};

export type StaffInviteDelivery = "email" | "link";

export type StaffInviteResult =
  | { delivery: "email"; invitationId: string; expiresAt: string; reinvite: boolean; sentTo: string; emailMessageId: string }
  | { delivery: "link"; invitationId: string; expiresAt: string; reinvite: boolean; link: string };

export const enrolmentLink = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/enrol#token=${token}`;

/** When the link expires, as the person reads it: London time, spelled out. */
const expiryForPeople = (iso: string) => new Intl.DateTimeFormat("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
}).format(new Date(iso)) + " (UK time)";

export async function inviteStaffMember(
  pool: PoolLike, principal: StaffPrincipal, input: { userId: string; delivery?: StaffInviteDelivery }, deps: StaffInviteDeps, now = new Date(),
): Promise<StaffInviteResult> {
  requireCapability(principal, "staff.invite");
  const userId = input.userId.trim();
  const delivery = input.delivery ?? "email";
  if (!userId) throw new StaffEnrolmentError("Choose a member of the team to invite.");
  if (delivery !== "email" && delivery !== "link") throw new StaffEnrolmentError("An invitation is emailed, or issued as a link to copy.");
  if (userId === principal.userId) throw new StaffEnrolmentError("You cannot issue your own enrolment link.");
  let origin: URL;
  try { origin = new URL(deps.consoleOrigin); } catch { throw new StaffEnrolmentError("The console's own address is not configured."); }

  return withTenantWrite(pool, principal.organisationId, async (db) => {
    const issued = await issueStaffEnrolmentInvitationIn(db, {
      organisationId: principal.organisationId, userId, actorId: principal.userId, principalType: "staff",
      delivery: delivery === "email" ? "email" : "admin-link",
    }, now);
    const link = enrolmentLink(origin.origin, issued.token);
    const base = { invitationId: issued.invitationId, expiresAt: issued.expiresAt, reinvite: issued.reinvite };
    if (delivery === "link") return { delivery: "link", ...base, link };

    // The issue checked the address exists; it is read again here, inside the same lock, rather than trusted from a form.
    const { rows: [member] } = await db.query<{ email: string }>(`SELECT email FROM nzi_console.memberships WHERE user_id = $1`, [userId]);
    const sentTo = member!.email.trim().toLowerCase();
    try {
      const queued = await sendTemplatedEmail(db, principal.organisationId, {
        templateCode: "staff.invitation", to: sentTo, consoleOrigin: origin.origin,
        vars: { inviteLink: link, expiresAt: expiryForPeople(issued.expiresAt) },
        // Correlated to the invitation, so the roster can say how its email resolved; one email per invitation.
        correlationId: issued.invitationId, idempotencyKey: `staff.invitation:${issued.invitationId}`,
      });
      return { delivery: "email", ...base, sentTo, emailMessageId: queued.emailMessageId };
    } catch (error) {
      // Thrown inside the transaction, so the issue is rolled back with it: no live link without its email.
      throw new StaffEnrolmentError(`The invitation could not be queued, so no link was issued: ${error instanceof Error ? error.message : "the email was refused"}`);
    }
  });
}
