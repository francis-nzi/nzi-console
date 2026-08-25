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
        <h1>Emissions chart library</h1>
        <div className="sub">
          @nzi/charts · one SVG spec → screen · PDF · portal · illustrative data only
        </div>
      </div>
      <div className="nz-body">
        <div style={{ paddingTop: 16 }}><ChartProof target="screen" label="Consultant console" /></div>
      </div>
    </AppShell>
  )}</ScreenState>;
}
