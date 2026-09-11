"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AppShell, EvidenceDrawer, TabPanel, Tabs, TopBar, WorkspaceRail } from "@nzi/ui";
import { siteLifecycleStatus, type FigureEvidence } from "@nzi/contracts";
import { clientStatusMeta, jobFamilyMeta } from "@nzi/mock-data";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { NAV, USER } from "../../lib/nav";
import { formatDate } from "../../lib/formatDate";
import { useEditAccess } from "../../lib/useEditAccess";
import { ClientFactorsManager } from "../ClientFactorsManager";
import { ClientSites } from "./ClientSites";
import { FigureCard, FigureEvidenceBody, ScopeRows } from "./FigureEvidence";

type EvidenceKey = "latest" | "yoy" | "scopes" | "intensity";
const EVIDENCE_TITLE: Record<EvidenceKey, string> = { latest: "Latest footprint", yoy: "Year-on-year", scopes: "Scope split", intensity: "Intensity detail" };
const TABS = [{ id: "overview", label: "Overview" }, { id: "carbon", label: "Carbon analytics" }] as const;

export function ClientWorkspaceView({ workspace, jobs, today, writeEnabled, factorsEnabled }: {
  workspace: ClientWorkspaceReadModel; jobs: JobScreenReadModel[]; today: string; writeEnabled: boolean; factorsEnabled: boolean;
}) {
  const { client, sites, evidence, reportingPeriods } = workspace;
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("overview");
  const [selected, setSelected] = useState<EvidenceKey | null>(null);
  const access = useEditAccess("emissions.data.edit", writeEnabled);

  const meta = clientStatusMeta[client.status];
  const open = jobs.filter((job) => ["draft", "open", "on-hold"].includes(job.header.status));
  const crp = jobs.filter((job) => job.header.family === "crp");
  const reviewGaps = crp.reduce((sum, job) => sum + (job.detail.kind === "crp" ? Math.max(0, job.detail.totalRows - job.detail.reviewedRows) : 0), 0);
  const activity = jobs.flatMap((job) => job.stageHistory.map((event) => ({ ...event, jobId: job.header.id, jobNumber: job.header.number }))).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 6);
  const inService = sites.filter((site) => siteLifecycleStatus(site, today).kind === "in-service").length;

  const figureFor = (key: EvidenceKey): FigureEvidence => key === "scopes" ? evidence.latest : evidence[key];
  const drawer = selected ? (() => {
    const figure = figureFor(selected);
    return <EvidenceDrawer kicker="◈ Evidence" title={EVIDENCE_TITLE[selected]}
      subtitle={figure.source ? `Resolved from ${figure.source.jobNumber} · reviewed snapshot v${figure.source.snapshotVersion}` : "No reviewed snapshot"}
      actions={<button type="button" className="nz-btn" onClick={() => setSelected(null)}>Close evidence</button>}>
      <FigureEvidenceBody figure={figure} scopes={selected === "scopes" ? evidence.scopes : undefined} />
    </EvidenceDrawer>;
  })() : undefined;
  const open_ = (key: EvidenceKey) => () => setSelected(key);

  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="clients" user={USER} />} drawer={drawer}>
    <TopBar searchPlaceholder="Search this client…" crumbs={<><Link href="/clients">Clients</Link><span className="muted">/</span><b>{client.name}</b></>} />
    <div className="nz-head"><div className="nz-client-head"><div className="nz-client-monogram">{client.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("")}</div><div className="nz-client-identity"><div><h1>{client.name}</h1><span className={`nz-st ${meta.cls}`}>{meta.label}</span></div><p className="sub">{client.sector} · {client.location} · Account owner {client.owner}</p></div><div className="nz-head-actions"><Link className="nz-btn" href={`/clients/${client.id}/edit`}>Edit client</Link><Link className="nz-btn" href="/platform">Portal access</Link><Link className="nz-btn pri" href={`/jobs?client=${client.id}`}>Create job</Link></div></div></div>
    <div className="nz-body" style={{ paddingTop: 16 }}>
      <div className="nz-metrics"><Metric label="Open jobs" value={String(open.length)} note={`${jobs.length} total engagements`} /><Metric label="Sites in service" value={String(inService)} note={`${sites.length} recorded · effective-dated`} /><Metric label="Rows awaiting review" value={String(reviewGaps)} note="Across CRP engagements" /><Metric label="Next report" value={client.nextReportDue || "Not scheduled"} note="Client reporting calendar" /></div>
      <div className="nz-client-grid"><div className="nz-client-main">
        <Tabs items={TABS} value={tab} onChange={(id) => setTab(id as typeof tab)} ariaLabel="Client workspace" idBase="client-workspace" className="nz-client-tabs" />
        <TabPanel id="overview" idBase="client-workspace" active={tab === "overview"} className="nz-client-panel">
          <section className="nz-panel"><Head title="Engagements" right={<Link href={`/jobs?client=${client.id}`}>New job →</Link>} />{jobs.length === 0 ? <Empty text="No engagements have been created for this client." /> : <table className="nz-tbl"><thead><tr><th>Job</th><th>Family</th><th>Stage</th><th>Progress</th><th>Owner</th><th>Due</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.header.id}><td><Link href={`/jobs/${job.header.id}`} className="nz-table-link">{job.header.number}</Link><div className="muted">{job.header.title}</div></td><td><span className="nz-st need">{jobFamilyMeta[job.header.family].code}</span></td><td>{job.header.workflowStage}</td><td><Progress value={job.header.progressPct} /></td><td>{job.header.owner}</td><td className="num">{formatDate(job.header.dueDate)}</td></tr>)}</tbody></table>}</section>
          <section className="nz-panel"><Head title="Reporting and assurance" /><div className="nz-client-signals">
            <Signal label="CRP engagements" value={String(crp.length)} tone="ok" />
            <Signal label="Review outstanding" value={String(reviewGaps)} tone={reviewGaps ? "warn" : "ok"} />
            <FigureCard title="Latest footprint" figure={evidence.latest} onEvidence={open_("latest")} />
          </div></section>
          <section className="nz-panel"><Head title="Relationship activity" />{activity.length === 0 ? <Empty text="No workflow changes have been recorded for this client." /> : <div style={{ padding: "6px 16px 12px" }}>{activity.map((event) => <div className="nz-kv" key={event.id}><span className="k"><Link href={`/jobs/${event.jobId}`}>{event.jobNumber}</Link> · {event.fromStage} → {event.toStage}</span><span className="v">{formatDate(event.occurredAt)}</span></div>)}</div>}</section>
          {factorsEnabled ? <ClientFactorsManager clientId={client.id} /> : null}
        </TabPanel>
        <TabPanel id="carbon" idBase="client-workspace" active={tab === "carbon"} className="nz-client-panel">
          <section className="nz-panel"><Head title="Carbon analytics" right={evidence.latest.source ? <>From <Link href={`/jobs/${encodeURIComponent(evidence.latest.source.jobId)}`}>{evidence.latest.source.jobNumber}</Link> · reviewed snapshot v{evidence.latest.source.snapshotVersion}</> : undefined} />
            {evidence.state === "empty" ? <div className="nz-banner warn" role="status" style={{ margin: "14px 16px 0" }}>Not reported: no reviewed snapshot has been issued for this client, so there is no assured figure to show.</div> : null}
            <div className="nz-figure-grid">
              <FigureCard title="Year-on-year" figure={evidence.yoy} onEvidence={open_("yoy")} />
              <FigureCard title="Scope split" figure={evidence.latest} onEvidence={open_("scopes")}><ScopeRows scopes={evidence.scopes} /></FigureCard>
              <FigureCard title="Intensity detail" figure={evidence.intensity} onEvidence={open_("intensity")} />
            </div>
          </section>
        </TabPanel>
      </div><aside className="nz-client-aside">
        <section className="nz-panel"><Head title="Primary contact" /><div className="nz-client-contact"><b>{client.contact.name || "Not configured"}</b><div className="sub">{client.contact.role || "Role not configured"}</div>{client.contact.email ? <a href={`mailto:${client.contact.email}`}>{client.contact.email}</a> : null}</div></section>
        <ClientSites clientId={client.id} sites={sites} reportingPeriods={reportingPeriods} today={today} access={access} />
        <section className="nz-panel"><Head title="Account overview" /><div style={{ padding: "6px 16px 12px" }}><Row label="Member since" value={client.memberSince} /><Row label="Account owner" value={client.owner} /><Row label="Data completeness" value={`${client.completeness}%`} /></div></section>
        <section className="nz-panel nz-client-experience"><div className="eyebrow">Client experience</div><h2>Portal and reports</h2><p>Manage account invitations and job-level access, then review published reports from the same evidence base.</p><div><Link href="/platform" className="nz-btn pri">Manage access</Link><Link href="/reports" className="nz-btn">Reports</Link></div></section>
      </aside></div>
    </div>
  </AppShell>;
}

function Head({ title, right }: { title: string; right?: ReactNode }) { return <div style={{ display: "flex", padding: "13px 16px", borderBottom: "1px solid var(--line2)", alignItems: "center" }}><h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2>{right ? <div className="sub" style={{ marginLeft: "auto", fontSize: 12 }}>{right}</div> : null}</div>; }
function Metric({ label, value, note }: { label: string; value: string; note: string }) { return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div><div className="sub">{note}</div></div>; }
function Progress({ value }: { value: number }) { return <span className="nz-client-progress"><span role="progressbar" aria-label="Job progress" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></span><span className="num muted">{value}%</span></span>; }
function Signal({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" }) { return <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 13 }}><span className={`nz-st ${tone === "ok" ? "done" : "est"}`}>{tone === "ok" ? "On track" : "Attention"}</span><div style={{ fontSize: 18, fontWeight: 650, marginTop: 9 }}>{value}</div><div className="sub">{label}</div></div>; }
function Row({ label, value }: { label: string; value: string }) { return <div className="nz-kv"><span className="k">{label}</span><span className="v">{value}</span></div>; }
function Empty({ text }: { text: string }) { return <div className="sub" style={{ padding: 18 }}>{text}</div>; }
