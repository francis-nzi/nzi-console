import Link from "next/link";
import { AppShell, TopBar, WorkspaceRail } from "@nzi/ui";
import { reportTemplates, reportVersions } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { hasData } from "@nzi/contracts";
import { NAV, USER } from "../lib/nav";
import {ReportReviewInbox} from "./ReportReviewInbox";
import {LiveReportRegister} from "./LiveReportRegister";
import { ScreenState } from "../lib/ScreenState";

export default function ReportsPage() {
  const result = loadFixtureScreen<{ reports: typeof reportVersions; templates: typeof reportTemplates }>("reports", { reports: reportVersions, templates: reportTemplates });
  if (!hasData(result)) return <ScreenState result={result}>{() => null}</ScreenState>;
  const { templates } = result.data;
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="reports" user={USER} />}>
    <TopBar searchPlaceholder="Search reports, jobs, clients…" crumbs={<><b>Reports</b> <span className="muted">/</span> Versions</>} />
    <div className="nz-head"><div style={{ display: "flex" }}><div><h1>Reports</h1><div className="sub">Versioned templates · immutable outputs · manifest validation</div></div><Link className="nz-btn pri" style={{ marginLeft: "auto" }} href="/report-preview">Prepare report version</Link></div></div>
    <div className="nz-body" style={{ paddingTop: 18 }}><LiveReportRegister/>
      <div className="nz-panel" style={{ padding: 18, marginTop: 18 }}><h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Templates</h2>{reportTemplates.map((template) => <div className="nz-kv" key={template.id}><span className="k">{template.name} · v{template.version}</span><span className="v">{template.variables.length} typed variables · {template.status}</span></div>)}</div>
      <ReportReviewInbox />
    </div>
  </AppShell>;
}
