/**
 * Whether a contact may be emailed by an automation — and, just as importantly, how anyone
 * came to believe that.
 *
 * `0083` made `unknown` the default and made it block. This module is the vocabulary for
 * moving off that default deliberately: a decision, a basis, and a person who recorded it.
 *
 * The state alone is never enough to show a reader. "Granted" with nothing behind it is the
 * shape a hand-edited database has, and it is exactly what this control exists to replace —
 * so every surface renders the basis and the date beside it, or says plainly that there is
 * none.
 */

/** The stored state on `client_contacts.email_consent`. `unknown` blocks. */
export const contactConsentStates = ["unknown", "granted", "declined"] as const;
export type ContactConsentState = (typeof contactConsentStates)[number];

/**
 * What someone can actually record. Not `unknown`: nobody decides to stop knowing, and the
 * default already means "not asked".
 */
export const contactConsentDecisions = ["granted", "declined"] as const;
export type ContactConsentDecision = (typeof contactConsentDecisions)[number];

/**
 * How the decision reached NZI.
 *
 * `portal-self-serve` is declared but **not recordable from the staff console** — phase 2
 * gives it to the contact themselves. Staff must not be able to claim a client acted on
 * their own behalf, so `staffRecordableBases` is what the console offers and what the
 * command accepts.
 */
export const contactConsentBases = ["consultant-recorded", "imported", "portal-self-serve"] as const;
export type ContactConsentBasis = (typeof contactConsentBases)[number];

export const staffRecordableBases = ["consultant-recorded", "imported"] as const;
export type StaffRecordableBasis = (typeof staffRecordableBases)[number];

export const isStaffRecordableBasis = (value: unknown): value is StaffRecordableBasis =>
  typeof value === "string" && (staffRecordableBases as readonly string[]).includes(value);

export const contactConsentStateLabels: Record<ContactConsentState, string> = {
  unknown: "Not asked",
  granted: "Consented",
  declined: "Declined",
};

export const contactConsentBasisLabels: Record<ContactConsentBasis, string> = {
  "consultant-recorded": "Recorded by consultant",
  imported: "Imported with the contact record",
  "portal-self-serve": "Given by the contact in the portal",
};

/** One recorded decision, as the history shows it. */
export type ContactConsentEvent = {
  id: string;
  contactId: string;
  version: number;
  state: ContactConsentDecision;
  previousState: ContactConsentState;
  basis: ContactConsentBasis;
  note: string;
  recordedBy: string;
  recordedAt: string;
};

/**
 * What a surface should say about a contact's consent.
 *
 * Four outcomes, deliberately distinct — collapsing any two of them is how a page ends up
 * implying permission nobody gave:
 *
 * - `blocked` — the default. Not asked, so not sendable.
 * - `sendable` — granted, and the decision behind it is on the record.
 * - `refused` — declined. Never sendable, and it stays visible rather than reverting to
 *   looking like "not asked".
 * - `unevidenced` — the state says granted but no decision was ever recorded, which is what
 *   a hand-edited row looks like. Reported as not sendable-looking: the reader is told the
 *   basis is missing rather than shown a bare "granted".
 */
export type ContactConsentView =
  | { state: "unknown"; kind: "blocked"; label: string; detail: string; sendable: false }
  | { state: "granted"; kind: "sendable"; label: string; detail: string; sendable: true; event: ContactConsentEvent }
  | { state: "declined"; kind: "refused"; label: string; detail: string; sendable: false; event: ContactConsentEvent | null }
  | { state: "granted"; kind: "unevidenced"; label: string; detail: string; sendable: true };

/**
 * Resolve what to show. `latest` is the newest recorded decision for this contact, or null
 * where none was ever recorded.
 *
 * `sendable` mirrors what the worker will actually do, which is read the column — so an
 * unevidenced grant reports `sendable: true` even while the page is telling the reader its
 * basis is missing. Reporting `false` there would be a more comfortable lie: mail would go
 * out regardless, and the screen would be the only thing claiming otherwise.
 */
export function contactConsentView(
  state: ContactConsentState,
  latest: ContactConsentEvent | null,
): ContactConsentView {
  if (state === "granted") {
    if (latest === null || latest.state !== "granted") {
      return {
        state: "granted", kind: "unevidenced", sendable: true,
        label: contactConsentStateLabels.granted,
        detail: "No basis was recorded for this. Re-record it so the permission has evidence behind it.",
      };
    }
    return {
      state: "granted", kind: "sendable", sendable: true, event: latest,
      label: contactConsentStateLabels.granted,
      detail: contactConsentBasisLabels[latest.basis],
    };
  }
  if (state === "declined") {
    return {
      state: "declined", kind: "refused", sendable: false,
      event: latest !== null && latest.state === "declined" ? latest : null,
      label: contactConsentStateLabels.declined,
      detail: "This contact will not be emailed by automations.",
    };
  }
  return {
    state: "unknown", kind: "blocked", sendable: false,
    label: contactConsentStateLabels.unknown,
    detail: "No decision has been recorded, so nothing will be sent to this contact.",
  };
}
