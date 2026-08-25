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
    <div className="nz-head"><div className="nz-job-titleline"><div><div className="nz-eyebrow">Assured reporting</div><h1>Publication studio</h1><div className="sub">Create, assure and release decision-grade carbon reports</div></div><Link className="nz-btn pri" href="/report-preview">Prepare report version</Link></div></div>
    <div className="nz-body" style={{ paddingTop: 18 }}>
      <section className="nz-report-hero"><div><span className="nz-eyebrow light">One governed publishing system</span><h2>From reviewed evidence to a board-ready report.</h2><p>Every publication is assembled from an immutable snapshot, validated against the shared chart manifest and released as an exact, traceable version.</p></div><div className="nz-report-flow"><span><i>1</i>Freeze evidence</span><b>→</b><span><i>2</i>Validate output</span><b>→</b><span><i>3</i>Release to client</span></div></section>
      <div className="nz-section-intro"><div><span className="nz-eyebrow">Publication register</span><h2>Controlled report versions</h2><p>Live status across preparation, validation, release and client assurance.</p></div><Link className="nz-btn" href="/charts">Open chart library</Link></div>
      <LiveReportRegister/>
      <div className="nz-panel nz-template-card"><div className="nz-card-heading"><div><span className="nz-eyebrow">Governed content system</span><h2>Report templates</h2></div><span className="nz-st done">Version controlled</span></div>{reportTemplates.map((template) => <div className="nz-template-row" key={template.id}><div className="nz-template-mark">CRP</div><div><b>{template.name}</b><span>Template v{template.version} · {template.variables.length} typed variables</span></div><span className="nz-st done">{template.status}</span></div>)}</div>
      <ReportReviewInbox />
    </div>
  </AppShell>;
}
