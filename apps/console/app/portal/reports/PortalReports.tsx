"use client";
// Client portal — the Reports view (BUILD-client-portal-reports), laid out as MOCKUP-client-portal.html's Reports in the portal's
// own components and light tokens: a page header, then the client's published reports grouped by state — awaiting their approval,
// and issued. Every affordance routes into what already exists: "Review & approve" and "Open" go to the job's published report
// (the composed document and its approval card, with every guard it already has), "Download PDF" to the version-bound document.
// Read-only: the index makes no approval and has no write path. The client's copy only; no money anywhere (NZC-120).
import { useCallback, useEffect, useState } from "react";
import { useOrganisationName } from "../../lib/OrganisationNameProvider";
import type { OrganisationCopy } from "../../lib/organisationName";
import { formatDate } from "../../lib/formatDate";
import { CLIENT_PORTAL_SURFACE, usePortalSurface, type PortalSurface } from "../portalSurface";
import { isPortalJobList, type PortalJob } from "../portalPortfolioValidation";
import { portalReportViewOf, type PortalReportView } from "../portalReportView";
import {
  approvable, approveHref, documentLine, pdfHref, publishedScopesOf, readPublishedReport, reportEntry, reportGroups, reportHref,
  type PortalReportEntry, type UnreadJob,
} from "../reportsView";

export type ReportsState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; entries: PortalReportEntry[]; unread: UnreadJob[] };

export class SessionEnded extends Error {}

const getJsonOn = (surface: PortalSurface) => async (url: string): Promise<unknown> => {
  const response = await fetch(url, { cache: "no-store" });
  if (await surface.sessionEnded(response)) throw new SessionEnded();
  if (!response.ok) throw new Error(url);
  return response.json();
};

/**
 * Every published report version of every granted job — each read as the report page reads it, each failing on its own. `json`
 * is the portal GET (a route that does not answer 2xx throws; an ended session throws `SessionEnded`, which ends the load); `api` is
 * the surface's base — the client's routes, or the staff preview's mirror of them.
 */
export async function loadReports(json: (url: string) => Promise<unknown> = getJsonOn(CLIENT_PORTAL_SURFACE), api = CLIENT_PORTAL_SURFACE.api): Promise<{ entries: PortalReportEntry[]; unread: UnreadJob[] }> {
  const body = await json(`${api}/jobs`);
  const jobs = body && typeof body === "object" ? (body as { jobs?: unknown }).jobs : undefined;
  if (!isPortalJobList(jobs)) throw new Error("The reporting jobs could not be verified.");
  const entries: PortalReportEntry[] = [], unread: UnreadJob[] = [];
  await Promise.all((jobs as PortalJob[]).filter((job) => job.hasPublishedReport).map(async (job) => {
    const named: UnreadJob = { jobId: job.id, jobNumber: job.number, reportingYear: job.reportingYear };
    try {
      const scopes = publishedScopesOf(await json(`${api}/jobs/${encodeURIComponent(job.id)}/published-report`));
      if (!scopes) { unread.push(named); return; }
      await Promise.all(scopes.map(async (scope) => {
        const query = `reportVersionId=${encodeURIComponent(scope.reportVersionId)}`;
        const [reportBody, viewBody] = await Promise.allSettled([
          json(`${api}/jobs/${encodeURIComponent(job.id)}/published-report?${query}`),
          json(`${api}/jobs/${encodeURIComponent(job.id)}/published-report/composition?${query}`),
        ]);
        if ([reportBody, viewBody].some((settled) => settled.status === "rejected" && settled.reason instanceof SessionEnded)) throw new SessionEnded();
        const read = reportBody.status === "fulfilled" ? readPublishedReport(reportBody.value, { jobId: job.id, reportVersionId: scope.reportVersionId }) : null;
        if (!read) { unread.push(named); return; }
        // The composition's own verdict, as the report page reaches it: anything unverified is unreadable, never the snapshot.
        const view: PortalReportView = viewBody.status === "fulfilled" ? portalReportViewOf(viewBody.value, { reportVersionId: scope.reportVersionId, jobId: job.id })
          : { state: "failed", message: "The issued report could not be loaded." };
        entries.push(reportEntry({ ...read, view, scopeLabel: scopes.length > 1 ? scope.scopeLabel : null }));
      }));
    } catch (cause) {
      if (cause instanceof SessionEnded) throw cause;
      unread.push(named);
    }
  }));
  // One note per job, however many of its versions could not be read.
  const seen = new Set<string>();
  return { entries, unread: unread.filter((job) => !seen.has(job.jobId) && (seen.add(job.jobId), true)).sort((a, b) => a.jobNumber.localeCompare(b.jobNumber)) };
}

export function PortalReports() {
  const org = useOrganisationName();
  const surface = usePortalSurface();
  const [state, setState] = useState<ReportsState>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try { setState({ kind: "ready", ...await loadReports(getJsonOn(surface), surface.api) }); }
    catch (cause) { if (!(cause instanceof SessionEnded)) setState({ kind: "failed" }); }
  }, [surface]);
  useEffect(() => { void load(); }, [load]);
  return <PortalReportsView state={state} org={org} onRetry={() => void load()} />;
}

export function PortalReportsView({ state, org, onRetry }: { state: ReportsState; org: OrganisationCopy; onRetry?: () => void }) {
  const home = usePortalSurface().link("/portal");
  return (
    <div className="nz-portal-dash nz-pd nz-pr">
      <header className="nz-pd-top">
        <div>
          <span className="nz-eyebrow">Published disclosures</span>
          <h1 className="nz-pd-client">Reports</h1>
          <p className="nz-pd-meta">Your Carbon Reduction Plans and certificates, by period</p>
        </div>
        {home ? <div className="nz-pd-top-actions"><a className="nz-btn" href={home}>Back to reporting jobs</a></div> : null}
      </header>
      {state.kind === "loading" ? <div className="nz-portal-state loading" role="status"><i>↻</i><div><b>Loading your reports</b><span>Reading each published report and its approval…</span></div></div>
        : state.kind === "failed" ? <div className="nz-portal-state failed" role="alert"><i>!</i><div><b>Your reports are temporarily unavailable</b><span>Your reporting jobs could not be read. No report or approval has been assumed.</span>{onRetry ? <button className="nz-btn" onClick={onRetry}>Try again</button> : null}</div></div>
        : <ReadyReports entries={state.entries} unread={state.unread} org={org} />}
    </div>
  );
}

function ReadyReports({ entries, unread, org }: { entries: PortalReportEntry[]; unread: UnreadJob[]; org: OrganisationCopy }) {
  const { awaiting, issued } = reportGroups(entries);
  return (
    <>
      {unread.length ? <p className="nz-pd-quiet" role="alert">{unread.length === 1 ? "One report" : `${unread.length} reports`} could not be loaded just now ({unread.map((job) => job.jobNumber).join(", ")}). {unread.length === 1 ? "It is" : "They are"} not shown here, and nothing about {unread.length === 1 ? "it" : "them"} has been assumed.</p> : null}
      {entries.length === 0 && unread.length === 0 ? <div className="nz-portal-state empty"><i>✓</i><div><b>No published reports yet</b><span>{org.Your("team")} will release each report here once it has passed assurance.</span></div></div> : null}
      {awaiting.length ? <ReportGroup title="Awaiting your approval" intro="Review each report, then approve it as your record for the period." entries={awaiting} org={org} /> : null}
      {issued.length ? <ReportGroup title="Issued" intro="Approved reports, each fixed to the version you approved." entries={issued} org={org} /> : null}
    </>
  );
}

function ReportGroup({ title, intro, entries, org }: { title: string; intro: string; entries: PortalReportEntry[]; org: OrganisationCopy }) {
  return (
    <section aria-label={title}>
      <div className="nz-pd-sechead"><h3>{title}</h3><p>{intro}</p></div>
      <div className="nz-pr-grid">{entries.map((entry) => <ReportCard key={entry.reportVersionId} entry={entry} org={org} />)}</div>
    </section>
  );
}

function ReportCard({ entry, org }: { entry: PortalReportEntry; org: OrganisationCopy }) {
  // Through the surface: in the staff preview there is no approving (R5) and no download; "Open" goes to the preview's report.
  const { link, readOnly } = usePortalSurface();
  const open = link(reportHref(entry)), approve = readOnly ? null : link(approveHref(entry)), pdf = link(pdfHref(entry));
  const awaiting = entry.approvedAt === null;
  const unreadable = entry.document.kind === "unreadable";
  return (
    <article className={`nz-pr-card${awaiting ? " awaiting" : ""}`}>
      <div className="nz-pr-head">
        <span className="nz-pr-eyebrow">{awaiting ? "Awaiting your approval" : `Issued ${formatDate(entry.publishedAt)}`}</span>
        <h4>Carbon Reduction Plan — {entry.jobNumber}</h4>
      </div>
      <p className="nz-pr-doc">{documentLine(entry)}</p>
      {unreadable ? <p className="nz-pr-note" role="note">{awaiting
        ? `It can't be approved until it can be shown in full — nothing is approved unseen. Try again later, or contact ${org.your("adviser")}.`
        : `It can't be shown just now. Your approval of it stands. Try again later, or contact ${org.your("adviser")}.`}</p> : null}
      <div className="nz-pr-actions">
        {awaiting && approvable(entry) && approve ? <a className="nz-btn pri" href={approve}>Review &amp; approve</a> : null}
        {open ? <a className="nz-btn" href={open}>Open</a> : null}
        {!awaiting && pdf ? <a className="nz-btn" href={pdf}>Download PDF</a> : null}
      </div>
      <p className="nz-pr-src">Reviewed snapshot {entry.snapshotId} · {awaiting ? "publication gate passed" : `approved ${formatDate(entry.approvedAt!)}`}</p>
      <details className="nz-pr-evidence">
        <summary>View report evidence</summary>
        <dl>
          <div><dt>Report version</dt><dd>{entry.reportVersionId}</dd></div>
          <div><dt>Reviewed snapshot</dt><dd>{entry.snapshotId}</dd></div>
          <div><dt>Evidence hash</dt><dd className="num">{entry.evidenceHash}</dd></div>
          <div><dt>Published</dt><dd>{formatDate(entry.publishedAt)}</dd></div>
          {entry.approvedAt ? <div><dt>Approved by you</dt><dd>{formatDate(entry.approvedAt)}</dd></div> : null}
        </dl>
      </details>
    </article>
  );
}
