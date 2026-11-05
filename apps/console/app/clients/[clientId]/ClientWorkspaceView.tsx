"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell, Drawer, EvidenceDrawer, TabPanel, Tabs, TopBar } from "@nzi/ui";
import type { FigureEvidence } from "@nzi/contracts";
import { clientStatusMeta } from "@nzi/mock-data";
import type { ClientHistoryEntry, ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import type { ScreenResult } from "@nzi/contracts";
import { StaffRail } from "../../lib/StaffRail";
import { useEditAccess, useHasCapability } from "../../lib/useEditAccess";
import { clientCrumbs, clientJobsHref, crumbTrail } from "../../lib/crumbTrail";
import { AiProfileArea } from "./AiProfileArea";
import { AnalyticsArea } from "./AnalyticsArea";
import { CommsArea, FilesArea } from "./CommsFilesAreas";
import { ReportingArea } from "./ReportingArea";
import { IntensityMetricsDrawer } from "./IntensityMetricsDrawer";
import { IntensityTargetForm } from "./ClientIntensityTargets";
import { ReportingTemplateCard, ReportingTemplateForm, ReportingTemplateFromMasterForm, ReportingTemplateInitialiseForm } from "./ClientReportingTemplate";
import { ReportProfileCard, ReportProfileForm } from "./ClientReportProfile";
import { SrsArea } from "./SrsArea";
import { ReductionStrategiesArea } from "./ReductionStrategiesArea";
import { StrategyBespokeForm, StrategyEditForm, StrategyLibraryForm, StrategyProposalForm } from "./StrategyForms";
import { strategyDrawerLabel, type StrategyDrawerRequest } from "./strategyDrawers";
import { SrsItemForm } from "./SrsAssessmentForms";
import { SrsBridgeForm } from "./SrsBridgeForm";
import { srsDrawerLabel, type SrsDrawerRequest } from "./srsDrawers";
import { orderedRequirements, type SrsRequirement } from "@nzi/contracts";
import { FinancialsHeldArea, UnavailableArea } from "./ClientAreaStates";
import { HistoryArea } from "./HistoryArea";
import { PortalManagementArea } from "./PortalManagementArea";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { ContactForm } from "./ClientContacts";
import { ClientLogoBadge, IdentityForm } from "./ClientIdentity";
import { AddressForm, ComplianceForm, FactorsDrawerBody, RebaselineForm } from "./ClientRecordDrawers";
import { SiteForm } from "./ClientSites";
import { TargetsForm } from "./ClientTargets";
import { CLIENT_TABS, tabForParam, type ClientTabId } from "./clientAreas";
import { drawerLabel, type DrawerRequest } from "./clientDrawers";
import { OverviewArea } from "./OverviewArea";
import { ActivityCard, BaselineTargetsCard, EmissionsHistoryCard, RecordTab } from "./ClientTabCards";
import { FigureEvidenceBody, fyLabel } from "./FigureEvidence";

/**
 * The client workspace shell (client workspace v10): the global rail, then the client header with its top tab bar
 * (Overview · Carbon · Data entry · Reporting · Reduction Strategies · SRS Readiness · Record · Manage), then the tab's sections, with one drawer host on the right.
 *
 * The shell composes — it does not resolve. Every figure, site, contact and target comes
 * from the workspace read model; every change goes through the command the drawer sends,
 * gated by the capability that command enforces.
 */

type EvidenceKey = "latest" | "yoy" | "scopes" | "intensity";
const EVIDENCE_TITLE: Record<EvidenceKey, string> = { latest: "Latest emissions", yoy: "Year on year", scopes: "Scope split", intensity: "Intensity detail" };

export function ClientWorkspaceView({ workspace, jobs, today, writeEnabled, factorsEnabled, initialArea, auditHistory, geocodingEnabled = false }: {
  workspace: ClientWorkspaceReadModel; jobs: JobScreenReadModel[]; today: string; writeEnabled: boolean; factorsEnabled: boolean; initialArea?: string;
  auditHistory: ScreenResult<{ history: ClientHistoryEntry[]; limit: number }>;
  /** CLIENT-04: whether site and client geocoding is switched on (NZI_SITE_GEOCODING_ENABLED). */
  geocodingEnabled?: boolean;
}) {
  const router = useRouter();
  const { client, sites, evidence, contacts, targets } = workspace;
  const [tab, setTab] = useState<ClientTabId>(tabForParam(initialArea));
  const [evidenceKey, setEvidenceKey] = useState<EvidenceKey | null>(null);
  const [drawer, setDrawer] = useState<DrawerRequest | null>(null);
  // The SRS drawers carry their own payloads (an assessment, a requirement), so they have
  // their own request type — still one host, still one drawer open at a time.
  const [srsDrawer, setSrsDrawer] = useState<SrsDrawerRequest | null>(null);
  const [strategyDrawer, setStrategyDrawer] = useState<StrategyDrawerRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // NZC-022 — each control reads the capability its own command enforces.
  const access = {
    site: useEditAccess("site.manage", writeEnabled),
    contact: useEditAccess("contact.manage", writeEnabled),
    client: useEditAccess("client.edit", writeEnabled, client.ownerUserId),
    target: useEditAccess("target.edit", writeEnabled),
    srs: useEditAccess("srs.manage", writeEnabled),
    actions: useEditAccess("strategy.manage", writeEnabled),
  };

  const canPreviewPortal = useHasCapability("support.portal_impersonate", client.ownerUserId);
  // Actions A2, R3: promoting a client's approved proposal into the library is the library's own capability.
  const canPromoteToLibrary = useHasCapability("admin.lookups") && writeEnabled;
  // CLIENT-12 — the History area is offered only to whoever may read this client's audit history.
  const canReadHistory = useHasCapability("audit.view", client.ownerUserId);
  // Portal data-entry phase 1: behind `portal-management` (ships dark), and only to a holder of portal.admin on this client.
  const canManagePortal = useHasCapability("portal.admin", client.ownerUserId) && portalFeatureEnabled("portal-management");

  const meta = clientStatusMeta[client.status];
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

  // The evidence drawer keeps the shell's right-hand slot; the edit drawers share one host.
  const evidenceDrawer = evidenceKey ? (() => {
    const figure = figureFor(evidenceKey);
    return <EvidenceDrawer onClose={() => setEvidenceKey(null)} kicker={`Evidence · ${EVIDENCE_TITLE[evidenceKey].toLowerCase()}`} title={EVIDENCE_TITLE[evidenceKey]}
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
  const openStrategyDrawer = (request: StrategyDrawerRequest) => { setNotice(null); setDrawer(null); setSrsDrawer(null); setStrategyDrawer(request); };
  const closeStrategyDrawer = () => setStrategyDrawer(null);
  const strategySaved = (text: string) => { setNotice(text); router.refresh(); };
  const srsSaved = (text: string) => { setNotice(text); router.refresh(); };
  const selectTab = (next: string) => {
    const target = tabForParam(next);
    setTab(target);
    setNotice(null);
    // The tab is in the URL, so a client screen can be linked to and reloaded where it was.
    window.history.replaceState(null, "", target === "overview" ? `/clients/${encodeURIComponent(client.id)}` : `/clients/${encodeURIComponent(client.id)}?area=${target}`);
  };

  // What each tab hosts. The sections are the components the client workspace has always rendered — only where they sit changed.
  const openPortal = canManagePortal ? () => selectTab("manage") : undefined;
  const tabBody = (id: ClientTabId) => {
    switch (id) {
      case "overview":
        return <OverviewArea workspace={workspace} jobs={jobs} today={today} onEvidence={() => setEvidenceKey("latest")} onOpenTab={selectTab} />;
      case "carbon":
        return <>
          <EmissionsHistoryCard history={workspace.history} />
          <BaselineTargetsCard workspace={workspace} access={access.target} onDrawer={openDrawer} />
          <AnalyticsArea workspace={workspace} onEvidence={setEvidenceKey} access={access.client} onDrawer={openDrawer} />
        </>;
      case "data-entry":
        // Phase 1c — what the client reports, year to year, held on the Client rather than rebuilt on every job.
        return <ReportingTemplateCard template={workspace.reportingTemplate ?? { current: null, latestVersion: 0, categories: [], masters: [] }} access={access.client}
          onEdit={() => openDrawer({ kind: "reporting-template" })} onInitialise={() => openDrawer({ kind: "reporting-template-initialise" })}
          onInitialiseFromMaster={() => openDrawer({ kind: "reporting-template-from-master" })} />;
      case "reporting":
        return <>
          <ReportingArea workspace={workspace} />
          {/* F-1b (R-D1) — the order this client's reports start in, and a line for the cover. */}
          <ReportProfileCard profile={workspace.reportProfile ?? { current: null, latestVersion: 0 }} access={access.client} onEdit={() => openDrawer({ kind: "report-profile" })} />
        </>;
      case "strategies":
        return <ReductionStrategiesArea workspace={workspace} today={today} access={access.actions} onDrawer={openStrategyDrawer} />;
      case "srs":
        return <SrsArea workspace={workspace} access={access.srs} onDrawer={openSrsDrawer} onSaved={srsSaved} />;
      case "record":
        return <>
          <RecordTab workspace={workspace} today={today} access={access} onDrawer={openDrawer} onOpenPortal={openPortal} factorsEnabled={factorsEnabled} geocodingEnabled={geocodingEnabled} />
          <FinancialsHeldArea />
          <AiProfileArea workspace={workspace} />
        </>;
      case "manage":
        return <>
          <UnavailableArea area="tasks" clientId={client.id} />
          <UnavailableArea area="notes" clientId={client.id} />
          <FilesArea workspace={workspace} />
          <CommsArea workspace={workspace} />
          {canManagePortal
            ? <PortalManagementArea clientId={client.id} clientOwnerUserId={client.ownerUserId ?? null} writeEnabled={writeEnabled} />
            : <section className="nz-panel" aria-labelledby="area-portal"><div className="nz-card-h"><h2 id="area-portal">Portal Management</h2></div><div className="nz-card-b"><p className="sub" role="status">Portal Management is not available here: it is not switched on yet, or your role does not include portal administration for this client.</p></div></section>}
          {canReadHistory ? <HistoryArea result={auditHistory} /> : null}
          <ActivityCard jobs={jobs} />
        </>;
    }
  };

  return <AppShell
    rail={<StaffRail activeId="clients" />}
    drawer={evidenceDrawer}>
    {/* The sections are the tab bar's job, not the trail's — the trail carries hierarchy. */}
    <TopBar crumbs={crumbTrail(clientCrumbs(client))} />
    <div className="nz-head"><div className="nz-client-head">
      <ClientLogoBadge client={client} onOpen={() => openDrawer({ kind: "identity" })} />
      <div className="nz-client-identity">
        <div><h1>{client.name}</h1><span className={`nz-st ${meta.cls}`}>{meta.label}</span></div>
        <p className="sub">{client.sector} · {client.location} · Account owner {client.owner}</p>
      </div>
      <div className="nz-head-actions">
        {/* No "Edit client" here: the record is edited one thing at a time, in its own
            drawer, from the surface that shows it (v10). */}
        {canManagePortal ? <button type="button" className="nz-btn" onClick={() => selectTab("manage")}>Portal access</button> : null}
        {/* Read-only preview of what this client sees. Gated on the capability the matrix has
            always described as "enter a client's portal context" — see NZC-087. */}
        {canPreviewPortal ? <Link className="nz-btn" href={`/clients/${encodeURIComponent(client.id)}/portal-preview`}>Go to portal</Link> : null}
        <Link className="nz-btn pri" href={clientJobsHref(client.id)}>Create job</Link>
      </div>
    </div>
    {/* The tab bar sits on the client header: one place to move between the client's eight sections. */}
    <div style={{ marginTop: 14 }}><Tabs className="nz-tabs" items={CLIENT_TABS} value={tab} onChange={selectTab} ariaLabel="Client sections" idBase="client" /></div>
    </div>

    <div className="nz-body" style={{ paddingTop: 16 }}>
      {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}
      {CLIENT_TABS.map(({ id }) => <TabPanel key={id} id={id} idBase="client" active={tab === id}>{tab === id ? tabBody(id) : null}</TabPanel>)}
    </div>

    <Drawer open={drawer !== null} onClose={closeDrawer} ariaLabel={drawer ? drawerLabel(drawer) : "Client drawer"} className="nz-site-drawer" dismissOnOutsideClick>
      {drawer?.kind === "identity" ? <IdentityForm key={`identity-${client.version}`} client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "targets" ? <TargetsForm clientId={client.id} targets={targets} access={access.target} onClose={closeDrawer} onSaved={saved}
        heldNetZero={{ year: client.profile.netZeroTargetYear ?? null, pct: client.profile.netZeroTargetReductionPct ?? null }} /> : null}
      {drawer?.kind === "rebaseline" ? <RebaselineForm client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "address" ? <AddressForm client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "compliance" ? <ComplianceForm client={client} access={access.client} onClose={closeDrawer} /> : null}
      {drawer?.kind === "factors" ? <FactorsDrawerBody clientId={client.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "intensity-target" ? (() => { const metric = workspace.intensityMetrics.find((item) => item.key === drawer.metricKey); return metric ? <IntensityTargetForm key={drawer.metricKey} clientId={client.id} metric={metric} target={workspace.intensityTargets?.find((item) => item.metricKey === drawer.metricKey) ?? null} access={access.target} onClose={closeDrawer} onSaved={saved} /> : null; })() : null}
      {drawer?.kind === "reporting-template" ? <ReportingTemplateForm key={`template-${workspace.reportingTemplate.latestVersion}`} clientId={client.id} template={workspace.reportingTemplate} access={access.client} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "reporting-template-from-master" ? <ReportingTemplateFromMasterForm clientId={client.id} template={workspace.reportingTemplate} access={access.client} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "reporting-template-initialise" ?<ReportingTemplateInitialiseForm clientId={client.id} template={workspace.reportingTemplate} jobs={jobs} access={access.client} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "report-profile" ? <ReportProfileForm key={`profile-${workspace.reportProfile.latestVersion}`} clientId={client.id} profile={workspace.reportProfile} access={access.client} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "intensity-metrics" ?<IntensityMetricsDrawer clientId={client.id} currency={client.profile.currency ?? "GBP"} metrics={workspace.intensityMetrics} access={access.client} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "contact" ? <ContactForm key={drawer.contact?.id ?? "new-contact"} clientId={client.id} contact={drawer.contact} latestConsent={workspace.contactConsent?.find((event) => event.contactId === drawer.contact?.id) ?? null} access={access.contact} onClose={closeDrawer} onSaved={saved} /> : null}
      {drawer?.kind === "site" ? <SiteForm key={drawer.site?.id ?? "new-site"} clientId={client.id} site={drawer.site} sites={sites} periods={[...workspace.reportingPeriods].reverse()} access={access.site} onClose={closeDrawer} onSaved={saved} onPartial={() => router.refresh()} /> : null}
    </Drawer>

    <Drawer open={srsDrawer !== null} onClose={closeSrsDrawer} ariaLabel={srsDrawer ? srsDrawerLabel(srsDrawer) : "SRS drawer"} className="nz-site-drawer" dismissOnOutsideClick>
      {srsDrawer?.kind === "srs-bridge"
        ? <SrsBridgeForm key={`${srsDrawer.assessment.assessmentId}-${srsDrawer.requirementId}`} workspace={workspace} assessment={srsDrawer.assessment}
          requirementId={srsDrawer.requirementId} access={access.srs} onClose={closeSrsDrawer} onSaved={(text: string) => { closeSrsDrawer(); srsSaved(text); }} /> : null}
      {srsDrawer?.kind === "srs-item" && workspace.srs.framework
        ? <SrsItemForm key={srsDrawer.requirement.id} framework={workspace.srs.framework} assessment={srsDrawer.assessment}
          requirement={srsDrawer.requirement} item={srsDrawer.item} access={access.srs} onClose={closeSrsDrawer} onSaved={srsSaved}
          onNext={(requirement: SrsRequirement) => setSrsDrawer({ kind: "srs-item", assessment: srsDrawer.assessment, requirement, item: srsDrawer.assessment.items.find((item) => item.requirementId === requirement.id) ?? null })} /> : null}
    </Drawer>
    <Drawer open={strategyDrawer !== null} onClose={closeStrategyDrawer} ariaLabel={strategyDrawer ? strategyDrawerLabel(strategyDrawer) : "Actions drawer"} className="nz-site-drawer" dismissOnOutsideClick>
      {strategyDrawer?.kind === "strategy-library"
        ? <StrategyLibraryForm clientId={client.id} library={strategyDrawer.library} framework={workspace.srs.framework} contacts={contacts} access={access.actions}
          onClose={closeStrategyDrawer} onSaved={strategySaved} onBespoke={() => setStrategyDrawer({ kind: "strategy-bespoke" })} /> : null}
      {strategyDrawer?.kind === "strategy-bespoke"
        ? <StrategyBespokeForm clientId={client.id} framework={workspace.srs.framework} contacts={contacts} access={access.actions} onClose={closeStrategyDrawer}
          onSaved={(text: string) => { closeStrategyDrawer(); strategySaved(text); }} /> : null}
      {strategyDrawer?.kind === "strategy-edit"
        ? <StrategyEditForm key={strategyDrawer.strategy.id} action={strategyDrawer.strategy} framework={workspace.srs.framework} contacts={contacts}
          benchmark={workspace.targets.benchmarkInForce}
          libraryDefault={workspace.strategies.library.find((entry) => entry.id === strategyDrawer.strategy.strategyId) ?? null}
          reminderDefaultLeadDays={workspace.strategies.reminders?.settings.defaultLeadDays ?? null}
          access={access.actions}
          onClose={closeStrategyDrawer} onSaved={(text: string) => { closeStrategyDrawer(); strategySaved(text); }} /> : null}
      {strategyDrawer?.kind === "strategy-proposal"
        ? <StrategyProposalForm key={strategyDrawer.strategy.id} proposal={strategyDrawer.strategy} framework={workspace.srs.framework} contacts={contacts}
          levers={workspace.strategies.levers} canPromote={canPromoteToLibrary} access={access.actions}
          onClose={closeStrategyDrawer} onSaved={(text: string) => { closeStrategyDrawer(); strategySaved(text); }} /> : null}
    </Drawer>
  </AppShell>;
}
