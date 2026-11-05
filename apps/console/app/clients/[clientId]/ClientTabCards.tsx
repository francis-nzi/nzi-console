"use client";

import Link from "next/link";
import { Collapsible, InfoTip } from "@nzi/ui";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";
import { ClientContacts } from "./ClientContacts";
import { ClientSites } from "./ClientSites";
import { ClientTargets } from "./ClientTargets";
import { ClientIntensityTargets } from "./ClientIntensityTargets";
import { VehicleRegistrationsCard } from "./VehicleRegistrationsCard";
import { ProfileArea } from "./ProfileArea";
import { Empty } from "./OverviewArea";
import { fyLabel, tonnes } from "./FigureEvidence";
import type { DrawerRequest } from "./clientDrawers";

/**
 * The working cards that used to be stacked on the Overview, unchanged, now hosted by the tab they belong to
 * (Carbon, Record, Manage). The Overview keeps only the at-a-glance set; each card here is the component that
 * rendered there before — same markup, same copy, same drawers.
 */

/** Carbon: the verified years, newest first. */
export function EmissionsHistoryCard({ history }: { history: ClientWorkspaceReadModel["history"] }) {
  return <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h" title={<h2>Emissions history</h2>} count={history.length ? `${history.length} verified year${history.length === 1 ? "" : "s"}` : "None yet"}>
    {history.length === 0
      ? <Empty text="No reviewed snapshot has been issued for this client, so there is no verified history yet." />
      : <table className="nz-tbl"><thead><tr><th>Year</th><th>Job</th><th className="num">Total</th><th>Scope split</th><th>Issued</th></tr></thead><tbody>
        {history.map((year) => <tr key={year.snapshotId}>
          <td><b>{fyLabel(year.year)}</b></td>
          <td><Link href={`/jobs/${encodeURIComponent(year.jobId)}`} className="nz-table-link">{year.jobNumber}</Link><div className="muted">snapshot v{year.snapshotVersion}</div></td>
          <td className="num">{year.totalTco2e === null ? "—" : tonnes(year.totalTco2e)}</td>
          <td>{year.scopes.map((scope) => <span key={scope.scope} className="nz-scope-inline"><span className={`nz-scope-sw s${scope.scope}`} aria-hidden="true" />{scope.tco2e === null ? "—" : Math.round(scope.tco2e).toLocaleString("en-GB")}</span>)}</td>
          <td className="muted">{formatDate(year.issuedAt)}{year.provenance ? "" : " · unstamped"}</td>
        </tr>)}
      </tbody></table>}
  </Collapsible>;
}

/** Carbon: the baseline in force, net-zero and intensity targets, and the re-baseline entry. */
export function BaselineTargetsCard({ workspace, access, onDrawer }: {
  workspace: ClientWorkspaceReadModel; access: EditAccess; onDrawer: (request: DrawerRequest) => void;
}) {
  const { targets } = workspace;
  return <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h"
    title={<h2>Baseline &amp; targets</h2>}
    count={targets.model ? "Targets set" : targets.benchmarkInForce ? "No targets set" : "No baseline"}>
    <ClientTargets targets={targets} access={access} onEdit={() => onDrawer({ kind: "targets" })} hideHead />
    {/* Phase 1b — the intensity targets live beside net zero; the job keeps only the year's Value. */}
    <ClientIntensityTargets metrics={workspace.intensityMetrics ?? []} targets={workspace.intensityTargets ?? []} access={access} onEdit={(metricKey) => onDrawer({ kind: "intensity-target", metricKey })} />
    <div className="nz-card-b" style={{ paddingTop: 0 }}>
      <button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "rebaseline" })}>⇄ Re-baseline / recalculate</button>
      <InfoTip label="the baseline record">The dated baseline record and its history timeline arrive with <code>client_baselines</code>; the baseline in force is shown above.</InfoTip>
    </div>
  </Collapsible>;
}

/** Manage: the latest workflow changes across the client's jobs. */
export function ActivityCard({ jobs }: { jobs: JobScreenReadModel[] }) {
  const activity = jobs.flatMap((job) => job.stageHistory.map((event) => ({ ...event, jobId: job.header.id, jobNumber: job.header.number })))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 6);
  return <Collapsible className="nz-panel nz-collapsible-card" headingClassName="nz-card-h"
    title={<h2>Activity</h2>}
    count={activity.length ? String(activity.length) : "None yet"}>
    {activity.length === 0
      ? <Empty text="No workflow changes have been recorded for this client." />
      : <div style={{ padding: "6px 16px 12px" }}>{activity.map((event) => <div className="nz-kv" key={event.id}>
        <span className="k"><Link href={`/jobs/${event.jobId}`}>{event.jobNumber}</Link> · {event.fromStage} → {event.toStage}</span>
        <span className="v">{formatDate(event.occurredAt)}</span>
      </div>)}</div>}
  </Collapsible>;
}

/**
 * Record: the company profile with, beneath it, the client's own record surfaces that sat in the Overview's right
 * rail — contacts (with consent), sites and vehicle registrations. The full contacts card stands in for the profile's
 * plain list, so contacts appear once. Each is edited in its drawer, as before.
 */
export function RecordTab({ workspace, today, access, onDrawer, onOpenPortal, factorsEnabled, geocodingEnabled = false }: {
  /** Opens Portal Management → Access; absent when the viewer cannot manage this client's portal. */
  onOpenPortal?: () => void;
  geocodingEnabled?: boolean;
  workspace: ClientWorkspaceReadModel;
  today: string;
  access: { site: EditAccess; contact: EditAccess; client: EditAccess };
  onDrawer: (request: DrawerRequest) => void;
  factorsEnabled: boolean;
}) {
  const { client, sites, reportingPeriods, contacts, contactConsent, degraded } = workspace;
  // A part that could not be read says so on its own card; the rest of the page is unaffected.
  const consentUnavailable = degraded?.find((entry) => entry.part === "contactConsent")?.reason ?? null;
  return <>
    <ProfileArea workspace={workspace} access={access} onDrawer={onDrawer} onOpenPortal={onOpenPortal} factorsEnabled={factorsEnabled} geocodingEnabled={geocodingEnabled}
      contactsCard={<ClientContacts contacts={contacts ?? []} consent={contactConsent ?? []} consentUnavailable={consentUnavailable} access={access.contact} onEdit={(contact) => onDrawer({ kind: "contact", contact })} />} />
    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        <ClientSites sites={sites} archived={workspace.archivedSites ?? []} reportingPeriods={reportingPeriods} today={today} access={access.site} onEdit={(site) => onDrawer({ kind: "site", site })} geocodingEnabled={geocodingEnabled} />
      </div>
      <div className="nz-cw-col">
        {/* D4 (R1): whether this client's vehicle registrations are held (sealed) or not at all. */}
        <VehicleRegistrationsCard clientId={client.id} version={client.version} optOut={client.vehicleRegistrationsOptOut === true} access={access.client} />
      </div>
    </div>
  </>;
}
