"use client";

import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { GatedButton } from "@nzi/ui";
import type { EditAccess } from "../../lib/useEditAccess";
import { CardHead } from "./OverviewArea";
import type { DrawerRequest } from "./clientDrawers";

/**
 * Company Profile (client workspace v10, phase 2): the whole client record on one screen —
 * identity, compliance, addresses and reference data — each block edited in the drawer that
 * already owns it. One editor per thing: this area reads the record and opens those
 * drawers; it does not introduce a second way to edit the same fields.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (month: number | null | undefined) => month && month >= 1 && month <= 12 ? MONTHS[month - 1]! : null;

export function ProfileArea({ workspace, access, onDrawer, factorsEnabled }: {
  workspace: ClientWorkspaceReadModel;
  access: { client: EditAccess; contact: EditAccess };
  onDrawer: (request: DrawerRequest) => void;
  factorsEnabled: boolean;
}) {
  const { client, contacts } = workspace;
  const profile = client.profile;
  const address = [profile.registeredAddressLine1, profile.registeredAddressLine2, profile.registeredCity, profile.registeredRegion, profile.registeredPostcode, profile.registeredCountry]
    .map((part) => part?.trim()).filter(Boolean);
  const billing = profile.billingSameAsRegistered
    ? null
    : [profile.billingCompany, profile.billingAddressLine1, profile.billingAddressLine2, profile.billingCity, profile.billingRegion, profile.billingPostcode, profile.billingCountry]
      .map((part) => part?.trim()).filter(Boolean);

  // Only the record drawers that carry no payload — each named, so no cast is needed and
  // a drawer that stops existing stops compiling.
  const edit = (request: { kind: "identity" } | { kind: "compliance" } | { kind: "address" }, label = "Edit") => <GatedButton className="nz-editlink"
    blocked={access.client.state !== "allowed"} blockedReason={access.client.state === "allowed" ? undefined : access.client.reason}
    reasonClassName="hint nz-gated-reason" onClick={() => onDrawer(request)}>{label}</GatedButton>;

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Record</div><h2>Company profile</h2></div><span style={{ flex: 1 }} />
      <span className="sub">Version {client.version}</span></div>
    <p className="nz-cw-vsub">What this client is, as the platform holds it. Every block is edited in its own drawer, and every change is versioned and audited.</p>

    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow="Identity" title="Identity" right={edit({ kind: "identity" })} />
          <div style={{ padding: "6px 16px 12px" }}>
            <Row label="Client name" value={client.name} />
            <Row label="Status" value={client.status} />
            <Row label="Industry" value={client.sector} />
            <Row label="SIC code" value={profile.industrySic} />
            <Row label="Company registration" value={profile.companyRegistration} />
            <Row label="Website" value={profile.website} />
            <Row label="Financial year end" value={monthName(profile.financialYearEndMonth)} hint="Sets each reporting year's period and the 300–400 day eligibility rule (NZC-067)." />
            <Row label="Reporting frequency" value={profile.dataReportingFrequency} />
            <Row label="Currency" value={profile.currency} />
            <Row label="Account owner" value={client.owner} />
            <Row label="Member since" value={client.memberSince} />
          </div>
        </section>

        <section className="nz-panel">
          <CardHead eyebrow="Obligations" title="Compliance" right={edit({ kind: "compliance" })} />
          <div style={{ padding: "6px 16px 12px" }}>
            <Row label="Parent company" value={profile.parentCompany} />
            <Row label="Group structure" value={profile.groupStructure} />
            <ListRow label="Reporting frameworks" values={profile.reportingFrameworks} />
            <ListRow label="Certifications" values={profile.certifications} />
            <ListRow label="Primary Scope 3 categories" values={profile.primaryScope3Categories} />
          </div>
        </section>
      </div>

      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow="Invoicing" title="Addresses" right={edit({ kind: "address" })} />
          <div style={{ padding: "6px 16px 12px" }}>
            <div className="nz-kv"><span className="k">Registered</span><span className="v">{address.length ? address.join(", ") : <span className="muted">Not set</span>}</span></div>
            <div className="nz-kv"><span className="k">Billing</span><span className="v">{profile.billingSameAsRegistered
              ? "Same as registered"
              : billing && billing.length ? billing.join(", ") : <span className="muted">Not set</span>}</span></div>
            {profile.headquarters ? <Row label="Headquarters" value={profile.headquarters} /> : null}
          </div>
        </section>

        <section className="nz-panel">
          <CardHead eyebrow="Relationship" title="Contacts" right={<button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "contact", contact: null })}>Add</button>} />
          <div style={{ padding: "6px 16px 12px" }}>
            {contacts.length === 0
              ? <p className="sub" style={{ margin: "6px 0" }}>No contact is recorded for this client.</p>
              : contacts.map((contact) => <div className="nz-kv" key={contact.id}>
                <span className="k">{contact.fullName}{contact.isPrimary ? <span className="nz-tag rr" style={{ marginLeft: 6 }}>Primary</span> : null}</span>
                <span className="v"><button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "contact", contact })}>{contact.jobTitle || "Edit"}</button></span>
              </div>)}
          </div>
        </section>

        <section className="nz-panel">
          <CardHead eyebrow="Reference data" title="Client factors" />
          <div style={{ padding: "6px 16px 12px" }}>
            {factorsEnabled
              ? <>
                <p className="sub" style={{ margin: "6px 0" }}>Client-specific, EPD-backed factors reusable across this client&apos;s jobs, with the same versioning and evidence lineage as dataset factors.</p>
                <button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "factors" })}>Manage client factors</button>
              </>
              : <p className="sub" style={{ margin: "6px 0" }}>Client factors are not enabled in this environment.</p>}
          </div>
        </section>

        <section className="nz-panel">
          <CardHead eyebrow="Client experience" title="Portal access" right={<button type="button" className="nz-editlink" onClick={() => onDrawer({ kind: "portal" })}>Open</button>} />
          <div style={{ padding: "6px 16px 12px" }}>
            <p className="sub" style={{ margin: "6px 0" }}>Portal users, their job-level access and data-entry windows.</p>
          </div>
        </section>
      </div>
    </div>
  </>;
}

function Row({ label, value, hint }: { label: string; value: string | null | undefined; hint?: string }) {
  return <div className="nz-kv">
    <span className="k">{label}{hint ? <span className="hint">{hint}</span> : null}</span>
    <span className="v">{value?.toString().trim() ? value : <span className="muted">Not set</span>}</span>
  </div>;
}
function ListRow({ label, values }: { label: string; values: readonly string[] | null | undefined }) {
  const list = (values ?? []).filter((value) => value.trim());
  return <div className="nz-kv"><span className="k">{label}</span>
    <span className="v">{list.length ? list.join(" · ") : <span className="muted">None recorded</span>}</span></div>;
}
