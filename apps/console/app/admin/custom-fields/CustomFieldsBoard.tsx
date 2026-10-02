"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  CUSTOM_FIELD_ENTITY_LABELS, CUSTOM_FIELD_ENTITY_TYPES, CUSTOM_FIELD_KEY_PATTERN, CUSTOM_FIELD_LABEL_MAX, CUSTOM_FIELD_TYPE_LABELS, CUSTOM_FIELD_TYPES,
  customFieldListSpec, customFieldOptionIssues, customFieldValueIssue, PAGE_SIZES,
  type CustomFieldEntityType, type CustomFieldListQuery, type CustomFieldOption, type CustomFieldType,
} from "@nzi/contracts";
import type { CustomFieldPage, CustomFieldRow } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, ProvenanceBadge, SelectField, StatusBadge, Switch, TextAreaField, TextField, type DataListColumn } from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * Custom fields (admin Phase F3): DataList → drawer editor → audit. A definition's entity, key and type are chosen once;
 * its label, order, required flag, options and default are editable. A choice-from-a-list field's options are never
 * removed — relabelled, reordered, deactivated or added — so every value already held still resolves. The values
 * themselves live on each record's own screens (docs/CUSTOM_FIELD_VALUES_CONTRACT.md).
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type OptionDraft = CustomFieldOption & { held: boolean };
type Draft = {
  entityType: CustomFieldEntityType; key: string; type: CustomFieldType; label: string; required: boolean; sortOrder: string;
  options: OptionDraft[]; defaultValue: string; active: boolean; reason: string;
};
const count = new Intl.NumberFormat("en-GB");
const plural = (n: number, one: string) => `${count.format(n)} ${n === 1 ? one : `${one}s`}`;

export function CustomFieldsBoard({ page, query, editing }: { page: CustomFieldPage; query: CustomFieldListQuery; editing: Editing }) {
  const router = useRouter();
  const nav = useListNavigation(customFieldListSpec, query, "/admin/custom-fields");
  const [open, setOpen] = useState<{ row: CustomFieldRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";
  const entity = query.filters.entity?.[0] ?? "";

  const columns: DataListColumn<CustomFieldRow>[] = [
    { key: "label", header: "Field", sortKey: "label", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.label}</button>
      {row.required ? <span className="nz-a-sub"> · required</span> : null}
      <div className="nz-a-sub nz-a-mono">{row.key}</div>
    </div> },
    { key: "entity", header: "On", cell: (row) => CUSTOM_FIELD_ENTITY_LABELS[row.entityType] },
    { key: "type", header: "Type", sortKey: "type", cell: (row) => <>{CUSTOM_FIELD_TYPE_LABELS[row.type]}{row.type === "select" && row.options
      ? <span className="nz-a-sub"> · {plural(row.options.filter((option) => option.active).length, "option")}</span> : null}</> },
    { key: "sortOrder", header: "Order", sortKey: "sortOrder", numeric: true, cell: (row) => <span className="nz-a-mono">{count.format(row.sortOrder)}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;
  const entityOptions = page.filterOptions.entity.map((option) => ({ ...option, label: CUSTOM_FIELD_ENTITY_LABELS[option.value as CustomFieldEntityType] ?? option.label }));

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Foundation</div>
        <h1>Custom fields</h1>
        <p>The extra fields your organisation keeps on its clients, jobs, contacts, quotes and suppliers. A field’s key and type are set once; the values are filled in on each record’s own screen.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.settings" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New field</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>Deactivating a field takes it off the forms; every value already entered for it is kept. A choice-from-a-list field’s options are never removed — deactivate one instead, and records that chose it keep it.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Custom fields"
        rows={page.rows}
        rowKey={(row) => row.definitionId}
        columns={columns}
        search={{ value: query.search, label: "Search custom fields", placeholder: "Search by key or label…", onChange: nav.search }}
        filters={[{ key: "entity", label: "On", value: entity, allLabel: "Every record", options: entityOptions }]}
        onFilter={(key, value) => nav.filter(key as "entity", value)}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "All", statusCount("active") + statusCount("inactive")], ["active", "Active", statusCount("active")], ["inactive", "Inactive", statusCount("inactive")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as CustomFieldListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status || entity ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No custom fields yet</b><span>{editing.allowed ? "Add the first one, or import v7’s." : "Definitions arrive with the v7 custom-field import."}</span></>
          : <><b>No fields match</b><span>Clear the search or the filters to see every field.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">A key is lower-case letters, digits, _ and -, starting with a letter. It and the type never change: a field that needs another type is a new field.</p>
    </div>

    {open ? <FieldDrawer key={open.row?.definitionId ?? "new"} row={open.row} editing={editing} defaultEntity={(entity || "client") as CustomFieldEntityType}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function FieldDrawer({ row, editing, defaultEntity, onClose, onSaved }: {
  row: CustomFieldRow | null; editing: Editing; defaultEntity: CustomFieldEntityType; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({
    entityType: row?.entityType ?? defaultEntity, key: row?.key ?? "", type: row?.type ?? "text", label: row?.label ?? "", required: row?.required ?? false,
    sortOrder: String(row?.sortOrder ?? 10), options: (row?.options ?? []).map((option) => ({ ...option, held: true })), defaultValue: row?.defaultValue ?? "",
    active: row?.active ?? true, reason: "",
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;
  const deactivating = row?.active === true && !draft.active;
  const reinstating = row?.active === false && draft.active;
  const options = draft.type === "select" ? draft.options.map(({ value, label, active }) => ({ value: value.trim(), label: label.trim(), active })) : null;
  const sortOrder = Number(draft.sortOrder);
  const defaultValue = draft.defaultValue.trim() === "" ? null : draft.defaultValue;
  const fieldsChanged = row !== null && (draft.label.trim().replace(/\s+/g, " ") !== row.label || draft.required !== row.required || sortOrder !== row.sortOrder
    || defaultValue !== row.defaultValue || JSON.stringify(options?.map((option) => [option.value, option.label, option.active]) ?? null)
      !== JSON.stringify(row.options?.map((option) => [option.value, option.label, option.active]) ?? null));
  const setOption = (index: number, change: Partial<OptionDraft>) => setDraft({ ...draft, options: draft.options.map((option, at) => at === index ? { ...option, ...change } : option) });
  const moveOption = (index: number, by: -1 | 1) => {
    const next = [...draft.options];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    setDraft({ ...draft, options: next });
  };

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["entityType", "fieldKey", "fieldType", "label", "sortOrder", "options", "defaultValue", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This field changed since you opened it. Close the panel and open it again to see the latest." : result.message);
    keys.current = {};
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const local: Record<string, string> = {};
    if (isNew && !CUSTOM_FIELD_KEY_PATTERN.test(draft.key)) local.fieldKey = "Lower-case letters, digits, _ and -, starting with a letter (up to 64).";
    if (!draft.label.trim()) local.label = "A label is required.";
    if (draft.sortOrder.trim() === "" || !Number.isInteger(sortOrder) || sortOrder < 0) local.sortOrder = "A whole number from 0.";
    const optionProblems = customFieldOptionIssues(draft.type, options);
    if (optionProblems.length) local.options = optionProblems.join(" ");
    else if (defaultValue !== null) { const issue = customFieldValueIssue(draft.type, defaultValue, options); if (issue) local.defaultValue = issue; }
    if (deactivating && !draft.reason.trim()) local.reason = "Say why this field is being deactivated.";
    if (Object.keys(local).length) { setIssues(local); return; }
    setSaving(true);
    try {
      const fields = { label: draft.label, required: draft.required, sortOrder, options, defaultValue };
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/custom-fields", { entityType: draft.entityType, fieldKey: draft.key, fieldType: draft.type, ...fields }, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added “${draft.label.trim()}” to ${CUSTOM_FIELD_ENTITY_LABELS[draft.entityType].toLowerCase()} (${draft.key}).`);
      }
      const path = `/api/isolated/custom-fields/${encodeURIComponent(row.definitionId)}`;
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
      return onSaved(done.length ? `“${draft.label.trim()}” ${done.join(", ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  const activeOptions = draft.options.filter((option) => option.active && option.value.trim());
  return <DrawerEditor open onClose={onClose} eyebrow="Custom field" title={isNew ? "New custom field" : row.label}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate field" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <FieldRow>
      <SelectField label="On" value={draft.entityType} disabled={!isNew || readOnly} error={issues.entityType}
        options={CUSTOM_FIELD_ENTITY_TYPES.map((value) => ({ value, label: CUSTOM_FIELD_ENTITY_LABELS[value] }))}
        onChange={(entityType) => setDraft({ ...draft, entityType: entityType as CustomFieldEntityType })} />
      <SelectField label="Type" value={draft.type} disabled={!isNew || readOnly} error={issues.fieldType}
        options={CUSTOM_FIELD_TYPES.map((value) => ({ value, label: CUSTOM_FIELD_TYPE_LABELS[value] }))}
        onChange={(type) => setDraft({ ...draft, type: type as CustomFieldType, defaultValue: "", options: type === "select" && draft.options.length === 0 ? [{ value: "", label: "", active: true, held: false }] : draft.options })} />
    </FieldRow>
    <TextField label="Key" mono value={draft.key} readOnly={!isNew || readOnly} required={isNew} maxLength={64} placeholder="e.g. delivery_mode"
      hint={isNew ? "Set once — values are stored against it. The entity and type are fixed too." : "Fixed, with the entity and type — values are stored against them."}
      error={issues.fieldKey} onChange={(value) => setDraft({ ...draft, key: value.toLowerCase() })} />
    <TextField label="Label" value={draft.label} required maxLength={CUSTOM_FIELD_LABEL_MAX} placeholder="e.g. Delivery mode" error={issues.label}
      readOnly={readOnly} onChange={(label) => setDraft({ ...draft, label })} />
    <FieldRow>
      <TextField label="Order" mono value={draft.sortOrder} required maxLength={7} error={issues.sortOrder} hint="Lower comes first on the form."
        readOnly={readOnly} onChange={(value) => setDraft({ ...draft, sortOrder: value })} />
      <Switch label="Required" description="A record cannot be saved without it." checked={draft.required} disabled={readOnly} onChange={(required) => setDraft({ ...draft, required })} />
    </FieldRow>

    {draft.type === "select" ? <>
      <h3>Options</h3>
      <p className="nz-a-hint">An option’s value is what a record stores; once saved it never changes and the option is never removed — deactivate it instead.</p>
      {issues.options ? <div className="nz-a-error" role="alert">{issues.options}</div> : null}
      <ol className="nz-a-sub-records" aria-label="Options">
        {draft.options.map((option, index) => <li key={index}>
          <FieldRow>
            <TextField label="Value" mono value={option.value} readOnly={option.held || readOnly} maxLength={80} placeholder="e.g. online"
              onChange={(value) => setOption(index, { value })} />
            <TextField label="Label" value={option.label} readOnly={readOnly} maxLength={120} placeholder="e.g. Online" onChange={(label) => setOption(index, { label })} />
          </FieldRow>
          {readOnly ? null : <div className="nz-a-sub-record-actions">
            <Switch label="Active" checked={option.active} onChange={(active) => setOption(index, { active })} />
            <button type="button" className="nz-a-linkish" disabled={index === 0} aria-label={`Move ${option.value || "option"} up`} onClick={() => moveOption(index, -1)}>↑</button>
            <button type="button" className="nz-a-linkish" disabled={index === draft.options.length - 1} aria-label={`Move ${option.value || "option"} down`} onClick={() => moveOption(index, 1)}>↓</button>
            {option.held ? null : <button type="button" className="nz-a-linkish" onClick={() => setDraft({ ...draft, options: draft.options.filter((_, at) => at !== index) })}>Remove</button>}
          </div>}
        </li>)}
      </ol>
      {readOnly ? null : <button type="button" className="nz-a-btn" onClick={() => setDraft({ ...draft, options: [...draft.options, { value: "", label: "", active: true, held: false }] })}>+ Add an option</button>}
    </> : null}

    {draft.type === "select" ? <SelectField label="Default" value={draft.defaultValue} placeholder="None" disabled={readOnly} error={issues.defaultValue}
        options={activeOptions.map((option) => ({ value: option.value, label: option.label || option.value }))} onChange={(defaultValue) => setDraft({ ...draft, defaultValue })} />
      : draft.type === "checkbox" ? <SelectField label="Default" value={draft.defaultValue} placeholder="None" disabled={readOnly} error={issues.defaultValue}
        options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} onChange={(defaultValue) => setDraft({ ...draft, defaultValue })} />
      : <TextField label="Default" mono={draft.type !== "text" && draft.type !== "long_text"} value={draft.defaultValue} readOnly={readOnly} maxLength={500}
        placeholder={draft.type === "date" ? "YYYY-MM-DD" : "None"} hint="Applied once, when a record is created." error={issues.defaultValue}
        onChange={(defaultValue) => setDraft({ ...draft, defaultValue })} />}

    {!isNew ? <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : "Added here"} readOnly /> : null}
    {!isNew ? <Switch label="Active" description="An inactive field leaves the forms; values already entered are kept." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for deactivating" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
  </DrawerEditor>;
}
