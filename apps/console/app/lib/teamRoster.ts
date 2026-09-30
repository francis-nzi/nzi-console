import type { TeamMember } from "@nzi/isolated-backend";

/**
 * What the owner and manager pickers are given about a colleague (admin Phase B): who they are and whether that is a
 * real name — never their work address. Every signed-in role reads the picker roster; an address is shown on Admin →
 * Team & access to admin.users holders alone.
 */
export type PickerMember = Pick<TeamMember, "userId" | "displayName" | "role" | "status" | "named">;
export const pickerMember = ({ userId, displayName, role, status, named }: TeamMember): PickerMember => ({ userId, displayName, role, status, named });
