"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { isVatPercentage, PAGE_SIZES, vatRateListSpec, VAT_RATE_NAME_MAX, type VatRateListQuery } from "@nzi/contracts";
import type { VatRatePage, VatRateRow } from "@nzi/isolated-backend";
import { AuditLine, DataList, DrawerEditor, ProvenanceBadge, StatusBadge, Switch, TextAreaField, TextField, type DataListColumn } from "@nzi/ui";
import { useListNavigation } from "../../../lib/useListNavigation";
import { TaxCurrencyHead } from "../TaxCurrencyHead";

/**
 * Tax & currency → VAT rates (admin Phase E1): DataList → drawer editor → audit. A rate is a name and a percentage;
 * exactly one is the default, which moves (with a reason) but never lapses and is never deactivated. A deactivated rate
 * leaves the pickers but stays on the job types that name it.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = { name: string; ratePct: string; makeDefault: boolean; active: boolean; reason: string };
const count = new Intl.NumberFormat("en-GB");
const pct = (value: number) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;

const DefaultBadge = () => <span className="nz-a-badge ok"><i aria-hidden="true" />Default</span>;

export function VatRatesBoard({ page, query, editing }: { page: VatRatePage; query: VatRateListQuery; editing: Editing }) {
  const router = useRouter();
  const nav = useListNavigation(vatRateListSpec, query, "/admin/tax-currency/vat-rates");
  const [open, setOpen] = useState<{ row: VatRateRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";

  const columns: DataListColumn<VatRateRow>[] = [
    { key: "name", header: "VAT rate", sortKey: "name", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.name}</button>
      {row.isDefault ? <> <DefaultBadge /></> : null}
    </div> },
    { key: "ratePct", header: "Rate", sortKey: "ratePct", numeric: true, cell: (row) => <span className="nz-a-mono">{pct(row.ratePct)}</span> },
    { key: "inUse", header: "Job types", numeric: true, cell: (row) => <span className="nz-a-mono" title="Job types naming this rate — they keep it whatever happens to it">{count.format(row.inUse)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <TaxCurrencyHead tab="vat-rates" action={editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New VAT rate</button> : null} />

    {editing.allowed ? null : <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div><b>{editing.reason}</b></div></div>}
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="VAT rates"
        rows={page.rows}
        rowKey={(row) => row.vatRateId}
        columns={columns}
        search={{ value: query.search, label: "Search VAT rates", placeholder: "Search by name…", onChange: nav.search }}
        filters={[]}
        onFilter={() => {}}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as VatRateListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No VAT rates yet</b><span>{editing.allowed ? "Add the first one — it becomes the default." : "VAT rates arrive with the v7 jobs-configuration import."}</span></>
          : <><b>No VAT rates match</b><span>Clear the search or the filter to see every rate.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">A rate is a percentage from 0 to 100, to two places. v7’s rates arrived with the jobs-configuration import.</p>
    </div>

    {open ? <VatRateDrawer key={open.row?.vatRateId ?? "new"} row={open.row} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function VatRateDrawer({ row, editing, onClose, onSaved }: { row: VatRateRow | null; editing: Editing; onClose: () => void; onSaved: (message: string) => void }) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({ name: row?.name ?? "", ratePct: row ? String(row.ratePct) : "", makeDefault: false, active: row?.active ?? true, reason: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;
  const isDefault = row?.isDefault === true;

  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const makingDefault = !isNew && !isDefault && draft.makeDefault;
  const fieldsChanged = row !== null && (draft.name.trim().replace(/\s+/g, " ") !== row.name || Number(draft.ratePct) !== row.ratePct);

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["name", "ratePct", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This VAT rate changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const ratePct = Number(draft.ratePct);
    const local: Record<string, string> = {};
    if (!draft.name.trim()) local.name = "A name is required.";
    if (draft.ratePct.trim() === "" || !isVatPercentage(ratePct)) local.ratePct = "A percentage from 0 to 100, to two places at most.";
    if ((deactivating || makingDefault) && !draft.reason.trim()) local.reason = makingDefault
      ? "Say why this becomes the default — every new job type and quote will start from it."
      : "Say why this rate is being deactivated — it leaves every picker.";
    if (Object.keys(local).length) { setIssues(local); return; }
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/vat-rates", { name: draft.name, ratePct }, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added the VAT rate “${draft.name.trim()}” (${pct(ratePct)}).`);
      }
      const path = `/api/isolated/vat-rates/${encodeURIComponent(row.vatRateId)}`;
      let version = row.version;
      const done: string[] = [];
      if (fieldsChanged) {
        const result = await patchBrowserCommand<{ version: number }>(path, { name: draft.name, ratePct, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("saved");
      }
      if (reinstating) {
        const result = await postBrowserCommand<{ version: number }>(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("reinstated");
      }
      if (makingDefault) {
        const result = await postBrowserCommandWithReason<{ version: number }>(`${path}/default`, { expectedVersion: version }, key("default"), draft.reason);
        if (result.state !== "success") return fail(result);
        done.push("made the default");
      } else if (deactivating) {
        const result = await postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        done.push("deactivated");
      }
      return onSaved(done.length ? `“${draft.name.trim()}” ${done.join(", ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="VAT rate" title={isNew ? "New VAT rate" : row.name}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate VAT rate" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {isDefault ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div><b>The default rate.</b> It cannot be deactivated; make another rate the default first. Its name and percentage can still be edited.</div></div> : null}
    <TextField label="Name" value={draft.name} required maxLength={VAT_RATE_NAME_MAX} placeholder="e.g. Standard rate" error={issues.name}
      readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />
    <TextField label="Rate (%)" mono value={draft.ratePct} required maxLength={6} placeholder="e.g. 20" error={issues.ratePct}
      hint="A percentage from 0 to 100, to two places." readOnly={readOnly} onChange={(ratePct) => setDraft({ ...draft, ratePct })} />
    {isNew ? <p className="nz-a-hint">A new rate is the default only when it is the organisation’s first; otherwise make it the default once it is saved.</p> : null}
    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : row.provenance === "seeded" ? "Seeded" : "Added here"} readOnly /> : null}
    {!isNew && !isDefault ? <Switch label="Make this the default" description="The current default stops being one. A default is always active." checked={draft.makeDefault}
      disabled={readOnly || !draft.active} onChange={(makeDefault) => setDraft({ ...draft, makeDefault, active: makeDefault ? true : draft.active, reason: "" })} /> : null}
    {!isNew && !isDefault ? <Switch label="Active" description="Inactive rates leave the pickers but stay on the job types that name them." checked={draft.active}
      disabled={readOnly || draft.makeDefault} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating || makingDefault ? <TextAreaField label={makingDefault ? "Reason for the new default" : "Reason for deactivating"} hint="Required — it is recorded in the audit log."
      value={draft.reason} rows={2} required error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
  </DrawerEditor>;
}
