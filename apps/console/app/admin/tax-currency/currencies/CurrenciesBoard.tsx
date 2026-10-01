"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { CURRENCY_NAME_MAX, CURRENCY_SYMBOL_MAX, currencyListSpec, isCurrencyCodeForSet, PAGE_SIZES, type CurrencyListQuery } from "@nzi/contracts";
import type { CurrencyPage, CurrencyRow } from "@nzi/isolated-backend";
import { AuditLine, DataList, DrawerEditor, ProvenanceBadge, StatusBadge, Switch, TextAreaField, TextField, type DataListColumn } from "@nzi/ui";
import { useListNavigation } from "../../../lib/useListNavigation";
import { TaxCurrencyHead } from "../TaxCurrencyHead";

/**
 * Tax & currency → Currencies (admin Phase E1): DataList → drawer editor → audit. A currency is its ISO-4217 code (set
 * once), a name and a symbol — the symbol every intensity unit reads in ("tCO₂e per £m"). Exactly one is the default.
 * A deactivated currency leaves the pickers; clients already holding it keep it.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = { code: string; name: string; symbol: string; makeDefault: boolean; active: boolean; reason: string };
const count = new Intl.NumberFormat("en-GB");

const DefaultBadge = () => <span className="nz-a-badge ok"><i aria-hidden="true" />Default</span>;

export function CurrenciesBoard({ page, query, editing }: { page: CurrencyPage; query: CurrencyListQuery; editing: Editing }) {
  const router = useRouter();
  const nav = useListNavigation(currencyListSpec, query, "/admin/tax-currency/currencies");
  const [open, setOpen] = useState<{ row: CurrencyRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";

  const columns: DataListColumn<CurrencyRow>[] = [
    { key: "code", header: "Code", sortKey: "code", cell: (row) => <div>
      <button type="button" className="nz-a-linkish nz-a-mono" onClick={() => setOpen({ row })}>{row.code}</button>
      {row.isDefault ? <> <DefaultBadge /></> : null}
    </div> },
    { key: "name", header: "Name", sortKey: "name", cell: (row) => row.name },
    { key: "symbol", header: "Symbol", cell: (row) => <span className="nz-a-mono">{row.symbol}</span> },
    { key: "inUse", header: "Clients", numeric: true, cell: (row) => <span className="nz-a-mono" title="Clients holding this currency — they keep it whatever happens to it">{count.format(row.inUse)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <TaxCurrencyHead tab="currencies" action={editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New currency</button> : null} />

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>A client’s currency is one of these, and its intensity reads in the symbol here — “tCO₂e per £m”. The set is ISO-4217: the UAE dirham is <b>AED</b>, never “UAE”.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Currencies"
        rows={page.rows}
        rowKey={(row) => row.code}
        columns={columns}
        search={{ value: query.search, label: "Search currencies", placeholder: "Search by code or name…", onChange: nav.search }}
        filters={[]}
        onFilter={() => {}}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as CurrencyListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No currencies yet</b><span>{editing.allowed ? "Add the first one — it becomes the default." : "Currencies arrive with the v7 currencies import."}</span></>
          : <><b>No currencies match</b><span>Clear the search or the filter to see every currency.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">A code is the three-letter ISO-4217 code and never changes. A currency with no sign of its own takes its code as its symbol — “AED m”.</p>
    </div>

    {open ? <CurrencyDrawer key={open.row?.code ?? "new"} row={open.row} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function CurrencyDrawer({ row, editing, onClose, onSaved }: { row: CurrencyRow | null; editing: Editing; onClose: () => void; onSaved: (message: string) => void }) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({ code: row?.code ?? "", name: row?.name ?? "", symbol: row?.symbol ?? "", makeDefault: false, active: row?.active ?? true, reason: "" });
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
  const fieldsChanged = row !== null && (draft.name.trim().replace(/\s+/g, " ") !== row.name || draft.symbol.trim() !== row.symbol);

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["code", "name", "symbol", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This currency changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const code = draft.code.trim().toUpperCase();
    const local: Record<string, string> = {};
    if (isNew && !isCurrencyCodeForSet(code)) local.code = code === "UAE" ? "“UAE” is the country, not a currency: the UAE dirham is AED." : "The three-letter ISO-4217 code, e.g. GBP.";
    if (!draft.name.trim()) local.name = "A name is required.";
    if (!draft.symbol.trim()) local.symbol = "A symbol is required — the code itself if the currency has no sign of its own.";
    if ((deactivating || makingDefault) && !draft.reason.trim()) local.reason = makingDefault
      ? "Say why this becomes the default currency."
      : "Say why this currency is being deactivated — it leaves every picker; clients holding it keep it.";
    if (Object.keys(local).length) { setIssues(local); return; }
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/currencies", { code, name: draft.name, symbol: draft.symbol }, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added ${code} — ${draft.name.trim()} (${draft.symbol.trim()}).`);
      }
      const path = `/api/isolated/currencies/${encodeURIComponent(row.code)}`;
      let version = row.version;
      const done: string[] = [];
      if (fieldsChanged) {
        const result = await patchBrowserCommand<{ version: number }>(path, { name: draft.name, symbol: draft.symbol, expectedVersion: version }, key("update"));
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
      return onSaved(done.length ? `${row.code} ${done.join(", ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Currency" title={isNew ? "New currency" : `${row.code} — ${row.name}`}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate currency" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {isDefault ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div><b>The default currency.</b> It cannot be deactivated; make another currency the default first. Its name and symbol can still be edited.</div></div> : null}
    <TextField label="Code" mono value={draft.code} readOnly={!isNew || readOnly} required={isNew} maxLength={3} placeholder="e.g. AED"
      hint={isNew ? "The three-letter ISO-4217 code. It can never be changed once saved." : "Fixed — a code never changes once made."}
      error={issues.code} onChange={(value) => setDraft({ ...draft, code: value.toUpperCase() })} />
    <TextField label="Name" value={draft.name} required maxLength={CURRENCY_NAME_MAX} placeholder="e.g. UAE dirham" error={issues.name}
      readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />
    <TextField label="Symbol" mono value={draft.symbol} required maxLength={CURRENCY_SYMBOL_MAX} placeholder="e.g. £, €, or the code" error={issues.symbol}
      hint="What every amount and intensity unit is written with — “£m”, or “AED m” for a code." readOnly={readOnly} onChange={(symbol) => setDraft({ ...draft, symbol })} />
    {isNew ? <p className="nz-a-hint">A new currency is the default only when it is the organisation’s first; otherwise make it the default once it is saved.</p> : null}
    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : row.provenance === "seeded" ? "Seeded (0145)" : "Added here"} readOnly /> : null}
    {!isNew && !isDefault ? <Switch label="Make this the default" description="The current default stops being one. A default is always active." checked={draft.makeDefault}
      disabled={readOnly || !draft.active} onChange={(makeDefault) => setDraft({ ...draft, makeDefault, active: makeDefault ? true : draft.active, reason: "" })} /> : null}
    {!isNew && !isDefault ? <Switch label="Active" description="Inactive currencies leave the pickers; clients already holding one keep it." checked={draft.active}
      disabled={readOnly || draft.makeDefault} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating || makingDefault ? <TextAreaField label={makingDefault ? "Reason for the new default" : "Reason for deactivating"} hint="Required — it is recorded in the audit log."
      value={draft.reason} rows={2} required error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
  </DrawerEditor>;
}
