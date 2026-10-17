"use client";

import Link from "next/link";
import { reportStageLabels, v7RecordLine, type ReportStage } from "@nzi/contracts";
import { useJobReportRow } from "../lib/useJobReportRow";
import { studioHasReport } from "./[jobId]/report/studio";

/**
 * DESIGN-job-data-entry-usability D (and RULING-report-studio-B2-4's "unmount the Jobs §4 editor", brought forward): the job's
 * "Report & publish" stage is the report's state and one way on — "Open in Report Studio". The report is drafted, validated and
 * published only in the studio (#483, the one path); the snapshot is approved in Review & QA (Data assurance). No narrative is
 * edited on the job. The state is the job's own row of the report status register, the same read as the job header's report link;
 * a read that fails says so rather than guessing.
 */
export function reportStageNext(stage: ReportStage, readyForReporting: boolean): string {
  switch (stage) {
    case "in-preparation": return readyForReporting
      ? "Evidence is complete — sign off and freeze the reviewed snapshot in Review & QA."
      : "Finish calculation and independent review in Review & QA, then freeze the reviewed snapshot.";
    case "awaiting-review": return "The reviewed snapshot is awaiting approval — approve it in Review & QA, under Data assurance.";
    case "ready-to-validate": return "The snapshot is approved. Draft the report, choose its signee and validate it in the Report Studio.";
    case "ready-to-publish": return "A validated version is ready. Publish it to the client portal from the Report Studio.";
    case "awaiting-client": return "Published — the client has not yet approved it.";
    case "changes-requested": return "Published — the client has asked for changes.";
    case "client-approved": return "Published and approved by the client.";
    case "v7-record": return "This period's record of account is its v7 report.";
  }
}

export function CrpReportStageCard({ jobId, readyForReporting }: { jobId: string; readyForReporting: boolean }) {
  const row = useJobReportRow(jobId);
  if (row === undefined) return <section className="nz-panel nz-report-stage" aria-busy><div className="nz-register-loading" role="status"><i /><span><b>Loading the report&rsquo;s state</b></span></div></section>;
  if (row === null) return <section className="nz-panel nz-report-stage"><div className="nz-banner warn" role="alert"><div>The report&rsquo;s state could not be read. Reload the page to try again.</div></div></section>;
  const ready = studioHasReport(row.stage);
  const studio = `/jobs/${encodeURIComponent(jobId)}/report/printing`;
  return <section className="nz-panel nz-report-stage" aria-label="Report state">
    <div className="nz-report-stage-h">
      <div><span className="nz-eyebrow">Report</span><b>{reportStageLabels[row.stage]}</b></div>
      <span className={`nz-st ${row.stage === "client-approved" ? "done" : ready ? "est" : "need"}`} data-report-stage={row.stage}>{reportStageLabels[row.stage]}</span>
    </div>
    <p className="sub">{row.stage === "v7-record" ? v7RecordLine(row.v7Report) : reportStageNext(row.stage, readyForReporting)}</p>
    <div className="nz-report-stage-a">
      {ready
        ? <Link className="nz-btn pri" href={studio} data-report-studio-link>Open in Report Studio</Link>
        : <><button type="button" className="nz-btn pri" disabled aria-describedby={`report-stage-why-${jobId}`}>Open in Report Studio</button>
          <span className="muted nz-gated-reason" id={`report-stage-why-${jobId}`}>{row.stage === "v7-record" ? "Opens once this period is re-composed in the console." : "Opens once the reviewed snapshot is approved."}</span></>}
    </div>
  </section>;
}
