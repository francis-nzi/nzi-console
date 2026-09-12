"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell, ClientWorkspaceNav, Drawer, EvidenceDrawer, TopBar, WorkspaceRail } from "@nzi/ui";
import { siteLifecycleStatus, type FigureEvidence } from "@nzi/contracts";
import { clientStatusMeta } from "@nzi/mock-data";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { NAV, USER } from "../../lib/nav";
import { useEditAccess } from "../../lib/useEditAccess";
import { AnalyticsArea } from "./AnalyticsArea";
import { FinancialsHeldArea, UnavailableArea } from "./ClientAreaStates";
import { ContactForm } from "./ClientContacts";
import { ClientLogoBadge, IdentityForm } from "./ClientIdentity";
import { AddressForm, ComplianceForm, FactorsDrawerBody, PortalDrawerBody, RebaselineForm } from "./ClientRecordDrawers";
import { SiteForm } from "./ClientSites";
import { TargetsForm } from "./ClientTargets";
import { CLIENT_AREA_LABELS, clientAreaGroups, isClientAreaId, type ClientAreaId } from "./clientAreas";
import { drawerLabel, type DrawerRequest } from "./clientDrawers";
import { MetricEvidence, Metric, OverviewArea, OverviewAside } from "./OverviewArea";
import { FigureEvidenceBody, formatFigure, fyLabel } from "./FigureEvidence";

/**
 * The client workspace shell (client workspace v10): the global rail, then this client's
 * area sub-nav, then the area itself, with one drawer host on the right.
 *
 * The shell composes — it does not resolve. Every figure, site, contact and target comes
 * from the workspace read model; every change goes through the command the drawer sends,
 * gated by the capability that command enforces.
 */

type EvidenceKey = "latest" | "yoy" | "scopes" | "intensity";
const EVIDENCE_TITLE: Record<EvidenceKey, string> = { latest: "Latest emissions", yoy: "Year on year", scopes: "Scope split", intensity: "Intensity detail" };

export function ClientWorkspaceView({ workspace, jobs, today, writeEnabled, factorsEnabled, initialArea }: {
  workspace: ClientWorkspaceReadModel; jobs: JobScreenReadModel[]; today: string; writeEnabled: boolean; factorsEnabled: boolean; initialArea?: string;
}) {
  const router = useRouter();
  const { client, sites, evidence, contacts, targets, history } = workspace;
  const [area, setArea] = useState<ClientAreaId>(isClientAreaId(initialArea) ? initialArea : "overview");
  const [evidenceKey, setEvidenceKey] = useState<EvidenceKey | null>(null);
  const [drawer, setDrawer] = useState<DrawerRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // NZC-022 — each control reads the capability its own command enforces.
  const access = {
    site: useEditAccess("site.manage", writeEnabled),
    contact: useEditAccess("contact.manage", writeEnabled),
    client: useEditAccess("client.edit", writeEnabled, client.ownerUserId),
    target: useEditAccess("target.edit", writeEnabled),
  };

  const meta = clientStatusMeta[client.status];
  const source = evidence.latest.source;
  const fy = source ? fyLabel(source.reportingYear) : null;
  const yoy = evidence.yoy;
  const scopeLine = evidence.scopes.map((scope) => `S${scope.scope} ${scope.value === null ? "—" : scope.value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`).join(" · ");
  const context: Record<EvidenceKey, string> = {
    latest: fy ? `${fy} · all scopes, all in-boundary sites` : "No reviewed snapshot",
    yoy: fy ? `${fy} against the prior reviewed year` : "No reviewed snapshot",
    scopes: fy ? `${fy} · ${scopeLine}` : "No reviewed snapshot",
    intensity: fy ? `${fy} · ${evidence.intensity.unit}` : "No reviewed snapshot",
  };
  const figureFor = (key: EvidenceKey): FigureEvidence => key === "scopes" ? evidence.latest : evidence[key];

  // The evidence drawer keeps the shell's right-hand slot; the edit drawers share one host.
  const evidenceDrawer = evidenceKey ? (() => {
    const figure = figureFor(evidenceKey);
    return <EvidenceDrawer kicker={`Evidence · ${EVIDENCE_TITLE[evidenceKey].toLowerCase()}`} title={EVIDENCE_TITLE[evidenceKey]}
      subtitle={figure.source ? `Resolved from ${figure.source.jobNumber} · reviewed snapshot v${figure.source.snapshotVersion}` : "No reviewed snapshot"}
      actions={<>{figure.source ? <Link className="nz-btn nz-dact-fit" href={`/jobs/${encodeURIComponent(figure.source.jobId)}`}>Open source snapshot →</Link> : null}<span style={{ flex: 1 }} /><button type="button" className="nz-btn pri nz-dact-fit" onClick={() => setEvidenceKey(null)}>Close</button></>}>
      <FigureEvidenceBody figure={figure} context={context[evidenceKey]} scopes={evidenceKey === "scopes" ? evidence.scopes : undefined} />
    </EvidenceDrawer>;
  })() : undefined;

  const openDrawer = (request: DrawerRequest) => { setNotice(null); setDrawer(request); };
  const closeDrawer = () => setDrawer(null);
  const saved = (text: string) => { setDrawer(null); setNotice(text); router.refresh(); };
  const selectArea = (next: string) => {
    if (!isClientAreaId(next)) return;
    setArea(next);
    setNotice(null);
    // The area is in the URL, so a client screen can be linked to and reloaded where it was.
    window.history.replaceState(null, "", next === "overview" ? `/clients/${encodeURIComponent(client.id)}` : `/clients/${encodeURIComponent(client.id)}?area=${next}`);
  };

  const latestNote = evidence.state === "empty" ? "Not reported" : yoy.value !== null ? `${formatFigure(yoy)} vs prior reviewed year` : "No earlier reviewed year";

  return <AppShell
    rail={<WorkspaceRail sections={NAV} activeId="clients" user={USER} />}
    areas={<ClientWorkspaceNav groups={clientAreaGroups({ tasks: null, analytics: history.length || null })} activeId={area} onSelect={selectArea} />}
    drawer={evidenceDrawer}>
    <TopBar searchPlaceholder="Search this client…" crumbs={<><Link href="/clients">Clients</Link><span className="muted">/</span><b>{client.name}</b><span className="muted">/</span><span>{CLIENT_AREA_LABELS[area]}</span></>} />
    <div className="nz-head"><div className="nz-client-head">
      <ClientLogoBadge client={client} onOpen={() => openDrawer({ kind: "identity" })} />
      <div className="nz-client-identity">
        <div><h1>{client.name}</h1><span className={`nz-st ${meta.cls}`}>{meta.label}</span></div>
        <p className="sub">{client.sector} · {client.location} · Account owner {client.owner}</p>
      </div>
      <div className="nz-head-actions">
        {/* No "Edit client" here: the record is edited one thing at a time, in its own
            drawer, from the surface that shows it (v10). */}
        <button type="button" className="nz-btn" onClick={() => openDrawer({ kind: "portal" })}>Portal access</button>
        <Link className="nz-btn pri" href={`/jobs?client=${client.id}`}>Create job</Link>
      </div>
    </div></div>

    <div className="nz-body" style={{ paddingTop: 16 }}>
      {area === "overview" ? <div className="nz-metrics">
        <Metric label="Open jobs" value={String(jobs.filter((job) => ["draft", "open", "on-hold"].includes(job.header.status)).length)} note={`${jobs.length} total engagements`} />
        <MetricEvidence label={`Latest emissions${fy ? ` · ${fy}` : ""}`} note={latestNote} tone={yoy.value !== null ? (yoy.value <= 0 ? "ok" : "up") : undefined} onEvidence={() => setEvidenceKey("latest")}>
          {evidence.latest.value === null ? "Not reported" : <>{evidence.latest.value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}<small> tCO₂e</small></>}
        </MetricEvidence>
        <Metric label="Data completeness" value={`${client.completeness}%`} note="across engagements" />
        <Metric label="Sites in service" value={String(sites.filter((site) => siteLifecycleStatus(site, today).kind === "in-service").length)} note={`${sites.length} recorded · effective-dated`} />
      </div> : null}

      {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}

      {area === "overview"
        ? <div className="nz-client-grid">
          <div className="nz-client-main">
            <OverviewArea workspace={workspace} jobs={jobs} today={today} access={access} onEvidence={() => setEvidenceKey("latest")} onDrawer={openDrawer} />
          </div>
          <aside className="nz-client-aside">
            <OverviewAside workspace={workspace} today={today} access={access} onDrawer={openDrawer} factorsEnabled={factorsEnabled} />
          </aside>
        </div>
        : area === "analytics" ? <AnalyticsArea workspace={workspace} onEvidence={setEvidenceKey} />
        : area === "financials" ? <FinancialsHeldArea />
        : <UnavailableArea area={area} clientId={client.id} />}
    </div>

    <Drawer open={drawer !== null} onClose={closeDrawer} ariaLabel={drawer ? drawerLabel(drawer) : "Client drawer"} className="nz-site-drawer" dismissOnOutsideClick>
      {drawer?.kind === "identity" ? <IdentityForm key={`identity-${client.version}`} client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "targets" ? <TargetsForm clientId={client.id} targets={targets} access={access.target} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "rebaseline" ? <RebaselineForm client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "address" ? <AddressForm client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "compliance" ? <ComplianceForm client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "factors" ? <FactorsDrawerBody clientId={client.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "portal" ? <PortalDrawerBody client={client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "contact" ? <ContactForm key={drawer.contact?.id ?? "new-contact"} clientId={client.id} contact={drawer.contact} access={access.contact} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "site" ? <SiteForm key={drawer.site?.id ?? "new-site"} clientId={client.id} site={drawer.site} sites={sites} periods={[...workspace.reportingPeriods].reverse()} access={access.site} onClose={closeDrawer} onSaved={saved} onPartial={() => router.refresh()} /> : null}
    </Drawer>
  </AppShell>;
}
