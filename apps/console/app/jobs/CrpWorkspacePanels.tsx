"use client";
import { useMemo, useState } from "react";
import { addManualDataset, datasets, recommendDatasets, type DatasetSelection, type Job } from "@nzi/mock-data";
import { EmissionsByActivity, EmissionsScopeDonut, ReductionPathway, ScopeYearOnYearBar, crpProfessionalManifest, emissionsByActivitySample, reductionPathwaySample, reviewedCrpSnapshotSample, scopeDonutSample, scopeYearOnYearSample, validateManifest } from "@nzi/charts";

export type CrpStage = "scope" | "data" | "mapping" | "review" | "report";
const context = { reportingFrom: "2024-01-01", reportingTo: "2024-12-31", country: "GB" };

export function CrpWorkspacePanel({ stage, job }: { stage: CrpStage; job: Job }) {
  if (stage === "scope") return <ScopeConfiguration />;
  if (stage === "data") return <ImportWorkspace job={job} />;
  if (stage === "mapping") return <FactorMapping job={job} />;
  if (stage === "review") return <ReviewQueue job={job} />;
  return <ReportPublish />;
}

function ScopeConfiguration() {
  const automatic = useMemo(() => recommendDatasets(context), []);
  const [manual, setManual] = useState<DatasetSelection[]>([]);
  const [datasetId, setDatasetId] = useState("epa-2024");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  function add() { try { setManual((items) => [...items, addManualDataset(datasetId, context, reason)]); setReason(""); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  return <div className="nz-body" style={{ paddingTop: 18 }}>
    <div className="nz-panel" style={{ padding: 20 }}><div style={{ display: "flex", justifyContent: "space-between" }}><div><h2 style={h2}>Scope and datasets</h2><p style={lead}>Reporting period drives the recommended factor datasets automatically. Additional datasets remain explicit and audited.</p></div><span className="nz-st done">Period matched</span></div>
      <div className="nz-metrics" style={{ marginTop: 18 }}><Metric label="Reporting from" value="1 Jan 2024" /><Metric label="Reporting to" value="31 Dec 2024" /><Metric label="Geography" value="United Kingdom" /><Metric label="Included scopes" value="1 · 2 · 3" /></div>
      <h3 style={h3}>Automatically selected</h3><DatasetTable selections={automatic} />
      <h3 style={h3}>Add another dataset</h3><div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 10 }}><select className="nz-sel" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.version} · {dataset.country}</option>)}</select><input className={`nz-inp${error ? " bad" : ""}`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason required for manual addition" /><button className="nz-btn pri" onClick={add}>Add dataset</button></div>{error && <div className="nz-hint bad">{error}</div>}{manual.length > 0 && <div style={{ marginTop: 12 }}><DatasetTable selections={manual} /></div>}
    </div>
  </div>;
}

function DatasetTable({ selections }: { selections: DatasetSelection[] }) { return <div className="nz-panel"><table className="nz-tbl"><thead><tr><th>Dataset</th><th>Version</th><th>Scopes</th><th>Method</th><th>Selection</th><th>Validation</th></tr></thead><tbody>{selections.map((item) => <tr key={`${item.source}-${item.dataset.id}`}><td>{item.dataset.name}</td><td>{item.dataset.version}</td><td>{item.dataset.scopes.join(", ")}</td><td>{item.dataset.method}</td><td><span className={`nz-st ${item.source === "automatic" ? "done" : "est"}`}>{item.source}</span></td><td>{item.warnings.length ? <span className="nz-st nof">{item.warnings.join(" ")}</span> : <span className="nz-st done">Matched</span>}</td></tr>)}</tbody></table></div>; }

function ImportWorkspace({ job }: { job: Job }) { return <Panel title="Data collection and import" subtitle="Preflight validates structure, units and duplicates before any rows are committed."><div className="nz-metrics"><Metric label="Template" value="CRP 2024 · v3" /><Metric label="Rows detected" value="214" /><Metric label="Ready to import" value="207" /><Metric label="Needs attention" value="7" /></div><div className="nz-banner warn" style={{ marginTop: 18 }}><div><b>Preflight only.</b> Seven rows need unit or duplicate resolution; no data has been committed.</div></div><div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}><button className="nz-btn">Download template</button><button className="nz-btn">Run preflight</button><button className="nz-btn pri">Commit {job.rows.length} validated examples</button></div></Panel>; }

function FactorMapping({ job }: { job: Job }) { const missing = job.rows.filter((row) => !row.factorMatched); return <Panel title="Factor mapping" subtitle="Automatic matches use the selected dataset set; exceptions retain their reason and provenance."><div className="nz-metrics"><Metric label="Rows" value={`${job.counts.all}`} /><Metric label="Matched" value={`${job.rows.filter((row) => row.factorMatched).length}`} /><Metric label="Unmatched" value={`${missing.length}`} /><Metric label="Dataset exceptions" value="0" /></div>{missing.map((row) => <div className="nz-banner warn" key={row.id} style={{ marginTop: 16 }}><div style={{ flex: 1 }}><b>{row.source}</b><div style={{ marginTop: 3 }}>{row.factorText}</div></div><button className="nz-btn pri">Match factor</button></div>)}</Panel>; }

function ReviewQueue({ job }: { job: Job }) { const review = job.rows.filter((row) => row.status !== "complete" || row.quality === "Estimated" || row.quality === "Spend-based"); return <Panel title="Review and QA" subtitle="Independent review covers unresolved data, estimates, spend proxies and material overrides."><div className="nz-metrics"><Metric label="Pending review" value={`${review.length}`} /><Metric label="Estimated" value={`${job.counts.estimated}`} /><Metric label="Needs data" value={`${job.counts.needs}`} /><Metric label="Overrides" value="0" /></div><div className="nz-panel" style={{ marginTop: 18 }}><table className="nz-tbl"><thead><tr><th>Source</th><th>Scope</th><th>Quality</th><th>Result</th><th>QA state</th></tr></thead><tbody>{review.map((row) => <tr key={row.id}><td>{row.source}</td><td>{row.scope}</td><td>{row.quality}</td><td>{row.tco2e ?? "—"}</td><td><span className={`nz-st ${row.status === "needs" ? "nof" : "est"}`}>{row.status === "needs" ? "Blocked" : "Review"}</span></td></tr>)}</tbody></table></div></Panel>; }

function ReportPublish() {
  const [published, setPublished] = useState(false);
  const charts = [scopeDonutSample, reductionPathwaySample, scopeYearOnYearSample, emissionsByActivitySample];
  const validation = validateManifest(crpProfessionalManifest, charts, reviewedCrpSnapshotSample.id);
  return <Panel title="Report, validation and portal release" subtitle="The manifest assembles canonical graphics and the same validator gates report, PDF and portal publication."><div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}><span className={`nz-st ${validation.valid ? "done" : "nof"}`}>{validation.valid ? "Manifest valid" : "Publication blocked"}</span><span className="sub">CRP professional manifest v{validation.manifestVersion} · reviewed snapshot {validation.reviewedSnapshotId}</span></div><div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(360px, 1fr))", gap: 16 }}><EmissionsScopeDonut data={scopeDonutSample} /><ReductionPathway data={reductionPathwaySample} /><ScopeYearOnYearBar data={scopeYearOnYearSample} /><EmissionsByActivity data={emissionsByActivitySample} /></div><div className={`nz-banner ${published ? "ok" : "warn"}`} style={{ marginTop: 18 }}><div><b>{published ? "Published to client portal." : "Ready to publish."}</b><div style={{ marginTop: 3 }}>{published ? "Immutable report version CRP-J000712-v1 created from the reviewed snapshot." : "Publication creates an immutable version and releases that exact version to authorised portal users."}</div></div></div><div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}><a className="nz-btn" href="/report-preview">Preview report</a><a className="nz-btn" href="/portal-preview">Preview portal</a><button className="nz-btn pri" disabled={!validation.valid || published} onClick={() => setPublished(true)}>{published ? "Published" : "Publish and send to portal"}</button></div></Panel>;
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <div className="nz-body" style={{ paddingTop: 18 }}><div className="nz-panel" style={{ padding: 20 }}><h2 style={h2}>{title}</h2><p style={lead}>{subtitle}</p><div style={{ marginTop: 18 }}>{children}</div></div></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="nz-metric"><div className="l">{label}</div><div className="v">{value}</div></div>; }
const h2 = { margin: 0, fontSize: 20 };
const h3 = { margin: "24px 0 10px", fontSize: 14 };
const lead = { margin: "5px 0 0", color: "var(--t2)", fontSize: 13 };
