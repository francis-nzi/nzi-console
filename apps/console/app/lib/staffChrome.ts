import { callName, firstWordOf, type StaffRole } from "@nzi/contracts";

/**
 * What the console chrome shows for the signed-in member of staff: their name, initials and role - from the authenticated principal, never a
 * constant. The rail chip and the Control Room greeting both read this. While the session is being checked, or when there is none, the chip is
 * neutral (it names nobody) rather than naming someone it does not know.
 */
export type ChromeUser = { initials: string; name: string; role: string };

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = { admin: "Administrator", consultant: "Consultant", reviewer: "Reviewer", finance: "Finance", viewer: "Viewer" };

/** Up to two capitals: first and last word of the name ("Francis Doherty" -> "FD", "Cher" -> "C"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? [words[0]!] : [words[0]!, words[words.length - 1]!];
  return letters.map((word) => [...word][0]!.toUpperCase()).join("");
}

export const CHROME_CHECKING: ChromeUser = { initials: "·", name: "Checking sign-in…", role: "" };
export const CHROME_SIGNED_OUT: ChromeUser = { initials: "–", name: "Not signed in", role: "" };

type Me = { userId: string; displayName?: string | null; /** How they are addressed (0207): the first name held, else the first word of displayName. */ firstName?: string | null; role: StaffRole };

/** `undefined` = still checking; `"signed-out"` / `null` = no principal (signed out, or auth switched off / unreachable). */
export function chromeUserFor(me: Me | "signed-out" | null | undefined): ChromeUser {
  if (me === undefined) return CHROME_CHECKING;
  if (me === "signed-out" || me === null) return CHROME_SIGNED_OUT;
  const fullName = me.displayName?.trim() || me.userId;
  // The chip names the signed-in person the way they are addressed (first name, 0207); the initials still come from the full name.
  return { initials: initialsOf(fullName), name: me.firstName?.trim() || firstWordOf(me.displayName) || me.userId, role: STAFF_ROLE_LABEL[me.role] ?? me.role };
}

/** The first name for the greeting, or null when there is no named principal - the greeting then says no name rather than a wrong one. */
export function greetingNameFor(me: Me | "signed-out" | null | undefined): string | null {
  if (me === undefined || me === "signed-out" || me === null) return null;
  return callName({ firstName: me.firstName, fullName: me.displayName });
}
