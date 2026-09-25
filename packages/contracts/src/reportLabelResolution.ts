/**
 * What a row is called in the client's report (NZC-109).
 *
 * Three things can supply that name, and they are ordered by how specific the decision was — the
 * narrowest wins, because a consultant who said something about *this row* meant this row:
 *
 * 1. **A name chosen on the row.** Within one job, a consultant can rename a single line: two sites
 *    on the same grid factor, one of which the client calls something particular.
 * 2. **A name this client uses for this factor.** The durable one. Keyed to the client and the
 *    factor, so it applies wherever that factor appears and survives into next year's job without
 *    being re-typed (`client_factor_aliases`, 0095).
 * 3. **The source label.** What the consultant called the source when they entered it.
 *
 * ## How "chosen on the row" is known
 *
 * There is no flag saying a row was renamed, and adding one would leave two facts to keep in step.
 * The row's label and its source label are written together and are equal exactly while nobody has
 * intervened — so they differ if and only if somebody chose a name. That is the same test the sync
 * paths use to decide what they may overwrite (NZC-108), which is what keeps the two consistent:
 * the rule that protects a chosen name is the rule that recognises it.
 *
 * ## A client's own factor names itself
 *
 * A factor from `client_factors` (0034) belongs to one client already and carries its own
 * `report_label` — its name *is* the client's name for it, and there is nothing to alias. So the
 * alias table answers only for shared dataset factors. Different factor kinds, different sources,
 * no conflict between them.
 *
 * ## Resolved on read, frozen at issue
 *
 * This runs when a screen or a report is built, never as a stored copy — so renaming a factor
 * retitles every live view at once instead of leaving rows to be migrated. An issued snapshot is
 * the exception and deliberately so: it is content-hashed evidence a client or auditor holds, it
 * already freezes the factor label and everything else, and a report must not silently reword
 * itself after the fact. Renaming a factor today does not retitle a report published last year.
 */

export type ReportLabelSources = {
  /** `job_scope_rows.report_label` — equal to the source label until somebody chooses otherwise. */
  rowReportLabel: string | null;
  /** `job_scope_rows.source_label` — what the consultant called the source. */
  sourceLabel: string;
  /** Which kind of factor the row carries. A client's own factor names itself. */
  factorSource?: "dataset" | "client" | null;
  /** The client's alias for this dataset factor, if one is in force. */
  alias?: string | null;
  /** The factor identity's curated report wording (0125), held once for every edition. */
  identityReportLabel?: string | null;
  /** A client factor's own `report_label` (0034), when the row carries one. */
  clientFactorLabel?: string | null;
};

const present = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

/** Whether somebody chose this row's name, as opposed to it having been filled in automatically. */
export const rowLabelWasChosen = (rowReportLabel: string | null, sourceLabel: string): boolean =>
  present(rowReportLabel) && rowReportLabel.trim() !== sourceLabel.trim();

/** The name to print, and where it came from — the second is what an evidence drawer shows. */
export type ResolvedReportLabel = { label: string; from: "row" | "alias" | "identity" | "clientFactor" | "source" };

export function resolveReportLabel(sources: ReportLabelSources): ResolvedReportLabel {
  if (rowLabelWasChosen(sources.rowReportLabel, sources.sourceLabel)) {
    return { label: sources.rowReportLabel!.trim(), from: "row" };
  }
  if (sources.factorSource === "client") {
    // A client's own factor carries its own name; an alias never applies to one.
    if (present(sources.clientFactorLabel)) return { label: sources.clientFactorLabel.trim(), from: "clientFactor" };
    return { label: sources.sourceLabel.trim(), from: "source" };
  }
  if (present(sources.alias)) return { label: sources.alias.trim(), from: "alias" };
  // NZI's curated report wording for the factor, the same for every edition of it (REFERENCE_DATA_DESIGN §2).
  if (present(sources.identityReportLabel)) return { label: sources.identityReportLabel.trim(), from: "identity" };
  // Falls back to the row's own label where it has one — which, not having been chosen, equals the
  // source label anyway; taking it rather than recomputing keeps a legacy row printing what it has
  // always printed.
  if (present(sources.rowReportLabel)) return { label: sources.rowReportLabel.trim(), from: "source" };
  return { label: sources.sourceLabel.trim(), from: "source" };
}

/** The alias key: one client's name for one shared factor, across every edition of it (0125). */
export const factorAliasKey = (factorId: string) => factorId;
