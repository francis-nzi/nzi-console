"use client";
import { useState } from "react";
import { EmissionsByActivity, EmissionsScopeDonut, ReductionPathway, ScopeYearOnYearBar, crpProfessionalManifest, emissionsByActivitySample, reductionPathwaySample, reviewedCrpSnapshotSample, scopeDonutSample, scopeYearOnYearSample, validateManifest } from "@nzi/charts";
import { canEnterPortalData, portalAccessSample, portalBucketsSample, publishedReportSample } from "@nzi/mock-data";

type Tab = "results" | "data" | "documents" | "messages";
export function PortalWorkspace() {
  const [tab, setTab] = useState<Tab>("results");
  const tabs: Array<{ id: Tab; label: string }> = [{ id: "results", label: "Results" }, { id: "data", label: "Data entry" }, { id: "documents", label: "Documents" }, { id: "messages", label: "Messages" }];
  return <div style={{ minHeight: "100vh", background: "#F3F7F5", color: "#0B1B2B", fontFamily: "var(--font-inter), Inter, sans-serif" }}>
    <header style={{ background: "#0B1B2B", color: "white", padding: "0 32px" }}><div style={{ maxWidth: 1220, margin: "auto", height: 72, display: "flex", alignItems: "center", gap: 16 }}><div style={{ width: 32, height: 32, borderRadius: 8, background: "#0BA75E", display: "grid", placeItems: "center", fontWeight: 700 }}>N</div><div><b>NZI Pro</b><div style={{ fontSize: 10, letterSpacing: ".12em", color: "#9CCDB4" }}>CLIENT PORTAL</div></div><div style={{ marginLeft: "auto", textAlign: "right" }}><b style={{ fontSize: 13 }}>Priya Nair</b><div style={{ fontSize: 11, color: "#AAB8B2" }}>Bushy Tails Ltd · client user</div></div></div></header>
    <div style={{ background: "white", borderBottom: "1px solid #E4EAE7" }}><div style={{ maxWidth: 1220, margin: "auto", display: "flex", gap: 4 }}>{tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} style={{ padding: "15px 18px", border: 0, borderBottom: tab === item.id ? "3px solid #0BA75E" : "3px solid transparent", background: "transparent", color: tab === item.id ? "#0B1B2B" : "#68766F", fontWeight: tab === item.id ? 600 : 500, cursor: "pointer" }}>{item.label}</button>)}</div></div>
    <main style={{ maxWidth: 1220, margin: "0 auto", padding: "28px 24px 48px" }}><div style={{ display: "flex", alignItems: "flex-start", marginBottom: 22 }}><div><div style={{ color: "#0BA75E", fontSize: 11, fontWeight: 700, letterSpacing: ".1em" }}>J000712 · CARBON REDUCTION PLAN</div><h1 style={{ margin: "5px 0 3px", fontSize: 30 }}>{tab === "results" ? "Your carbon impact" : tab === "data" ? "Provide activity data" : tab === "documents" ? "Reports and documents" : "Review messages"}</h1><div style={{ color: "#68766F", fontSize: 13 }}>Reporting year 2024 · published and verified by NZI consultants</div></div><span style={{ marginLeft: "auto", background: "#DFF5E9", color: "#0B7A4B", padding: "7px 11px", borderRadius: 20, fontSize: 12, fontWeight: 600 }}>Published version v1</span></div>
      {tab === "results" && <Results />}{tab === "data" && <DataEntry />}{tab === "documents" && <Documents />}{tab === "messages" && <Messages />}
    </main>
  </div>;
}

function Results() {
  const validation = validateManifest(crpProfessionalManifest, [scopeDonutSample, reductionPathwaySample, scopeYearOnYearSample, emissionsByActivitySample], reviewedCrpSnapshotSample.id);
  return <><div style={notice}><div><b>Verified report version</b><div style={small}>This view is fixed to {publishedReportSample.id}; later consultant edits cannot silently change it.</div></div><span style={{ marginLeft: "auto", fontSize: 12 }}>{validation.valid ? "Evidence matched" : "Unavailable"}</span></div><div style={grid}><EmissionsScopeDonut data={scopeDonutSample} /><ReductionPathway data={reductionPathwaySample} /><ScopeYearOnYearBar data={scopeYearOnYearSample} /><EmissionsByActivity data={emissionsByActivitySample} /></div></>;
}

function DataEntry() {
  const open = canEnterPortalData(portalAccessSample, "2026-08-24T00:00:00Z");
  return <><div style={notice}><div><b>{open ? "Data-entry window is open" : "Data-entry window is closed"}</b><div style={small}>Access expires 30 Sep 2026. You can only see categories authorised for this job.</div></div></div><div style={card}><table className="nz-tbl"><thead><tr><th>Category</th><th>Scope</th><th>Allowed units</th><th className="num">Rows</th><th>Status</th><th /></tr></thead><tbody>{portalBucketsSample.map((bucket) => <tr key={bucket.id}><td style={{ fontWeight: 600 }}>{bucket.label}</td><td>{bucket.scope}</td><td>{bucket.allowedUnits.join(" · ")}</td><td className="num">{bucket.rows}</td><td><span className={`nz-st ${bucket.status === "complete" ? "done" : bucket.status === "submitted" ? "est" : "need"}`}>{bucket.status.replace("-", " ")}</span></td><td><button className="nz-btn" disabled={!open}>{bucket.rows ? "Open" : "Add data"}</button></td></tr>)}</tbody></table></div><p style={foot}>Factor selection and final calculations remain consultant-controlled. Submitted data enters the internal review queue before inclusion.</p></>;
}

function Documents() { return <div style={card}>{[["CRP-J000712-v1.pdf", "Published report · 2.4 MB"], ["Emissions certificate.pdf", "Certificate · 340 KB"], ["Methodology statement.pdf", "Reference · 520 KB"]].map(([name, detail]) => <div key={name} style={{ display: "flex", padding: "16px 4px", borderBottom: "1px solid #EDF1EF", alignItems: "center" }}><div><b>{name}</b><div style={small}>{detail}</div></div><button className="nz-btn" style={{ marginLeft: "auto" }}>Download</button></div>)}</div>; }
function Messages() { return <div style={card}><div style={{ padding: 14, borderRadius: 8, background: "#F6F8F7" }}><b>A. Shaw · NZI reviewer</b><p style={{ margin: "6px 0 0", color: "#51605A", fontSize: 13 }}>The 2024 report is published. Please use this thread for questions about the results or supporting evidence.</p></div><textarea className="nz-notes" style={{ marginTop: 16, width: "100%" }} placeholder="Reply to the NZI review team…" /><div style={{ textAlign: "right", marginTop: 10 }}><button className="nz-btn pri">Send message</button></div></div>; }

const grid = { display: "grid", gridTemplateColumns: "repeat(2, minmax(420px, 1fr))", gap: 18 };
const card = { background: "white", border: "1px solid #E4EAE7", borderRadius: 12, padding: 18 };
const notice = { display: "flex", alignItems: "center", background: "#DFF5E9", color: "#0B7A4B", border: "1px solid #BCE8D0", borderRadius: 10, padding: "13px 16px", marginBottom: 18 };
const small = { fontSize: 12, color: "#68766F", marginTop: 3 };
const foot = { fontSize: 12, color: "#68766F", marginTop: 12 };
