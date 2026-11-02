/**
 * A client's portal access (RULING-portal-access-model; Portal Management → Access).
 *
 * One record per client, and **absence is the defaults** — enabled, not trained, no expiry, no cap, payment "—" — so nothing changes
 * for any client until somebody decides something. Two of its fields are *enforced*: `enabled` (the master switch) and `expiresAt`
 * are checked at portal login, at MFA completion and on every request of a live session; a client that is off or past its expiry is
 * refused exactly as an unknown user is, and switching it off ends its live sessions. Everything else is informational: the user cap
 * never blocks an invitation, and nothing gates on payment.
 */
export const PORTAL_PAYMENT_STATUSES = ["unpaid", "paid", "waived"] as const;
export type PortalPaymentStatus = (typeof PORTAL_PAYMENT_STATUSES)[number];
export const PORTAL_PAYMENT_STATUS_LABELS: Record<PortalPaymentStatus, string> = { unpaid: "Unpaid", paid: "Paid", waived: "Waived" };

export const PORTAL_ACCESS_NOTES_MAX = 4000;
export const PORTAL_ACCESS_PAYMENT_REF_MAX = 120;
export const PORTAL_ACCESS_NOTE_MAX = 500;

/** The fields a save may change. Absent = unchanged. */
export type PortalClientAccessChanges = Partial<{
  enabled: boolean; trained: boolean;
  /** An instant (ISO 8601); null = no expiry. A past instant is allowed — it is how a client is cut off. */
  expiresAt: string | null;
  userCap: number | null; paymentStatus: PortalPaymentStatus | null; paymentRef: string | null; notes: string;
}>;
export const PORTAL_ACCESS_FIELDS = ["enabled", "trained", "expires_at", "user_cap", "payment_status", "payment_ref", "notes"] as const;
export type PortalAccessField = (typeof PORTAL_ACCESS_FIELDS)[number];

export type PortalClientAccess = {
  clientId: string; enabled: boolean; trained: boolean; expiresAt: string | null; userCap: number | null;
  paymentStatus: PortalPaymentStatus | null; paymentRef: string | null; notes: string;
  /** null while there is no record (the defaults). The next save sends `expectedVersion: null`. */
  version: number | null; updatedBy: string | null; updatedAt: string | null;
};
export const portalClientAccessDefaults = (clientId: string): PortalClientAccess => ({
  clientId, enabled: true, trained: false, expiresAt: null, userCap: null, paymentStatus: null, paymentRef: null, notes: "", version: null, updatedBy: null, updatedAt: null,
});

export type PortalAccessDecision = { decisionId: string; field: PortalAccessField; from: unknown; to: unknown; note: string | null; changedBy: string; changedByName: string | null; changedAt: string };
export type PortalLoginOutcomeLabel = "success" | "bad_password" | "locked" | "unknown_user" | "user_disabled" | "client_disabled" | "client_expired" | "bad_code" | "invalid_challenge";
export type PortalLoginEventRecord = { eventId: string; occurredAt: string; outcome: PortalLoginOutcomeLabel; portalUserId: string | null; userName: string | null; ip: string | null; userAgent: string | null };

/** What the Access tab reads: the record (or the defaults), who is active, the decision log and the recent sign-in attempts. */
export type PortalClientAccessView = {
  access: PortalClientAccess;
  /** Users of this client who can sign in now — informational beside the cap, which never blocks inviting. */
  activeUsers: number;
  decisions: PortalAccessDecision[];
  loginEvents: PortalLoginEventRecord[];
};
