"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Collapsible } from "@nzi/ui";
import { siteLifecycleStatus } from "@nzi/contracts";
import { jobFamilyMeta } from "@nzi/mock-data";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import { clientJobsHref } from "../../lib/crumbs";
import { EvidenceButton, TierBadge, formatFigure, fyLabel } from "./FigureEvidence";
import type { ClientTabId } from "./clientAreas";

/**
 * Overview (client workspace v10): at a glance only — the headline metrics, the setup progress, the latest verified
 * emissions with their scope split, active jobs and milestone progress with the rows still awaiting review, and a
 * compact key-contacts card. Nothing here edits anything: each card links to the tab where its working section lives
 * (Carbon, Record, …). Every figure is resolved — nothing here is seeded.
 */
export function OverviewArea({ workspace, jobs, today, onEvidence, onOpenTab }: {
  workspace: ClientWorkspaceReadModel;
  jobs: JobScreenReadModel[];
  today: string;
  onEvidence: () => void;
  onOpenTab: (tab: ClientTabId) => void;
}) {
  const { client, sites, evidence, contacts } = workspace;
  const openJobs = jobs.filter((job) => ["draft", "open", "on-hold"].includes(job.header.status));
  const crp = jobs.filter((job) => job.header.family === "crp");
  const reviewGaps = crp.reduce((sum, job) => sum + (job.detail.kind === "crp" ? Math.max(0, job.detail.totalRows - job.detail.reviewedRows) : 0), 0);
  const source = evidence.latest.source;
  const fy = source ? fyLabel(source.reportingYear) : null;
  const yoy = evidence.yoy;
  const latestNote = evidence.state === "empty" ? "Not reported" : yoy.value !== null ? `${formatFigure(yoy)} vs prior reviewed year` : "No earlier reviewed year";
  // The primary contact first, then as recorded; the full list, with consent, is on the Record tab.
  const keyContacts = [...contacts].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).slice(0, 3);

  return <>
    <div className="nz-metrics">
      <Metric label="Open jobs" value={String(openJobs.length)} note={`${jobs.length} total jobs`} />
      <MetricEvidence label={`Latest emissions${fy ? ` · ${fy}` : ""}`} note={latestNote} tone={yoy.value !== null ? (yoy.value <= 0 ? "ok" : "up") : undefined} onEvidence={onEvidence}>
        {evidence.latest.value === null ? "Not reported" : <>{evidence.latest.value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}<small> tCO₂e</small></>}
      </MetricEvidence>
      <Metric label="Data completeness" value={`${client.completeness}%`} note="across jobs" />
      <Metric label="Sites in service" value={String(sites.filter((site) => siteLifecycleStatus(site, today).kind === "in-service").length)} note={`${sites.length} recorded · effective-dated`} />
    </div>

    <SetupProgress workspace={workspace} jobs={jobs} />

    <section className="nz-panel">
      <CardHead eyebrow="Verification" title="Latest verified emissions" right={<button type="button" className="nz-editlink" onClick={() => onOpenTab("carbon")}>Carbon →</button>} />
      {evidence.latest.value === null
        ? <Empty text="No reviewed snapshot has been issued for this client, so there is no verified headline yet." />
        : <div className="nz-card-b">
          <div style={{ fontSize: 18, fontWeight: 650 }}>{evidence.latest.value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}<small> tCO₂e</small>{fy ? <span className="sub"> · {fy}</span> : null}</div>
          <div className="sub" style={{ marginTop: 6 }}>{evidence.scopes.map((scope) => <span key={scope.scope} className="nz-scope-inline"><span className={`nz-scope-sw s${scope.scope}`} aria-hidden="true" />Scope {scope.scope} · {scope.value === null ? "—" : Math.round(scope.value).toLocaleString("en-GB")}</span>)}</div>
        </div>}
    </section>

    {/* Every Overview card is collapsible and only this one opens by default
        (DESIGN_CONVENTIONS §3.2): what is being delivered now is what you came to see. */}
    <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h" defaultOpen
      title={<><span className="eyebrow">Delivery</span><h2>Active jobs &amp; milestone progress</h2></>}
      count={openJobs.length ? `${openJobs.length} open` : jobs.length ? "None open" : null}>
      <div className="nz-card-b" style={{ paddingBottom: 0, display: "flex", justifyContent: "flex-end" }}>
        <Link className="nz-editlink" href={clientJobsHref(client.id)}>New job →</Link>
      </div>
      {jobs.length === 0
        ? <Empty text="No jobs have been created for this client." />
        : <table className="nz-tbl"><thead><tr><th>Job</th><th>Family</th><th>Stage</th><th>Progress</th><th>Owner</th><th>Due</th></tr></thead><tbody>
          {jobs.map((job) => <tr key={job.header.id}>
            <td><Link href={`/jobs/${job.header.id}`} className="nz-table-link">{job.header.number}</Link><div className="muted">{job.header.title}</div></td>
            <td><span className="nz-st need">{jobFamilyMeta[job.header.family].code}</span></td>
            <td>{job.header.workflowStage}</td>
            <td><Progress value={job.header.progressPct} /></td>
            <td>{job.header.owner}</td>
            <td className="num">{formatDate(job.header.dueDate)}</td>
          </tr>)}
        </tbody></table>}
      <div className="nz-card-b"><div className="nz-client-signals">
        <Signal label="CRP jobs" value={String(crp.length)} tone="ok" />
        <Signal label="Rows awaiting review" value={String(reviewGaps)} tone={reviewGaps ? "warn" : "ok"} />
        <Signal label="Open jobs" value={String(openJobs.length)} tone="ok" />
      </div></div>
    </Collapsible>

    <section className="nz-panel">
      <CardHead eyebrow="Relationship" title="Key contacts" right={<button type="button" className="nz-editlink" onClick={() => onOpenTab("record")}>All contacts →</button>} />
      {keyContacts.length === 0
        ? <Empty text="No contact is recorded for this client." />
        : <div style={{ padding: "6px 16px 12px" }}>{keyContacts.map((contact) => <div className="nz-kv" key={contact.id}>
          <span className="k">{contact.fullName}{contact.isPrimary ? <span className="nz-tag rr" style={{ marginLeft: 6 }}>Primary</span> : null}</span>
          <span className="v muted">{[contact.jobTitle, contact.email].filter(Boolean).join(" · ") || "—"}</span>
        </div>)}</div>}
    </section>
  </>;
}

/** What still has to be true before this client can be reported on. Each step is a fact, not a guess. */
function SetupProgress({ workspace, jobs }: { workspace: ClientWorkspaceReadModel; jobs: JobScreenReadModel[] }) {
  const { client, sites, contacts, targets, history } = workspace;
  const steps = [
    { label: "Identity", done: Boolean(client.sector?.trim() && client.profile.financialYearEndMonth) },
    { label: "Contacts", done: (contacts?.length ?? 0) > 0 },
    { label: "Sites", done: sites.length > 0 },
    { label: "Baseline", done: Boolean(targets.benchmarkInForce) },
    { label: "Targets", done: Boolean(targets.model) },
    { label: "Job", done: jobs.length > 0 },
    { label: "Verified year", done: history.length > 0 },
  ];
  const done = steps.filter((step) => step.done).length;
  return <section className="nz-panel nz-setup">
    <CardHead eyebrow="Setup" title="Client setup progress" right={<span className="sub">{done} of {steps.length} complete</span>} />
    <div className="nz-card-b"><ol className="nz-steps">
      {steps.map((step) => <li key={step.label} className={step.done ? "done" : undefined}><span className="m" aria-hidden="true">{step.done ? "✓" : "○"}</span>{step.label}</li>)}
    </ol></div>
  </section>;
}

export function CardHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return <div className="nz-card-h"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><span className="sp" />{right}</div>;
}
export function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div><div className="sub">{note}</div></div>;
}
export function MetricEvidence({ label, children, note, tone, onEvidence }: { label: string; children: ReactNode; note: string; tone?: "ok" | "up"; onEvidence: () => void }) {
  return <div className="nz-metric">
    <div className="l">{label}<EvidenceButton label={label} onOpen={onEvidence} /></div>
    <div className="v num">{children}</div>
    <div className={`sub${tone ? ` ${tone}` : ""}`}>{note}</div>
  </div>;
}
function Progress({ value }: { value: number }) {
  return <span className="nz-client-progress"><span role="progressbar" aria-label="Job progress" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></span><span className="num muted">{value}%</span></span>;
}
function Signal({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" }) {
  return <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 13 }}><span className={`nz-st ${tone === "ok" ? "done" : "est"}`}>{tone === "ok" ? "On track" : "Attention"}</span><div style={{ fontSize: 18, fontWeight: 650, marginTop: 9 }}>{value}</div><div className="sub">{label}</div></div>;
}
export function Empty({ text }: { text: string }) { return <div className="sub" style={{ padding: 18 }}>{text}</div>; }
export { TierBadge };
