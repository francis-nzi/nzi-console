// Reporting F-4b (ruled on F-4a's staff-identity finding): what of a published report reaches the client's browser. The
// portal draws the client's figures; it never needs to know which of the issuer's staff prepared, approved, reviewed or last
// edited them. Those identities are internal and undrawn, so they are left out of the client's copy at the read — data
// minimisation, not presentation: a name the client is not shown is a name the client is not sent.
import type { PublishedCrpReportReadModel, ReviewedCrpSnapshotReadModel } from "./commands";
import { isReportGap, type ReportComposition } from "./reportComposition";

/**
 * The client's copy of a frozen composition.
 * - D6 (F-4a): no internal owner of a reduction action.
 * - F-4b (ruled): no reviewer either. The Methodology's "Reviewed by" line goes with it (`reportMethodologyRows` drops an
 *   empty reviewer): no name, and no organisation in its place; the cover's internal-review statement stands alone.
 * Taken out at the read, so neither name reaches the client's browser; the staff copy keeps both. Every figure is the client's
 * own and stands as frozen. Pure, so the staff preview of the client's view applies the same strip.
 */
export function clientFacingComposition(composition: ReportComposition): ReportComposition {
  const assurance = { ...composition.assurance, reviewedBy: "" };
  // F-2's chart basis froze the reported intensity target whole — its last editor included (found by F-4b's leak test). The
  // chart needs the figures, never the editor: dropped from the client's copy like every other staff identity.
  const chartBasis = composition.chartBasis?.intensityTarget
    ? { ...composition.chartBasis, intensityTarget: omit(composition.chartBasis.intensityTarget, "updatedBy") }
    : composition.chartBasis;
  const base = { ...composition, assurance, ...(chartBasis ? { chartBasis } : {}) };
  if (isReportGap(composition.plan)) return base;
  return {
    ...base,
    plan: { ...composition.plan, groups: composition.plan.groups.map((group) => ({ ...group, strategies: group.strategies.map((strategy) => ({ ...strategy, owner: "" })) })) },
  };
}

type Snapshot = ReviewedCrpSnapshotReadModel;
type Without<T, K extends keyof T> = Omit<T, K>;

/** The snapshot as the client receives it: every staff identity removed, every figure as frozen. */
export type ClientFacingSnapshot = Without<Snapshot, "createdBy" | "approvedBy" | "target" | "intensityTarget" | "sections" | "gapResolutions" | "measurements"> & {
  target: Without<NonNullable<Snapshot["target"]>, "updatedBy"> | null;
  intensityTarget: Without<NonNullable<Snapshot["intensityTarget"]>, "updatedBy"> | null;
  sections: Array<Without<Snapshot["sections"][number], "updatedBy">>;
  gapResolutions: Array<Without<Snapshot["gapResolutions"][number], "resolvedBy">>;
  measurements: Array<Without<Snapshot["measurements"][number], "reviewedBy">>;
};
export type ClientFacingPublishedCrpReport = Without<PublishedCrpReportReadModel, "snapshot"> & { snapshot: ClientFacingSnapshot };

/** The staff identities a published report carries, by path — the list the strip and its test share. */
export const CLIENT_WITHHELD_IDENTITY_FIELDS = [
  "snapshot.createdBy", "snapshot.approvedBy", "snapshot.target.updatedBy", "snapshot.intensityTarget.updatedBy",
  "snapshot.sections[].updatedBy", "snapshot.gapResolutions[].resolvedBy", "snapshot.measurements[].reviewedBy",
] as const;

const omit = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> => {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
};

/** The client's copy of a published report: the same report, without who on the issuer's side touched it. */
export function clientFacingPublishedReport(report: PublishedCrpReportReadModel): ClientFacingPublishedCrpReport {
  const { snapshot } = report;
  return {
    ...report,
    snapshot: {
      ...omit(snapshot, "createdBy", "approvedBy"),
      target: snapshot.target ? omit(snapshot.target, "updatedBy") : null,
      intensityTarget: snapshot.intensityTarget ? omit(snapshot.intensityTarget, "updatedBy") : null,
      sections: snapshot.sections.map((section) => omit(section, "updatedBy")),
      gapResolutions: snapshot.gapResolutions.map((resolution) => omit(resolution, "resolvedBy")),
      measurements: snapshot.measurements.map((row) => omit(row, "reviewedBy")),
    },
  };
}
