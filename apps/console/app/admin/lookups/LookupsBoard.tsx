"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, postBrowserCommandWithReason, patchBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { PAGE_SIZES, referenceValueListSpec, type LookupCategory, type ReferenceValueListQuery } from "@nzi/contracts";
import type { LookupCategorySummary, ReferenceValuePage, ReferenceValueRow } from "@nzi/isolated-backend";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, NumberField, ProvenanceBadge, StatusBadge, Switch, TextAreaField, TextField,
  type DataListColumn, type Provenance,
} from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * The Lookups screen (admin Phase A2; docs/design/admin-prototype.html): category chips → DataList → drawer editor →
 * audit. One engine for every simple lookup. Values are added, edited and reordered, deactivated and reinstated —
 * never deleted — and a deactivated value still resolves on the records that use it.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = { label: string; code: string; sortOrder: string; active: boolean; reason: string };
const PROVENANCE: Record<ReferenceValueRow["provenance"], Provenance> = { v7: "v7", added: "added", seeded: "seeded" };
const count = new Intl.NumberFormat("en-GB");

export function LookupsBoard({ categories, page, query, category, editing }: {
  categories: LookupCategorySummary[]; page: ReferenceValuePage; query: ReferenceValueListQuery; category: LookupCategory; editing: Editing;
}) {
  const router = useRouter();
  const nav = useListNavigation(referenceValueListSpec, query, "/admin/lookups");
  const current = categories.find((item) => item.key === category) ?? categories[0]!;
  const [open, setOpen] = useState<{ row: ReferenceValueRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";

  const columns: DataListColumn<ReferenceValueRow>[] = [
    { key: "label", header: "Value", sortKey: "label", cell: (row) => <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.label}</button> },
    ...(current.carriesCode ? [{ key: "code", header: current.codeLabel ?? "Code", cell: (row: ReferenceValueRow) => row.code ? <span className="nz-a-mono">{row.code}</span> : <span className="nz-a-muted">—</span> }] : []),
    { key: "sortOrder", header: "Sort", sortKey: "sortOrder", numeric: true, cell: (row) => <span className="nz-a-mono">{row.sortOrder}</span> },
    { key: "inUse", header: "In use", sortKey: "inUse", numeric: true, cell: (row) => row.inUse === null
      ? <span className="nz-a-muted" title="Nothing in the console references this lookup yet">—</span>
      : <span className={`nz-a-mono${row.inUse === 0 ? " nz-a-muted" : ""}`}>{count.format(row.inUse)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={PROVENANCE[row.provenance]} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Foundation</div>
        <h1>Lookups</h1>
        <p>One engine for every simple reference list. Values can be edited, reordered and deactivated — never deleted — and stay resolved on records that already use them.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ Add value</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>These values were <b>seeded</b> for this organisation, and v7’s are matched onto them by exact label when they are imported — anything unmatched is reported, never guessed. Imported clients are linked to them by a separate, reported backfill.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    <nav className="nz-a-catbar" aria-label="Lookups">
      {categories.map((item) => <a key={item.key} href={`/admin/lookups?category=${item.key}`} className={`nz-a-cat${item.key === category ? " on" : ""}`} aria-current={item.key === category ? "page" : undefined}>
        {item.label}<span className="n">{count.format(item.active + item.inactive)}</span>
      </a>)}
    </nav>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label={current.label}
        rows={page.rows}
        rowKey={(row) => row.valueId}
        columns={columns}
        search={{ value: query.search, label: `Search ${current.label.toLowerCase()}`, placeholder: "Search values…", onChange: nav.search }}
        filters={[]}
        onFilter={() => {}}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as ReferenceValueListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status ? () => nav.clear({ category: [category] }) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No {current.label.toLowerCase()} yet</b><span>{editing.allowed ? "Add the first value, or import v7’s." : "Values arrive with the v7 import."}</span></>
          : <><b>No values match</b><span>Clear the search or the filter to see every value.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">{current.description}{current.consumer ? ` “In use” counts ${current.consumer} pointing at each value.` : " Nothing in the console references this lookup yet, so “In use” shows —."}</p>
    </div>

    {open ? <ValueDrawer key={open.row?.valueId ?? "new"} row={open.row} category={current} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function ValueDrawer({ row, category, editing, onClose, onSaved }: {
  row: ReferenceValueRow | null; category: LookupCategorySummary; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({ label: row?.label ?? "", code: row?.code ?? "", sortOrder: row ? String(row.sortOrder) : "", active: row?.active ?? true, reason: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;

  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const fieldsChanged = row !== null && (draft.label.trim() !== row.label || (draft.code.trim() || null) !== row.code || draft.sortOrder.trim() !== String(row.sortOrder));

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field === "reason" ? "reason" : issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["label", "code", "sortOrder", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This value changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const sortOrder = draft.sortOrder.trim() === "" ? undefined : Number(draft.sortOrder);
    if (sortOrder !== undefined && !Number.isInteger(sortOrder)) { setIssues({ sortOrder: "Sort order is a whole number." }); return; }
    if (deactivating && !draft.reason.trim()) { setIssues({ reason: "Say why this value is being deactivated — it leaves every picker." }); return; }
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/reference-values", { categoryKey: category.key, label: draft.label, code: draft.code || null, sortOrder }, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added “${draft.label.trim()}” to ${category.label}.`);
      }
      const path = `/api/isolated/reference-values/${encodeURIComponent(row.valueId)}`;
      let version = row.version;
      if (fieldsChanged) {
        const result = await patchBrowserCommand<{ version: number }>(path, { categoryKey: category.key, label: draft.label, code: draft.code || null, sortOrder: sortOrder ?? row.sortOrder, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version;
      }
      if (deactivating) {
        const result = await postBrowserCommandWithReason<{ inUse: number | null }>(`${path}/deactivate`, { categoryKey: category.key, expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        const held = result.data.inUse;
        return onSaved(`Deactivated “${draft.label.trim()}”.${held ? ` It still shows on the ${held} record${held === 1 ? "" : "s"} that use it.` : ""}`);
      }
      if (reinstating) {
        const result = await postBrowserCommand(`${path}/reinstate`, { categoryKey: category.key, expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Reinstated “${draft.label.trim()}”.`);
      }
      return onSaved(fieldsChanged ? `Saved “${draft.label.trim()}”.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  const title = isNew ? "New value" : row.label;
  return <DrawerEditor open onClose={onClose} eyebrow={category.label} title={title}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${draft.active ? " danger" : ""}`} onClick={() => setDraft({ ...draft, active: !draft.active, reason: "" })}>
          {draft.active ? "Deactivate…" : row.active ? "Keep active" : "Reinstate"}
        </button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate value" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Label" hint="Shown in pickers and on records." value={draft.label} placeholder="e.g. Professional services" required maxLength={120}
      error={issues.label} readOnly={readOnly} onChange={(label) => setDraft({ ...draft, label })} />
    {category.carriesCode ? <TextField label={category.codeLabel ?? "Code"} mono value={draft.code} placeholder="Optional short code" maxLength={32}
      error={issues.code} readOnly={readOnly} onChange={(code) => setDraft({ ...draft, code })} /> : null}
    <FieldRow>
      <NumberField label="Sort order" hint={isNew ? "Blank: after the last value." : undefined} value={draft.sortOrder} min={0} step={10}
        error={issues.sortOrder} disabled={readOnly} onChange={(sortOrder) => setDraft({ ...draft, sortOrder })} />
      <TextField label="Source" value={isNew ? "Added here" : row.provenance === "v7" ? "Imported · v7" : row.provenance === "added" ? "Added here" : "Seeded"} readOnly />
    </FieldRow>
    {row?.ownerClient ? <TextField label="Portfolio owner" hint="The client that owns this portfolio, from v7." value={row.ownerClient} readOnly /> : null}
    {!isNew ? <Switch label="Active" description="Inactive values leave the pickers but still show on existing records." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
    {row && row.inUse !== null && row.inUse > 0 ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>In use on <b>{count.format(row.inUse)}</b> record{row.inUse === 1 ? "" : "s"}. Deactivating keeps it resolved on those; it cannot be deleted.</div></div> : null}
  </DrawerEditor>;
}
