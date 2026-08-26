import {
  ManifestChartSet, chartAssetKey, crpChartSamples, crpProfessionalManifest,
  reviewedCrpSnapshotSample, validateManifest, type RenderTarget,
} from "@nzi/charts";

export function ChartProof({ target, label }: { target: RenderTarget; label: string }) {
  const charts = crpChartSamples;
  const validation = validateManifest(crpProfessionalManifest, charts, reviewedCrpSnapshotSample.id);
  return (
    <>
      <div className="nz-chart-register-head">
        <span className={`nz-st ${validation.valid ? "done" : "nof"}`}>{validation.valid ? "Publication gate passed" : "Publication blocked"}</span>
        <span style={{ color: "var(--t2)" }}>{label} · manifest v{validation.manifestVersion} · snapshot {validation.reviewedSnapshotId}</span>
      </div>
      <div className="nz-chart-catalogue"><ManifestChartSet manifest={crpProfessionalManifest} charts={charts} reviewedSnapshotId={reviewedCrpSnapshotSample.id} /></div>
      <details className="nz-asset-register"><summary>Inspect derived asset identities <span>{charts.length} immutable keys</span></summary><div>
        <b style={{ color: "var(--t1)" }}>Derived asset identities</b>
        {charts.map((chart) => <div key={chart.spec.id} className="num" style={{ marginTop: 5, overflowWrap: "anywhere" }}>{chartAssetKey(chart, target)}</div>)}
      </div></details>
    </>
  );
}
