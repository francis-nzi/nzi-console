"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { BD_STAGE_KEY_PATTERN, BD_STAGE_NAME_MAX, bdStageListSpec, isStageProbability, PAGE_SIZES, type BdStageListQuery } from "@nzi/contracts";
import type { BdStagePage, BdStageRow } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, ProvenanceBadge, StatusBadge, Switch, TextAreaField, TextField, type DataListColumn } from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * CRM & pipeline → the funnel (admin Phase F2): DataList → drawer editor → audit. A stage is a key (set once), a name, its
 * place in the order and a probability. The entry stage — where a new opportunity starts — is the first active by
 * order; the last active stage cannot be deactivated. CRM tags and service lines are Lookups lists, linked.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = { key: string; name: string; sortOrder: string; probability: string; active: boolean; reason: string };
const count = new Intl.NumberFormat("en-GB");
const pct = (value: number) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;

export function FunnelStagesBoard({ page, query, editing }: { page: BdStagePage; query: BdStageListQuery; editing: Editing }) {
  const router = useRouter();
  const nav = useListNavigation(bdStageListSpec, query, "/admin/crm-pipeline");
  const [open, setOpen] = useState<{ row: BdStageRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";

  const columns: DataListColumn<BdStageRow>[] = [
    { key: "sortOrder", header: "Order", sortKey: "sortOrder", numeric: true, cell: (row) => <span className="nz-a-mono">{count.format(row.sortOrder)}</span> },
    { key: "name", header: "Stage", sortKey: "name", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.name}</button>
      {row.entry ? <> <span className="nz-a-badge ok" title="Where a new opportunity starts: the first active stage by order"><i aria-hidden="true" />Entry</span></> : null}
      <div className="nz-a-sub nz-a-mono">{row.key}</div>
    </div> },
    { key: "probability", header: "Probability", sortKey: "probability", numeric: true, cell: (row) => <span className="nz-a-mono">{pct(row.probabilityPct)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Business development</div>
        <h1>CRM &amp; pipeline</h1>
        <p>The funnel an opportunity moves through — its stages in order, each with the probability a forecast weights it by. A new opportunity starts at the first active stage.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New stage</button> : null}
      </div>
    </div>
    <nav className="nz-a-seg nz-a-tabs" aria-label="CRM and pipeline lists">
      <a href="/admin/crm-pipeline" className="on" aria-current="page">Funnel stages</a>
      <a href="/admin/lookups?category=bd_service_lines">BD service lines ↗</a>
      <a href="/admin/lookups?category=crm_tags">CRM tags ↗</a>
    </nav>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>Automation rules are not here: they arrive with the CRM workstream, together with the engine that runs them.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Funnel stages"
        rows={page.rows}
        rowKey={(row) => row.stageId}
        columns={columns}
        search={{ value: query.search, label: "Search the funnel", placeholder: "Search by key or name…", onChange: nav.search }}
        filters={[]}
        onFilter={() => {}}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as BdStageListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No funnel stages yet</b><span>{editing.allowed ? "Add the first one — it becomes the entry stage." : "Stages arrive with the v7 funnel import."}</span></>
          : <><b>No stages match</b><span>Clear the search or the filter to see the whole funnel.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">A key is lower-case letters, digits and -, and never changes. Probability is a percentage from 0 to 100, to two places.</p>
    </div>

    {open ? <StageDrawer key={open.row?.stageId ?? "new"} row={open.row} editing={editing} nextOrder={(page.rows.reduce((max, row) => Math.max(max, row.sortOrder), 0) || 0) + 1}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function StageDrawer({ row, editing, nextOrder, onClose, onSaved }: { row: BdStageRow | null; editing: Editing; nextOrder: number; onClose: () => void; onSaved: (message: string) => void }) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({ key: row?.key ?? "", name: row?.name ?? "", sortOrder: String(row?.sortOrder ?? nextOrder),
    probability: row ? String(row.probabilityPct) : "", active: row?.active ?? true, reason: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;
  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const sortOrder = Number(draft.sortOrder);
  const probabilityPct = Number(draft.probability);
  const fieldsChanged = row !== null && (draft.name.trim().replace(/\s+/g, " ") !== row.name || sortOrder !== row.sortOrder || probabilityPct !== row.probabilityPct);

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["stageKey", "name", "sortOrder", "probabilityPct", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This stage changed since you opened it. Close the panel and open it again to see the latest." : result.message);
    keys.current = {};
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const local: Record<string, string> = {};
    if (isNew && !BD_STAGE_KEY_PATTERN.test(draft.key)) local.stageKey = "Lower-case letters, digits and - (up to 40).";
    if (!draft.name.trim()) local.name = "A name is required.";
    if (draft.sortOrder.trim() === "" || !Number.isInteger(sortOrder) || sortOrder < 0) local.sortOrder = "A whole number from 0.";
    if (draft.probability.trim() === "" || !isStageProbability(probabilityPct)) local.probabilityPct = "A percentage from 0 to 100, to two places.";
    if (deactivating && !draft.reason.trim()) local.reason = "Say why this stage is being deactivated.";
    if (Object.keys(local).length) { setIssues(local); return; }
    setSaving(true);
    try {
      const fields = { name: draft.name, sortOrder, probabilityPct };
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/bd-stages", { stageKey: draft.key, ...fields }, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added the stage “${draft.name.trim()}” (${draft.key}).`);
      }
      const path = `/api/isolated/bd-stages/${encodeURIComponent(row.stageId)}`;
      let version = row.version;
      const done: string[] = [];
      if (fieldsChanged) {
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
      return onSaved(done.length ? `“${draft.name.trim()}” ${done.join(", ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Funnel stage" title={isNew ? "New funnel stage" : row.name}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate stage" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {row?.entry ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div><b>The entry stage.</b> A new opportunity starts here, as the first active stage by order.</div></div> : null}
    <TextField label="Key" mono value={draft.key} readOnly={!isNew || readOnly} required={isNew} maxLength={40} placeholder="e.g. qualified"
      hint={isNew ? "Lower-case letters, digits and -. It can never be changed once saved." : "Fixed — opportunities will name the stage by it."}
      error={issues.stageKey} onChange={(value) => setDraft({ ...draft, key: value.toLowerCase() })} />
    <TextField label="Name" value={draft.name} required maxLength={BD_STAGE_NAME_MAX} placeholder="e.g. Qualified" error={issues.name}
      readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />
    <FieldRow>
      <TextField label="Order" mono value={draft.sortOrder} required maxLength={7} error={issues.sortOrder} hint="Lower comes first."
        readOnly={readOnly} onChange={(value) => setDraft({ ...draft, sortOrder: value })} />
      <TextField label="Probability (%)" mono value={draft.probability} required maxLength={6} placeholder="e.g. 35" error={issues.probabilityPct}
        hint="From 0 to 100, to two places." readOnly={readOnly} onChange={(probability) => setDraft({ ...draft, probability })} />
    </FieldRow>
    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : "Added here"} readOnly /> : null}
    {!isNew ? <Switch label="Active" description="An inactive stage leaves the funnel; the funnel's last active stage cannot be deactivated." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
  </DrawerEditor>;
}
