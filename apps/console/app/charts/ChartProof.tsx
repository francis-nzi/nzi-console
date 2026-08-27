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
        <div><span className="nz-eyebrow">Render assurance</span><b>{label}</b><span>Manifest v{validation.manifestVersion} · reviewed snapshot {validation.reviewedSnapshotId}</span></div>
        <span className="nz-st est">{target}</span>
        <span className={`nz-st ${validation.valid ? "done" : "nof"}`}>{validation.valid ? "Publication gate passed" : "Publication blocked"}</span>
      </div>
      <div className="nz-chart-catalogue"><ManifestChartSet manifest={crpProfessionalManifest} charts={charts} reviewedSnapshotId={reviewedCrpSnapshotSample.id} /></div>
      <details className="nz-asset-register"><summary>Inspect derived asset identities <span>{charts.length} immutable keys</span></summary><div><div className="nz-asset-explainer"><b>Deterministic render keys</b><p>Each key binds chart specification, reviewed evidence and render target. A changed input produces a different asset identity.</p></div><ol>{charts.map((chart) => <li key={chart.spec.id}><span>{chart.spec.title}</span><code>{chartAssetKey(chart, target)}</code></li>)}</ol></div></details>
    </>
  );
}
