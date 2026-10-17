// NZC-022, relaxed for now and reversibly (RULING-NZC022-relax-self-approval, 17 Oct 2026).
//
// REPORT_REQUIRE_INDEPENDENT_APPROVAL is a server variable, never NEXT_PUBLIC_*. Unset, it is true: a snapshot's
// preparer may not approve, validate or publish it, and a row's preparer may not approve the row — NZC-022 as it
// has always stood. Only the word "false" relaxes it, and then only for a holder of SELF_APPROVAL_CAPABILITY.
// Reinstating separation of duties is setting it back to true; nothing else changes.
import { maySelfApprove, type CommandContext } from "@nzi/contracts";
import type { ClientAccess } from "./access";

export function independentApprovalRequired(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.REPORT_REQUIRE_INDEPENDENT_APPROVAL?.trim().toLowerCase() !== "false";
}

/** Whether this actor may go on to act on what they prepared — read at the moment of the act. */
export function preparerMayProceed(context: CommandContext, access: ClientAccess | null): boolean {
  return maySelfApprove(context.grant?.capabilities ?? [], independentApprovalRequired(), access?.ownedByActor);
}
