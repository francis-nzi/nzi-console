// Data Assurance track (M8, NZC-059/060). The Review & QA stage becomes the
// assurance surface: a multi-year emissions trend read against the baseline, a
// four-flag integrity gap engine, and a governed sign-off that freezes the same
// content-addressed reviewed snapshot the Report track consumes.

// ── DA1 · baseline / prior-year resolution ──────────────────────────────────
//
// How a CRP job finds its baseline year and the reporting years it is compared
// against. Proposal for confirmation (see the DA1 PR description):
//
//  - Baseline year  = the job's emissions target `baseline_year`
//    (`job_emissions_targets`). No target ⇒ no baseline (trend shows current +
//    priors only, no BL pill / % vs BL).
//  - Prior years    = the reviewed CRP snapshots for the SAME client_id with
//    `job_family = 'crp'` and `reporting_year < current`, one per distinct year
//    (latest `snapshot_version` wins — same rule the existing `annualComparison`
//    query in `report.snapshot.create` uses). The trend takes the baseline year
//    plus the three most recent prior years strictly between baseline and
//    current.
//  - Current year   = the job's own `reporting_year`; its latest reviewed
//    snapshot if one exists, else `live` (the unreviewed job figures the
//    assurance surface is working on).
//
// No new column on `jobs` — the chain is client + reporting-year sequence, which
// reuses the mechanism already in place. An explicit `baseline_job_id` reference
// is deliberately NOT introduced.

export type ReportingChainSource = "reviewed-snapshot" | "live" | "none";

export type ReportingChainEntry = {
  year: number;
  kind: "baseline" | "prior" | "current";
  snapshotId: string | null;
  dataHash: string | null;
  source: ReportingChainSource;
};

export type CrpReportingChain = {
  jobId: string;
  clientId: string;
  currentYear: number;
  /** From `job_emissions_targets.baseline_year`; null when no target is set. */
  baselineYear: number | null;
  /** Ascending by year: `[baseline?, …priors, current]`. */
  entries: ReportingChainEntry[];
};

/**
 * Build the ordered chain from the resolved parts. Pure — the read model does
 * the queries and hands the pieces in.
 */
export function buildReportingChain(input: {
  jobId: string;
  clientId: string;
  currentYear: number;
  baselineYear: number | null;
  /** Latest reviewed snapshot per prior reporting year (year < currentYear). */
  priorSnapshots: ReadonlyArray<{ year: number; snapshotId: string; dataHash: string }>;
  /** The job's own current-year reviewed snapshot, if one exists. */
  currentSnapshot: { snapshotId: string; dataHash: string } | null;
  /** How many prior years (excluding the baseline) to carry. */
  priorYearCount?: number;
}): CrpReportingChain {
  const priorYearCount = input.priorYearCount ?? 3;
  const byYear = new Map(input.priorSnapshots.map((snap) => [snap.year, snap]));

  const priorYears = [...byYear.keys()]
    .filter((year) => year < input.currentYear && year !== input.baselineYear)
    .sort((a, b) => b - a)
    .slice(0, priorYearCount)
    .sort((a, b) => a - b);

  const entries: ReportingChainEntry[] = [];

  if (input.baselineYear != null) {
    const snap = byYear.get(input.baselineYear) ?? null;
    entries.push({
      year: input.baselineYear,
      kind: "baseline",
      snapshotId: snap?.snapshotId ?? null,
      dataHash: snap?.dataHash ?? null,
      source: snap ? "reviewed-snapshot" : "none",
    });
  }

  for (const year of priorYears) {
    const snap = byYear.get(year)!;
    entries.push({ year, kind: "prior", snapshotId: snap.snapshotId, dataHash: snap.dataHash, source: "reviewed-snapshot" });
  }

  entries.push({
    year: input.currentYear,
    kind: "current",
    snapshotId: input.currentSnapshot?.snapshotId ?? null,
    dataHash: input.currentSnapshot?.dataHash ?? null,
    source: input.currentSnapshot ? "reviewed-snapshot" : "live",
  });

  entries.sort((a, b) => a.year - b.year);
  return { jobId: input.jobId, clientId: input.clientId, currentYear: input.currentYear, baselineYear: input.baselineYear, entries };
}
