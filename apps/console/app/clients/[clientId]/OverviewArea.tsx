"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Collapsible } from "@nzi/ui";
import { siteLifecycleStatus } from "@nzi/contracts";
import { jobFamilyMeta } from "@nzi/mock-data";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import { clientJobsHref } from "../../lib/crumbs";
import type { EditAccess } from "../../lib/useEditAccess";
import { ClientContacts } from "./ClientContacts";
import { ClientSites } from "./ClientSites";
import { ClientTargets } from "./ClientTargets";
import { FinancialStatusCard } from "./ClientAreaStates";
import { EvidenceButton, TierBadge, fyLabel, tonnes } from "./FigureEvidence";
import type { DrawerRequest } from "./clientDrawers";

/**
 * Overview (client workspace v10): the metrics strip, the setup progress, the pinned
 * delivery card, then the collapsible history and commitment cards, with the client's
 * record surfaces in the right column. Every figure is resolved — nothing here is seeded.
 */
export function OverviewArea({ workspace, jobs, today, access, onEvidence, onDrawer }: {
  workspace: ClientWorkspaceReadModel;
  jobs: JobScreenReadModel[];
  today: string;
  access: { site: EditAccess; contact: EditAccess; client: EditAccess; target: EditAccess };
  onEvidence: () => void;
  onDrawer: (request: DrawerRequest) => void;
}) {
  const { client, sites, evidence, reportingPeriods, contacts, targets, history } = workspace;
  const openJobs = jobs.filter((job) => ["draft", "open", "on-hold"].includes(job.header.status));
  const crp = jobs.filter((job) => job.header.family === "crp");
  const reviewGaps = crp.reduce((sum, job) => sum + (job.detail.kind === "crp" ? Math.max(0, job.detail.totalRows - job.detail.reviewedRows) : 0), 0);
  const inService = sites.filter((site) => siteLifecycleStatus(site, today).kind === "in-service").length;
  const activity = jobs.flatMap((job) => job.stageHistory.map((event) => ({ ...event, jobId: job.header.id, jobNumber: job.header.number })))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 6);

  return <>
    <SetupProgress workspace={workspace} jobs={jobs} />

    {/* Every Overview card is collapsible and only this one opens by default
        (DESIGN_CONVENTIONS §3.2): what is being delivered now is what you came to see. */}
    <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h" defaultOpen
      title={<><span className="eyebrow">Delivery</span><h2>Active jobs &amp; milestone progress</h2></>}
      count={openJobs.length ? `${openJobs.length} open` : jobs.length ? "None open" : null}>
      <div className="nz-card-b" style={{ paddingBottom: 0, display: "flex", justifyContent: "flex-end" }}>
        <Link className="nz-editlink" href={clientJobsHref(client.id)}>New job →</Link>
      </div>
      {jobs.length === 0
        ? <Empty text="No engagements have been created for this client." />
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
        <Signal label="CRP engagements" value={String(crp.length)} tone="ok" />
        <Signal label="Rows awaiting review" value={String(reviewGaps)} tone={reviewGaps ? "warn" : "ok"} />
        <Signal label="Open jobs" value={String(openJobs.length)} tone="ok" />
      </div></div>
    </Collapsible>

    <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h" title={<><span className="eyebrow">Assurance</span><h2>Emissions history</h2></>} count={history.length ? `${history.length} assured year${history.length === 1 ? "" : "s"}` : "None yet"}>
      {history.length === 0
        ? <Empty text="No reviewed snapshot has been issued for this client, so there is no assured history yet." />
        : <table className="nz-tbl"><thead><tr><th>Year</th><th>Job</th><th className="num">Total</th><th>Scope split</th><th>Issued</th></tr></thead><tbody>
          {history.map((year) => <tr key={year.snapshotId}>
            <td><b>{fyLabel(year.year)}</b></td>
            <td><Link href={`/jobs/${encodeURIComponent(year.jobId)}`} className="nz-table-link">{year.jobNumber}</Link><div className="muted">snapshot v{year.snapshotVersion}</div></td>
            <td className="num">{year.totalTco2e === null ? "—" : tonnes(year.totalTco2e)}</td>
            <td>{year.scopes.map((scope) => <span key={scope.scope} className="nz-scope-inline"><span className={`nz-scope-sw s${scope.scope}`} aria-hidden="true" />{scope.tco2e === null ? "—" : Math.round(scope.tco2e).toLocaleString("en-GB")}</span>)}</td>
            <td className="muted">{formatDate(year.issuedAt)}{year.provenance ? "" : " · unstamped"}</td>
          </tr>)}
        </tbody></table>}
    </Collapsible>

    <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h"
      title={<><span className="eyebrow">Commitment</span><h2>Baseline &amp; targets</h2></>}
      count={targets.model ? "Targets set" : targets.benchmarkInForce ? "No targets set" : "No baseline"}>
      <ClientTargets targets={targets} access={access.target} onEdit={() => onDrawer({ kind: "targets" })} hideHead />
      <div className="nz-card-b" style={{ paddingTop: 0 }}>
        <button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "rebaseline" })}>⇄ Re-baseline / recalculate</button>
        <p className="nz-maps">The dated baseline record and its history timeline arrive with <code>client_baselines</code>; the baseline in force is shown above.</p>
      </div>
    </Collapsible>

    <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h"
      title={<><span className="eyebrow">Relationship</span><h2>Activity</h2></>}
      count={activity.length ? String(activity.length) : "None yet"}>
      {activity.length === 0
        ? <Empty text="No workflow changes have been recorded for this client." />
        : <div style={{ padding: "6px 16px 12px" }}>{activity.map((event) => <div className="nz-kv" key={event.id}>
          <span className="k"><Link href={`/jobs/${event.jobId}`}>{event.jobNumber}</Link> · {event.fromStage} → {event.toStage}</span>
          <span className="v">{formatDate(event.occurredAt)}</span>
        </div>)}</div>}
    </Collapsible>
  </>;
}

/** The right-hand column: the client's own record surfaces, each edited in a drawer. */
export function OverviewAside({ workspace, today, access, onDrawer, factorsEnabled }: {
  workspace: ClientWorkspaceReadModel;
  today: string;
  access: { site: EditAccess; contact: EditAccess; client: EditAccess };
  onDrawer: (request: DrawerRequest) => void;
  factorsEnabled: boolean;
}) {
  const { client, sites, reportingPeriods, contacts } = workspace;
  return <>
    <ClientContacts contacts={contacts ?? []} access={access.contact} onEdit={(contact) => onDrawer({ kind: "contact", contact })} />
    <ClientSites sites={sites} reportingPeriods={reportingPeriods} today={today} access={access.site} onEdit={(site) => onDrawer({ kind: "site", site })} />
    <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h" title={<><span className="eyebrow">Commercial</span><h2>Financial status</h2></>} count="Held">
      <FinancialStatusCard />
    </Collapsible>
    <section className="nz-panel">
      <CardHead eyebrow="Record" title="Company profile" right={<button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "identity" })}>Edit</button>} />
      <div style={{ padding: "6px 16px 12px" }}>
        <Row label="Industry" value={client.sector || "—"} />
        <Row label="Financial year end" value={monthName(client.profile.financialYearEndMonth) ?? "Not set"} />
        <Row label="Member since" value={client.memberSince} />
        <Row label="Account owner" value={client.owner} />
        <div className="nz-kv"><span className="k">Address</span><span className="v"><button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "address" })}>{client.profile.registeredCity?.trim() ? `${client.profile.registeredCity} · edit` : "Add"}</button></span></div>
        <div className="nz-kv"><span className="k">Compliance</span><span className="v"><button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "compliance" })}>{client.profile.reportingFrameworks?.length ? `${client.profile.reportingFrameworks.length} framework${client.profile.reportingFrameworks.length === 1 ? "" : "s"} · edit` : "Add"}</button></span></div>
        {factorsEnabled ? <div className="nz-kv"><span className="k">Client factors</span><span className="v"><button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "factors" })}>Manage</button></span></div> : null}
        <div className="nz-kv"><span className="k">Portal access</span><span className="v"><button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "portal" })}>Open</button></span></div>
      </div>
    </section>
  </>;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (month: number | null | undefined) => month && month >= 1 && month <= 12 ? MONTHS[month - 1]! : null;

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
    { label: "Assured year", done: history.length > 0 },
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
function Row({ label, value }: { label: string; value: string }) { return <div className="nz-kv"><span className="k">{label}</span><span className="v">{value}</span></div>; }
export function Empty({ text }: { text: string }) { return <div className="sub" style={{ padding: 18 }}>{text}</div>; }
export { TierBadge };
