import {
  derivePortalBaseline, derivePortalTrendYear,
  type PortalAssuredDashboard, type PortalTrendYear, type ReviewedCrpSnapshotReadModel,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { getGrantedPublishedCrpReport, resolveCrpReportingChain } from "./readModels";

// Client portal Phase 2 · A1 — the assured baseline endpoint's read model.
// §0: sourced ONLY from the content-addressed published report snapshot and the
// prior years' frozen snapshots. It never touches `job_scope_rows`
// (`resolveAssuranceTrend` would fall back to live rows for an unreviewed
// current year — the portal must not).

type PriorPayload = {
  reportingYear: number;
  target?: ReviewedCrpSnapshotReadModel["target"];
  intensityTarget?: ReviewedCrpSnapshotReadModel["intensityTarget"];
  measurements: ReviewedCrpSnapshotReadModel["measurements"];
};

/** Minimal read-model shim for the pure `@nzi/contracts` derivers. */
const asSnapshot = (payload: PriorPayload, year: number): ReviewedCrpSnapshotReadModel => ({
  id: "", jobId: "", jobNumber: "", client: "", reportingYear: payload.reportingYear ?? year, version: 0, jobVersion: 0,
  createdAt: "", createdBy: "", dataHash: "",
  target: payload.target ?? null, intensityTarget: payload.intensityTarget ?? null,
  annualComparison: [], sections: [], gapResolutions: [],
  measurements: payload.measurements ?? [],
});

export async function getPortalAssuredDashboard(
  db: Queryable,
  input: { portalUserId: string; clientId: string; jobId: string },
): Promise<PortalAssuredDashboard> {
  const report = await getGrantedPublishedCrpReport(db, input);
  if (!report) return { published: false };

  const baseline = derivePortalBaseline(report.snapshot);

  // Prior years: the reporting chain's baseline + prior entries, each read from
  // its own frozen snapshot payload. The current year is the published snapshot
  // we already have (never the chain's "latest reviewed", which may be newer
  // and unpublished).
  const chain = await resolveCrpReportingChain(db, input.jobId);
  const priorEntries = (chain?.entries ?? []).filter((entry) => entry.kind !== "current" && entry.snapshotId);
  const priorIds = priorEntries.map((entry) => entry.snapshotId!);
  const payloadById = new Map<string, PriorPayload>();
  if (priorIds.length) {
    const { rows } = await db.query<{ snapshot_id: string; payload_json: PriorPayload }>(
      `SELECT snapshot_id, payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = ANY($1)`,
      [priorIds],
    );
    for (const row of rows) payloadById.set(row.snapshot_id, row.payload_json);
  }

  const trend: PortalTrendYear[] = [
    ...priorEntries.map((entry) =>
      derivePortalTrendYear({
        year: entry.year,
        kind: entry.kind === "baseline" ? "baseline" : "prior",
        snapshot: payloadById.has(entry.snapshotId!) ? asSnapshot(payloadById.get(entry.snapshotId!)!, entry.year) : null,
      }),
    ),
    { year: baseline.reportingYear, kind: "current" as const, total: baseline.total, byScope: baseline.byScope },
  ].sort((a, b) => a.year - b.year);

  return {
    published: true,
    reportVersionId: report.reportVersionId,
    publishedAt: report.publishedAt,
    dataHash: report.dataHash,
    trend,
    ...baseline,
  };
}
