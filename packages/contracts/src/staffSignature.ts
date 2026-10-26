/**
 * A member of staff's email signature — the personal lines of the house signature (email programme phase 5-2): the sign-off,
 * their name, title, email and mobile, above 5-1's fixed chrome on an email attributed to them. The member edits their own
 * on their account page (R2); the name comes from their Team & access record, and each field has a default, so an
 * un-edited member still signs correctly. No photos (Francis, 26 Oct 2026).
 */

export type StaffSignatureFields = {
  /** Their title as it should read; null: their position in Team & access. */
  title: string | null;
  /** The address the signature shows; null: their work email. */
  displayEmail: string | null;
  /** Shown as "Mobile UK"; null: no mobile line. */
  mobile: string | null;
  /** The sign-off; null: "Kind regards". */
  signOff: string | null;
};
export const STAFF_SIGNATURE_FIELDS = ["title", "displayEmail", "mobile", "signOff"] as const satisfies ReadonlyArray<keyof StaffSignatureFields>;

export const DEFAULT_SIGN_OFF = "Kind regards";
export const STAFF_SIGNATURE_MAX = { title: 120, displayEmail: 254, signOff: 60 } as const;

/** What the member's record supplies for the defaults. */
export type StaffSignatureDefaults = { name: string | null; positionTitle: string | null; workEmail: string | null };

const blankToNull = (value: string | null | undefined) => { const trimmed = value?.trim().replace(/\s+/g, " "); return trimmed ? trimmed : null; };

/** What a save stores: trimmed, spaces collapsed (so a sign-off is one line), blanks as null, the address lower-cased. */
export function normaliseStaffSignature(fields: StaffSignatureFields): StaffSignatureFields {
  const out = Object.fromEntries(STAFF_SIGNATURE_FIELDS.map((key) => [key, blankToNull(fields[key])])) as StaffSignatureFields;
  if (out.displayEmail) out.displayEmail = out.displayEmail.toLowerCase();
  return out;
}

export type StaffSignatureIssue = { field: keyof StaffSignatureFields; code: string; message: string };

/** The rules, on normalised values — the same as 0185's CHECKs. */
export function staffSignatureIssues(fields: StaffSignatureFields): StaffSignatureIssue[] {
  const issues: StaffSignatureIssue[] = [];
  if (fields.title !== null && fields.title.length > STAFF_SIGNATURE_MAX.title) issues.push({ field: "title", code: "TOO_LONG", message: `At most ${STAFF_SIGNATURE_MAX.title} characters.` });
  if (fields.displayEmail !== null && (fields.displayEmail.length > STAFF_SIGNATURE_MAX.displayEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.displayEmail))) {
    issues.push({ field: "displayEmail", code: "INVALID", message: "An email address." });
  }
  if (fields.mobile !== null && !/^[0-9+() .-]{5,30}$/.test(fields.mobile)) issues.push({ field: "mobile", code: "INVALID", message: "A phone number: digits, spaces and + ( ) - only." });
  if (fields.signOff !== null && fields.signOff.length > STAFF_SIGNATURE_MAX.signOff) issues.push({ field: "signOff", code: "TOO_LONG", message: `At most ${STAFF_SIGNATURE_MAX.signOff} characters.` });
  return issues;
}

/** The personal lines as an email draws them. */
export type EmailPerson = { signOff: string; name: string; title: string | null; email: string | null; mobile: string | null };

/**
 * The personal lines for a member: their own fields over the record's defaults. **No name, no lines** (R3): a sign-off
 * with nobody under it is worse than the organisation's chrome alone, so a member with no name signs as the organisation.
 * A missing title, email or mobile only drops that line (R4).
 */
export function emailPersonFor(defaults: StaffSignatureDefaults, fields: StaffSignatureFields | null): EmailPerson | null {
  const name = blankToNull(defaults.name);
  if (!name) return null;
  return {
    signOff: fields?.signOff ?? DEFAULT_SIGN_OFF,
    name,
    title: fields?.title ?? blankToNull(defaults.positionTitle),
    email: fields?.displayEmail ?? blankToNull(defaults.workEmail)?.toLowerCase() ?? null,
    mobile: fields?.mobile ?? null,
  };
}
