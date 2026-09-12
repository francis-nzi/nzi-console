"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GatedButton } from "@nzi/ui";
import { patchBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  clientBaselineFields, clientCertifications, clientGroupStructures, clientReportingFrameworks, scope3CategoryCodes,
  type ClientGroupStructure, type ClientProfileFields,
} from "@nzi/contracts";
import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import { ClientFactorsManager } from "../ClientFactorsManager";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * The record drawers the retired edit page used to hold: the registered and billing
 * address, the compliance profile, and the governed re-baseline. One editor per thing,
 * each a drawer, each gated and audited by the command it sends (client.edit, and
 * baseline.rebaseline for the baseline).
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

/** Every client.update carries the whole record, so each drawer edits its own fields over the current one. */
function useClientUpdate(client: ClientScreenReadModel, onClose: () => void) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const save = async (changes: Partial<ClientProfileFields>, reason = "") => {
    setPending(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    const input = {
      expectedVersion: client.version, name: client.name, status: client.status, sector: client.sector,
      location: client.location, owner: client.owner, ...client.profile, ...changes,
    };
    const result = await patchBrowserCommandWithReason<{ version: number }>(`/api/isolated/commands/clients/${encodeURIComponent(client.id)}`, input, key.current, reason);
    setPending(false);
    if (result.state !== "success") {
      key.current = null;
      setError(result.state === "conflict" ? "The client record changed since this was opened. Close and reopen to see the latest." : errorText(result));
      return false;
    }
    key.current = null;
    onClose();
    router.refresh();
    return true;
  };
  return { pending, error, save };
}

function DrawerFrame({ kicker, title, onClose, children, footer }: { kicker: string; title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  return <>
    <div className="nz-dh"><div className="k">{kicker}</div><h3>{title}</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">{children}</div>
    <div className="nz-df"><button type="button" className="nz-btn" onClick={onClose}>Cancel</button><span className="sp" />{footer}</div>
  </>;
}

const Text = ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) =>
  <label className="nz-fl"><span>{label}</span><input className="nz-inp" value={value} onChange={(event) => onChange(event.target.value)} /></label>;

export function AddressForm({ client, access, onClose }: { client: ClientScreenReadModel; access: EditAccess; onClose: () => void }) {
  const profile = client.profile;
  const [draft, setDraft] = useState({
    registeredAddressLine1: profile.registeredAddressLine1 ?? "", registeredAddressLine2: profile.registeredAddressLine2 ?? "",
    registeredCity: profile.registeredCity ?? "", registeredRegion: profile.registeredRegion ?? "",
    registeredPostcode: profile.registeredPostcode ?? "", registeredCountry: profile.registeredCountry ?? "",
    billingSameAsRegistered: profile.billingSameAsRegistered ?? true, billingCompany: profile.billingCompany ?? "",
    billingAddressLine1: profile.billingAddressLine1 ?? "", billingCity: profile.billingCity ?? "", billingPostcode: profile.billingPostcode ?? "",
  });
  const { pending, error, save } = useClientUpdate(client, onClose);
  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  const denied = access.state !== "allowed" ? access.reason : null;
  return <DrawerFrame kicker="Invoicing" title="Registered address" onClose={onClose}
    footer={<GatedButton className="nz-btn pri" blocked={pending || denied !== null} blockedReason={pending ? "Saving…" : denied ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save(draft)}>{pending ? "Saving…" : "Save address"}</GatedButton>}>
    <Text label="Registered / trading address" value={draft.registeredAddressLine1} onChange={(value) => set({ registeredAddressLine1: value })} />
    <Text label="Address line 2" value={draft.registeredAddressLine2} onChange={(value) => set({ registeredAddressLine2: value })} />
    <div className="nz-two">
      <Text label="City" value={draft.registeredCity} onChange={(value) => set({ registeredCity: value })} />
      <Text label="Postcode" value={draft.registeredPostcode} onChange={(value) => set({ registeredPostcode: value })} />
    </div>
    <div className="nz-two">
      <Text label="Region" value={draft.registeredRegion} onChange={(value) => set({ registeredRegion: value })} />
      <Text label="Country" value={draft.registeredCountry} onChange={(value) => set({ registeredCountry: value })} />
    </div>
    <label className="nz-check"><input type="checkbox" checked={draft.billingSameAsRegistered} onChange={(event) => set({ billingSameAsRegistered: event.target.checked })} /> Billing address same as registered</label>
    {draft.billingSameAsRegistered ? null : <>
      <Text label="Billing company" value={draft.billingCompany} onChange={(value) => set({ billingCompany: value })} />
      <Text label="Billing address" value={draft.billingAddressLine1} onChange={(value) => set({ billingAddressLine1: value })} />
      <div className="nz-two">
        <Text label="Billing city" value={draft.billingCity} onChange={(value) => set({ billingCity: value })} />
        <Text label="Billing postcode" value={draft.billingPostcode} onChange={(value) => set({ billingPostcode: value })} />
      </div>
    </>}
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
  </DrawerFrame>;
}

const CheckList = ({ legend, options, selected, onToggle }: { legend: string; options: readonly string[]; selected: string[]; onToggle: (value: string) => void }) => (
  <div className="nz-fl"><span>{legend}</span>
    <div className="nz-roles" role="group" aria-label={legend}>
      {options.map((option) => <label key={option} className="nz-rolechk"><input type="checkbox" checked={selected.includes(option)} onChange={() => onToggle(option)} /> {option}</label>)}
    </div>
  </div>
);

export function ComplianceForm({ client, access, onClose }: { client: ClientScreenReadModel; access: EditAccess; onClose: () => void }) {
  const profile = client.profile;
  const [parentCompany, setParent] = useState(profile.parentCompany ?? "");
  const [groupStructure, setGroup] = useState<ClientGroupStructure | "">(profile.groupStructure ?? "");
  const [frameworks, setFrameworks] = useState<string[]>(profile.reportingFrameworks ?? []);
  const [certifications, setCertifications] = useState<string[]>(profile.certifications ?? []);
  const [scope3, setScope3] = useState<string[]>(profile.primaryScope3Categories ?? []);
  const { pending, error, save } = useClientUpdate(client, onClose);
  const toggle = (list: string[], value: string, set: (next: string[]) => void, order: readonly string[]) =>
    set(order.filter((item) => item === value ? !list.includes(value) : list.includes(item)));
  const denied = access.state !== "allowed" ? access.reason : null;
  return <DrawerFrame kicker="Obligations" title="Compliance" onClose={onClose}
    footer={<GatedButton className="nz-btn pri" blocked={pending || denied !== null} blockedReason={pending ? "Saving…" : denied ?? undefined} reasonClassName="hint nz-gated-reason"
      onClick={() => void save({ parentCompany: parentCompany.trim() || null, groupStructure: groupStructure || null, reportingFrameworks: frameworks, certifications, primaryScope3Categories: scope3 })}>{pending ? "Saving…" : "Save compliance"}</GatedButton>}>
    <Text label="Parent company" value={parentCompany} onChange={setParent} />
    <label className="nz-fl"><span>Group structure</span>
      <select className="nz-sel" value={groupStructure} onChange={(event) => setGroup(event.target.value as ClientGroupStructure | "")}>
        <option value="">Not set</option>
        {clientGroupStructures.map((value) => <option key={value} value={value}>{value.replace("-", " ").replace(/^./, (letter) => letter.toUpperCase())}</option>)}
      </select>
    </label>
    <CheckList legend="Reporting frameworks" options={clientReportingFrameworks} selected={frameworks} onToggle={(value) => toggle(frameworks, value, setFrameworks, clientReportingFrameworks)} />
    <CheckList legend="Certifications & commitments" options={clientCertifications} selected={certifications} onToggle={(value) => toggle(certifications, value, setCertifications, clientCertifications)} />
    <CheckList legend="Primary Scope 3 categories" options={scope3CategoryCodes} selected={scope3} onToggle={(value) => toggle(scope3, value, setScope3, scope3CategoryCodes)} />
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
  </DrawerFrame>;
}

/**
 * The baseline: the past anchor. Changing one that exists is a re-baseline — it needs
 * `baseline.rebaseline` (own clients for a Consultant), a reason, and it writes a governed
 * event. Targets are not touched: they are held against the benchmark they were set
 * against until they are restated deliberately (NZC-068).
 */
export function RebaselineForm({ client, access, onClose }: { client: ClientScreenReadModel; access: EditAccess; onClose: () => void }) {
  const profile = client.profile;
  const [draft, setDraft] = useState({
    baselinePeriodStart: profile.baselinePeriodStart ?? "", baselinePeriodEnd: profile.baselinePeriodEnd ?? "",
    baselineScope1Tco2e: profile.baselineScope1Tco2e?.toString() ?? "", baselineScope2Tco2e: profile.baselineScope2Tco2e?.toString() ?? "",
    baselineScope3Tco2e: profile.baselineScope3Tco2e?.toString() ?? "", baselineTotalTco2e: profile.baselineTotalTco2e?.toString() ?? "",
  });
  const [reason, setReason] = useState("");
  const { pending, error, save } = useClientUpdate(client, onClose);
  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  const number = (value: string) => value.trim() === "" ? null : Number(value);
  const changes = {
    baselinePeriodStart: draft.baselinePeriodStart || null, baselinePeriodEnd: draft.baselinePeriodEnd || null,
    baselineScope1Tco2e: number(draft.baselineScope1Tco2e), baselineScope2Tco2e: number(draft.baselineScope2Tco2e),
    baselineScope3Tco2e: number(draft.baselineScope3Tco2e), baselineTotalTco2e: number(draft.baselineTotalTco2e),
  };
  const had = clientBaselineFields.some((field) => (profile[field] ?? null) !== null);
  const changed = clientBaselineFields.some((field) => String(profile[field] ?? "") !== String(changes[field] ?? ""));
  const rebaselining = had && changed;
  const problem = !draft.baselinePeriodStart || !draft.baselinePeriodEnd ? "Give the baseline period."
    : draft.baselinePeriodEnd <= draft.baselinePeriodStart ? "The baseline period must end after it starts."
    : Object.values(changes).some((value) => typeof value === "number" && !Number.isFinite(value)) ? "Baseline figures must be numbers."
    : rebaselining && !reason.trim() ? "Give a reason for the re-baseline."
    : null;
  const denied = access.state !== "allowed" ? access.reason : null;
  return <DrawerFrame kicker="Baseline & targets" title={had ? "Re-baseline" : "Set the baseline"} onClose={onClose}
    footer={<GatedButton className="nz-btn pri" blocked={pending || denied !== null || problem !== null} blockedReason={pending ? "Saving…" : denied ?? problem ?? undefined} reasonClassName="hint nz-gated-reason"
      onClick={() => void save(changes, rebaselining ? reason : "")}>{pending ? "Saving…" : had ? "Record baseline change" : "Set baseline"}</GatedButton>}>
    <p className="nz-hint" style={{ marginTop: 0 }}>The baseline is the past anchor every target and every trend is measured against. Forward targets are set separately, in Reduction targets.</p>
    <div className="nz-two">
      <label className="nz-fl"><span>Period start<span className="nz-req">*</span></span><input className="nz-inp" type="date" value={draft.baselinePeriodStart} onChange={(event) => set({ baselinePeriodStart: event.target.value })} /></label>
      <label className="nz-fl"><span>Period end<span className="nz-req">*</span></span><input className="nz-inp" type="date" value={draft.baselinePeriodEnd} onChange={(event) => set({ baselinePeriodEnd: event.target.value })} /></label>
    </div>
    <div className="nz-three">
      <label className="nz-fl"><span>Scope 1</span><input className="nz-inp num" inputMode="decimal" value={draft.baselineScope1Tco2e} onChange={(event) => set({ baselineScope1Tco2e: event.target.value })} /></label>
      <label className="nz-fl"><span>Scope 2</span><input className="nz-inp num" inputMode="decimal" value={draft.baselineScope2Tco2e} onChange={(event) => set({ baselineScope2Tco2e: event.target.value })} /></label>
      <label className="nz-fl"><span>Scope 3</span><input className="nz-inp num" inputMode="decimal" value={draft.baselineScope3Tco2e} onChange={(event) => set({ baselineScope3Tco2e: event.target.value })} /></label>
    </div>
    <label className="nz-fl"><span>Baseline total</span><input className="nz-inp num" inputMode="decimal" value={draft.baselineTotalTco2e} onChange={(event) => set({ baselineTotalTco2e: event.target.value })} />
      <span className="nz-hint">Leave blank to use the sum of the scopes.</span></label>
    {rebaselining ? <label className="nz-fl"><span>Reason for the re-baseline<span className="nz-req">*</span></span>
      <input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Acquisition of Site B restated the base year" />
      <span className="nz-hint">Recorded on the baseline record and in the audit log.</span></label> : null}
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>A re-baseline is <b>governed</b>: reason required, prior baseline retained, audit-logged. Targets are <b>held</b> against the benchmark they were set against until they are restated deliberately (NZC-068).</span></div>
  </DrawerFrame>;
}

/** Client factors: the same manager, hosted in the drawer rather than dropped into the page. */
export function FactorsDrawerBody({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  return <DrawerFrame kicker="Reference data" title="Client factors" onClose={onClose}
    footer={<button type="button" className="nz-btn pri" onClick={onClose}>Done</button>}>
    <ClientFactorsManager clientId={clientId} />
  </DrawerFrame>;
}

/** Portal access is administered in Platform & audit; this says so rather than duplicating it. */
export function PortalDrawerBody({ client, onClose }: { client: ClientScreenReadModel; onClose: () => void }) {
  return <DrawerFrame kicker="Client experience" title="Portal access" onClose={onClose}
    footer={<Link className="nz-btn pri nz-dact-fit" href="/platform">Manage access &amp; invites</Link>}>
    <p className="nz-hint" style={{ marginTop: 0 }}>Portal users are a separate principal type with their own identity, so they are administered in <b>Platform &amp; audit</b>: invitations, job-level access and data-entry windows, each audited.</p>
    <div className="nz-kv"><span className="k">Client</span><span className="v">{client.name}</span></div>
    <div className="nz-kv"><span className="k">Invite candidates</span><span className="v">Contacts marked <b>Portal candidate</b></span></div>
    <p className="nz-maps">Mark a contact as a portal candidate on this client&apos;s Contacts card, then invite them from Platform &amp; audit.</p>
  </DrawerFrame>;
}
