"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, GatedButton, TabPanel, Tabs, TopBar, WorkspaceRail } from "@nzi/ui";
import { patchBrowserCommandWithReason } from "@nzi/api-client";
import { clientBaselineFields, type ClientProfileFields } from "@nzi/contracts";
import { clientStatusMeta } from "@nzi/mock-data";
import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import { NAV, USER } from "../../../lib/nav";
import { formatDate } from "../../../lib/formatDate";
import { AddressGroup, ComplianceGroup, DetailsGroup, TargetsGroup, normaliseClientForm, type ClientFormState, type FieldErrors } from "../../clientForm";

const TABS = [
  { id: "details", label: "Details" },
  { id: "targets", label: "Targets" },
  { id: "address", label: "Address" },
  { id: "sites", label: "Sites" },
  { id: "compliance", label: "Compliance" },
] as const;

function formFrom(client: ClientScreenReadModel): ClientFormState {
  return { name: client.name, status: client.status, sector: client.sector, location: client.location, owner: client.owner, ...client.profile };
}

export function ClientEditTabs({ client }: { client: ClientScreenReadModel }) {
  const router = useRouter();
  const [tab, setTab] = useState<string>("details");
  const [form, setForm] = useState<ClientFormState>(formFrom(client));
  const [version, setVersion] = useState(client.version);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const submissionKey = useRef<string | null>(null);
  const [reason, setReason] = useState("");
  // NZC-068 / NZC-022 — changing a baseline that exists is a re-baseline: it needs a reason (and baseline.rebaseline).
  const rebaselining = isRebaseline(client.profile, normaliseClientForm(form));

  function change(patch: Partial<ClientFormState>) {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
    setErrors((current) => {
      const remaining = Object.entries(current).filter(([field]) => !(field in patch));
      return remaining.length === Object.keys(current).length ? current : Object.fromEntries(remaining);
    });
  }

  async function save() {
    setSaving(true); setNotice(null);
    submissionKey.current ??= crypto.randomUUID();
    const result = await patchBrowserCommandWithReason<{ clientId: string; name: string; version: number }>(
      `/api/isolated/commands/clients/${client.id}`,
      { ...normaliseClientForm(form), expectedVersion: version },
      submissionKey.current,
      rebaselining ? reason : "",
    );
    setSaving(false);
    if (result.state === "success") {
      submissionKey.current = null; setVersion(result.data.version); setErrors({}); setDirty(false); setReason("");
      setNotice({ kind: "ok", text: `${result.data.name} saved.` });
      router.refresh();
      return;
    }
    if (result.state !== "failed" || !result.retryable) submissionKey.current = null;
    if (result.state === "validation_failed") {
      setErrors(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      const firstTab = tabForField(result.issues[0]?.field);
      if (firstTab && firstTab !== tab) setTab(firstTab);
      setNotice({ kind: "warn", text: result.issues[0]?.message ?? result.message });
      return;
    }
    setNotice({ kind: "warn", text: result.state === "conflict" ? "This client was changed elsewhere. Reload to pick up the newer version before saving again." : result.message });
  }

  const meta = clientStatusMeta[client.status];
  const groupProps = { form, onChange: change, errors };

  return (
    <AppShell rail={<WorkspaceRail sections={NAV} activeId="clients" user={USER} />}>
      <TopBar searchPlaceholder="Search this client…" crumbs={<><Link href="/clients">Clients</Link><span className="muted">/</span><Link href={`/clients/${client.id}`}>{client.name}</Link><span className="muted">/</span><b>Edit</b></>} />
      <div className="nz-head">
        <div className="nz-job-titleline">
          <div>
            <div className="nz-eyebrow">Client record</div>
            <h1>Edit client <span className={`nz-st ${meta.cls}`}>{meta.label}</span></h1>
            <div className="sub">{client.name} · version {version}</div>
          </div>
          <div className="nz-head-actions">
            <Link className="nz-btn" href={`/clients/${client.id}`}>Cancel</Link>
            <GatedButton className="nz-btn pri" blocked={!dirty || saving || (rebaselining && !reason.trim())} blockedReason={!dirty ? "No unsaved changes" : rebaselining && !reason.trim() ? "Give a reason for the re-baseline" : undefined} onClick={save}>{saving ? "Saving…" : "Save all"}</GatedButton>
          </div>
        </div>
      </div>
      <div className="nz-body" style={{ paddingTop: 16 }}>
        {notice ? <div className={`nz-banner ${notice.kind}`} role="status"><div>{notice.text}</div></div> : null}
        {rebaselining ? <div className="nz-banner warn" role="status"><div><b>This changes the client&apos;s baseline — a re-baseline.</b><div style={{ marginTop: 4 }}>It needs a reason, recorded on the baseline record and in the audit log. A Consultant can re-baseline only their own clients.</div><label className="nz-fl" style={{ marginTop: 8 }}><span>Reason for the re-baseline</span><input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Acquisition of Site B restated the base year" /></label></div></div> : null}
        <Tabs items={TABS} value={tab} onChange={setTab} ariaLabel="Client record sections" idBase="client-edit" className="nz-tabs" />
        <section className="nz-panel" style={{ padding: 20 }}>
          <TabPanel id="details" idBase="client-edit" active={tab === "details"}><DetailsGroup {...groupProps} editing clientId={client.id} /></TabPanel>
          <TabPanel id="targets" idBase="client-edit" active={tab === "targets"}><TargetsGroup {...groupProps} /></TabPanel>
          <TabPanel id="address" idBase="client-edit" active={tab === "address"}><AddressGroup {...groupProps} /></TabPanel>
          <TabPanel id="sites" idBase="client-edit" active={tab === "sites"}><SitesPanel client={client} /></TabPanel>
          <TabPanel id="compliance" idBase="client-edit" active={tab === "compliance"}><ComplianceGroup {...groupProps} /></TabPanel>
          {tab !== "sites" ? (
            <div className="nz-config-actions" style={{ marginTop: 20 }}>
              <GatedButton className="nz-btn pri" blocked={!dirty || saving || (rebaselining && !reason.trim())} blockedReason={!dirty ? "No unsaved changes" : rebaselining && !reason.trim() ? "Give a reason for the re-baseline" : undefined} onClick={save}>{saving ? "Saving…" : "Save"}</GatedButton>
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

/** A baseline existed and the form changes any baseline field. Setting the first baseline is not a re-baseline. */
function isRebaseline(saved: ClientProfileFields, next: ClientProfileFields): boolean {
  const value = (source: ClientProfileFields, field: (typeof clientBaselineFields)[number]) => source[field] ?? null;
  const had = clientBaselineFields.some((field) => value(saved, field) !== null);
  return had && clientBaselineFields.some((field) => String(value(saved, field)) !== String(value(next, field)));
}

function tabForField(field: string | undefined): string | undefined {
  if (!field) return undefined;
  if (/^(netZero|baseline|scope[123]Interim)/.test(field)) return "targets";
  if (/^(registered|billing)/.test(field)) return "address";
  if (/^(parentCompany|groupStructure|reportingFrameworks|certifications|primaryScope3)/.test(field)) return "compliance";
  return "details";
}

/**
 * A read-only roll-up here; site lifecycle (registered office, in-service and
 * vacated dates, floor area) is managed on the client workspace (NZC-070).
 */
function SitesPanel({ client }: { client: ClientScreenReadModel }) {
  return (
    <div>
      <div className="nz-config-head" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <div>
          <span className="nz-eyebrow">Operational footprint</span>
          <b>Sites ({client.sites.length})</b>
          <div className="sub">Sites are effective-dated and never deleted. Add sites, set the registered office, vacate or reinstate them, and record floor area from the client workspace — or add one from a job&apos;s emissions rows.</div>
        </div>
      </div>
      {client.sites.length === 0
        ? <p className="sub" style={{ padding: "12px 0" }}>No sites have been created for this client yet.</p>
        : <table className="nz-tbl"><thead><tr><th>Site</th><th>In service</th></tr></thead><tbody>
            {client.sites.map((site) => <tr key={site.id}><td>{site.name}{site.isRegisteredOffice ? " · registered office" : ""}</td><td className="muted">{site.inServiceFrom ? formatDate(site.inServiceFrom) : "Before records"} → {site.vacatedEffective ? formatDate(site.vacatedEffective) : "present"}</td></tr>)}
          </tbody></table>}
      <div className="nz-config-actions" style={{ marginTop: 16 }}>
        <Link className="nz-btn" href={`/clients/${client.id}`}>Manage sites on the client workspace</Link>
      </div>
    </div>
  );
}
