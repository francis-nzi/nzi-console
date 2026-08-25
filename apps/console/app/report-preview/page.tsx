import { ChartProof } from "../charts/ChartProof";
import { EmissionsByActivity, EmissionsScopeDonut, EmissionsSiteDonut, IntensityPathway, PurchasedGoodsBreakdown, ReductionPathway, ScopeYearOnYearBar, emissionsByActivitySample, emissionsSiteDonutSample, intensityPathwaySample, purchasedGoodsBreakdownSample, reductionPathwaySample, scopeDonutSample, scopeYearOnYearSample } from "@nzi/charts";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";

export default function ReportPreviewPage() {
  const result = loadFixtureScreen("report", { report: { id: "CRP-J000712-preview", reviewedSnapshotId: "reviewed-crp-J000712-v1" } });
  return <ScreenState result={result}>{() => (
    <main style={{ background: "#eef2f0", minHeight: "100vh", padding: 32, fontFamily: "var(--font-inter), Inter, sans-serif" }}>
      <section style={{ background: "white", maxWidth: 1180, margin: "0 auto", padding: 28, boxShadow: "0 4px 24px rgba(11,27,43,.08)" }}>
        <div style={{ color: "#0BA75E", fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>NZI Professional Report · J000712</div>
        <h1 style={{ color: "#0B1B2B", margin: "8px 0 4px" }}>Carbon performance</h1>
        <p style={{ color: "#51605A", margin: "0 0 22px" }}>Print/PDF preview · same reviewed chart objects</p>
        <ChartProof target="print" label="Print and PDF" />

        <div style={{ marginTop: 42, paddingTop: 28, borderTop: "1px solid #E4EAE7" }}>
          <div style={{ color: "#0BA75E", fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Large-format chart review</div>
          <h2 style={{ color: "#0B1B2B", margin: "8px 0 4px", fontSize: 24 }}>Full-width report graphics</h2>
          <p style={{ color: "#51605A", margin: "0 0 22px" }}>The same chart components and reviewed data, each shown in its own larger container.</p>
          <div style={{ display: "grid", gap: 26 }}>
            <div style={{ width: "100%" }}><EmissionsScopeDonut data={scopeDonutSample} /></div>
            <div style={{ width: "100%" }}><ReductionPathway data={reductionPathwaySample} /></div>
            <div style={{ width: "100%" }}><ScopeYearOnYearBar data={scopeYearOnYearSample} /></div>
            <div style={{ width: "100%" }}><EmissionsByActivity data={emissionsByActivitySample} /></div>
            <div style={{ width: "100%" }}><EmissionsSiteDonut data={emissionsSiteDonutSample} /></div>
            <div style={{ width: "100%" }}><IntensityPathway data={intensityPathwaySample} /></div>
            <div style={{ width: "100%" }}><PurchasedGoodsBreakdown data={purchasedGoodsBreakdownSample} /></div>
          </div>
        </div>
      </section>
    </main>
  )}</ScreenState>;
}
