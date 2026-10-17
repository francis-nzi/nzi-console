import { maySelfApprove } from "@nzi/contracts";
import { accessFor, type EditAccess, type StaffMe } from "../lib/useEditAccess";

/**
 * NZC-022 as the server holds it now, for the job's approve / validate / publish controls: the snapshot's preparer is
 * refused unless independent approval is relaxed (REPORT_REQUIRE_INDEPENDENT_APPROVAL=false, read from the snapshot
 * list) and they hold the self-approval capability — the same `maySelfApprove` the commands call. Then the command's
 * own capability. A convenience only; the command decides.
 */
export function snapshotActAccess(
  me: StaffMe | "signed-out" | null | undefined,
  snapshot: { createdBy: string } | undefined,
  capability: "snapshot.review" | "report.publish",
  independentApprovalRequired: boolean,
): EditAccess {
  if (me === undefined) return { state: "checking", reason: "Checking your permissions…" };
  if (me === "signed-out") return { state: "denied", reason: "Sign in as staff to make changes." };
  if (me === null) return { state: "unavailable", reason: "Your permissions could not be checked, so this is unavailable." };
  if (snapshot && snapshot.createdBy === me.userId && !maySelfApprove(me.capabilities, independentApprovalRequired)) {
    return { state: "denied", reason: capability === "snapshot.review" ? "You prepared this snapshot, so another person must approve it." : "You prepared this snapshot, so another person must validate and publish it." };
  }
  return accessFor(me, capability);
}

/** The snapshot was approved by the person who froze it — possible only while NZC-022 is relaxed, and always shown. */
export const isSelfApproved = (snapshot: { createdBy: string; approvedBy?: string | null }): boolean =>
  Boolean(snapshot.approvedBy) && snapshot.approvedBy === snapshot.createdBy;

/** The response's NZC-022 setting; anything but an explicit false keeps independent approval required. */
export const readIndependentApprovalRequired = (body: unknown): boolean =>
  !(body && typeof body === "object" && (body as { independentApprovalRequired?: unknown }).independentApprovalRequired === false);
