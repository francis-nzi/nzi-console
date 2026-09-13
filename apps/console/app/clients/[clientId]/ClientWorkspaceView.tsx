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
import { clientCrumbs, clientJobsHref, crumbTrail } from "../../lib/crumbTrail";
import { AiProfileArea } from "./AiProfileArea";
import { AnalyticsArea } from "./AnalyticsArea";
import { CommsArea, FilesArea } from "./CommsFilesAreas";
import { ProfileArea } from "./ProfileArea";
import { ReportingArea } from "./ReportingArea";
import { IntensityMetricsDrawer } from "./IntensityMetricsDrawer";
import { SrsArea } from "./SrsArea";
import { SrsItemForm, SrsStartForm } from "./SrsAssessmentForms";
import { srsDrawerLabel, type SrsDrawerRequest } from "./srsDrawers";
import { orderedRequirements, type SrsRequirement } from "@nzi/contracts";
import { FinancialsHeldArea, UnavailableArea } from "./ClientAreaStates";
import { ContactForm } from "./ClientContacts";
import { ClientLogoBadge, IdentityForm } from "./ClientIdentity";
import { AddressForm, ComplianceForm, FactorsDrawerBody, PortalDrawerBody, RebaselineForm } from "./ClientRecordDrawers";
import { SiteForm } from "./ClientSites";
import { TargetsForm } from "./ClientTargets";
import { clientAreaGroups, isClientAreaId, type ClientAreaId } from "./clientAreas";
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
  // The SRS drawers carry their own payloads (an assessment, a requirement), so they have
  // their own request type — still one host, still one drawer open at a time.
  const [srsDrawer, setSrsDrawer] = useState<SrsDrawerRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // NZC-022 — each control reads the capability its own command enforces.
  const access = {
    site: useEditAccess("site.manage", writeEnabled),
    contact: useEditAccess("contact.manage", writeEnabled),
    client: useEditAccess("client.edit", writeEnabled, client.ownerUserId),
    target: useEditAccess("target.edit", writeEnabled),
    srs: useEditAccess("srs.manage", writeEnabled),
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

  const openDrawer = (request: DrawerRequest) => { setNotice(null); setSrsDrawer(null); setDrawer(request); };
  const closeDrawer = () => setDrawer(null);
  const saved = (text: string) => { setDrawer(null); setNotice(text); router.refresh(); };

  // "Continue assessment" lands on the first requirement still unanswered — the guided path.
  const openSrsDrawer = (request: SrsDrawerRequest) => {
    setNotice(null);
    setDrawer(null);
    if (request.kind !== "srs-assess") { setSrsDrawer(request); return; }
    const framework = workspace.srs.framework;
    if (!framework) return;
    const answered = new Set(request.assessment.items.filter((item) => item.maturity !== null).map((item) => item.requirementId));
    const ordered = orderedRequirements(framework);
    const requirement = ordered.find((entry) => !answered.has(entry.id)) ?? ordered[0];
    if (!requirement) return;
    setSrsDrawer({ kind: "srs-item", assessment: request.assessment, requirement, item: request.assessment.items.find((item) => item.requirementId === requirement.id) ?? null });
  };
  const closeSrsDrawer = () => setSrsDrawer(null);
  const srsSaved = (text: string) => { setNotice(text); router.refresh(); };
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
    areas={<ClientWorkspaceNav groups={clientAreaGroups({
      analytics: history.length || null, reporting: workspace.reports.length || null,
      comms: workspace.messages.length || null, files: workspace.files.length || null,
    })} activeId={area} onSelect={selectArea} />}
    drawer={evidenceDrawer}>
    {/* The area is the left sub-nav's job, not the trail's — the trail carries hierarchy. */}
    <TopBar searchPlaceholder="Search this client…" crumbs={crumbTrail(clientCrumbs(client))} />
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
        <Link className="nz-btn pri" href={clientJobsHref(client.id)}>Create job</Link>
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
        : area === "analytics" ? <AnalyticsArea workspace={workspace} onEvidence={setEvidenceKey} access={access.client} onDrawer={openDrawer} />
        : area === "reporting" ? <ReportingArea workspace={workspace} />
        : area === "srs" ? <SrsArea workspace={workspace} access={access.srs} onDrawer={openSrsDrawer} />
        : area === "profile" ? <ProfileArea workspace={workspace} access={access} onDrawer={openDrawer} factorsEnabled={factorsEnabled} />
        : area === "comms" ? <CommsArea workspace={workspace} />
        : area === "files" ? <FilesArea workspace={workspace} />
        : area === "ai" ? <AiProfileArea workspace={workspace} />
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
      {drawer?.kind === "intensity-metrics" ? <IntensityMetricsDrawer clientId={client.id} metrics={workspace.intensityMetrics} access={access.client} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "contact" ? <ContactForm key={drawer.contact?.id ?? "new-contact"} clientId={client.id} contact={drawer.contact} access={access.contact} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "site" ? <SiteForm key={drawer.site?.id ?? "new-site"} clientId={client.id} site={drawer.site} sites={sites} periods={[...workspace.reportingPeriods].reverse()} access={access.site} onClose={closeDrawer} onSaved={saved} onPartial={() => router.refresh()} /> : null}
    </Drawer>

    <Drawer open={srsDrawer !== null} onClose={closeSrsDrawer} ariaLabel={srsDrawer ? srsDrawerLabel(srsDrawer) : "SRS drawer"} className="nz-site-drawer" dismissOnOutsideClick>
      {srsDrawer?.kind === "srs-start" && workspace.srs.framework
        ? <SrsStartForm clientId={client.id} framework={workspace.srs.framework} access={access.srs} onClose={closeSrsDrawer} onSaved={(text: string) => { closeSrsDrawer(); srsSaved(text); }} /> : null}
      {srsDrawer?.kind === "srs-item" && workspace.srs.framework
        ? <SrsItemForm key={srsDrawer.requirement.id} framework={workspace.srs.framework} assessment={srsDrawer.assessment}
          requirement={srsDrawer.requirement} item={srsDrawer.item} access={access.srs} onClose={closeSrsDrawer} onSaved={srsSaved}
          onNext={(requirement: SrsRequirement) => setSrsDrawer({ kind: "srs-item", assessment: srsDrawer.assessment, requirement, item: srsDrawer.assessment.items.find((item) => item.requirementId === requirement.id) ?? null })} /> : null}
    </Drawer>
  </AppShell>;
}
