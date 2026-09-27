import { isStaffRole, roleLabels } from "@nzi/contracts";
import type { RailUser } from "@nzi/ui";

/** Who is signed in, as the chrome shows them: the rail's block, and the Control Room's greeting. */
export type SessionIdentity = RailUser & { firstName: string };

const words = (value: string) => value.trim().split(/\s+/).filter(Boolean);
const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

/**
 * Name, first name, initials and role label from the membership. The name is the display name; failing that, the email's
 * local part made readable ("jo.bloggs" → "Jo Bloggs"); failing that, the user id. Initials follow whichever was used.
 */
export function identityFor(member: { userId: string; role: string; displayName?: string | null; email?: string | null }): SessionIdentity {
  const local = member.email?.split("@")[0]?.trim() ?? "";
  const fromEmail = local ? local.split(/[._-]+/).filter(Boolean).map(titleCase).join(" ") : "";
  const name = member.displayName?.trim() || fromEmail || member.userId;
  const parts = words(name);
  const initials = (parts.length >= 2 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
  return { name, firstName: parts[0] ?? name, initials, role: isStaffRole(member.role) ? roleLabels[member.role] : member.role };
}
