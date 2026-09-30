"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, postBrowserCommandWithReason, patchBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { FILE_TYPE_FOLDER_PATTERN, FILE_TYPE_KEY_PATTERN, fileTypeListSpec, PAGE_SIZES, type FileTypeListQuery } from "@nzi/contracts";
import type { FileTypePage, FileTypeRow } from "@nzi/isolated-backend";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, NumberField, ProvenanceBadge, StatusBadge, Switch, TextAreaField, TextField,
  type DataListColumn,
} from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * The File types screen (admin Phase C3; docs/design/admin-prototype.html → File types): DataList → drawer editor →
 * audit. The job file-type vocabulary and its storage folder. A key is set once, at create, and shown read-only after;
 * a system type carries a lock and has no Deactivate. Nothing references a file type until the job-file store exists.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = { key: string; displayName: string; folder: string; sortOrder: string; active: boolean; reason: string };
const count = new Intl.NumberFormat("en-GB");

function Lock({ label = "System type — always available, cannot be deactivated" }: { label?: string }) {
  return <svg className="nz-a-lock" viewBox="0 0 24 24" width="13" height="13" role="img" aria-label={label}>
    <title>{label}</title>
    <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>;
}

export function FileTypesBoard({ page, query, editing }: { page: FileTypePage; query: FileTypeListQuery; editing: Editing }) {
  const router = useRouter();
  const nav = useListNavigation(fileTypeListSpec, query, "/admin/file-types");
  const [open, setOpen] = useState<{ row: FileTypeRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";

  const columns: DataListColumn<FileTypeRow>[] = [
    { key: "name", header: "File type", sortKey: "name", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.displayName}</button>
      <div className="nz-a-sub nz-a-mono">{row.key}</div>
    </div> },
    { key: "folder", header: "Storage folder", cell: (row) => <span className="nz-a-mono">{row.storageFolderKey}</span> },
    { key: "sortOrder", header: "Sort", sortKey: "sortOrder", numeric: true, cell: (row) => <span className="nz-a-mono">{row.sortOrder}</span> },
    { key: "inUse", header: "In use", numeric: true, cell: (row) => row.inUse === null
      ? <span className="nz-a-muted" title="The console has no job-file store yet, so nothing references a file type">none yet</span>
      : <span className="nz-a-mono">{count.format(row.inUse)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <span className="nz-a-status-cell"><StatusBadge active={row.active} />{row.isSystem ? <Lock /> : null}</span> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Delivery</div>
        <h1>File types</h1>
        <p>The job file-type vocabulary and where each type is stored. A type’s key is fixed once made, and the two system types cannot be removed.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New file type</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>The console has <b>no job-file store yet</b>, so these types are recorded, not yet used: “In use” reads none yet. v7’s types arrived with the jobs-configuration import, the two system types matched by key.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="File types"
        rows={page.rows}
        rowKey={(row) => row.fileTypeId}
        columns={columns}
        search={{ value: query.search, label: "Search file types", placeholder: "Search by name or key…", onChange: nav.search }}
        filters={[]}
        onFilter={() => {}}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as FileTypeListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No file types yet</b><span>{editing.allowed ? "Add the first one, or import v7’s." : "File types arrive with the v7 jobs-configuration import."}</span></>
          : <><b>No file types match</b><span>Clear the search or the filter to see every file type.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">A key is lower-case letters, digits and underscores, and never changes. A storage folder is where files of the type will be filed once the console stores job files.</p>
    </div>

    {open ? <FileTypeDrawer key={open.row?.fileTypeId ?? "new"} row={open.row} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function FileTypeDrawer({ row, editing, onClose, onSaved }: {
  row: FileTypeRow | null; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({ key: row?.key ?? "", displayName: row?.displayName ?? "", folder: row?.storageFolderKey ?? "",
    sortOrder: row ? String(row.sortOrder) : "", active: row?.active ?? true, reason: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;

  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const fieldsChanged = row !== null && (draft.displayName.trim().replace(/\s+/g, " ") !== row.displayName || draft.folder.trim() !== row.storageFolderKey
    || draft.sortOrder.trim() !== String(row.sortOrder));

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["fileTypeKey", "displayName", "storageFolderKey", "sortOrder", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This file type changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const sortOrder = draft.sortOrder.trim() === "" ? undefined : Number(draft.sortOrder);
    const local: Record<string, string> = {};
    if (isNew && !FILE_TYPE_KEY_PATTERN.test(draft.key.trim())) local.fileTypeKey = "Lower-case letters, digits and underscores, starting with a letter (2–41 characters).";
    if (!draft.displayName.trim()) local.displayName = "A display name is required.";
    if (!FILE_TYPE_FOLDER_PATTERN.test(draft.folder.trim())) local.storageFolderKey = "Lower-case letters, digits and hyphens.";
    if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0)) local.sortOrder = "Sort order is a whole number from 0.";
    if (deactivating && !draft.reason.trim()) local.reason = "Say why this file type is being deactivated — it leaves every picker.";
    if (Object.keys(local).length) { setIssues(local); return; }
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/file-types", { fileTypeKey: draft.key.trim(), displayName: draft.displayName, storageFolderKey: draft.folder.trim(), sortOrder }, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added the file type “${draft.displayName.trim()}” (${draft.key.trim()}).`);
      }
      const path = `/api/isolated/file-types/${encodeURIComponent(row.fileTypeId)}`;
      let version = row.version;
      if (fieldsChanged) {
        const result = await patchBrowserCommand<{ version: number }>(path, { displayName: draft.displayName, storageFolderKey: draft.folder.trim(), sortOrder: sortOrder ?? row.sortOrder, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version;
      }
      if (deactivating) {
        const result = await postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        return onSaved(`Deactivated “${draft.displayName.trim()}”.`);
      }
      if (reinstating) {
        const result = await postBrowserCommand(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Reinstated “${draft.displayName.trim()}”.`);
      }
      return onSaved(fieldsChanged ? `Saved “${draft.displayName.trim()}”.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  const system = row?.isSystem === true;
  return <DrawerEditor open onClose={onClose} eyebrow="File type" title={isNew ? "New file type" : row.displayName}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew || system ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${draft.active ? " danger" : ""}`} onClick={() => setDraft({ ...draft, active: !draft.active, reason: "" })}>
          {draft.active ? "Deactivate…" : row.active ? "Keep active" : "Reinstate"}
        </button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate file type" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {system ? <div className="nz-a-hint-strip"><span aria-hidden="true"><Lock label="System type" /></span><div><b>A system type.</b> It is always available and cannot be deactivated; its name, folder and order can still be edited.</div></div> : null}
    <TextField label="Key" mono value={draft.key} readOnly={!isNew || readOnly} required={isNew} maxLength={41} placeholder="e.g. site_photos"
      hint={isNew ? "Lower-case letters, digits and underscores. It can never be changed once saved." : "Fixed — a key never changes once made."}
      error={issues.fileTypeKey} onChange={(value) => setDraft({ ...draft, key: value })} />
    <TextField label="Display name" value={draft.displayName} required maxLength={120} placeholder="e.g. Site photos" error={issues.displayName}
      readOnly={readOnly} onChange={(displayName) => setDraft({ ...draft, displayName })} />
    <FieldRow>
      <TextField label="Storage folder" mono value={draft.folder} required maxLength={41} placeholder="e.g. site-photos" error={issues.storageFolderKey}
        hint="Where its files will be filed, once the console stores job files." readOnly={readOnly} onChange={(folder) => setDraft({ ...draft, folder })} />
      <NumberField label="Sort order" hint={isNew ? "Blank: after the last type." : undefined} value={draft.sortOrder} min={0} step={10}
        error={issues.sortOrder} disabled={readOnly} onChange={(sortOrder) => setDraft({ ...draft, sortOrder })} />
    </FieldRow>
    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : row.provenance === "seeded" ? "Seeded" : "Added here"} readOnly /> : null}
    {!isNew && !system ? <Switch label="Active" description="Inactive types leave the pickers but still show on records that name them." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
  </DrawerEditor>;
}
