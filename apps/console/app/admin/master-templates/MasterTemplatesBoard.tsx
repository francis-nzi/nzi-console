"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  groupMasterTemplateRows, masterFactorServes, masterTemplateTitle, MASTER_TEMPLATE_NAME_MAX, REPORTING_TEMPLATE_LABEL_MAX,
  type MasterTemplate, type MasterTemplateFactorOption, type MasterTemplateRowInput, type MasterTemplatesReadModel, type ReportingTemplateScope,
} from "@nzi/contracts";
import { AuditLine, CapabilityChip, DrawerEditor, StatusBadge, Switch, TextAreaField, TextField } from "@nzi/ui";
import { searchActivityOptions } from "../../jobs/emissionEntryModel";

/**
 * The Master templates screen (data-entry R1, 0197): a card per master — `Master · <Type>`, its lines in force by scope —
 * and the drawer that authors one: its name, its lines (scope · category · activity · labels · unit, never a quantity),
 * and archive / reinstate. Saving the lines writes the next version; the one before stays in the record.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type LineDraft = { key: string; scope: ReportingTemplateScope; categoryCode: string; sourceLabel: string; reportLabel: string; factorId: string | null; factorLabel: string | null; unit: string };
type Draft = { name: string; lines: LineDraft[]; active: boolean; reason: string };
const SCOPES: ReportingTemplateScope[] = ["1", "2", "3"];
const count = new Intl.NumberFormat("en-GB");
const plural = (n: number, one: string, many = `${one}s`) => `${count.format(n)} ${n === 1 ? one : many}`;

export function MasterTemplatesBoard({ screen, editing }: { screen: MasterTemplatesReadModel; editing: Editing }) {
  const router = useRouter();
  const [open, setOpen] = useState<{ master: MasterTemplate | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Carbon data</div>
        <h1>Master templates</h1>
        <p>The starting point for a client&rsquo;s first job: the scopes, categories and activities a kind of organisation usually reports. A consultant seeds a job from one, trims it to the client and saves it as the client&rsquo;s own reporting template. A template is a shell — it never holds a quantity.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ master: null })}>+ New master</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>A master names no site and no dataset: each activity is the factor itself, resolved to the job&rsquo;s own datasets when a job is seeded from it. Saving the lines writes the next version; an archived master leaves the seed choices but stays in the record.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    {screen.masters.length === 0
      ? <div className="nz-a-placeholder"><h2>No master templates yet</h2><p>{editing.allowed ? "Add the first one." : "An administrator adds them here."}</p></div>
      : <ul className="nz-a-mt-grid" aria-label="Master templates">
        {screen.masters.map((master) => <li key={master.masterId}>
          <button type="button" className={`nz-a-mt-card${master.active ? "" : " inactive"}`} onClick={() => setOpen({ master })}
            aria-label={`${masterTemplateTitle(master.name)}${master.active ? "" : ", archived"} — ${editing.allowed ? "edit" : "view"}`}>
            <span className="nz-a-mt-head">
              <span className="nz-a-mt-ic" aria-hidden="true">▤</span>
              <span className="nz-a-mt-title"><b>{masterTemplateTitle(master.name)}</b>
                <span className="nz-a-sub nz-a-mono">{master.rowsVersion === 0 ? "No lines yet" : `v${master.rowsVersion} · ${plural(master.rows.length, "line")}`}</span></span>
              {!master.active ? <StatusBadge active={false} /> : null}
            </span>
            <span className="nz-a-mitems">
              {groupMasterTemplateRows(master.rows).map((group) => <span key={group.scope} className="nz-a-mitem">
                <span className="k"><span className={`nz-scope-sw s${group.scope}`} aria-hidden="true" /></span>
                <span><b>Scope {group.scope}</b><span className="kind">{group.categories.map((category) => category.categoryName ?? category.categoryCode).join(" · ")}</span></span>
                <span className="off">{group.categories.reduce((n, category) => n + category.rows.length, 0)}</span>
              </span>)}
            </span>
          </button>
        </li>)}
      </ul>}

    {open ? <MasterDrawer key={open.master?.masterId ?? "new"} master={open.master} screen={screen} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

const lineDraftsOf = (master: MasterTemplate | null): LineDraft[] => (master?.rows ?? []).map((row) => ({
  key: row.rowId, scope: row.scope, categoryCode: row.categoryCode, sourceLabel: row.sourceLabel, reportLabel: row.reportLabel ?? "",
  factorId: row.factorId, factorLabel: row.factorLabel, unit: row.unit ?? "",
}));

/** The lines as the command takes them — the comparison of "changed" uses the same form. */
const rowsOf = (lines: LineDraft[]): MasterTemplateRowInput[] => lines.map((line) => ({
  scope: line.scope, categoryCode: line.categoryCode, sourceLabel: line.sourceLabel.trim(), reportLabel: line.reportLabel.trim() || null,
  factorId: line.factorId, unit: line.unit.trim() || null,
}));

function MasterDrawer({ master, screen, editing, onClose, onSaved }: {
  master: MasterTemplate | null; screen: MasterTemplatesReadModel; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = master === null;
  const [draft, setDraft] = useState<Draft>(() => ({ name: master?.name ?? "", lines: lineDraftsOf(master), active: master?.active ?? true, reason: "" }));
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  // An archived master is read-only until it is reinstated — the command refuses a change to one.
  const readOnly = !editing.allowed || (master !== null && !master.active);
  const archiving = master?.active === true && !draft.active;
  const reinstating = master?.active === false && draft.active;

  const setLine = (lineKey: string, change: Partial<LineDraft>) => setDraft((current) => ({ ...current, lines: current.lines.map((line) => line.key === lineKey ? { ...line, ...change } : line) }));
  const addLine = () => setDraft((current) => ({ ...current, lines: [...current.lines, { key: crypto.randomUUID(), scope: "1", categoryCode: "", sourceLabel: "", reportLabel: "", factorId: null, factorLabel: null, unit: "" }] }));

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["name", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This master changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving) return;
    setIssues({}); setProblem(null);
    const local: Record<string, string> = {};
    if (!draft.name.trim()) local.name = "A name is required — Default, Construction, Office…";
    draft.lines.forEach((line, index) => {
      if (!line.categoryCode) local[`rows[${index}].categoryCode`] = "Choose a category.";
      if (!line.sourceLabel.trim()) local[`rows[${index}].sourceLabel`] = "A source label is required.";
    });
    if (archiving && !draft.reason.trim()) local.reason = "Say why this master is being archived — it leaves the seed choices.";
    if (Object.keys(local).length) { setIssues(local); return; }
    const name = draft.name.trim().replace(/\s+/g, " ");
    const rows = rowsOf(draft.lines);
    const renamed = master !== null && name !== master.name;
    const rowsChanged = JSON.stringify(rows) !== JSON.stringify(rowsOf(lineDraftsOf(master)));
    setSaving(true);
    try {
      let masterId = master?.masterId ?? "";
      let version = master?.version ?? 1;
      const path = () => `/api/isolated/master-templates/${encodeURIComponent(masterId)}`;
      if (reinstating) {
        const result = await postBrowserCommand<{ version: number }>(`${path()}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Reinstated ${masterTemplateTitle(master!.name)}.`);
      }
      if (isNew) {
        const result = await postBrowserCommand<{ masterId: string; version: number }>("/api/isolated/master-templates", { name }, key("create"));
        if (result.state !== "success") return fail(result);
        ({ masterId, version } = result.data);
      } else if (renamed) {
        const result = await postBrowserCommand<{ version: number }>(`${path()}/rename`, { expectedVersion: version, name }, key("rename"));
        if (result.state !== "success") return fail(result);
        version = result.data.version;
      }
      // Each step passes on the header's new version, so a rename, the lines and an archive in one save all land.
      let saved: { rowsVersion: number; lineCount: number } | null = null;
      if (rowsChanged) {
        const result = await postBrowserCommand<{ version: number; rowsVersion: number; lineCount: number }>(`${path()}/rows`, { expectedVersion: version, rows }, key("rows"));
        if (result.state !== "success") return fail(result);
        version = result.data.version;
        saved = result.data;
      }
      if (archiving) {
        const result = await postBrowserCommandWithReason<{ version: number }>(`${path()}/archive`, { expectedVersion: version }, key("archive"), draft.reason);
        if (result.state !== "success") return fail(result);
        return onSaved(`Archived ${masterTemplateTitle(name)} — kept in the record, out of the seed choices.`);
      }
      if (saved) return onSaved(`Saved ${masterTemplateTitle(name)} · v${saved.rowsVersion} · ${plural(saved.lineCount, "line")}.`);
      return onSaved(isNew ? `Added ${masterTemplateTitle(name)}.` : renamed ? `Renamed to ${masterTemplateTitle(name)}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  const title = isNew ? "New master" : masterTemplateTitle(master.name);
  return <DrawerEditor open onClose={onClose} eyebrow="Master template" title={title}
    audit={<AuditLine version={isNew ? "new" : master.version}>{!editing.allowed ? "Read-only here — every change is recorded in the audit log"
      : master && !master.active ? "Archived — reinstate it to change it" : master && master.rowsVersion > 0 ? `Lines v${master.rowsVersion} · saving writes v${master.rowsVersion + 1}` : undefined}</AuditLine>}
    actions={!editing.allowed ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${draft.active ? " danger" : ""}`} onClick={() => setDraft({ ...draft, active: !draft.active, reason: "" })}>
          {draft.active ? (master.active ? "Archive…" : "Keep archived") : master.active ? "Keep active" : "Reinstate"}
        </button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving || (readOnly && !reinstating)}>{saving ? "Saving…" : archiving ? "Archive master" : reinstating ? "Reinstate master" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Type" value={draft.name} placeholder="e.g. Construction" required maxLength={MASTER_TEMPLATE_NAME_MAX}
      hint={`Shown as “${masterTemplateTitle(draft.name.trim() || "<Type>")}”.`} error={issues.name} readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />

    <fieldset className="nz-a-mt-editor" disabled={readOnly}>
      <legend>Lines · scope, category and activity — never a quantity</legend>
      {draft.lines.length === 0 ? <p className="nz-a-hint">No lines yet. Add the activities this kind of organisation usually reports.</p> : null}
      {draft.lines.map((line, index) => <MasterLine key={line.key} index={index} line={line} screen={screen} issues={issues}
        onChange={(change) => setLine(line.key, change)}
        onRemove={() => setDraft((current) => ({ ...current, lines: current.lines.filter((item) => item.key !== line.key) }))} />)}
      {readOnly ? null : <button type="button" className="nz-a-btn" onClick={addLine}>+ Add a line</button>}
      {issues.rows ? <div className="nz-a-error" role="alert">{issues.rows}</div> : null}
      <div className="nz-a-hint">A line names its category and, usually, its activity. A category with no activity is a shell — a spend line, captured through its own pathway.</div>
    </fieldset>

    {!isNew ? <Switch label="Active" description="An archived master leaves the seed choices but stays in the record; it can be reinstated." checked={draft.active}
      disabled={!editing.allowed} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {archiving ? <TextAreaField label="Reason for archiving" hint="Required — it is recorded in the audit log."
      value={draft.reason} rows={2} required error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
    {master && !master.active && master.archivedReason ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>Archived: {master.archivedReason}</div></div> : null}
  </DrawerEditor>;
}

/** One line: scope, category, the activity by smart search (the capture accordion's), labels and unit. */
function MasterLine({ index, line, screen, issues, onChange, onRemove }: {
  index: number; line: LineDraft; screen: MasterTemplatesReadModel; issues: Record<string, string>;
  onChange: (change: Partial<LineDraft>) => void; onRemove: () => void;
}) {
  const [query, setQuery] = useState(line.factorLabel ?? "");
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const categories = screen.categories.filter((category) => category.scope === line.scope);
  const offered = line.categoryCode ? screen.factors.filter((option) => masterFactorServes(option, line)) : [];
  const results = searchActivityOptions(offered, query);
  const listId = `master-line-${index}-results`;
  const field = (name: string) => issues[`rows[${index}].${name}`];

  function pick(option: MasterTemplateFactorOption) {
    // The activity sets the line's factor and its unit; the label follows it until someone writes their own.
    onChange({ factorId: option.factorId, factorLabel: option.label, unit: option.unit ?? line.unit,
      ...(line.sourceLabel.trim() === "" || line.sourceLabel === line.factorLabel ? { sourceLabel: option.label } : {}) });
    setQuery(option.label); setSearchOpen(false);
  }

  return <div className="nz-a-master-line" role="group" aria-label={`Line ${index + 1}`}>
    <div className="nz-two">
      <label className="nz-fl"><span>Scope</span>
        <select className="nz-inp" value={line.scope} onChange={(event) => { onChange({ scope: event.target.value as ReportingTemplateScope, categoryCode: "", factorId: null, factorLabel: null }); setQuery(""); }}>
          {SCOPES.map((scope) => <option key={scope} value={scope}>Scope {scope}</option>)}
        </select></label>
      <label className="nz-fl"><span>Category<span className="nz-req">*</span></span>
        <select className="nz-inp" value={line.categoryCode} aria-invalid={field("categoryCode") ? true : undefined}
          onChange={(event) => { onChange({ categoryCode: event.target.value, factorId: null, factorLabel: null }); setQuery(""); }}>
          <option value="">Choose…</option>
          {line.categoryCode && !categories.some((category) => category.code === line.categoryCode) ? <option value={line.categoryCode}>{line.categoryCode} (retired)</option> : null}
          {categories.map((category) => <option key={category.code} value={category.code}>{category.name}</option>)}
        </select>
        {field("categoryCode") ? <span className="nz-a-error" role="alert">{field("categoryCode")}</span> : null}</label>
    </div>
    <div className="nz-fl nz-fast-add-search">
      <label className="nz-fl" style={{ margin: 0 }}>Activity <span className="muted">· smart search</span>
        <input className="nz-inp" role="combobox" aria-expanded={searchOpen} aria-controls={listId} aria-autocomplete="list" value={query}
          disabled={!line.categoryCode} placeholder={line.categoryCode ? "Search this category’s activities…" : "Choose a category first"}
          aria-invalid={field("factorId") ? true : undefined}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setSearchOpen(true); setHighlighted((i) => Math.min(i + 1, results.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setHighlighted((i) => Math.max(i - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); const picked = searchOpen ? results[highlighted] : undefined; if (picked) pick(picked); }
            else if (event.key === "Escape") setSearchOpen(false);
          }}
          // Typing is a search, never an activity: only a pick sets the factor, so typed text clears the one held.
          onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); setHighlighted(0); if (line.factorId) onChange({ factorId: null, factorLabel: null }); }} />
      </label>
      {searchOpen && line.categoryCode ? <ul className="nz-template-results" id={listId} role="listbox">
        {offered.length === 0 ? <li className="nz-template-empty">No activities are filed under this category — leave it as a category shell.</li>
          : results.length === 0 ? <li className="nz-template-empty">No activity matches “{query.trim()}”.</li> : null}
        {results.map((option, at) => <li key={option.factorId}>
          <button type="button" role="option" aria-selected={at === highlighted} className={at === highlighted ? "on" : ""}
            onMouseEnter={() => setHighlighted(at)} onMouseDown={(event) => { event.preventDefault(); pick(option); }}>
            <b>{option.label}</b>{option.unit ? <span className="nz-template-meta">{option.unit}</span> : null}
          </button>
        </li>)}
      </ul> : null}
      {field("factorId") ? <span className="nz-a-error" role="alert">{field("factorId")}</span> : null}
    </div>
    <div className="nz-two">
      <label className="nz-fl"><span>Source label<span className="nz-req">*</span></span>
        <input className="nz-inp" value={line.sourceLabel} maxLength={REPORTING_TEMPLATE_LABEL_MAX} aria-invalid={field("sourceLabel") ? true : undefined} onChange={(event) => onChange({ sourceLabel: event.target.value })} />
        {field("sourceLabel") ? <span className="nz-a-error" role="alert">{field("sourceLabel")}</span> : null}</label>
      <label className="nz-fl"><span>Report label</span>
        <input className="nz-inp" value={line.reportLabel} maxLength={REPORTING_TEMPLATE_LABEL_MAX} placeholder="As the source label" onChange={(event) => onChange({ reportLabel: event.target.value })} /></label>
    </div>
    <div className="nz-two">
      <label className="nz-fl"><span>Unit</span>
        <input className="nz-inp" value={line.unit} maxLength={40} placeholder="From the activity" onChange={(event) => onChange({ unit: event.target.value })} /></label>
      <div className="nz-a-master-line-end"><button type="button" className="nz-a-btn danger" onClick={onRemove} aria-label={`Remove line ${index + 1}`}>Remove</button></div>
    </div>
  </div>;
}
