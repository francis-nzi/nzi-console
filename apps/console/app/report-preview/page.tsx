import { ChartProof } from "../charts/ChartProof";

export default function ReportPreviewPage() {
  return (
    <main style={{ background: "#eef2f0", minHeight: "100vh", padding: 32, fontFamily: "var(--font-inter), Inter, sans-serif" }}>
      <section style={{ background: "white", maxWidth: 1180, margin: "0 auto", padding: 28, boxShadow: "0 4px 24px rgba(11,27,43,.08)" }}>
        <div style={{ color: "#0BA75E", fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>NZI Professional Report · J000712</div>
        <h1 style={{ color: "#0B1B2B", margin: "8px 0 4px" }}>Carbon performance</h1>
        <p style={{ color: "#51605A", margin: "0 0 22px" }}>Print/PDF preview · same reviewed chart objects</p>
        <ChartProof target="print" label="Print and PDF" />
      </section>
    </main>
  );
}
