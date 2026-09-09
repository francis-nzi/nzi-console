"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, GatedButton, TabPanel, Tabs, TopBar, WorkspaceRail } from "@nzi/ui";
import { patchBrowserCommand } from "@nzi/api-client";
import { clientStatusMeta } from "@nzi/mock-data";
import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import { NAV, USER } from "../../../lib/nav";
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
    const result = await patchBrowserCommand<{ clientId: string; name: string; version: number }>(
      `/api/isolated/commands/clients/${client.id}`,
      { ...normaliseClientForm(form), expectedVersion: version },
      submissionKey.current,
    );
    setSaving(false);
    if (result.state === "success") {
      submissionKey.current = null; setVersion(result.data.version); setErrors({}); setDirty(false);
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
            <GatedButton className="nz-btn pri" blocked={!dirty || saving} blockedReason={!dirty ? "No unsaved changes" : undefined} onClick={save}>{saving ? "Saving…" : "Save all"}</GatedButton>
          </div>
        </div>
      </div>
      <div className="nz-body" style={{ paddingTop: 16 }}>
        {notice ? <div className={`nz-banner ${notice.kind}`} role="status"><div>{notice.text}</div></div> : null}
        <Tabs items={TABS} value={tab} onChange={setTab} ariaLabel="Client record sections" idBase="client-edit" className="nz-tabs" />
        <section className="nz-panel" style={{ padding: 20 }}>
          <TabPanel id="details" idBase="client-edit" active={tab === "details"}><DetailsGroup {...groupProps} /></TabPanel>
          <TabPanel id="targets" idBase="client-edit" active={tab === "targets"}><TargetsGroup {...groupProps} /></TabPanel>
          <TabPanel id="address" idBase="client-edit" active={tab === "address"}><AddressGroup {...groupProps} /></TabPanel>
          <TabPanel id="sites" idBase="client-edit" active={tab === "sites"}><SitesPanel client={client} /></TabPanel>
          <TabPanel id="compliance" idBase="client-edit" active={tab === "compliance"}><ComplianceGroup {...groupProps} /></TabPanel>
          {tab !== "sites" ? (
            <div className="nz-config-actions" style={{ marginTop: 20 }}>
              <GatedButton className="nz-btn pri" blocked={!dirty || saving} blockedReason={!dirty ? "No unsaved changes" : undefined} onClick={save}>{saving ? "Saving…" : "Save"}</GatedButton>
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

function tabForField(field: string | undefined): string | undefined {
  if (!field) return undefined;
  if (/^(netZero|baseline|scope[123]Interim)/.test(field)) return "targets";
  if (/^(registered|billing)/.test(field)) return "address";
  if (/^(parentCompany|groupStructure|reportingFrameworks|certifications|primaryScope3)/.test(field)) return "compliance";
  return "details";
}

/**
 * Sites stay job-scoped (a site is created in the job workspace where it is first
 * used); this is the client-level roll-up of what those jobs have created.
 */
function SitesPanel({ client }: { client: ClientScreenReadModel }) {
  return (
    <div>
      <div className="nz-config-head" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <div>
          <span className="nz-eyebrow">Operational footprint</span>
          <b>Sites ({client.sites.length})</b>
          <div className="sub">Sites are created in the job workspace where they are first used, so every site stays tied to the engagement that measures it.</div>
        </div>
      </div>
      {client.sites.length === 0
        ? <p className="sub" style={{ padding: "12px 0" }}>No sites have been created for this client yet. Open a job and add a site from its emissions rows.</p>
        : <table className="nz-tbl"><thead><tr><th>Site</th><th>Reference</th></tr></thead><tbody>
            {client.sites.map((site) => <tr key={site.id}><td>{site.name}</td><td className="muted">{site.id}</td></tr>)}
          </tbody></table>}
      <div className="nz-config-actions" style={{ marginTop: 16 }}>
        <Link className="nz-btn" href={`/jobs?client=${client.id}`}>Open jobs to add a site</Link>
      </div>
    </div>
  );
}
