import type { StaffReportThread } from "@nzi/isolated-backend";

/**
 * F1: the studio's round thread picks its one round out of the inbox read (`GET reports/review-messages`, the same read the inbox uses), so a
 * reply goes through the same staff route and the same rules. Nothing here reads or writes anything.
 */
export function threadOfRound(threads: readonly StaffReportThread[] | null, reportVersionId: string): StaffReportThread | null {
  return threads?.find((thread) => thread.reportVersionId === reportVersionId) ?? null;
}

export const ROUND_THREAD_EMPTY = "No messages on this round yet.";
