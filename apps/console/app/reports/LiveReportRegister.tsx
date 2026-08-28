"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReportVersionRegisterItem } from "@nzi/isolated-backend";

function isReport(value: unknown): value is ReportVersionRegisterItem {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<ReportVersionRegisterItem>;
  return typeof report.reportVersionId === "string" && typeof report.jobId === "string" && typeof report.jobNumber === "string" && typeof report.client === "string" && (report.reportingYear === null || typeof report.reportingYear === "number") && ["draft", "validated", "published", "superseded"].includes(String(report.status)) && typeof report.manifestVersion === "number" && typeof report.snapshotId === "string" && typeof report.dataHash === "string" && typeof report.createdAt === "string" && (report.publishedAt === null || typeof report.publishedAt === "string") && typeof report.approvalCount === "number" && typeof report.commentCount === "number";
}

export function LiveReportRegister() {
  const [reports, setReports] = useState<ReportVersionRegisterItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/isolated/report-versions", { cache: "no-store" })
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.message ?? "Report register is unavailable.");
        if (!Array.isArray(body.reports) || !body.reports.every(isReport)) throw new Error("The report register returned an invalid response.");
        setReports(body.reports);
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Report register is unavailable.");
        setReports(null);
      });
  }, []);

  if (error) return <section className="nz-report-register" aria-label="Immutable report register"><div className="nz-banner warn" role="alert"><div><b>Live register unavailable</b><div>{error} No report-version claims are shown.</div></div></div></section>;
  if (reports === null) return <div className="nz-register-loading" role="status"><i aria-hidden="true" /> <span><b>Loading publication register</b><small>Retrieving immutable report versions…</small></span></div>;

  const published = reports.filter((report) => report.status === "published").length;
  const validated = reports.filter((report) => report.status === "validated").length;
  const awaiting = reports.filter((report) => report.status === "published" && report.approvalCount === 0).length;

  return <section className="nz-report-register" aria-label="Immutable report register">
    <div className="nz-metrics"><Metric label="Report versions" value={String(reports.length)} note="Immutable records" /><Metric label="Ready to publish" value={String(validated)} note="Validation passed" /><Metric label="Published" value={String(published)} note={`${awaiting} awaiting approval`} /><Metric label="Client approvals" value={String(reports.reduce((sum, report) => sum + report.approvalCount, 0))} note="Version-bound evidence" /></div>
    {reports.length === 0 ? <div className="nz-register-empty"><i>0</i><div><b>No immutable report versions</b><span>Validate a reviewed snapshot to create the first controlled version.</span></div><Link className="nz-btn pri" href="/report-preview">Prepare report version</Link></div> : <>
      <div className="nz-panel nz-report-table"><table className="nz-tbl"><thead><tr><th>Report version</th><th>Job / client</th><th>Manifest</th><th>Status</th><th>Client review</th><th>Created</th><th><span className="nz-sr-only">Actions</span></th></tr></thead><tbody>{reports.map((report) => <tr key={report.reportVersionId}><td><b>{report.reportVersionId}</b><code>{report.dataHash.slice(0, 22)}…</code></td><td><Link className="nz-register-job" href={`/jobs/${report.jobId}`}>{report.jobNumber}</Link><div className="muted">{report.client}{report.reportingYear ? ` · ${report.reportingYear}` : ""}</div></td><td>CRP · v{report.manifestVersion}</td><td><span className={`nz-st ${report.status === "published" ? "done" : report.status === "validated" ? "est" : "need"}`}>{report.status}</span></td><td>{report.status === "published" ? <><b>{report.approvalCount}</b> approvals · {report.commentCount} messages</> : <span className="muted">Not released</span>}</td><td>{new Date(report.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td><td><Link className="nz-btn" href={`/reports/${report.reportVersionId}`}>Open version</Link></td></tr>)}</tbody></table></div>
      <div className="nz-report-cards">{reports.map((report) => <article key={report.reportVersionId}><div><span className={`nz-st ${report.status === "published" ? "done" : report.status === "validated" ? "est" : "need"}`}>{report.status}</span><b>{report.reportVersionId}</b><code>{report.dataHash.slice(0, 22)}…</code></div><dl><div><dt>Job / client</dt><dd>{report.jobNumber} · {report.client}</dd></div><div><dt>Client review</dt><dd>{report.status === "published" ? `${report.approvalCount} approvals · ${report.commentCount} messages` : "Not released"}</dd></div><div><dt>Created</dt><dd>{new Date(report.createdAt).toLocaleDateString("en-GB")}</dd></div></dl><Link className="nz-btn" href={`/reports/${report.reportVersionId}`}>Open report version</Link></article>)}</div>
    </>}
  </section>;
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div><div className="sub">{note}</div></div>;
}
