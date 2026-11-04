/**
 * How a person is addressed (0207).
 *
 * The rule of thumb, which every call site follows: **the first name addresses a person; the full name records who did
 * something.** A greeting, a chip, "Hello …", "your adviser …" read {@link callName}; an audit trail, a decision log, a
 * data-subject record, a report signee or a signature keeps the full name.
 *
 * A first name is held per contact and per member and is always editable, but it is a default taken from the full name — so
 * where it is not held (an older row, a loader, a portal user with no contact), the first word of the full name stands in,
 * and where there is no name at all the greeting says "there". Nothing greets blank.
 */

/** What a greeting says when the person has no name. */
export const FIRST_NAME_FALLBACK = "there";

/** The longest first name held (the column's CHECK). */
export const FIRST_NAME_MAX_LENGTH = 120;

/** The first whitespace-separated word of a full name, trimmed — the default a first name is created with. Null for no name. */
export function firstWordOf(fullName: string | null | undefined): string | null {
  const word = (fullName ?? "").trim().split(/\s+/)[0];
  return word ? word.slice(0, FIRST_NAME_MAX_LENGTH) : null;
}

/** What to call a person: the first name held, else the first word of the full name, else null (no name to use). */
export function callName(person: { firstName?: string | null; fullName?: string | null }): string | null {
  return person.firstName?.trim() || firstWordOf(person.fullName);
}

/** The same, for a sentence that has to say something: "there" when the person has no name. */
export function greetingName(person: { firstName?: string | null; fullName?: string | null }): string {
  return callName(person) ?? FIRST_NAME_FALLBACK;
}

/**
 * The first name an update stores. Offered: as {@link firstNameToStore} (blank means the default). Not offered: what is held —
 * unless what is held is still just the default from the old full name (or nothing), in which case it follows the new full
 * name, so renaming "Jane Smith" to "Janet Smith" through a caller that never mentions a first name does not leave "Jane".
 * A first name somebody set to something else is never overwritten by a rename.
 */
export function firstNameForUpdate(
  held: string | null | undefined, heldFullName: string | null | undefined, newFullName: string, offered: string | null | undefined,
): string | null {
  if (offered !== undefined) return firstNameToStore(offered, newFullName) ?? null;
  const heldName = held?.trim() || null;
  return heldName === null || heldName === firstWordOf(heldFullName) ? firstWordOf(newFullName) : heldName;
}

/**
 * The first name a write stores. Offered and non-blank: that, trimmed. Offered blank: the default from the full name (clearing
 * the field means "go back to the default", not "hold nothing"). Not offered: `undefined`, so an update leaves what is held.
 */
export function firstNameToStore(offered: string | null | undefined, fullName: string | null | undefined): string | null | undefined {
  if (offered === undefined) return undefined;
  return offered?.trim() ? offered.trim().slice(0, FIRST_NAME_MAX_LENGTH) : firstWordOf(fullName);
}
