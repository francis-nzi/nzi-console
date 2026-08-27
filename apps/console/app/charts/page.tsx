import { AppShell, WorkspaceRail, TopBar } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { ChartProof } from "./ChartProof";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import {
  crpChartSamples,
  crpProfessionalManifest,
  reviewedCrpSnapshotSample,
  validateManifest,
} from "@nzi/charts";

// @nzi/charts preview — the CRP chart set on illustrative mock data.
// One SVG spec renders here on screen, and the same components (chrome off)
// are what the report/PDF and client portal embed. See docs/GRAPHICS_PIPELINE.md.
export default function ChartsPage() {
  const result = loadFixtureScreen("charts", { catalogue: "crp-professional", reviewedSnapshot: "reviewed-crp-J000712-v1" });
  const requiredCharts = crpProfessionalManifest.charts.filter((chart) => chart.required);
  const resolvedIds = new Set(crpChartSamples.map((chart) => chart.spec.id));
  const requiredPresent = requiredCharts.filter((chart) => resolvedIds.has(chart.id)).length;
  const requiredPercent = requiredCharts.length ? Math.round(requiredPresent / requiredCharts.length * 100) : 0;
  const validation = validateManifest(crpProfessionalManifest, crpChartSamples, reviewedCrpSnapshotSample.id);
  const rail = <WorkspaceRail sections={NAV} activeId="emissions" user={USER} />;
  return <ScreenState result={result}>{() => (
    <AppShell rail={rail}>
      <TopBar
        searchPlaceholder="Search charts…"
        crumbs={
          <>
            Emissions <span className="muted">/</span> <b>Chart library</b>
          </>
        }
      />
      <div className="nz-head">
        <span className="nz-eyebrow">Emissions intelligence</span><h1>Visual evidence studio</h1>
        <div className="sub">
          @nzi/charts · one SVG specification → screen · PDF · portal · illustrative data only
        </div>
      </div>
      <div className="nz-body">
        <section className="nz-chart-hero"><div><span className="nz-eyebrow light">Illustrative reviewed snapshot · J000712</span><h2>From calculation lineage to publication-ready insight.</h2><p>Every visual is derived from reviewed data, carries its evidence identity, and renders consistently across every delivery surface.</p></div><div className="nz-chart-flow" aria-label="Chart governance flow"><span><b>01</b>Reviewed data</span><i aria-hidden="true">→</i><span><b>02</b>Manifest gate</span><i aria-hidden="true">→</i><span><b>03</b>Every surface</span></div></section>
        <div className="nz-chart-metrics"><div><span>Charts governed</span><strong>{crpProfessionalManifest.charts.length}</strong><small>CRP professional manifest v{crpProfessionalManifest.version}</small></div><div><span>Required present</span><strong>{requiredPercent}%</strong><small>{requiredPresent} of {requiredCharts.length} required charts resolved</small></div><div><span>Publication gate</span><strong>{validation.valid ? "Passed" : "Blocked"}</strong><small>{validation.valid ? "No manifest exceptions" : `${validation.issues.length} manifest exception${validation.issues.length === 1 ? "" : "s"}`}</small></div><div><span>Evidence state</span><strong>Illustrative</strong><small>{reviewedCrpSnapshotSample.id}</small></div></div>
        <ChartProof target="screen" label="Consultant console" />
      </div>
    </AppShell>
  )}</ScreenState>;
}
