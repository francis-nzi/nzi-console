import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { reportTemplates, reportVersions } from "@nzi/mock-data";
import { NAV, USER } from "../lib/nav";

export default function ReportsPage() {
  const published = reportVersions.filter((version) => version.status === "published").length;
  const ready = reportVersions.filter((version) => version.status === "validated").length;
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="reports" user={USER} />}>
    <TopBar searchPlaceholder="Search reports, jobs, clients…" crumbs={<><b>Reports</b> <span className="muted">/</span> Versions</>} />
    <div className="nz-head"><div style={{ display: "flex" }}><div><h1>Reports</h1><div className="sub">Versioned templates · immutable outputs · manifest validation</div></div><button className="nz-btn pri" style={{ marginLeft: "auto" }}>Create report version</button></div></div>
    <div className="nz-body" style={{ paddingTop: 18 }}><div className="nz-metrics"><Metric label="Report versions" value={`${reportVersions.length}`} /><Metric label="Ready to publish" value={`${ready}`} /><Metric label="Published" value={`${published}`} /><Metric label="Active templates" value={`${reportTemplates.filter((template) => template.status === "active").length}`} /></div>
      <div className="nz-panel" style={{ marginTop: 18 }}><table className="nz-tbl"><thead><tr><th>Version</th><th>Job</th><th>Client</th><th>Template</th><th>Manifest</th><th>Status</th><th>Created</th><th /></tr></thead><tbody>{reportVersions.map((version) => <tr key={version.id}><td style={{ fontWeight: 600 }}>v{version.version}</td><td>{version.jobNumber}</td><td>{version.client}</td><td>CRP Professional v{version.templateVersion}</td><td>{version.manifestId} · v{version.manifestVersion}</td><td><span className={`nz-st ${version.status === "published" ? "done" : "est"}`}>{version.status}</span></td><td>{formatDate(version.createdAt)}</td><td><a className="nz-btn" href={`/reports/${version.id}`}>Open version</a></td></tr>)}</tbody></table></div>
      <div className="nz-panel" style={{ padding: 18, marginTop: 18 }}><h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Templates</h2>{reportTemplates.map((template) => <div className="nz-kv" key={template.id}><span className="k">{template.name} · v{template.version}</span><span className="v">{template.variables.length} typed variables · {template.status}</span></div>)}</div>
    </div>
  </AppShell>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div></div>; }
function formatDate(iso: string) { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); }
