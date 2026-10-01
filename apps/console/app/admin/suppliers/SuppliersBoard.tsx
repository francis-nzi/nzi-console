"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  isAgreedRate, isSupplierContactEmail, PAGE_SIZES, SUPPLIER_CONTACT_NAME_MAX, SUPPLIER_CONTACT_PHONE_MAX, SUPPLIER_COST_TYPE_MAX, SUPPLIER_ITEM_DESCRIPTION_MAX,
  SUPPLIER_ITEM_NAME_MAX, SUPPLIER_NAME_MAX, SUPPLIER_WEBSITE_MAX, supplierListSpec, type SupplierListQuery,
} from "@nzi/contracts";
import type { JobItemPickers, SupplierContactRow, SupplierItemRow, SupplierPage, SupplierParts, SupplierRow } from "@nzi/isolated-backend";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, ProvenanceBadge, SelectField, StatusBadge, Switch, TextAreaField, TextField,
  type DataListColumn,
} from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * Suppliers (admin Phase E4): DataList → drawer → audit. The drawer holds the company (name, website), the people at it
 * and its rate card. The people are third-party personal data, sealed on write (E-Q6): what the audit records is which
 * fields changed, never the values. An agreed rate is finance.manage's (E-Q8): shown, and set by its own command, only to
 * a holder — the audit records that it changed, never the figure. One currency, the organisation's (E-Q9).
 */
type Gate = { allowed: true } | { allowed: false; reason: string };
type Failure = Exclude<BrowserCommandResult<unknown>, { state: "success" }>;
const count = new Intl.NumberFormat("en-GB");
const money = (value: number | null, currency: string) => value === null ? "Not agreed"
  : new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2 }).format(value);
const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const blank = (value: string) => value.trim() || null;
const describe = (result: Failure, what: string) => result.state === "validation_failed"
  ? { fields: Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])), message: result.issues.length ? null : "That was refused." }
  : { fields: {}, message: result.state === "conflict" ? `This ${what} changed since the page loaded. It has been refreshed — try again.` : result.message };

/** Idempotency keys per step, so a retried click is the same command rather than a second one. */
function useKeys() {
  const keys = useRef<Record<string, string>>({});
  return { key: (step: string) => (keys.current[step] ??= crypto.randomUUID()), reset: () => { keys.current = {}; } };
}

export function SuppliersBoard({ page, parts, pickers, query, editing, rating, showRates }: {
  page: SupplierPage; parts: Record<string, SupplierParts>; pickers: JobItemPickers; query: SupplierListQuery; editing: Gate; rating: Gate; showRates: boolean;
}) {
  const router = useRouter();
  const nav = useListNavigation(supplierListSpec, query, "/admin/suppliers");
  // The open supplier by id, so a refresh after a save re-reads its contacts and rate card while the drawer stays open.
  const [open, setOpen] = useState<{ supplierId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";
  const done = (message: string) => { setNotice(message); router.refresh(); };

  const columns: DataListColumn<SupplierRow>[] = [
    { key: "name", header: "Supplier", sortKey: "name", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ supplierId: row.supplierId })}>{row.name}</button>
      {row.website ? <div className="nz-a-sub">{row.website}</div> : null}
    </div> },
    { key: "contacts", header: "Contacts", sortKey: "contacts", numeric: true, cell: (row) => <span className={`nz-a-mono${row.contacts === 0 ? " nz-a-muted" : ""}`}>{count.format(row.contacts)}</span> },
    { key: "items", header: "Rate card", sortKey: "items", numeric: true, cell: (row) => <span className={`nz-a-mono${row.items === 0 ? " nz-a-muted" : ""}`} title="Active services on the rate card">{count.format(row.items)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;
  const openRow = open?.supplierId ? page.rows.find((row) => row.supplierId === open.supplierId) ?? null : null;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Commercial</div>
        <h1>Suppliers</h1>
        <p>The subcontractors a job’s other costs are bought from: the company, the people at it, and its rate card of agreed services.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        <CapabilityChip capability="finance.manage" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ supplierId: null })}>+ New supplier</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div><b>Contacts are third-party personal data</b>, sealed when saved: the audit records which details changed, never what they are. {showRates
        ? <>Agreed rates are visible to you because you hold finance.manage, held in the organisation’s currency{pickers.currency ? <> (<b>{pickers.currency}</b>)</> : null}.</>
        : <><b>Agreed rates are restricted</b> to finance.manage.</>}{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Suppliers"
        rows={page.rows}
        rowKey={(row) => row.supplierId}
        columns={columns}
        search={{ value: query.search, label: "Search suppliers", placeholder: "Search by name…", onChange: nav.search }}
        filters={[]}
        onFilter={() => undefined}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as SupplierListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No suppliers yet</b><span>{editing.allowed ? "Add the first one, or import v7’s." : "Suppliers arrive with the v7 supplier import."}</span></>
          : <><b>No suppliers match</b><span>Clear the search or the filter to see them all.</span></>}
        onSelect={(row) => setOpen({ supplierId: row.supplierId })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">Deactivating a supplier keeps its contacts and rate card; it only stops new ones being added. A contact is removed only by erasure, through a data-subject request.</p>
    </div>

    {/* A supplier just added opens in place once the refreshed list holds it; one not on this page simply stays closed. */}
    {open && (open.supplierId === null || openRow) ? <SupplierDrawer key={open.supplierId ?? "new"} row={openRow} parts={open.supplierId ? parts[open.supplierId] ?? null : null} pickers={pickers}
      editing={editing} rating={rating} onClose={() => setOpen(null)}
      onCreated={(supplierId, message) => { setOpen({ supplierId }); done(message); }}
      onSaved={done} /> : null}
  </>;
}

function SupplierDrawer({ row, parts, pickers, editing, rating, onClose, onCreated, onSaved }: {
  row: SupplierRow | null; parts: SupplierParts | null; pickers: JobItemPickers; editing: Gate; rating: Gate;
  onClose: () => void; onCreated: (supplierId: string, message: string) => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const readOnly = !editing.allowed;
  const [draft, setDraft] = useState({ name: row?.name ?? "", website: row?.website ?? "", active: row?.active ?? true, reason: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { key, reset } = useKeys();
  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const changed = row !== null && (clean(draft.name) !== row.name || blank(draft.website) !== row.website);

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const local: Record<string, string> = {};
    if (!draft.name.trim()) local.name = "A supplier's name is required.";
    if (deactivating && !draft.reason.trim()) local.reason = "Say why this supplier is being deactivated.";
    if (Object.keys(local).length) { setIssues(local); return; }
    const fail = (result: Failure) => { const { fields, message } = describe(result, "supplier"); setIssues(fields); setProblem(message ?? fields.supplierId ?? null); reset(); };
    setSaving(true);
    try {
      const fields = { name: draft.name, website: blank(draft.website) };
      if (isNew) {
        const result = await postBrowserCommand<{ supplierId: string }>("/api/isolated/suppliers", fields, key("create"));
        if (result.state !== "success") return fail(result);
        return onCreated(result.data.supplierId, `Added “${clean(draft.name)}”. Its contacts and rate card are added in its panel.`);
      }
      const path = `/api/isolated/suppliers/${encodeURIComponent(row.supplierId)}`;
      let version = row.version;
      const done: string[] = [];
      if (changed) {
        const result = await patchBrowserCommand<{ version: number }>(path, { ...fields, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("saved");
      }
      if (reinstating) {
        const result = await postBrowserCommand(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        done.push("reinstated");
      } else if (deactivating) {
        const result = await postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        done.push("deactivated");
      }
      reset();
      onSaved(done.length ? `“${clean(draft.name)}” ${done.join(", ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Supplier" title={isNew ? "New supplier" : row.name}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Close</button>
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : isNew ? "Add supplier" : deactivating ? "Deactivate supplier" : "Save supplier"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Name" value={draft.name} required maxLength={SUPPLIER_NAME_MAX} placeholder="e.g. Verifiers Ltd" error={issues.name}
      readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />
    <TextField label="Website" value={draft.website} maxLength={SUPPLIER_WEBSITE_MAX} placeholder="Optional" error={issues.website}
      readOnly={readOnly} onChange={(website) => setDraft({ ...draft, website })} />
    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : "Added here"} readOnly /> : null}
    {!isNew ? <Switch label="Active" description="An inactive supplier keeps its contacts and rate card; nothing new can be added to it." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}

    {isNew || parts === null ? <p className="nz-a-hint">Contacts and the rate card are added once the supplier is saved.</p> : <>
      <h3>Contacts</h3>
      <p className="nz-a-hint">Third-party personal data, sealed when saved. The audit records which details changed — never the details.</p>
      {parts.contacts.length === 0 ? <p className="nz-a-muted">None yet.</p> : <ul className="nz-a-sub-records">
        {parts.contacts.map((contact) => <ContactCard key={`${contact.contactId}:${contact.version}`} contact={contact} readOnly={readOnly} onSaved={onSaved} />)}
      </ul>}
      {!readOnly && row.active ? <AddContact key={`add-contact:${parts.contacts.length}`} supplierId={row.supplierId} onSaved={onSaved} /> : null}

      <h3>Rate card <CapabilityChip capability="finance.manage" /></h3>
      <p className="nz-a-hint">{rating.allowed ? "Changing an agreed rate records that it changed — never the figure." : rating.reason}</p>
      {parts.items.length === 0 ? <p className="nz-a-muted">None yet.</p> : <ul className="nz-a-sub-records">
        {parts.items.map((item) => <LineCard key={`${item.serviceItemId}:${item.version}`} item={item} pickers={pickers} readOnly={readOnly} rating={rating} onSaved={onSaved} />)}
      </ul>}
      {!readOnly && row.active ? <AddLine key={`add-line:${parts.items.length}`} supplierId={row.supplierId} pickers={pickers} onSaved={onSaved} /> : null}
    </>}
  </DrawerEditor>;
}

// ── Contacts ─────────────────────────────────────────────────────────────────────────────────────────────────────

type ContactDraft = { fullName: string; email: string; phone: string };
const contactIssues = (draft: ContactDraft) => {
  const local: Record<string, string> = {};
  if (!draft.fullName.trim()) local.fullName = "A contact's name is required.";
  if (draft.email.trim() && !isSupplierContactEmail(draft.email)) local.email = "Enter a valid email address, or leave it blank.";
  return local;
};
const contactPayload = (draft: ContactDraft) => ({ fullName: draft.fullName, email: blank(draft.email), phone: blank(draft.phone) });

function ContactFields({ draft, issues, onChange }: { draft: ContactDraft; issues: Record<string, string>; onChange: (draft: ContactDraft) => void }) {
  return <>
    <TextField label="Name" value={draft.fullName} required maxLength={SUPPLIER_CONTACT_NAME_MAX} error={issues.fullName} onChange={(fullName) => onChange({ ...draft, fullName })} />
    <FieldRow>
      <TextField label="Email" value={draft.email} maxLength={254} placeholder="Optional" error={issues.email} onChange={(email) => onChange({ ...draft, email })} />
      <TextField label="Phone" value={draft.phone} maxLength={SUPPLIER_CONTACT_PHONE_MAX} placeholder="Optional" error={issues.phone} onChange={(phone) => onChange({ ...draft, phone })} />
    </FieldRow>
  </>;
}

function ContactCard({ contact, readOnly, onSaved }: { contact: SupplierContactRow; readOnly: boolean; onSaved: (message: string) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "deactivate">("view");
  const [draft, setDraft] = useState<ContactDraft>({ fullName: contact.fullName ?? "", email: contact.email ?? "", phone: contact.phone ?? "" });
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { key, reset } = useKeys();
  const path = `/api/isolated/supplier-contacts/${encodeURIComponent(contact.contactId)}`;
  const run = async (step: () => Promise<BrowserCommandResult<unknown>>, message: string) => {
    setSaving(true); setIssues({}); setProblem(null);
    try {
      const result = await step();
      if (result.state !== "success") { const { fields, message: text } = describe(result, "contact"); setIssues(fields); setProblem(text ?? fields.contactId ?? null); reset(); return; }
      onSaved(message);
    } finally { setSaving(false); }
  };

  if (contact.erased) return <li><div className="nz-a-sub-record-head"><span className="nz-a-muted">Erased contact</span><StatusBadge active={contact.active} /></div>
    <p className="nz-a-hint">This person’s details were erased on request. The record stays so nothing that pointed at it dangles.</p></li>;
  return <li>
    <div className="nz-a-sub-record-head">
      <div>
        <div className="nz-a-sub-record-name">{contact.fullName}</div>
        <div className="nz-a-sub">{[contact.email, contact.phone].filter(Boolean).join(" · ") || "No email or phone"}</div>
      </div>
      <div className="nz-a-sub-record-actions">
        <ProvenanceBadge provenance={contact.provenance} />
        <StatusBadge active={contact.active} />
        {readOnly || mode !== "view" ? null : <>
          <button type="button" className="nz-a-linkish" onClick={() => setMode("edit")} aria-label={`Edit ${contact.fullName}`}>Edit</button>
          {contact.active
            ? <button type="button" className="nz-a-linkish" onClick={() => setMode("deactivate")} aria-label={`Deactivate ${contact.fullName}`}>Deactivate</button>
            : <button type="button" className="nz-a-linkish" disabled={saving} aria-label={`Reinstate ${contact.fullName}`}
              onClick={() => run(() => postBrowserCommand(`${path}/reinstate`, { expectedVersion: contact.version }, key("reinstate")), `Reinstated ${contact.fullName}.`)}>Reinstate</button>}
        </>}
      </div>
    </div>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {mode === "edit" ? <div className="nz-a-sub-record-form">
      <ContactFields draft={draft} issues={issues} onChange={setDraft} />
      <div className="nz-a-sub-record-actions">
        <button type="button" className="nz-a-btn" onClick={() => { setMode("view"); setIssues({}); }}>Cancel</button>
        <button type="button" className="nz-a-btn pri" disabled={saving} onClick={() => {
          const local = contactIssues(draft);
          if (Object.keys(local).length) { setIssues(local); return; }
          void run(() => patchBrowserCommand(path, { ...contactPayload(draft), expectedVersion: contact.version }, key("update")), `Saved ${clean(draft.fullName)}.`);
        }}>{saving ? "Saving…" : "Save contact"}</button>
      </div>
    </div> : null}
    {mode === "deactivate" ? <div className="nz-a-sub-record-form">
      <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log. To remove the person’s details entirely, use a data-subject erasure." value={reason} rows={2} required
        error={issues.reason} onChange={setReason} />
      <div className="nz-a-sub-record-actions">
        <button type="button" className="nz-a-btn" onClick={() => { setMode("view"); setIssues({}); }}>Cancel</button>
        <button type="button" className="nz-a-btn pri" disabled={saving} onClick={() => {
          if (!reason.trim()) { setIssues({ reason: "Say why this contact is being deactivated." }); return; }
          void run(() => postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: contact.version }, key("deactivate"), reason), `Deactivated ${contact.fullName}.`);
        }}>Deactivate contact</button>
      </div>
    </div> : null}
  </li>;
}

function AddContact({ supplierId, onSaved }: { supplierId: string; onSaved: (message: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ContactDraft>({ fullName: "", email: "", phone: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { key, reset } = useKeys();
  if (!adding) return <button type="button" className="nz-a-btn" onClick={() => setAdding(true)}>+ Add a contact</button>;
  return <div className="nz-a-sub-record-form nz-a-sub-record-new">
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <ContactFields draft={draft} issues={issues} onChange={setDraft} />
    <div className="nz-a-sub-record-actions">
      <button type="button" className="nz-a-btn" onClick={() => setAdding(false)}>Cancel</button>
      <button type="button" className="nz-a-btn pri" disabled={saving} onClick={async () => {
        const local = contactIssues(draft);
        setIssues(local); setProblem(null);
        if (Object.keys(local).length) return;
        setSaving(true);
        try {
          const result = await postBrowserCommand(`/api/isolated/suppliers/${encodeURIComponent(supplierId)}/contacts`, contactPayload(draft), key("add"));
          if (result.state !== "success") { const { fields, message } = describe(result, "supplier"); setIssues(fields); setProblem(message ?? fields.supplierId ?? null); reset(); return; }
          onSaved(`Added ${clean(draft.fullName)} as a contact.`);
        } finally { setSaving(false); }
      }}>{saving ? "Adding…" : "Add contact"}</button>
    </div>
  </div>;
}

// ── The rate card ────────────────────────────────────────────────────────────────────────────────────────────────

type LineDraft = { costType: string; name: string; description: string; unitValueId: string; vatRateId: string; rate: string };
const lineIssues = (draft: LineDraft, withRate: boolean) => {
  const local: Record<string, string> = {};
  if (!draft.name.trim()) local.name = "A service's name is required.";
  if (withRate && draft.rate.trim() !== "" && !isAgreedRate(Number(draft.rate))) local.agreedRate = "A rate from 0, to two places — or blank.";
  return local;
};
const linePayload = (draft: LineDraft) => ({
  costType: blank(draft.costType), name: draft.name, description: blank(draft.description), unitValueId: draft.unitValueId || null, vatRateId: draft.vatRateId || null,
});

function LineFields({ draft, issues, pickers, held, rate, onChange }: {
  draft: LineDraft; issues: Record<string, string>; pickers: JobItemPickers; held: SupplierItemRow | null;
  rate: { shown: boolean; editable: boolean; currency: string };
  onChange: (draft: LineDraft) => void;
}) {
  const units = pickers.units.filter((unit) => unit.active || unit.valueId === held?.unitValueId)
    .map((unit) => ({ value: unit.valueId, label: `${unit.label}${unit.active ? "" : " (inactive)"}` }));
  const vat = pickers.vatRates.filter((entry) => entry.active || entry.vatRateId === held?.vatRateId)
    .map((entry) => ({ value: entry.vatRateId, label: `${entry.label}${entry.isDefault ? " (default)" : ""}${entry.active ? "" : " (inactive)"}` }));
  return <>
    <FieldRow>
      <TextField label="Cost type" value={draft.costType} maxLength={SUPPLIER_COST_TYPE_MAX} placeholder="e.g. Verification" error={issues.costType} onChange={(costType) => onChange({ ...draft, costType })} />
      <TextField label="Service" value={draft.name} required maxLength={SUPPLIER_ITEM_NAME_MAX} placeholder="e.g. Limited assurance" error={issues.name} onChange={(name) => onChange({ ...draft, name })} />
    </FieldRow>
    <TextAreaField label="Description" value={draft.description} rows={2} error={issues.description} hint={`Optional — up to ${SUPPLIER_ITEM_DESCRIPTION_MAX} characters.`}
      onChange={(description) => onChange({ ...draft, description })} />
    <FieldRow>
      <SelectField label="Unit" value={draft.unitValueId} placeholder="None" options={units} error={issues.unitValueId} onChange={(unitValueId) => onChange({ ...draft, unitValueId })} />
      <SelectField label="VAT rate" value={draft.vatRateId} placeholder="None" options={vat} error={issues.vatRateId} onChange={(vatRateId) => onChange({ ...draft, vatRateId })} />
    </FieldRow>
    {rate.shown ? <TextField label={`Agreed rate (${rate.currency})`} mono value={draft.rate} maxLength={16} placeholder="Not agreed" error={issues.agreedRate}
      readOnly={!rate.editable} onChange={(value) => onChange({ ...draft, rate: value })} /> : null}
  </>;
}

function LineCard({ item, pickers, readOnly, rating, onSaved }: {
  item: SupplierItemRow; pickers: JobItemPickers; readOnly: boolean; rating: Gate; onSaved: (message: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "deactivate">("view");
  const heldRate = item.rate?.agreedRate ?? null;
  const [draft, setDraft] = useState<LineDraft>({ costType: item.costType ?? "", name: item.name, description: item.description ?? "", unitValueId: item.unitValueId ?? "",
    vatRateId: item.vatRateId ?? "", rate: heldRate === null ? "" : String(heldRate) });
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { key, reset } = useKeys();
  const path = `/api/isolated/supplier-items/${encodeURIComponent(item.serviceItemId)}`;
  const canRate = rating.allowed && item.rate !== null;
  const canEdit = !readOnly || canRate;
  const fail = (result: Failure) => { const { fields, message } = describe(result, "service"); setIssues(fields); setProblem(message ?? fields.serviceItemId ?? null); reset(); };

  async function save() {
    const local = lineIssues(draft, canRate);
    setIssues(local); setProblem(null);
    if (Object.keys(local).length) return;
    const fields = linePayload(draft);
    const definitionChanged = !readOnly && (clean(draft.name) !== item.name || fields.costType !== item.costType || fields.description !== item.description
      || fields.unitValueId !== item.unitValueId || fields.vatRateId !== item.vatRateId);
    const rate = draft.rate.trim() === "" ? null : Number(draft.rate);
    const rateChanged = canRate && rate !== heldRate;
    setSaving(true);
    try {
      let version = item.version;
      const done: string[] = [];
      if (definitionChanged) {
        const result = await patchBrowserCommand<{ version: number }>(path, { ...fields, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("saved");
      }
      if (rateChanged) {
        const result = await putBrowserCommand<{ version: number }>(`${path}/rate`, { agreedRate: rate, expectedVersion: version }, key("rate"));
        if (result.state !== "success") return fail(result);
        done.push(rate === null ? "rate cleared" : "rate set");
      }
      onSaved(done.length ? `“${clean(draft.name)}” ${done.join(", ")}.` : "No changes to save.");
    } finally { setSaving(false); }
  }

  return <li>
    <div className="nz-a-sub-record-head">
      <div>
        <div className="nz-a-sub-record-name">{item.costType ? <span className="nz-a-muted">{item.costType} · </span> : null}{item.name}</div>
        <div className="nz-a-sub">{[item.unit ? `Unit: ${item.unit}` : null, item.vatRate ? `VAT ${item.vatRate}` : null].filter(Boolean).join(" · ") || "No unit or VAT"}</div>
      </div>
      <div className="nz-a-sub-record-actions">
        {item.rate === null ? <span className="nz-a-muted" title="Agreed rates need finance.manage">restricted</span>
          : <span className="nz-a-mono">{money(item.rate.agreedRate, item.currency)}</span>}
        <StatusBadge active={item.active} />
        {!canEdit || mode !== "view" ? null : <button type="button" className="nz-a-linkish" onClick={() => setMode("edit")} aria-label={`Edit ${item.name}`}>Edit</button>}
        {readOnly || mode !== "view" ? null : item.active
          ? <button type="button" className="nz-a-linkish" onClick={() => setMode("deactivate")} aria-label={`Deactivate ${item.name}`}>Deactivate</button>
          : <button type="button" className="nz-a-linkish" disabled={saving} aria-label={`Reinstate ${item.name}`} onClick={async () => {
            setSaving(true);
            try {
              const result = await postBrowserCommand(`${path}/reinstate`, { expectedVersion: item.version }, key("reinstate"));
              if (result.state !== "success") return fail(result);
              onSaved(`Reinstated “${item.name}”.`);
            } finally { setSaving(false); }
          }}>Reinstate</button>}
      </div>
    </div>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {mode === "edit" ? <div className="nz-a-sub-record-form">
      {readOnly ? <p className="nz-a-hint">You can set the agreed rate; the service itself needs admin.lookups.</p> : null}
      <LineFields draft={draft} issues={issues} pickers={pickers} held={item} rate={{ shown: item.rate !== null, editable: canRate, currency: item.currency }} onChange={setDraft} />
      <div className="nz-a-sub-record-actions">
        <button type="button" className="nz-a-btn" onClick={() => { setMode("view"); setIssues({}); }}>Cancel</button>
        <button type="button" className="nz-a-btn pri" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save service"}</button>
      </div>
    </div> : null}
    {mode === "deactivate" ? <div className="nz-a-sub-record-form">
      <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={reason} rows={2} required error={issues.reason} onChange={setReason} />
      <div className="nz-a-sub-record-actions">
        <button type="button" className="nz-a-btn" onClick={() => { setMode("view"); setIssues({}); }}>Cancel</button>
        <button type="button" className="nz-a-btn pri" disabled={saving} onClick={async () => {
          if (!reason.trim()) { setIssues({ reason: "Say why this service is being deactivated." }); return; }
          setSaving(true);
          try {
            const result = await postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: item.version }, key("deactivate"), reason);
            if (result.state !== "success") return fail(result);
            onSaved(`Deactivated “${item.name}”.`);
          } finally { setSaving(false); }
        }}>Deactivate service</button>
      </div>
    </div> : null}
  </li>;
}

function AddLine({ supplierId, pickers, onSaved }: { supplierId: string; pickers: JobItemPickers; onSaved: (message: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<LineDraft>({ costType: "", name: "", description: "", unitValueId: "", vatRateId: pickers.vatRates.find((rate) => rate.isDefault && rate.active)?.vatRateId ?? "", rate: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { key, reset } = useKeys();
  if (!adding) return <button type="button" className="nz-a-btn" onClick={() => setAdding(true)}>+ Add a service</button>;
  return <div className="nz-a-sub-record-form nz-a-sub-record-new">
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <LineFields draft={draft} issues={issues} pickers={pickers} held={null} rate={{ shown: false, editable: false, currency: pickers.currency ?? "" }} onChange={setDraft} />
    <p className="nz-a-hint">The agreed rate is set once the service is saved, by someone holding finance.manage.</p>
    <div className="nz-a-sub-record-actions">
      <button type="button" className="nz-a-btn" onClick={() => setAdding(false)}>Cancel</button>
      <button type="button" className="nz-a-btn pri" disabled={saving} onClick={async () => {
        const local = lineIssues(draft, false);
        setIssues(local); setProblem(null);
        if (Object.keys(local).length) return;
        setSaving(true);
        try {
          const result = await postBrowserCommand(`/api/isolated/suppliers/${encodeURIComponent(supplierId)}/items`, linePayload(draft), key("add"));
          if (result.state !== "success") { const { fields, message } = describe(result, "supplier"); setIssues(fields); setProblem(message ?? fields.supplierId ?? null); reset(); return; }
          onSaved(`Added “${clean(draft.name)}” to the rate card.`);
        } finally { setSaving(false); }
      }}>{saving ? "Adding…" : "Add service"}</button>
    </div>
  </div>;
}
