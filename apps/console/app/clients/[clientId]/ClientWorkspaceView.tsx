"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AppShell, EvidenceDrawer, TabPanel, Tabs, TopBar, WorkspaceRail } from "@nzi/ui";
import { CRP_RESOLVER_VERSION, EmissionsScopeDonut, RENDERER_VERSION, TOKENS_VERSION } from "@nzi/charts";
import { siteLifecycleStatus, type FigureEvidence } from "@nzi/contracts";
import { clientStatusMeta, jobFamilyMeta } from "@nzi/mock-data";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { NAV, USER } from "../../lib/nav";
import { formatDate } from "../../lib/formatDate";
import { useEditAccess } from "../../lib/useEditAccess";
import { ClientFactorsManager } from "../ClientFactorsManager";
import { ClientContacts } from "./ClientContacts";
import { ClientPathway } from "./ClientPathway";
import { ClientTargets } from "./ClientTargets";
import { ClientLogoBadge, ClientProfileCard, IdentityDrawer } from "./ClientIdentity";
import { ClientSites } from "./ClientSites";
import { EvidenceButton, FigureEvidenceBody, FigureStatus, TierBadge, formatFigure, fyLabel, tonnes } from "./FigureEvidence";

type EvidenceKey = "latest" | "yoy" | "scopes" | "intensity";
const EVIDENCE_TITLE: Record<EvidenceKey, string> = { latest: "Latest emissions", yoy: "Year on year", scopes: "Scope split", intensity: "Intensity detail" };
const TABS = [{ id: "overview", label: "Overview" }, { id: "carbon", label: "Carbon analytics" }] as const;

export function ClientWorkspaceView({ workspace, jobs, today, writeEnabled, factorsEnabled }: {
  workspace: ClientWorkspaceReadModel; jobs: JobScreenReadModel[]; today: string; writeEnabled: boolean; factorsEnabled: boolean;
}) {
  const { client, sites, evidence, reportingPeriods, contacts, targets, actuals } = workspace;
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("overview");
  const [selected, setSelected] = useState<EvidenceKey | null>(null);
  // NZC-022 — each control reads the capability its command enforces.
  const siteAccess = useEditAccess("site.manage", writeEnabled);
  const contactAccess = useEditAccess("contact.manage", writeEnabled);
  const clientAccess = useEditAccess("client.edit", writeEnabled);
  const targetAccess = useEditAccess("target.edit", writeEnabled);
  const [identityOpen, setIdentityOpen] = useState(false);

  const meta = clientStatusMeta[client.status];
  const open = jobs.filter((job) => ["draft", "open", "on-hold"].includes(job.header.status));
  const crp = jobs.filter((job) => job.header.family === "crp");
  const reviewGaps = crp.reduce((sum, job) => sum + (job.detail.kind === "crp" ? Math.max(0, job.detail.totalRows - job.detail.reviewedRows) : 0), 0);
  const activity = jobs.flatMap((job) => job.stageHistory.map((event) => ({ ...event, jobId: job.header.id, jobNumber: job.header.number }))).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 6);
  const inService = sites.filter((site) => siteLifecycleStatus(site, today).kind === "in-service").length;

  const source = evidence.latest.source;
  const fy = source ? fyLabel(source.reportingYear) : null;
  const scopeLine = evidence.scopes.map((scope) => `S${scope.scope} ${scope.value === null ? "—" : scope.value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`).join(" · ");
  const context: Record<EvidenceKey, string> = {
    latest: fy ? `${fy} · all scopes, all in-boundary sites` : "No reviewed snapshot",
    yoy: fy ? `${fy} against the prior reviewed year` : "No reviewed snapshot",
    scopes: fy ? `${fy} · ${scopeLine}` : "No reviewed snapshot",
    intensity: fy ? `${fy} · ${evidence.intensity.unit}` : "No reviewed snapshot",
  };
  const figureFor = (key: EvidenceKey): FigureEvidence => key === "scopes" ? evidence.latest : evidence[key];
  const drawer = selected ? (() => {
    const figure = figureFor(selected);
    return <EvidenceDrawer kicker={`Evidence · ${EVIDENCE_TITLE[selected].toLowerCase()}`} title={EVIDENCE_TITLE[selected]}
      subtitle={figure.source ? `Resolved from ${figure.source.jobNumber} · reviewed snapshot v${figure.source.snapshotVersion}` : "No reviewed snapshot"}
      actions={<>{figure.source ? <Link className="nz-btn nz-dact-fit" href={`/jobs/${encodeURIComponent(figure.source.jobId)}`}>Open source snapshot →</Link> : null}<span style={{ flex: 1 }} /><button type="button" className="nz-btn pri nz-dact-fit" onClick={() => setSelected(null)}>Close</button></>}>
      <FigureEvidenceBody figure={figure} context={context[selected]} scopes={selected === "scopes" ? evidence.scopes : undefined} />
    </EvidenceDrawer>;
  })() : undefined;
  const openEvidence = (key: EvidenceKey) => () => setSelected(key);

  const yoy = evidence.yoy;
  const latestNote = evidence.state === "empty" ? "Not reported" : yoy.value !== null ? `${formatFigure(yoy)} vs prior reviewed year` : "No earlier reviewed year";

  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="clients" user={USER} />} drawer={drawer}>
    <TopBar searchPlaceholder="Search this client…" crumbs={<><Link href="/clients">Clients</Link><span className="muted">/</span><b>{client.name}</b></>} />
    <div className="nz-head"><div className="nz-client-head"><ClientLogoBadge client={client} onOpen={() => setIdentityOpen(true)} /><div className="nz-client-identity"><div><h1>{client.name}</h1><span className={`nz-st ${meta.cls}`}>{meta.label}</span></div><p className="sub">{client.sector} · {client.location} · Account owner {client.owner}</p></div><div className="nz-head-actions"><Link className="nz-btn" href={`/clients/${client.id}/edit`}>Edit client</Link><Link className="nz-btn" href="/platform">Portal access</Link><Link className="nz-btn pri" href={`/jobs?client=${client.id}`}>Create job</Link></div></div></div>
    <div className="nz-body" style={{ paddingTop: 16 }}>
      <div className="nz-metrics">
        <Metric label="Open jobs" value={String(open.length)} note={`${jobs.length} total engagements`} />
        <div className="nz-metric">
          <div className="l">Latest emissions{fy ? ` · ${fy}` : ""}<EvidenceButton label="Latest emissions" onOpen={openEvidence("latest")} /></div>
          <div className="v num">{evidence.latest.value === null ? "Not reported" : <>{evidence.latest.value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}<small> tCO₂e</small></>}</div>
          <div className={`sub${yoy.value !== null ? (yoy.value <= 0 ? " ok" : " up") : ""}`}>{latestNote}</div>
        </div>
        <Metric label="Data completeness" value={`${client.completeness}%`} note="across engagements" />
        <Metric label="Sites in service" value={String(inService)} note={`${sites.length} recorded · effective-dated`} />
      </div>
      <div className="nz-client-grid"><div className="nz-client-main">
        <Tabs items={TABS} value={tab} onChange={(id) => setTab(id as typeof tab)} ariaLabel="Client workspace" idBase="client-workspace" className="nz-client-tabs" />
        <TabPanel id="overview" idBase="client-workspace" active={tab === "overview"} className="nz-client-panel">
          <section className="nz-panel"><CardHead eyebrow="Delivery" title="Active jobs & milestone progress" right={<Link className="nz-editlink" href={`/jobs?client=${client.id}`}>New job →</Link>} />{jobs.length === 0 ? <Empty text="No engagements have been created for this client." /> : <table className="nz-tbl"><thead><tr><th>Job</th><th>Family</th><th>Stage</th><th>Progress</th><th>Owner</th><th>Due</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.header.id}><td><Link href={`/jobs/${job.header.id}`} className="nz-table-link">{job.header.number}</Link><div className="muted">{job.header.title}</div></td><td><span className="nz-st need">{jobFamilyMeta[job.header.family].code}</span></td><td>{job.header.workflowStage}</td><td><Progress value={job.header.progressPct} /></td><td>{job.header.owner}</td><td className="num">{formatDate(job.header.dueDate)}</td></tr>)}</tbody></table>}</section>
          <section className="nz-panel"><CardHead eyebrow="Assurance" title="Reporting and assurance" /><div className="nz-client-signals"><Signal label="CRP engagements" value={String(crp.length)} tone="ok" /><Signal label="Rows awaiting review" value={String(reviewGaps)} tone={reviewGaps ? "warn" : "ok"} /></div></section>
          <section className="nz-panel"><CardHead eyebrow="Relationship" title="Activity" />{activity.length === 0 ? <Empty text="No workflow changes have been recorded for this client." /> : <div style={{ padding: "6px 16px 12px" }}>{activity.map((event) => <div className="nz-kv" key={event.id}><span className="k"><Link href={`/jobs/${event.jobId}`}>{event.jobNumber}</Link> · {event.fromStage} → {event.toStage}</span><span className="v">{formatDate(event.occurredAt)}</span></div>)}</div>}</section>
          {factorsEnabled ? <ClientFactorsManager clientId={client.id} /> : null}
        </TabPanel>
        <TabPanel id="carbon" idBase="client-workspace" active={tab === "carbon"} className="nz-client-panel">
          <div className="nz-cw-vhead"><div><div className="eyebrow">Carbon</div><h2>Carbon analytics</h2></div><span style={{ flex: 1 }} />{source ? <span className="sub">From <Link href={`/jobs/${encodeURIComponent(source.jobId)}`}>{source.jobNumber}</Link> · reviewed snapshot v{source.snapshotVersion}</span> : null}</div>
          <p className="nz-cw-vsub">Scope split, year-on-year change and intensity — every figure resolved from the client&apos;s assured, reviewed snapshot, with its provenance one click away.</p>
          {evidence.state === "empty" ? <div className="nz-banner warn" role="status">Not reported: no reviewed snapshot has been issued for this client, so there is no assured figure to show.</div> : null}
          <div className="nz-cw-grid">
            <div className="nz-cw-col">
              <section className="nz-panel">
                <CardHead eyebrow={fy ?? "Latest"} title="Scope split" right={<EvidenceButton label="Scope split" onOpen={openEvidence("scopes")} />} />
                {evidence.latest.value !== null && evidence.latest.value > 0 && source ? <div className="nz-donut-ring"><EmissionsScopeDonut ring showChrome={false} data={{
                  spec: { id: `client-scope-split-${source.snapshotId}`, type: "emissions_scope_donut", title: `${fy} emissions by scope`, family: "crp", specVersion: 2 },
                  unit: "tCO₂e", state: "success",
                  segments: evidence.scopes.map((scope) => ({ scope: scope.scope, label: `Scope ${scope.scope}`, value: scope.value ?? 0 })),
                  provenance: { jobId: source.jobId, dataHash: evidence.latest.provenance?.dataHash ?? "", factorSets: evidence.latest.provenance ? [evidence.latest.provenance.factorSet] : [], generatedAt: evidence.latest.provenance?.asAtDate ?? "", reviewedSnapshotId: source.snapshotId, resolverVersion: CRP_RESOLVER_VERSION, tokensVersion: TOKENS_VERSION, rendererVersion: RENDERER_VERSION },
                }} /></div> : null}
                <div className="nz-card-b">
                  {evidence.scopes.map((scope) => <div className="nz-cw-kv" key={scope.scope}>
                    <span className="k"><span className={`nz-scope-sw s${scope.scope}`} aria-hidden="true" />Scope {scope.scope}</span>
                    <span className="v">{scope.value === null ? "—" : `${scope.value.toLocaleString("en-GB", { maximumFractionDigits: 0 })} · ${share(scope.value, evidence.latest.value)}`}{scope.state === "resolved" ? <TierBadge tier={scope.qualityTier} /> : null}</span>
                  </div>)}
                </div>
                {evidence.state === "empty" ? null : <p className="nz-maps">Scope 3 is often mixed: each scope is a roll-up of its reviewed rows with per-row tiers — open a row in the job to see its factor and tier.</p>}
              </section>
              <ClientPathway client={{ id: client.id, name: client.name }} targets={targets} actuals={actuals ?? []} />
            </div>
            <div className="nz-cw-col">
              <section className="nz-panel">
                <CardHead eyebrow={fy ?? "Latest"} title="Intensity detail" right={<EvidenceButton label="Intensity detail" onOpen={openEvidence("intensity")} />} />
                <div className="nz-card-b">
                  <div className="nz-cw-kv"><span className="k">Intensity{evidence.intensity.unit.includes("/") ? ` · per ${evidence.intensity.unit.split("/")[1]!.trim()}` : ""}</span><span className="v">{formatFigure(evidence.intensity)}</span></div>
                  <Denominator detail={lineage(evidence.intensity, "Denominator")} />
                  <div className="nz-cw-kv"><span className="k">Status</span><span className="v"><FigureStatus figure={evidence.intensity} /></span></div>
                </div>
                {evidence.intensity.state === "unavailable" && evidence.intensity.note ? <p className="nz-maps">{evidence.intensity.note}</p> : null}
                <p className="nz-maps">Turnover and employees come from the job&apos;s business metrics; floor area is summed from the client&apos;s in-service sites for the year (effective-dated).</p>
              </section>
              <section className="nz-panel">
                <CardHead eyebrow="Year on year" title="Change" right={<EvidenceButton label="Year on year" onOpen={openEvidence("yoy")} />} />
                <div className="nz-card-b">
                  <div className="nz-cw-kv"><span className="k">{fy ?? "Latest"} total</span><span className="v">{evidence.latest.value === null ? "Not reported" : tonnes(evidence.latest.value)}</span></div>
                  <div className="nz-cw-kv"><span className="k">Compared with</span><span className="v">{lineage(yoy, "Compared with") ?? "—"}</span></div>
                  <div className="nz-cw-kv"><span className="k">Change</span><span className={`v${yoy.value !== null ? (yoy.value <= 0 ? " ok" : " up") : ""}`}>{formatFigure(yoy)}</span></div>
                </div>
                {yoy.state === "unavailable" && yoy.note ? <p className="nz-maps">{yoy.note}</p> : null}
              </section>
            </div>
          </div>
        </TabPanel>
      </div><aside className="nz-client-aside">
        <ClientTargets clientId={client.id} targets={targets} access={targetAccess} />
        <ClientContacts clientId={client.id} contacts={contacts ?? []} access={contactAccess} />
        <ClientSites clientId={client.id} sites={sites} reportingPeriods={reportingPeriods} today={today} access={siteAccess} />
        <ClientProfileCard client={client} onEdit={() => setIdentityOpen(true)} />
        <section className="nz-panel"><CardHead eyebrow="Record" title="Account overview" /><div style={{ padding: "6px 16px 12px" }}><Row label="Member since" value={client.memberSince} /><Row label="Account owner" value={client.owner} /></div></section>
        <section className="nz-panel nz-client-experience"><div className="eyebrow">Client experience</div><h2>Portal and reports</h2><p>Manage account invitations and job-level access, then review published reports from the same evidence base.</p><div><Link href="/platform" className="nz-btn pri">Manage access</Link><Link href="/reports" className="nz-btn">Reports</Link></div></section>
      </aside></div>
    </div>
    <IdentityDrawer open={identityOpen} client={client} access={clientAccess} onClose={() => setIdentityOpen(false)} />
  </AppShell>;
}

/** "3,200 m² — the sum of …" → the figure as the value, its explanation beneath. */
function Denominator({ detail }: { detail: string | null }) {
  const [value, ...rest] = (detail ?? "—").split(" — ");
  return <div className="nz-cw-kv"><span className="k">Denominator</span><span className="v" style={{ display: "block" }}>{value}{rest.length ? <span className="hint">{rest.join(" — ")}</span> : null}</span></div>;
}
const share = (value: number, total: number | null) => total && total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
const lineage = (figure: FigureEvidence, title: string) => figure.lineage.find((step) => step.title === title)?.detail ?? null;

export function CardHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return <div className="nz-card-h"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><span className="sp" />{right}</div>;
}
function Metric({ label, value, note }: { label: string; value: string; note: string }) { return <div className="nz-metric"><div className="l">{label}</div><div className="v num">{value}</div><div className="sub">{note}</div></div>; }
function Progress({ value }: { value: number }) { return <span className="nz-client-progress"><span role="progressbar" aria-label="Job progress" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></span><span className="num muted">{value}%</span></span>; }
function Signal({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" }) { return <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 13 }}><span className={`nz-st ${tone === "ok" ? "done" : "est"}`}>{tone === "ok" ? "On track" : "Attention"}</span><div style={{ fontSize: 18, fontWeight: 650, marginTop: 9 }}>{value}</div><div className="sub">{label}</div></div>; }
function Row({ label, value }: { label: string; value: string }) { return <div className="nz-kv"><span className="k">{label}</span><span className="v">{value}</span></div>; }
function Empty({ text }: { text: string }) { return <div className="sub" style={{ padding: 18 }}>{text}</div>; }
