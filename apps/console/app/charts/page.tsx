import { AppShell, WorkspaceRail, TopBar } from "@nzi/ui";
import {
  EmissionsScopeDonut,
  ReductionPathway,
  scopeDonutSample,
  reductionPathwaySample,
} from "@nzi/charts";
import { NAV, USER } from "../lib/nav";

// @nzi/charts preview — the CRP chart set on illustrative mock data.
// One SVG spec renders here on screen, and the same components (chrome off)
// are what the report/PDF and client portal embed. See docs/GRAPHICS_PIPELINE.md.
export default function ChartsPage() {
  const rail = <WorkspaceRail sections={NAV} activeId="emissions" user={USER} />;
  return (
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
            gap: 18,
            maxWidth: 1120,
            paddingTop: 16,
          }}
        >
          <EmissionsScopeDonut data={scopeDonutSample} />
          <ReductionPathway data={reductionPathwaySample} />
        </div>
      </div>
    </AppShell>
  );
}
