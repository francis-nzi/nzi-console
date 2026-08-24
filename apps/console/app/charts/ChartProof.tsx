import {
  EmissionsScopeDonut, ReductionPathway, chartAssetKey, crpProfessionalManifest,
  reductionPathwaySample, reviewedCrpSnapshotSample, scopeDonutSample, validateManifest,
  type RenderTarget,
} from "@nzi/charts";

export function ChartProof({ target, label }: { target: RenderTarget; label: string }) {
  const charts = [scopeDonutSample, reductionPathwaySample];
  const validation = validateManifest(crpProfessionalManifest, charts, reviewedCrpSnapshotSample.id);
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, fontSize: 12 }}>
        <span className={`nz-st ${validation.valid ? "done" : "nof"}`}>{validation.valid ? "Publication gate passed" : "Publication blocked"}</span>
        <span style={{ color: "var(--t2)" }}>{label} · manifest v{validation.manifestVersion} · snapshot {validation.reviewedSnapshotId}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 18, maxWidth: 1120 }}>
        <EmissionsScopeDonut data={scopeDonutSample} />
        <ReductionPathway data={reductionPathwaySample} />
      </div>
      <div style={{ marginTop: 14, padding: 12, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, fontSize: 11, color: "var(--t2)" }}>
        <b style={{ color: "var(--t1)" }}>Derived asset identities</b>
        {charts.map((chart) => <div key={chart.spec.id} className="num" style={{ marginTop: 5, overflowWrap: "anywhere" }}>{chartAssetKey(chart, target)}</div>)}
      </div>
    </>
  );
}
