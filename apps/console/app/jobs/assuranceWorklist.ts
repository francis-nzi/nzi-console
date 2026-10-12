// SPEC-review-surface-readiness §2 — the reviewer's working list in the Data assurance stage. Pure: what is still to do and what
// is done, from the same audit rows and gaps the surface already reads. A row is done once it is approved and none of its own
// gaps is open; done rows leave the "to do" list but stay reachable under "done". Nothing here changes a row or a gap.
import type { AssuranceAuditRow, AssuranceGap } from "@nzi/contracts";

export type Worklist = "todo" | "done" | "all";
export type GapFilter = "open" | "resolved" | "all";

const openGapRowIds = (gaps: readonly AssuranceGap[]) =>
  new Set(gaps.filter((gap) => !gap.resolved && gap.scopeRowId).map((gap) => gap.scopeRowId as string));

/** Approved, with none of its own gaps open. */
export function auditRowIsDone(row: AssuranceAuditRow, gaps: readonly AssuranceGap[]): boolean {
  return row.reviewStatus === "approved" && !openGapRowIds(gaps).has(row.rowId);
}

export function filterAuditRows(rows: readonly AssuranceAuditRow[], gaps: readonly AssuranceGap[], worklist: Worklist): AssuranceAuditRow[] {
  if (worklist === "all") return [...rows];
  const open = openGapRowIds(gaps);
  const done = (row: AssuranceAuditRow) => row.reviewStatus === "approved" && !open.has(row.rowId);
  return rows.filter((row) => (worklist === "done" ? done(row) : !done(row)));
}

export function filterGaps(gaps: readonly AssuranceGap[], filter: GapFilter): AssuranceGap[] {
  return filter === "all" ? [...gaps] : gaps.filter((gap) => (filter === "open" ? !gap.resolved : gap.resolved));
}

/** The counts the surface shows, from the same data — so they move whenever the data does. */
export function worklistCounts(rows: readonly AssuranceAuditRow[], gaps: readonly AssuranceGap[]) {
  const done = filterAuditRows(rows, gaps, "done").length;
  const openGaps = gaps.filter((gap) => !gap.resolved).length;
  return {
    todo: rows.length - done, done,
    awaitingReview: rows.filter((row) => row.reviewStatus !== "approved").length,
    approved: rows.filter((row) => row.reviewStatus === "approved").length,
    openGaps, resolvedGaps: gaps.length - openGaps,
  };
}
