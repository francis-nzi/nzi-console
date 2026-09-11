import type { ReviewedCrpSnapshotReadModel } from "./commands";

/**
 * NZC-005 — figure evidence. Every emissions figure on a client screen is
 * derived from a reviewed snapshot and carries its provenance signature, tier
 * and lineage. A signature is only ever read from the snapshot's issue-time
 * stamp; when there is none, provenance is null and the UI says so.
 */

export type QualityTier = "Measured" | "Estimated" | "Spend-based" | "Survey";
export type FigureTier = QualityTier | "Mixed";

const TIER_LABEL: Record<string, QualityTier> = { measured: "Measured", estimated: "Estimated", "spend-based": "Spend-based", survey: "Survey" };
export function qualityTierLabel(tier: string | null | undefined): QualityTier | null {
  return tier ? TIER_LABEL[tier] ?? null : null;
}

export type ProvenanceSignature = {
  factorSet: string;
  factorSetVersion: string;
  dataHash: string;
  asAtDate: string;
  sourceRef: string;
  resolver: string;
};

/**
 * Stamped onto a reviewed snapshot when it is issued (NZC-066) — the only source of a
 * signature. Deterministic by design (no clock), so identical data hashes alike; the
 * as-at date is the snapshot's own issue time.
 */
export type SnapshotProvenanceStamp = {
  resolver: string;
  reportingPeriod: { from: string; to: string };
  factorSets: Array<{ source: "dataset" | "client"; id: string; name: string; version: string }>;
  /** NZC-070 — the sites in the boundary, and the rows excluded because their site was outside it. */
  boundary: { siteIds: string[]; excludedRowIds: string[] };
};

export type FigureSource = { jobId: string; jobNumber: string; snapshotId: string; snapshotVersion: number; reportingYear: number };

export type FigureEvidence = {
  state: "resolved" | "unavailable";
  /** null when unavailable — never a stand-in zero. */
  value: number | null;
  unit: string;
  /** null when no row carries a tier (or the figure is unavailable). */
  qualityTier: FigureTier | null;
  /** tCO₂e by tier, largest first — how a Mixed tier is made up. */
  tiers: Array<{ tier: QualityTier; tco2e: number }>;
  provenance: ProvenanceSignature | null;
  lineage: Array<{ title: string; detail: string }>;
  source: FigureSource | null;
  /** Why the figure or its provenance is unavailable, or a qualifying note. */
  note: string | null;
};

export type ScopeFigureEvidence = FigureEvidence & { scope: "1" | "2" | "3" };

export type ClientEmissionsEvidence = {
  /** empty = no reviewed snapshot exists for the client yet. */
  state: "resolved" | "empty";
  latest: FigureEvidence;
  yoy: FigureEvidence;
  scopes: ScopeFigureEvidence[];
  intensity: FigureEvidence;
};

type Snapshot = Pick<ReviewedCrpSnapshotReadModel, "id" | "jobId" | "jobNumber" | "reportingYear" | "version" | "createdAt" | "createdBy" | "dataHash" | "measurements" | "intensityTarget" | "provenance">;

const SCOPES = ["1", "2", "3"] as const;
const TCO2E = "tCO₂e";
const ddmmyyyy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const tonnes = (value: number): string => `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${TCO2E}`;

/** The signature, read from the issue-time stamp only. */
export function provenanceFromSnapshot(snapshot: Snapshot): ProvenanceSignature | null {
  const stamp = snapshot.provenance;
  if (!stamp || stamp.factorSets.length === 0) return null;
  const sets = [...stamp.factorSets].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    factorSet: [...new Set(sets.map((set) => set.name))].join(" · "),
    factorSetVersion: sets.map((set) => `${set.name} ${set.version}`).join(" · "),
    dataHash: snapshot.dataHash,
    asAtDate: snapshot.createdAt.slice(0, 10),
    sourceRef: `${snapshot.jobNumber} · reviewed snapshot v${snapshot.version}`,
    resolver: stamp.resolver,
  };
}

function tierMix(rows: ReadonlyArray<{ qualityTier: string; tco2e: number }>): { tier: FigureTier | null; tiers: FigureEvidence["tiers"] } {
  const byTier = new Map<QualityTier, number>();
  for (const row of rows) {
    const tier = qualityTierLabel(row.qualityTier);
    if (tier) byTier.set(tier, (byTier.get(tier) ?? 0) + row.tco2e);
  }
  const tiers = [...byTier].map(([tier, tco2e]) => ({ tier, tco2e })).sort((a, b) => b.tco2e - a.tco2e);
  return { tier: tiers.length === 0 ? null : tiers.length === 1 ? tiers[0]!.tier : "Mixed", tiers };
}

const unavailable = (unit: string, note: string, source: FigureSource | null = null, lineage: FigureEvidence["lineage"] = []): FigureEvidence =>
  ({ state: "unavailable", value: null, unit, qualityTier: null, tiers: [], provenance: null, lineage, source, note });

const sum = (rows: ReadonlyArray<{ tco2e: number }>): number => rows.reduce((total, row) => total + row.tco2e, 0);

/**
 * Resolve a client's figures from its latest reviewed snapshot (`current`) and the
 * latest reviewed snapshot for an earlier reporting year (`prior`, for YoY). Pure.
 */
export function resolveClientEmissionsEvidence(input: { current: Snapshot | null; prior: Snapshot | null }): ClientEmissionsEvidence {
  const { current, prior } = input;
  if (!current) {
    const note = "No reviewed snapshot has been issued for this client, so there is no assured figure to show.";
    return {
      state: "empty",
      latest: unavailable(TCO2E, note),
      yoy: unavailable("%", note),
      scopes: SCOPES.map((scope) => ({ scope, ...unavailable(TCO2E, note) })),
      intensity: unavailable(`${TCO2E} / reporting metric`, note),
    };
  }

  const provenance = provenanceFromSnapshot(current);
  const provenanceNote = provenance ? null : "Provenance unavailable: this snapshot was issued before factor-set versions were stamped. Re-issue it to stamp them.";
  const source: FigureSource = { jobId: current.jobId, jobNumber: current.jobNumber, snapshotId: current.id, snapshotVersion: current.version, reportingYear: current.reportingYear };
  const rows = current.measurements;
  const excluded = current.provenance?.boundary.excludedRowIds.length ?? 0;
  const period = current.provenance?.reportingPeriod;
  const baseLineage: FigureEvidence["lineage"] = [
    { title: "Reviewed snapshot", detail: `${current.jobNumber} · version ${current.version} · issued ${ddmmyyyy(current.createdAt)} by ${current.createdBy}` },
    ...(period ? [{ title: "Reporting period", detail: `${ddmmyyyy(period.from)} to ${ddmmyyyy(period.to)}` }] : []),
    { title: "Rows", detail: `${rows.length} independently approved row${rows.length === 1 ? "" : "s"}${excluded ? ` · ${excluded} out-of-boundary row${excluded === 1 ? "" : "s"} excluded` : ""}` },
  ];
  const resolved = (value: number, unit: string, mix: ReturnType<typeof tierMix>, lineage: FigureEvidence["lineage"], note: string | null = provenanceNote): FigureEvidence =>
    ({ state: "resolved", value, unit, qualityTier: mix.tier, tiers: mix.tiers, provenance, lineage, source, note });

  const total = sum(rows);
  const overall = tierMix(rows);
  const latest = resolved(total, TCO2E, overall, [...baseLineage, { title: "Calculation", detail: `Scope 1 + 2 + 3 across ${rows.length} row${rows.length === 1 ? "" : "s"}` }]);

  const scopes = SCOPES.map((scope): ScopeFigureEvidence => {
    const scopeRows = rows.filter((row) => row.scope === scope);
    const lineage = [...baseLineage, { title: "Calculation", detail: `Sum of ${scopeRows.length} Scope ${scope} row${scopeRows.length === 1 ? "" : "s"}` }, { title: "Row detail", detail: "Per-row factors and tiers are visible by opening the row in the job." }];
    const note = scopeRows.length ? provenanceNote : `No Scope ${scope} rows were reported in this snapshot.`;
    return { scope, ...resolved(sum(scopeRows), TCO2E, tierMix(scopeRows), lineage, note) };
  });

  const target = current.intensityTarget;
  let intensity: FigureEvidence;
  if (!target) {
    intensity = unavailable(`${TCO2E} / reporting metric`, `No intensity metric is set on ${current.jobNumber}.`, source, baseLineage);
  } else {
    const unit = `${TCO2E} / ${target.denominatorUnit}`;
    const basis = target.denominatorBasis;
    const denominator = target.reportingDenominator;
    if (denominator === null || !(denominator > 0)) {
      const reason = basis?.kind === "site-floor-area" && basis.reason ? `Per-m² intensity unavailable: ${basis.reason}` : `No reporting denominator is recorded on ${current.jobNumber}.`;
      intensity = unavailable(unit, reason, source, baseLineage);
    } else {
      const denominatorDetail = basis?.kind === "site-floor-area"
        ? `${denominator.toLocaleString("en-GB")} m² — the sum of ${basis.sites.length} in-boundary site${basis.sites.length === 1 ? "" : "s"}' floor area (${basis.sites.map((site) => site.name).join(", ")})`
        : `${denominator.toLocaleString("en-GB")} ${target.denominatorUnit} — the reporting-year ${target.metric} recorded on ${current.jobNumber}`;
      intensity = resolved(total / denominator, unit, overall, [...baseLineage, { title: "Numerator", detail: `${tonnes(total)} assured total` }, { title: "Denominator", detail: denominatorDetail }]);
    }
  }

  let yoy: FigureEvidence;
  const priorTotal = prior ? sum(prior.measurements) : null;
  if (!prior || priorTotal === null) {
    yoy = unavailable("%", `No reviewed snapshot for an earlier reporting year to compare ${current.reportingYear} against.`, source, baseLineage);
  } else if (!(priorTotal > 0)) {
    yoy = unavailable("%", `${prior.jobNumber} has no reviewed emissions to compare against.`, source, baseLineage);
  } else {
    yoy = resolved((total / priorTotal - 1) * 100, "%", overall, [
      ...baseLineage,
      { title: "Compared with", detail: `${prior.jobNumber} · version ${prior.version} · ${prior.reportingYear} · ${tonnes(priorTotal)}` },
      { title: "Calculation", detail: `(${tonnes(total)} ÷ ${tonnes(priorTotal)}) − 1` },
    ]);
  }

  return { state: "resolved", latest, yoy, scopes, intensity };
}
