"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  isCatalogueAmount, JOB_ITEM_AMOUNT_MAX, JOB_ITEM_CODE_PATTERN, JOB_ITEM_DESCRIPTION_MAX, JOB_ITEM_HOURS_MAX, JOB_ITEM_NAME_MAX, jobItemListSpec, PAGE_SIZES,
  type JobItemListQuery,
} from "@nzi/contracts";
import type { JobItemPage, JobItemPickers, JobItemRow } from "@nzi/isolated-backend";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, ProvenanceBadge, SelectField, StatusBadge, Switch, TextAreaField, TextField,
  type DataListColumn,
} from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * The Service catalogue (admin Phase E2): DataList → drawer editor → audit. An item's code is fixed once made (E-Q4);
 * its category, unit and VAT come from the governed lookups. Cost and sell are finance.manage's (E-Q8): shown, and set
 * by their own command, only to a holder — and the audit records that they changed, never the figures. One currency,
 * the organisation's (E-Q9). The copy into a job's lines is downstream (E-Q5).
 */
type Gate = { allowed: true } | { allowed: false; reason: string };
type Draft = {
  code: string; name: string; description: string; categoryValueId: string; unitValueId: string; hours: string; vatRateId: string; sortOrder: string;
  cost: string; sell: string; active: boolean; reason: string;
};
const count = new Intl.NumberFormat("en-GB");
const money = (value: number | null, currency: string) => value === null ? "—"
  : new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2 }).format(value);

export function ServiceCatalogueBoard({ page, pickers, query, editing, pricing, showAmounts }: {
  page: JobItemPage; pickers: JobItemPickers; query: JobItemListQuery; editing: Gate; pricing: Gate; showAmounts: boolean;
}) {
  const router = useRouter();
  const nav = useListNavigation(jobItemListSpec, query, "/admin/service-catalogue");
  const [open, setOpen] = useState<{ row: JobItemRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";
  const category = query.filters.category?.[0] ?? "";

  const columns: DataListColumn<JobItemRow>[] = [
    { key: "name", header: "Item", sortKey: "name", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.name}</button>
      <div className="nz-a-sub nz-a-mono">{row.code}</div>
    </div> },
    { key: "category", header: "Category", sortKey: "category", cell: (row) => row.category ?? <span className="nz-a-muted">—</span> },
    { key: "unit", header: "Unit", cell: (row) => row.unit ?? <span className="nz-a-muted">—</span> },
    { key: "hours", header: "Hours", sortKey: "hours", numeric: true, cell: (row) => <span className="nz-a-mono">{row.defaultHours === null ? "—" : row.defaultHours}</span> },
    { key: "sell", header: "Sell", numeric: true, cell: (row) => row.amounts === null
      ? <span className="nz-a-muted" title="Cost and sell need finance.manage">restricted</span>
      : <span className="nz-a-mono">{money(row.amounts.sell, row.currency)}</span> },
    { key: "vat", header: "VAT", cell: (row) => row.vatRate ?? <span className="nz-a-muted">—</span> },
    { key: "inUse", header: "Job types", numeric: true, cell: (row) => <span className={`nz-a-mono${row.inUse === 0 ? " nz-a-muted" : ""}`} title="Job types whose included items name this item">{count.format(row.inUse)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Commercial</div>
        <h1>Service catalogue</h1>
        <p>The billable items quotes, invoices and job lines are chosen from. An item’s code never changes once made; a job line copies the item when it is created, so a later edit here never reaches it.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        <CapabilityChip capability="finance.manage" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New item</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>Amounts are held in the organisation’s currency{pickers.currency ? <> (<b>{pickers.currency}</b>)</> : null}. {showAmounts
        ? "Cost and sell are visible to you because you hold finance.manage; changing them records that they changed, never the figures."
        : <><b>Cost and sell are restricted</b> to finance.manage.</>}{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Service catalogue"
        rows={page.rows}
        rowKey={(row) => row.itemId}
        columns={columns}
        search={{ value: query.search, label: "Search the catalogue", placeholder: "Search by code or name…", onChange: nav.search }}
        filters={[{ key: "category", label: "Category", value: category, allLabel: "All categories", options: page.filterOptions.category }]}
        onFilter={(key, value) => nav.filter(key as "category", value)}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as JobItemListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status || category ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No catalogue items yet</b><span>{editing.allowed ? "Add the first one, or import v7’s." : "Items arrive with the v7 catalogue import."}</span></>
          : <><b>No items match</b><span>Clear the search or the filters to see the whole catalogue.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">A code is upper-case letters, digits, - and _, and never changes. Categories and units are Lookups lists; VAT rates are in Tax &amp; currency.</p>
    </div>

    {open ? <ItemDrawer key={open.row?.itemId ?? "new"} row={open.row} pickers={pickers} editing={editing} pricing={pricing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function ItemDrawer({ row, pickers, editing, pricing, onClose, onSaved }: {
  row: JobItemRow | null; pickers: JobItemPickers; editing: Gate; pricing: Gate; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({
    code: row?.code ?? "", name: row?.name ?? "", description: row?.description ?? "", categoryValueId: row?.categoryValueId ?? "", unitValueId: row?.unitValueId ?? "",
    hours: row?.defaultHours === null || row?.defaultHours === undefined ? "" : String(row.defaultHours), vatRateId: row?.vatRateId ?? "",
    sortOrder: row ? String(row.sortOrder) : "",
    cost: row?.amounts?.cost === null || row?.amounts?.cost === undefined ? "" : String(row.amounts.cost),
    sell: row?.amounts?.sell === null || row?.amounts?.sell === undefined ? "" : String(row.amounts.sell),
    active: row?.active ?? true, reason: "",
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;
  const canPrice = pricing.allowed && !isNew && row?.amounts !== null;

  const optionsOf = (list: Array<{ valueId: string; label: string; active: boolean }>, held: string | null | undefined) =>
    list.filter((entry) => entry.active || entry.valueId === held).map((entry) => ({ value: entry.valueId, label: `${entry.label}${entry.active ? "" : " (inactive)"}` }));
  const vatOptions = pickers.vatRates.filter((rate) => rate.active || rate.vatRateId === row?.vatRateId)
    .map((rate) => ({ value: rate.vatRateId, label: `${rate.label}${rate.isDefault ? " (default)" : ""}${rate.active ? "" : " (inactive)"}` }));

  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const hours = draft.hours.trim() === "" ? null : Number(draft.hours);
  const sortOrder = draft.sortOrder.trim() === "" ? undefined : Number(draft.sortOrder);
  const definition = { name: draft.name, description: draft.description.trim() || null, categoryValueId: draft.categoryValueId || null,
    unitValueId: draft.unitValueId || null, defaultHours: hours, vatRateId: draft.vatRateId || null };
  const definitionChanged = row !== null && (draft.name.trim().replace(/\s+/g, " ") !== row.name || (draft.description.trim() || null) !== row.description
    || (draft.categoryValueId || null) !== row.categoryValueId || (draft.unitValueId || null) !== row.unitValueId || hours !== row.defaultHours
    || (draft.vatRateId || null) !== row.vatRateId || (sortOrder ?? row.sortOrder) !== row.sortOrder);
  const cost = draft.cost.trim() === "" ? null : Number(draft.cost);
  const sell = draft.sell.trim() === "" ? null : Number(draft.sell);
  const amountsChanged = canPrice && row !== null && row.amounts !== null && (cost !== row.amounts.cost || sell !== row.amounts.sell);

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["itemCode", "name", "description", "categoryValueId", "unitValueId", "defaultHours", "vatRateId", "sortOrder", "defaultCostAmount", "defaultSellAmount", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This item changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || (readOnly && !canPrice)) return;
    setIssues({}); setProblem(null);
    const local: Record<string, string> = {};
    if (isNew && !JOB_ITEM_CODE_PATTERN.test(draft.code.trim())) local.itemCode = "Upper-case letters, digits, - and _ (up to 30).";
    if (!draft.name.trim()) local.name = "A name is required.";
    if (hours !== null && !isCatalogueAmount(hours, JOB_ITEM_HOURS_MAX)) local.defaultHours = "Hours are a number from 0, to two places.";
    if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0)) local.sortOrder = "Sort order is a whole number from 0.";
    if (cost !== null && !isCatalogueAmount(cost, JOB_ITEM_AMOUNT_MAX)) local.defaultCostAmount = "An amount from 0, to two places — or blank.";
    if (sell !== null && !isCatalogueAmount(sell, JOB_ITEM_AMOUNT_MAX)) local.defaultSellAmount = "An amount from 0, to two places — or blank.";
    if (deactivating && !draft.reason.trim()) local.reason = "Say why this item is being deactivated — it leaves every picker.";
    if (Object.keys(local).length) { setIssues(local); return; }
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/job-items", { itemCode: draft.code.trim(), ...definition, sortOrder }, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added “${draft.name.trim()}” (${draft.code.trim()})${pricing.allowed ? " — open it to set its cost and sell." : "."}`);
      }
      const path = `/api/isolated/job-items/${encodeURIComponent(row.itemId)}`;
      let version = row.version;
      const done: string[] = [];
      if (definitionChanged && !readOnly) {
        const result = await patchBrowserCommand<{ version: number }>(path, { ...definition, sortOrder: sortOrder ?? row.sortOrder, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("saved");
      }
      if (amountsChanged) {
        const result = await putBrowserCommand<{ version: number }>(`${path}/price`, { defaultCostAmount: cost, defaultSellAmount: sell, expectedVersion: version }, key("price"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("priced");
      }
      if (reinstating && !readOnly) {
        const result = await postBrowserCommand(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        done.push("reinstated");
      } else if (deactivating && !readOnly) {
        const result = await postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        done.push("deactivated");
      }
      return onSaved(done.length ? `“${draft.name.trim()}” ${done.join(", ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Catalogue item" title={isNew ? "New catalogue item" : `${row.code} — ${row.name}`}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly && !canPrice ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly && !canPrice ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate item" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Code" mono value={draft.code} readOnly={!isNew || readOnly} required={isNew} maxLength={30} placeholder="e.g. ASSESS"
      hint={isNew ? "Upper-case letters, digits, - and _. It can never be changed once saved." : "Fixed — job lines are copied from it."}
      error={issues.itemCode} onChange={(value) => setDraft({ ...draft, code: value.toUpperCase() })} />
    <TextField label="Name" value={draft.name} required maxLength={JOB_ITEM_NAME_MAX} placeholder="e.g. Carbon assessment" error={issues.name}
      readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />
    <TextAreaField label="Description" value={draft.description} rows={2} error={issues.description} disabled={readOnly}
      hint={`Optional — up to ${JOB_ITEM_DESCRIPTION_MAX} characters.`} onChange={(description) => setDraft({ ...draft, description })} />
    <FieldRow>
      <SelectField label="Category" value={draft.categoryValueId} placeholder="None" options={optionsOf(pickers.categories, row?.categoryValueId)}
        error={issues.categoryValueId} disabled={readOnly} onChange={(categoryValueId) => setDraft({ ...draft, categoryValueId })} />
      <SelectField label="Unit" value={draft.unitValueId} placeholder="None" options={optionsOf(pickers.units, row?.unitValueId)}
        error={issues.unitValueId} disabled={readOnly} onChange={(unitValueId) => setDraft({ ...draft, unitValueId })} />
    </FieldRow>
    <FieldRow>
      <TextField label="Default hours" mono value={draft.hours} maxLength={8} placeholder="e.g. 7.5" error={issues.defaultHours}
        readOnly={readOnly} onChange={(value) => setDraft({ ...draft, hours: value })} />
      <SelectField label="VAT rate" value={draft.vatRateId} placeholder="None" options={vatOptions}
        error={issues.vatRateId} disabled={readOnly} onChange={(vatRateId) => setDraft({ ...draft, vatRateId })} />
    </FieldRow>
    <TextField label="Sort order" mono value={draft.sortOrder} maxLength={7} placeholder={isNew ? "Blank: after the last item" : undefined}
      error={issues.sortOrder} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, sortOrder: value })} />

    <h3>Cost and sell <CapabilityChip capability="finance.manage" /></h3>
    {isNew ? <p className="nz-a-hint">Priced once it is saved, by someone holding finance.manage.</p>
      : row.amounts === null ? <p className="nz-a-hint">Restricted — cost and sell need finance.manage.</p>
      : <FieldRow>
        <TextField label={`Default cost (${row.currency})`} mono value={draft.cost} maxLength={16} placeholder="Not priced" error={issues.defaultCostAmount}
          readOnly={!pricing.allowed} onChange={(value) => setDraft({ ...draft, cost: value })} />
        <TextField label={`Default sell (${row.currency})`} mono value={draft.sell} maxLength={16} placeholder="Not priced" error={issues.defaultSellAmount}
          readOnly={!pricing.allowed} onChange={(value) => setDraft({ ...draft, sell: value })} />
      </FieldRow>}
    {!isNew && row.amounts !== null ? <p className="nz-a-hint">Changing these records <b>that</b> they changed and who changed them — never the figures.</p> : null}

    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : row.provenance === "seeded" ? "Seeded" : "Added here"} readOnly /> : null}
    {!isNew ? <Switch label="Active" description="Inactive items leave the pickers but still resolve wherever they are named." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
  </DrawerEditor>;
}
