// Reporting client-review loop, S1 (RULING-reporting-client-review-state-model): the STORED lifecycle of a report version.
//
//   validated → in_client_review → client_approved → published (Final)
//                     ↑   reopen: a new round (a new version row) ──┘
//
// `published` stays the final status (D5) — a loop-completed version is marked by `final_approved_at`, not by a new value — so
// every existing consumer of `published` reads exactly what it read. `draft` is never stored; `superseded` is a prior round.
//
// Edits are an ALLOW-LIST, never a deny-list: a status this file does not name — a value added later, or one that could not be
// read — is locked, so the safe answer to "may this be edited?" is the default. Every edit path asks here.

export const REPORT_VERSION_STATUSES = ["draft", "validated", "in_client_review", "client_approved", "published", "superseded"] as const;
export type ReportVersionStatus = (typeof REPORT_VERSION_STATUSES)[number];

export const isReportVersionStatus = (value: unknown): value is ReportVersionStatus =>
  typeof value === "string" && (REPORT_VERSION_STATUSES as readonly string[]).includes(value);

/** The statuses in which the staff may amend the narrative: before the client has approved. After that, a change is a reopen (ruled). */
export const STAFF_NARRATIVE_EDITABLE_STATUSES = ["validated", "in_client_review"] as const satisfies readonly ReportVersionStatus[];
/** The statuses in which the client may edit the editable parts. Only the open review round. */
export const CLIENT_EDITABLE_STATUSES = ["in_client_review"] as const satisfies readonly ReportVersionStatus[];
/** The statuses in which a version's section order may change — presentation, set before a version goes to the client. */
export const STAFF_PLAN_EDITABLE_STATUSES = ["validated"] as const satisfies readonly ReportVersionStatus[];
/** A round that is open: sent to the client and not yet final. At most one per job and scope (0214). */
export const IN_FLIGHT_STATUSES = ["in_client_review", "client_approved"] as const satisfies readonly ReportVersionStatus[];

const within = (allowed: readonly string[], status: unknown): boolean => typeof status === "string" && allowed.includes(status);

/** May the staff amend this version's narrative? Anything unrecognised or unreadable (null, undefined, a new value) is no. */
export const staffMayEditNarrative = (status: unknown): boolean => within(STAFF_NARRATIVE_EDITABLE_STATUSES, status);
/** May the client edit this version? Only while the round is open — `client_approved` locks the client's side. */
export const clientMayEdit = (status: unknown): boolean => within(CLIENT_EDITABLE_STATUSES, status);
/** May the staff change this version's section order? */
export const staffMayEditPlan = (status: unknown): boolean => within(STAFF_PLAN_EDITABLE_STATUSES, status);
/** Is this round open — sent to the client and not yet final? */
export const isInFlight = (status: unknown): boolean => within(IN_FLIGHT_STATUSES, status);
/** Fail-safe: a version is locked unless a status explicitly says otherwise. `published` and `superseded` are locked in full. */
export const isReportLocked = (status: unknown): boolean => !staffMayEditNarrative(status) && !clientMayEdit(status) && !staffMayEditPlan(status);

/** The one reason an edit is refused, worded for the status — the same words wherever the refusal surfaces. */
export function reportEditRefusal(status: unknown): string {
  if (status === "client_approved") return "The client has approved this report, so it is locked for edits. Reopen it to change the content — the narrative carries forward and the client approves again.";
  if (status === "published") return "A published report is fixed as it was issued. Reopen it to change the content.";
  if (status === "superseded") return "This version has been superseded by a later one.";
  if (status === "in_client_review" || status === "validated") return "This change is not available at this stage.";
  return "This report is locked: its status is not one that allows edits.";
}

/**
 * D7 (job-data unlock, mid-review): the new `validated` row takes its figures from the new snapshot and its WORDS from the round it
 * replaces. For each narrative section the new plan draws, the in-flight round's frozen element wins when it has one; a section the
 * round never drew keeps the freshly resolved one. Order and membership follow the resolved narrative (the new plan), never the old.
 * A round with no frozen narrative (null — validated before 0169) carries nothing.
 */
export function carryNarrativeForward<T extends { key: string }>(resolved: readonly T[], inFlight: readonly T[] | null | undefined): { narrative: T[]; carriedKeys: string[] } {
  const earlier = new Map((inFlight ?? []).map((element) => [element.key, element] as const));
  const carriedKeys: string[] = [];
  const narrative = resolved.map((element) => {
    const kept = earlier.get(element.key);
    if (!kept) return element;
    carriedKeys.push(element.key);
    return kept;
  });
  return { narrative, carriedKeys };
}
