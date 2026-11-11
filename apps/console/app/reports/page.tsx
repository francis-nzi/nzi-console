import Link from "next/link";
import { AppShell, TopBar } from "@nzi/ui";
import { crpProfessionalManifest } from "@nzi/charts";
import { StaffRail } from "../lib/StaffRail";
import { crumbTrail, workspaceCrumbs } from "../lib/crumbTrail";
import {ReportReviewInbox} from "./ReportReviewInbox";
import {LiveReportRegister} from "./LiveReportRegister";
import {ReportStatusBoard} from "./ReportStatusBoard";
import {WithOrganisationName} from "../lib/organisationBrand";

export default function ReportsPage() {
  return <AppShell rail={<StaffRail activeId="reports" />}>
    <TopBar crumbs={crumbTrail(workspaceCrumbs("Reports", "/reports"))} />
    <div className="nz-head"><div className="nz-job-titleline"><div><div className="nz-eyebrow">Verified reporting</div><h1>Publication studio</h1><div className="sub">Create, verify and release decision-grade carbon reports</div></div><Link className="nz-btn pri" href="/report-preview">Prepare report version</Link></div></div>
    <div className="nz-body" style={{ paddingTop: 18 }}>
      <div className="nz-section-intro"><div><span className="nz-eyebrow">Report pipeline</span><h2>Every CRP job, at its stage</h2></div></div>
      <ReportStatusBoard/>
      <div className="nz-section-intro"><div><span className="nz-eyebrow">Publication register</span><h2>Controlled report versions</h2><p>Live status across preparation, validation, release and client verification.</p></div><Link className="nz-btn" href="/charts">Open chart library</Link></div>
      <LiveReportRegister/>
      <div className="nz-panel nz-template-card"><div className="nz-card-heading"><div><span className="nz-eyebrow">Governed content system</span><h2>Report manifest</h2></div><span className="nz-st done">Active</span></div><div className="nz-template-row"><div className="nz-template-mark">CRP</div><div><b>CRP professional</b><span>Manifest v{crpProfessionalManifest.version} · {crpProfessionalManifest.sections.length} controlled sections · {crpProfessionalManifest.charts.length} typed charts</span></div><span className="nz-st done">Code governed</span></div></div>
      <WithOrganisationName><ReportReviewInbox /></WithOrganisationName>
    </div>
  </AppShell>;
}
