"use client";

import Link from "next/link";
import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import { CardHead, Empty } from "./OverviewArea";

/**
 * Reporting (client workspace v10, phase 2): every report version this client has, newest
 * first, each opening on the reviewed snapshot it was issued from. The list is resolved
 * from `report_versions` joined to the client's jobs — a client with none says so.
 */

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "est" },
  validated: { label: "Validated", cls: "need" },
  published: { label: "Published", cls: "done" },
  superseded: { label: "Superseded", cls: "" },
};

export function ReportingArea({ workspace }: { workspace: ClientWorkspaceReadModel }) {
  const { reports } = workspace;
  const published = reports.filter((report) => report.status === "published");
  const inProgress = reports.filter((report) => report.status === "draft" || report.status === "validated");

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Deliverables</div><h2>Reporting</h2></div><span style={{ flex: 1 }} />
      <span className="sub">{reports.length === 0 ? "No report versions" : `${published.length} published · ${inProgress.length} in progress`}</span>
    </div>
    <p className="nz-cw-vsub">Published reports and in-progress versions for this client. Each report opens on the reviewed snapshot it was issued from — the figures are the frozen ones, not re-resolved.</p>

    <section className="nz-panel">
      <CardHead eyebrow="Versions" title="Report versions" />
      {reports.length === 0
        ? <Empty text="No report version has been created for this client yet. A version appears here once a CRP job validates its reviewed snapshot for release." />
        : <table className="nz-tbl">
          <thead><tr><th>Report</th><th>Job</th><th>Version</th><th>Status</th><th>Issued</th><th>Client review</th><th /></tr></thead>
          <tbody>
            {reports.map((report) => {
              const meta = STATUS[report.status] ?? { label: report.status, cls: "" };
              return <tr key={report.reportVersionId}>
                <td><b>{report.title}</b>{report.reportingYear ? <div className="muted">FY{String(report.reportingYear).slice(-2)}</div> : null}</td>
                <td><Link href={`/jobs/${encodeURIComponent(report.jobId)}`} className="nz-table-link">{report.jobNumber}</Link></td>
                <td className="num">v{report.manifestVersion}</td>
                <td><span className={`nz-st ${meta.cls}`}>{meta.label}</span></td>
                <td className="num">{report.publishedAt ? formatDate(report.publishedAt) : <span className="muted">—</span>}</td>
                <td>{report.approvalCount === 0 && report.commentCount === 0
                  ? <span className="muted">None yet</span>
                  : `${report.approvalCount} approval${report.approvalCount === 1 ? "" : "s"} · ${report.commentCount} comment${report.commentCount === 1 ? "" : "s"}`}</td>
                <td style={{ textAlign: "right" }}><Link className="nz-table-link" href={`/reports/${encodeURIComponent(report.reportVersionId)}`}>
                  {report.status === "published" ? "Open report →" : "Open draft →"}
                </Link></td>
              </tr>;
            })}
          </tbody>
        </table>}
      <div className="nz-card-b">
        <p className="nz-maps">A published report and its PDF stay retrievable whatever its provenance stamp says (NZC-066) — the stamp is context, never a gate. Validation and publishing happen on the job, under separation of duties.</p>
      </div>
    </section>
  </>;
}
