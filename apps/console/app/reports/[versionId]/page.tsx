import { ManifestChartSet, crpChartSamples, crpProfessionalManifest } from "@nzi/charts";
import { findReportVersion, reportVersions } from "@nzi/mock-data";
import { notFound } from "next/navigation";
import { PrintButton } from "./PrintButton";

export function generateStaticParams() { return reportVersions.map((version) => ({ versionId: version.id })); }
export default async function ReportVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const version = findReportVersion(versionId);
  if (!version) notFound();
  return <main className="report-canvas" style={{ minHeight: "100vh", background: "#E9EFEC", padding: "28px 18px", fontFamily: "var(--font-inter), Inter, sans-serif" }}>
    <style>{`@page{size:A4;margin:14mm}@media print{.report-canvas{background:white!important;padding:0!important}.report-toolbar{display:none!important}.report-sheet{box-shadow:none!important;max-width:none!important;padding:0!important}[data-report-manifest]>section>div{grid-template-columns:1fr!important}figure{break-inside:avoid;page-break-inside:avoid}section{break-inside:auto}}`}</style>
    <div className="report-toolbar" style={{ maxWidth: 1120, margin: "0 auto 12px", display: "flex", alignItems: "center", gap: 10 }}><a href="/reports" style={{ color: "#0B7A4B", textDecoration: "none", fontWeight: 600 }}>← Reports</a><span style={{ color: "#68766F", fontSize: 12 }}>{version.id} · immutable {version.status} version</span><div style={{ marginLeft: "auto" }}><PrintButton /></div></div>
    <article className="report-sheet" style={{ maxWidth: 1120, margin: "auto", background: "white", padding: 34, boxShadow: "0 8px 30px rgba(11,27,43,.1)" }}>
      <header style={{ borderBottom: "3px solid #0BA75E", paddingBottom: 22, marginBottom: 26 }}><div style={{ display: "flex", alignItems: "center" }}><div style={{ width: 38, height: 38, borderRadius: 9, background: "#0BA75E", color: "white", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 20 }}>N</div><div style={{ marginLeft: 12 }}><b style={{ fontSize: 17 }}>NZI Pro</b><div style={{ fontSize: 10, letterSpacing: ".12em", color: "#0B7A4B" }}>VERIFIED CARBON REPORT</div></div><div style={{ marginLeft: "auto", textAlign: "right", fontSize: 12, color: "#51605A" }}>{version.id}<br />Manifest v{version.manifestVersion}</div></div><h1 style={{ margin: "34px 0 7px", fontSize: 34, color: "#0B1B2B" }}>2024 Carbon Reduction Plan</h1><div style={{ fontSize: 18, color: "#51605A" }}>{version.client} · {version.jobNumber}</div></header>
      <section style={{ marginBottom: 28 }}><h2 style={h2}>Executive summary</h2><p style={body}>Bushy Tails Ltd recorded a reviewed 2024 footprint of 1,418 tCO₂e. Scope 3 remains the largest source of emissions, led by purchased goods and upstream freight. This immutable report version is assembled from the reviewed job snapshot and its versioned chart manifest.</p><div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 18 }}>{[["Total", "1,418 tCO₂e"], ["Scope 1", "146 tCO₂e"], ["Scope 2", "96 tCO₂e"], ["Scope 3", "1,176 tCO₂e"]].map(([label, value]) => <div key={label} style={{ background: "#F6F8F7", borderRadius: 8, padding: 12 }}><div style={{ color: "#68766F", fontSize: 11 }}>{label}</div><b style={{ display: "block", marginTop: 5 }}>{value}</b></div>)}</div></section>
      <ManifestChartSet manifest={crpProfessionalManifest} charts={crpChartSamples} reviewedSnapshotId={version.reviewedSnapshotId} />
      <section style={{ borderTop: "1px solid #E4EAE7", paddingTop: 20, marginTop: 10 }}><h2 style={h2}>Evidence and version record</h2><div style={{ fontSize: 11.5, color: "#51605A", lineHeight: 1.8 }}>Reviewed snapshot: <b>{version.reviewedSnapshotId}</b><br />Data hash: <b>{version.dataHash}</b><br />Template: <b>{version.templateId} · v{version.templateVersion}</b><br />Created by: <b>{version.createdBy}</b> at {version.createdAt}<br />Status: <b>{version.status}</b></div></section>
    </article>
  </main>;
}
const h2 = { fontSize: 21, color: "#0B1B2B", margin: "0 0 9px" };
const body = { color: "#51605A", fontSize: 13.5, lineHeight: 1.65, margin: 0 };
