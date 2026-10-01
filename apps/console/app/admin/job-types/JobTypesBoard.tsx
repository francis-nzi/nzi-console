"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, postBrowserCommandWithReason, patchBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { isTemplateQuantity, JOB_TYPE_FAMILIES, JOB_TYPE_ITEMS_MAX, jobTypeListSpec, PAGE_SIZES, type JobTypeFamily, type JobTypeListQuery } from "@nzi/contracts";
import type { JobTypePage, JobTypePickers, JobTypeRow, JobTypeTemplate, TemplateCatalogueItem } from "@nzi/isolated-backend";
import { jobFamilyMeta } from "@nzi/mock-data";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, NumberField, ProvenanceBadge, SelectField, StatusBadge, Switch, TextAreaField, TextField,
  type DataListColumn,
} from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * The Job types screen (admin Phase C1; docs/design/admin-prototype.html → Job types): DataList → drawer editor →
 * audit. The services the firm sells, each with one family, a default price ex VAT, estimated hours, a VAT rate and
 * the milestone template a new job of the type starts from. Deactivated and reinstated — never deleted.
 *
 * Admin E3 adds the type's **included items**: the catalogue items a new job of the type starts with, each with a
 * quantity and a required flag, set whole and in order against the template's own version. A new job's lines are copied
 * from them when the job is created (downstream; docs/JOB_TYPE_TEMPLATE_CONTRACT.md) — an edit here never reaches an
 * existing job.
 */
type TemplateDraftItem = { itemId: string; quantity: string; isRequired: boolean };
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = {
  name: string; code: string; family: JobTypeFamily | ""; description: string; price: string; hours: string; vatRateId: string; templateId: string;
  active: boolean; reason: string;
};
const count = new Intl.NumberFormat("en-GB");
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const poundsAndPence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Whole pounds as £4,500; anything with pence as £2,950.50 — never £2,950.5. */
const money = { format: (value: number) => (Number.isInteger(value) ? pounds : poundsAndPence).format(value) };
const hours = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const familyLabel = (family: JobTypeFamily) => jobFamilyMeta[family].label;
/** "20% Standard Rate" already says its rate; "Reduced" does not, so it reads "Reduced (5%)". */
const vatLabel = (name: string, ratePct: number) => name.includes(`${pct.format(ratePct)}%`) ? name : `${name} (${pct.format(ratePct)}%)`;
const dash = <span className="nz-a-muted">—</span>;

export function JobTypesBoard({ page, pickers, templates, catalogue, query, editing }: {
  page: JobTypePage; pickers: JobTypePickers; templates: Record<string, JobTypeTemplate>; catalogue: TemplateCatalogueItem[]; query: JobTypeListQuery; editing: Editing;
}) {
  const router = useRouter();
  const nav = useListNavigation(jobTypeListSpec, query, "/admin/job-types");
  const [open, setOpen] = useState<{ row: JobTypeRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";
  const family = query.filters.family?.[0] ?? "";

  const columns: DataListColumn<JobTypeRow>[] = [
    { key: "name", header: "Job type", sortKey: "name", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.name}</button>
      {row.code ? <div className="nz-a-sub nz-a-mono">{row.code}</div> : null}
    </div> },
    { key: "family", header: "Family", sortKey: "family", cell: (row) => familyLabel(row.family) },
    { key: "price", header: "Default price", sortKey: "price", numeric: true, cell: (row) => row.defaultPriceExVat === null ? dash : <span className="nz-a-mono">{money.format(row.defaultPriceExVat)}</span> },
    { key: "hours", header: "Est. hours", sortKey: "hours", numeric: true, cell: (row) => row.estimatedHours === null ? dash : <span className="nz-a-mono">{hours.format(row.estimatedHours)}</span> },
    { key: "vat", header: "VAT", numeric: true, cell: (row) => row.vatRatePct === null ? dash : <span className="nz-a-mono" title={row.vatRateName ?? undefined}>{pct.format(row.vatRatePct)}%</span> },
    { key: "template", header: "Milestone template", cell: (row) => row.milestoneTemplateName ?? dash },
    { key: "items", header: "Items", numeric: true, cell: (row) => { const n = templates[row.jobTypeId]?.items.length ?? 0;
      return <span className={`nz-a-mono${n === 0 ? " nz-a-muted" : ""}`} title="Catalogue items a new job of this type starts with">{count.format(n)}</span>; } },
    { key: "inUse", header: "Jobs", sortKey: "inUse", numeric: true, cell: (row) => <span className={`nz-a-mono${row.inUse === 0 ? " nz-a-muted" : ""}`}>{count.format(row.inUse)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Delivery</div>
        <h1>Job types</h1>
        <p>The services NZI sells. Each carries a default price, effort and VAT, and links to the milestone template a new job of this type starts from.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New job type</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>v7’s job types arrive with the jobs-configuration import, matched by name — never guessed. A type’s <b>milestone template</b> is where a new job of that type will take its schedule from once the milestone command lands; until then it is recorded, not yet applied.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Job types"
        rows={page.rows}
        rowKey={(row) => row.jobTypeId}
        columns={columns}
        search={{ value: query.search, label: "Search job types", placeholder: "Search by name or code…", onChange: nav.search }}
        filters={[{
          key: "family", label: "Family", value: family, allLabel: "All families",
          options: JOB_TYPE_FAMILIES.map((value) => ({ value, label: familyLabel(value), count: page.filterOptions.family.find((option) => option.value === value)?.count ?? 0 })),
        }]}
        onFilter={(key, value) => nav.filter(key as "family", value)}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as JobTypeListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status || family ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No job types yet</b><span>{editing.allowed ? "Add the first one, or import v7’s." : "Job types arrive with the v7 jobs-configuration import."}</span></>
          : <><b>No job types match</b><span>Clear the search or the filters to see every job type.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">Prices are ex VAT, in pounds sterling. “Jobs” counts the jobs recorded against each type; a type in use keeps its family.</p>
    </div>

    {open ? <JobTypeDrawer key={open.row?.jobTypeId ?? "new"} row={open.row} pickers={pickers} editing={editing}
      template={open.row ? templates[open.row.jobTypeId] ?? null : null} catalogue={catalogue}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

const blankToNull = (value: string) => value.trim() === "" ? null : value.trim();
const amount = (value: string): number | null | "invalid" => {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && Math.abs(Math.round(parsed * 100) - parsed * 100) < 1e-6 ? parsed : "invalid";
};

function JobTypeDrawer({ row, pickers, editing, template, catalogue, onClose, onSaved }: {
  row: JobTypeRow | null; pickers: JobTypePickers; editing: Editing; template: JobTypeTemplate | null; catalogue: TemplateCatalogueItem[];
  onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({
    name: row?.name ?? "", code: row?.code ?? "", family: row?.family ?? "", description: row?.description ?? "",
    price: row?.defaultPriceExVat === null || row === null ? "" : String(row.defaultPriceExVat),
    hours: row?.estimatedHours === null || row === null ? "" : String(row.estimatedHours),
    vatRateId: row?.vatRateId ?? (isNew ? pickers.vatRates.find((rate) => rate.isDefault && rate.active)?.vatRateId ?? "" : ""),
    templateId: row?.milestoneTemplateId ?? "", active: row?.active ?? true, reason: "",
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const held = template?.items ?? [];
  const [items, setItems] = useState<TemplateDraftItem[]>(() => held.map((item) => ({ itemId: item.itemId, quantity: String(item.quantity), isRequired: item.isRequired })));
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;
  const familyLocked = (row?.inUse ?? 0) > 0;
  const itemsChanged = items.length !== held.length || items.some((item, index) => item.itemId !== held[index]?.itemId
    || Number(item.quantity) !== held[index]?.quantity || item.isRequired !== held[index]?.isRequired);
  const catalogueItem = (itemId: string) => catalogue.find((entry) => entry.itemId === itemId);
  // Active items not already included; an inactive one shows only where the template already holds it (R3).
  const addable = catalogue.filter((entry) => entry.active && !items.some((item) => item.itemId === entry.itemId));
  const move = (index: number, by: number) => setItems((current) => {
    const next = [...current];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    return next;
  });

  // Active choices, plus the one this type already holds if it has since been deactivated (it still resolves).
  const vatOptions = pickers.vatRates.filter((rate) => rate.active || rate.vatRateId === row?.vatRateId)
    .map((rate) => ({ value: rate.vatRateId, label: `${vatLabel(rate.name, rate.ratePct)}${rate.active ? "" : " (inactive)"}` }));
  const templateOptions = pickers.milestoneTemplates.filter((template) => template.active || template.templateId === row?.milestoneTemplateId)
    .map((template) => ({ value: template.templateId, label: `${template.name}${template.isDefault ? " (default)" : ""}${template.active ? "" : " (inactive)"}` }));

  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const fieldsChanged = row !== null && (
    draft.name.trim() !== row.name || blankToNull(draft.code) !== row.code || draft.family !== row.family || blankToNull(draft.description) !== row.description
    || amount(draft.price) !== row.defaultPriceExVat || amount(draft.hours) !== row.estimatedHours
    || (draft.vatRateId || null) !== row.vatRateId || (draft.templateId || null) !== row.milestoneTemplateId);

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    const own = ["name", "code", "family", "description", "defaultPriceExVat", "estimatedHours", "vatRateId", "milestoneTemplateId", "reason"];
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !own.includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This job type changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const price = amount(draft.price);
    const effort = amount(draft.hours);
    const local: Record<string, string> = {};
    if (!draft.name.trim()) local.name = "A name is required.";
    if (!draft.family) local.family = "Choose the job family.";
    if (price === "invalid") local.defaultPriceExVat = "A price is an amount from 0, to two decimal places.";
    if (effort === "invalid") local.estimatedHours = "Hours are a number from 0, to two decimal places.";
    if (deactivating && !draft.reason.trim()) local.reason = "Say why this job type is being deactivated — it leaves every picker.";
    items.forEach((item, index) => { if (!isTemplateQuantity(Number(item.quantity))) local[`items.${index}.quantity`] = "A quantity above 0, to two places."; });
    if (Object.keys(local).length) { setIssues(local); return; }
    const fields = {
      name: draft.name, code: blankToNull(draft.code), family: draft.family as JobTypeFamily, description: blankToNull(draft.description),
      defaultPriceExVat: price as number | null, estimatedHours: effort as number | null, vatRateId: draft.vatRateId || null, milestoneTemplateId: draft.templateId || null,
    };
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/job-types", fields, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added the job type “${draft.name.trim()}”.`);
      }
      const path = `/api/isolated/job-types/${encodeURIComponent(row.jobTypeId)}`;
      let version = row.version;
      if (fieldsChanged) {
        const result = await patchBrowserCommand<{ version: number }>(path, { ...fields, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version;
      }
      if (itemsChanged) {
        const result = await putBrowserCommand(`${path}/items`, {
          expectedItemsVersion: template?.itemsVersion ?? 1,
          items: items.map((item) => ({ itemId: item.itemId, quantity: Number(item.quantity), isRequired: item.isRequired })),
        }, key("items"));
        if (result.state !== "success") return fail(result);
        if (!deactivating && !reinstating) return onSaved(`Saved ${fieldsChanged ? "" : "the included items of "}“${draft.name.trim()}” — ${items.length} included item${items.length === 1 ? "" : "s"}.`);
      }
      if (deactivating) {
        const result = await postBrowserCommandWithReason<{ inUse: number }>(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        const held = result.data.inUse;
        return onSaved(`Deactivated “${draft.name.trim()}”.${held ? ` It still shows on the ${held} job${held === 1 ? "" : "s"} recorded against it.` : ""}`);
      }
      if (reinstating) {
        const result = await postBrowserCommand(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Reinstated “${draft.name.trim()}”.`);
      }
      return onSaved(fieldsChanged ? `Saved “${draft.name.trim()}”.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Job type" title={isNew ? "New job type" : row.name}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${draft.active ? " danger" : ""}`} onClick={() => setDraft({ ...draft, active: !draft.active, reason: "" })}>
          {draft.active ? "Deactivate…" : row.active ? "Keep active" : "Reinstate"}
        </button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate job type" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Name" value={draft.name} placeholder="e.g. Carbon Report — Standard" required maxLength={120}
      error={issues.name} readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />
    <FieldRow>
      <TextField label="Code" mono value={draft.code} placeholder="Optional, e.g. CRP-STD" maxLength={32}
        error={issues.code} readOnly={readOnly} onChange={(code) => setDraft({ ...draft, code })} />
      <SelectField label="Family" value={draft.family} placeholder={isNew ? "Choose…" : undefined} required
        options={JOB_TYPE_FAMILIES.map((value) => ({ value, label: familyLabel(value) }))}
        hint={familyLocked ? `Locked — ${count.format(row!.inUse)} job${row!.inUse === 1 ? " uses" : "s use"} this type, and each carries its family.` : undefined}
        error={issues.family} disabled={readOnly || familyLocked} onChange={(value) => setDraft({ ...draft, family: value as JobTypeFamily })} />
    </FieldRow>
    <TextAreaField label="Description" value={draft.description} rows={2} error={issues.description} disabled={readOnly}
      onChange={(description) => setDraft({ ...draft, description })} />
    <FieldRow>
      <NumberField label="Default price (ex VAT, £)" value={draft.price} min={0} step={0.01} error={issues.defaultPriceExVat} disabled={readOnly}
        onChange={(price) => setDraft({ ...draft, price })} />
      <NumberField label="Estimated hours" value={draft.hours} min={0} step={0.5} error={issues.estimatedHours} disabled={readOnly}
        onChange={(value) => setDraft({ ...draft, hours: value })} />
    </FieldRow>
    <FieldRow>
      <SelectField label="VAT rate" value={draft.vatRateId} placeholder="None" options={vatOptions}
        hint={pickers.vatRates.length === 0 ? "No VAT rates yet — they arrive with the v7 import." : undefined}
        error={issues.vatRateId} disabled={readOnly} onChange={(vatRateId) => setDraft({ ...draft, vatRateId })} />
      <SelectField label="Milestone template" value={draft.templateId} placeholder="None" options={templateOptions}
        hint={pickers.milestoneTemplates.length === 0 ? "No templates yet — they arrive with Milestone templates and the v7 import." : "A new job of this type starts from it."}
        error={issues.milestoneTemplateId} disabled={readOnly} onChange={(templateId) => setDraft({ ...draft, templateId })} />
    </FieldRow>
    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : "Added here"} readOnly /> : null}
    {!isNew ? <Switch label="Active" description="Available when creating a new job. Inactive types leave the pickers but still show on existing jobs." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}

    <h3>Included items</h3>
    {isNew ? <p className="nz-a-hint">Add the catalogue items a new job of this type starts with once the type is saved.</p> : <>
      <p className="nz-a-hint">A new job of this type starts with these lines, copied when the job is created — an edit here never reaches an existing job.</p>
      {items.length === 0 ? <p className="nz-a-muted">None yet.</p> : <ol className="nz-a-template-items">
        {items.map((item, index) => { const entry = catalogueItem(item.itemId);
          return <li key={item.itemId}>
            <div className="nz-a-template-item-name"><span className="nz-a-mono">{entry?.code ?? item.itemId}</span> {entry?.name}{entry?.unit ? <span className="nz-a-muted"> · {entry.unit}</span> : null}{entry && !entry.active ? <span className="nz-a-muted"> (inactive)</span> : null}</div>
            <TextField label="Quantity" mono value={item.quantity} maxLength={10} readOnly={readOnly} error={issues[`items.${index}.quantity`]}
              onChange={(quantity) => setItems(items.map((other, at) => at === index ? { ...other, quantity } : other))} />
            <Switch label="Required" checked={item.isRequired} disabled={readOnly}
              onChange={(isRequired) => setItems(items.map((other, at) => at === index ? { ...other, isRequired } : other))} />
            {readOnly ? null : <div className="nz-a-template-item-actions">
              <button type="button" className="nz-a-linkish" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${entry?.code ?? "item"} up`}>↑</button>
              <button type="button" className="nz-a-linkish" disabled={index === items.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${entry?.code ?? "item"} down`}>↓</button>
              <button type="button" className="nz-a-linkish" onClick={() => setItems(items.filter((_, at) => at !== index))} aria-label={`Remove ${entry?.code ?? "item"}`}>Remove</button>
            </div>}
          </li>; })}
      </ol>}
      {readOnly || items.length >= JOB_TYPE_ITEMS_MAX ? null : <SelectField label="Add an item" value="" placeholder={addable.length ? "Choose a catalogue item…" : "Every active item is included"}
        options={addable.map((entry) => ({ value: entry.itemId, label: `${entry.code} — ${entry.name}` }))}
        onChange={(itemId) => { if (itemId) setItems([...items, { itemId, quantity: "1", isRequired: true }]); }} />}
      {issues.items ? <div className="nz-a-error" role="alert">{issues.items}</div> : null}
    </>}
    {row && row.inUse > 0 ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>Recorded on <b>{count.format(row.inUse)}</b> job{row.inUse === 1 ? "" : "s"}. Deactivating keeps it shown on those; it cannot be deleted.</div></div> : null}
  </DrawerEditor>;
}
