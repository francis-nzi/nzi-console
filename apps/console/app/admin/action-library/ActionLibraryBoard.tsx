"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, putBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  strategyControlLevelLabels, strategyControlLevels, strategyScopeLabel, strategyScopes,
  type Lever, type LibraryStrategy, type StrategyControlLevel, type StrategyScope,
} from "@nzi/contracts";
import { useLocalList } from "../useLocalList";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, NumberField, SelectField, StatusBadge, Switch, TextAreaField, TextField,
  type DataListColumn,
} from "@nzi/ui";

/**
 * The action library (Actions A1, R1): the reduction strategies every client's plan draws from, and the levers they are
 * allocated to. Admin-owned (admin.lookups), versioned on every edit, withdrawn rather than deleted — a client plan
 * already holding a strategy keeps it, and a strategy under a withdrawn lever shows under "Other" rather than vanishing.
 * Two short lists, read whole and searched here.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Tab = "strategies" | "levers";
const count = new Intl.NumberFormat("en-GB");
const errorOf = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) =>
  result.state === "validation_failed" ? { issues: Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])), problem: null }
    : { issues: {}, problem: result.state === "conflict" ? "This changed since you opened it. Close the panel and open it again to see the latest." : result.message };

export function ActionLibraryBoard({ strategies, levers, heldBy, editing }: {
  strategies: LibraryStrategy[]; levers: Lever[]; heldBy: Record<string, number>; editing: Editing;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("strategies");
  const [openStrategy, setOpenStrategy] = useState<{ row: LibraryStrategy | null } | null>(null);
  const [openLever, setOpenLever] = useState<{ row: Lever | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const leverTitle = useMemo(() => new Map(levers.map((lever) => [lever.id, lever.title])), [levers]);
  const saved = (message: string) => { setOpenStrategy(null); setOpenLever(null); setNotice(message); router.refresh(); };

  const strategyList = useLocalList(strategies, (row) => `${row.title} ${row.key} ${row.leverIds.map((id) => leverTitle.get(id) ?? "").join(" ")}`,
    { title: (row) => row.title.toLowerCase(), control: (row) => strategyControlLevels.indexOf(row.controlLevel), held: (row) => heldBy[row.id] ?? 0 });
  const leverList = useLocalList(levers, (row) => `${row.title} ${row.key}`, { ordering: (row) => row.ordering, title: (row) => row.title.toLowerCase() });
  const under = (leverId: string) => strategies.filter((strategy) => strategy.leverIds.includes(leverId)).length;

  const strategyColumns: DataListColumn<LibraryStrategy>[] = [
    { key: "title", header: "Strategy", sortKey: "title", cell: (row) => <button type="button" className="nz-a-linkish" onClick={() => setOpenStrategy({ row })}>{row.title}</button> },
    { key: "levers", header: "Levers", cell: (row) => row.leverIds.length ? row.leverIds.map((id) => leverTitle.get(id) ?? id).join(" · ") : <span className="nz-a-muted">None</span> },
    { key: "scope", header: "Scope", cell: (row) => strategyScopeLabel(row.scope) },
    { key: "control", header: "Control", sortKey: "control", cell: (row) => strategyControlLevelLabels[row.controlLevel].split(" · ")[0] },
    { key: "held", header: "On plans", sortKey: "held", numeric: true, cell: (row) => <span className={`nz-a-mono${heldBy[row.id] ? "" : " nz-a-muted"}`}>{count.format(heldBy[row.id] ?? 0)}</span> },
    { key: "version", header: "Version", numeric: true, cell: (row) => <span className="nz-a-mono">v{row.version}</span> },
    { key: "status", header: "Status", cell: (row) => <StatusBadge active={row.active} /> },
  ];
  const leverColumns: DataListColumn<Lever>[] = [
    { key: "ordering", header: "Order", sortKey: "ordering", numeric: true, cell: (row) => <span className="nz-a-mono">{row.ordering}</span> },
    { key: "title", header: "Lever", sortKey: "title", cell: (row) => <button type="button" className="nz-a-linkish" onClick={() => setOpenLever({ row })}>{row.title}</button> },
    { key: "key", header: "Key", cell: (row) => <span className="nz-a-mono">{row.key}</span> },
    { key: "under", header: "Strategies", numeric: true, cell: (row) => <span className="nz-a-mono">{count.format(under(row.id))}</span> },
    { key: "version", header: "Version", numeric: true, cell: (row) => <span className="nz-a-mono">v{row.version ?? 1}</span> },
    { key: "status", header: "Status", cell: (row) => <StatusBadge active={row.active} /> },
  ];

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Reduction plans</div>
        <h1>Action library</h1>
        <p>The reduction strategies every client&rsquo;s plan is built from, and the levers they sit under. One catalogue, versioned on every edit; a strategy is withdrawn, never deleted, and stays on the plans that hold it.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => tab === "strategies" ? setOpenStrategy({ row: null }) : setOpenLever({ row: null })}>
          {tab === "strategies" ? "+ Add strategy" : "+ Add lever"}</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>Consultants add these to a client&rsquo;s plan, or write something bespoke for one client. Changing a strategy here changes it on every plan that holds it — the plan reads the library&rsquo;s wording.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    <nav className="nz-a-catbar" aria-label="Action library">
      {([["strategies", "Strategies", strategies.length], ["levers", "Levers", levers.length]] as const).map(([value, label, total]) =>
        <button key={value} type="button" className={`nz-a-cat${tab === value ? " on" : ""}`} aria-pressed={tab === value} onClick={() => setTab(value)}>
          {label}<span className="n">{count.format(total)}</span></button>)}
    </nav>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      {tab === "strategies"
        ? <DataList label="Strategies" rows={strategyList.rows} rowKey={(row) => row.id} columns={strategyColumns}
          search={{ ...strategyList.search, label: "Search strategies", placeholder: "Search strategies or levers…" }} filters={[]} onFilter={() => {}}
          sort={strategyList.sort} onSort={strategyList.onSort} paging={strategyList.paging} onPage={strategyList.onPage} onPageSize={strategyList.onPageSize}
          onClear={strategyList.clear} onSelect={(row) => setOpenStrategy({ row })}
          noMatches={strategyList.unfiltered === 0 ? <><b>No strategies yet</b><span>Add the first one to offer it to every client.</span></> : <><b>No strategies match</b><span>Clear the search to see them all.</span></>} />
        : <DataList label="Levers" rows={leverList.rows} rowKey={(row) => row.id} columns={leverColumns}
          search={{ ...leverList.search, label: "Search levers", placeholder: "Search levers…" }} filters={[]} onFilter={() => {}}
          sort={leverList.sort} onSort={leverList.onSort} paging={leverList.paging} onPage={leverList.onPage} onPageSize={leverList.onPageSize}
          onClear={leverList.clear} onSelect={(row) => setOpenLever({ row })}
          noMatches={leverList.unfiltered === 0 ? <><b>No levers yet</b><span>Add a lever before allocating strategies to it.</span></> : <><b>No levers match</b><span>Clear the search to see them all.</span></>} />}
    </div>

    {openStrategy ? <StrategyDrawer key={openStrategy.row?.id ?? "new"} row={openStrategy.row} levers={levers} held={openStrategy.row ? heldBy[openStrategy.row.id] ?? 0 : 0}
      editing={editing} onClose={() => setOpenStrategy(null)} onSaved={saved} /> : null}
    {openLever ? <LeverDrawer key={openLever.row?.id ?? "new"} row={openLever.row} under={openLever.row ? under(openLever.row.id) : 0}
      editing={editing} onClose={() => setOpenLever(null)} onSaved={saved} /> : null}
  </>;
}

function StrategyDrawer({ row, levers, held, editing, onClose, onSaved }: {
  row: LibraryStrategy | null; levers: Lever[]; held: number; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const readOnly = !editing.allowed;
  const [draft, setDraft] = useState({
    key: row?.key ?? "", title: row?.title ?? "", description: row?.description ?? "", scope: (row?.scope ?? "2") as StrategyScope,
    controlLevel: (row?.controlLevel ?? "direct_control") as StrategyControlLevel, iconKey: row?.iconKey ?? "target", leverIds: row?.leverIds ?? [] as string[],
  });
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  // A withdrawn lever is offered only where the strategy already sits under it.
  const offered = levers.filter((lever) => lever.active || draft.leverIds.includes(lever.id));
  const toggleLever = (id: string) => setDraft({ ...draft, leverIds: draft.leverIds.includes(id) ? draft.leverIds.filter((value) => value !== id) : [...draft.leverIds, id] });

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null); setSaving(true);
    try {
      if (withdrawing && row) {
        if (!reason.trim()) { setIssues({ reason: "Say why it is being withdrawn — no consultant can offer it after this." }); return; }
        const result = await putBrowserCommandWithReason<{ heldByClients: number }>("/api/isolated/reduction-strategies", { strategyId: row.id, expectedVersion: row.version, reason }, key("withdraw"), reason);
        if (result.state !== "success") { const failed = errorOf(result); setIssues(failed.issues); setProblem(failed.problem); return; }
        return onSaved(`Withdrew “${row.title}”.${result.data.heldByClients ? ` It stays on the ${result.data.heldByClients} plan${result.data.heldByClients === 1 ? "" : "s"} that hold it.` : ""}`);
      }
      const result = await postBrowserCommand<{ version: number }>("/api/isolated/reduction-strategies",
        { ...(row ? { strategyId: row.id, expectedVersion: row.version } : {}), ...draft }, key("save"));
      if (result.state !== "success") { const failed = errorOf(result); setIssues(failed.issues); setProblem(failed.problem); return; }
      return onSaved(isNew ? `Added “${draft.title.trim()}” to the library.` : `Saved “${draft.title.trim()}” — now version ${result.data.version}.`);
    } finally { setSaving(false); }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Action library · strategy" title={isNew ? "New strategy" : row.title}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew || !row.active ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${withdrawing ? "" : " danger"}`} onClick={() => { setWithdrawing(!withdrawing); setReason(""); }}>{withdrawing ? "Keep it" : "Withdraw…"}</button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : withdrawing ? "Withdraw strategy" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {row && !row.active ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>Withdrawn — no longer offered, and kept on the <b>{count.format(held)}</b> plan{held === 1 ? "" : "s"} that hold it.</div></div> : null}
    <TextField label="Title" value={draft.title} required maxLength={200} error={issues.title} readOnly={readOnly} onChange={(title) => setDraft({ ...draft, title })} />
    <FieldRow>
      <TextField label="Key" mono hint="Lower-case, unique; how imports and seeds find it." value={draft.key} required maxLength={60} error={issues.key} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, key: value })} />
      <TextField label="Icon" mono hint="An NZI icon name." value={draft.iconKey} required maxLength={40} error={issues.iconKey} readOnly={readOnly} onChange={(iconKey) => setDraft({ ...draft, iconKey })} />
    </FieldRow>
    <TextAreaField label="Description" value={draft.description} rows={2} error={issues.description} disabled={readOnly} onChange={(description) => setDraft({ ...draft, description })} />
    <FieldRow>
      <SelectField label="Scope" value={draft.scope} options={strategyScopes.map((value) => ({ value, label: strategyScopeLabel(value) }))} error={issues.scope} disabled={readOnly}
        onChange={(scope) => setDraft({ ...draft, scope: scope as StrategyScope })} />
      <SelectField label="How much the client controls" value={draft.controlLevel} options={strategyControlLevels.map((value) => ({ value, label: strategyControlLevelLabels[value] }))}
        error={issues.controlLevel} disabled={readOnly} onChange={(controlLevel) => setDraft({ ...draft, controlLevel: controlLevel as StrategyControlLevel })} />
    </FieldRow>
    <fieldset className="nz-a-checks" aria-describedby="strategy-levers-hint">
      <legend>Levers</legend>
      {offered.map((lever) => <label key={lever.id}><input type="checkbox" checked={draft.leverIds.includes(lever.id)} disabled={readOnly} onChange={() => toggleLever(lever.id)} />
        {lever.title}{lever.active ? null : <span className="nz-a-muted"> (withdrawn)</span>}</label>)}
      <small id="strategy-levers-hint" className="nz-a-hint">At least one — a plan is grouped by lever, and a strategy under none would show only under &ldquo;Other&rdquo;.</small>
      {issues.leverIds ? <div className="nz-a-error" role="alert">{issues.leverIds}</div> : null}
    </fieldset>
    {withdrawing ? <TextAreaField label="Reason for withdrawing" hint="Required — it is recorded in the audit log." value={reason} rows={2} required error={issues.reason} onChange={setReason} /> : null}
    {!isNew && held > 0 && row.active ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>On <b>{count.format(held)}</b> client plan{held === 1 ? "" : "s"}. An edit here changes it there too; withdrawing keeps it there but stops it being offered.</div></div> : null}
  </DrawerEditor>;
}

function LeverDrawer({ row, under, editing, onClose, onSaved }: {
  row: Lever | null; under: number; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const readOnly = !editing.allowed;
  const [draft, setDraft] = useState({ key: row?.key ?? "", title: row?.title ?? "", iconKey: row?.iconKey ?? "target", ordering: row ? String(row.ordering) : "" });
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const ordering = draft.ordering.trim() === "" ? undefined : Number(draft.ordering);
    if (ordering !== undefined && !Number.isInteger(ordering)) { setIssues({ ordering: "Order is a whole number." }); return; }
    setSaving(true);
    try {
      if (withdrawing && row) {
        if (!reason.trim()) { setIssues({ reason: "Say why it is being withdrawn." }); return; }
        const result = await putBrowserCommandWithReason<{ strategiesUnder: number }>("/api/isolated/reduction-levers", { leverId: row.id, expectedVersion: row.version ?? 1, reason }, key("withdraw"), reason);
        if (result.state !== "success") { const failed = errorOf(result); setIssues(failed.issues); setProblem(failed.problem); return; }
        return onSaved(`Withdrew the “${row.title}” lever.${result.data.strategiesUnder ? ` Its ${result.data.strategiesUnder} strateg${result.data.strategiesUnder === 1 ? "y keeps" : "ies keep"} the allocation.` : ""}`);
      }
      const result = await postBrowserCommand<{ version: number }>("/api/isolated/reduction-levers",
        { ...(row ? { leverId: row.id, expectedVersion: row.version ?? 1 } : {}), key: draft.key, title: draft.title, iconKey: draft.iconKey, ordering }, key("save"));
      if (result.state !== "success") { const failed = errorOf(result); setIssues(failed.issues); setProblem(failed.problem); return; }
      return onSaved(isNew ? `Added the “${draft.title.trim()}” lever.` : `Saved “${draft.title.trim()}” — now version ${result.data.version}.`);
    } finally { setSaving(false); }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Action library · lever" title={isNew ? "New lever" : row.title}
    audit={<AuditLine version={isNew ? "new" : row.version ?? 1}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew || !row.active ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${withdrawing ? "" : " danger"}`} onClick={() => { setWithdrawing(!withdrawing); setReason(""); }}>{withdrawing ? "Keep it" : "Withdraw…"}</button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : withdrawing ? "Withdraw lever" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Title" value={draft.title} required maxLength={120} error={issues.title} readOnly={readOnly} onChange={(title) => setDraft({ ...draft, title })} />
    <FieldRow>
      <TextField label="Key" mono value={draft.key} required maxLength={60} error={issues.key} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, key: value })} />
      <TextField label="Icon" mono value={draft.iconKey} required maxLength={40} error={issues.iconKey} readOnly={readOnly} onChange={(iconKey) => setDraft({ ...draft, iconKey })} />
    </FieldRow>
    <NumberField label="Order" hint={isNew ? "Blank: after the last lever. A client's plan is grouped in this order." : "A client's plan is grouped in this order."}
      value={draft.ordering} min={0} step={1} error={issues.ordering} disabled={readOnly} onChange={(ordering) => setDraft({ ...draft, ordering })} />
    {withdrawing ? <TextAreaField label="Reason for withdrawing" hint="Required — it is recorded in the audit log." value={reason} rows={2} required error={issues.reason} onChange={setReason} /> : null}
    {!isNew ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div><b>{count.format(under)}</b> strateg{under === 1 ? "y sits" : "ies sit"} under this lever.{row.active ? " Withdrawing keeps their allocation; a plan shows a strategy with no live lever under “Other”." : " It is withdrawn."}</div></div> : null}
    {row && !row.active ? <Switch label="Active" description="Withdrawn levers are not offered for new allocations." checked={false} disabled onChange={() => {}} /> : null}
  </DrawerEditor>;
}
