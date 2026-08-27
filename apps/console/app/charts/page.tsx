import { AppShell, WorkspaceRail, TopBar } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { ChartProof } from "./ChartProof";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";

// @nzi/charts preview — the CRP chart set on illustrative mock data.
// One SVG spec renders here on screen, and the same components (chrome off)
// are what the report/PDF and client portal embed. See docs/GRAPHICS_PIPELINE.md.
export default function ChartsPage() {
  const result = loadFixtureScreen("charts", { catalogue: "crp-professional", reviewedSnapshot: "reviewed-crp-J000712-v1" });
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
        <div className="nz-chart-metrics"><div><span>Charts governed</span><strong>7</strong><small>CRP professional catalogue</small></div><div><span>Required present</span><strong>100%</strong><small>No missing visual assets</small></div><div><span>Render targets</span><strong>3</strong><small>Console · PDF · portal</small></div><div><span>Evidence state</span><strong>Current</strong><small>Reviewed snapshot v1</small></div></div>
        <ChartProof target="screen" label="Consultant console" />
      </div>
    </AppShell>
  )}</ScreenState>;
}
