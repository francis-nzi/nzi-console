"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { orderedRequirements, type SrsFramework, type SrsRequirement } from "@nzi/contracts";
import type { SrsFrameworkHistoryEntry, SrsFrameworkSnapshot, SrsFrameworkState } from "@nzi/isolated-backend";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, NumberField, SelectField, StatusBadge, Switch, TextAreaField, TextField, type DataListColumn,
} from "@nzi/ui";
import { formatDate, formatDateTime } from "../../lib/formatDate";
import { useLocalList } from "../useLocalList";

/**
 * The SRS frameworks (SRS S1, R1; framework rework, Phase B). Each framework — UK SRS S2 — Climate, S1 — General — is
 * locked or unlocked. A locked one is read-only. Unlocking it opens it for editing in the working definition: reword,
 * reweight, set a target, add or retire requirements. Locking it makes the next snapshot, which supersedes the one in force;
 * assessments bind to a snapshot and keep it. Pillars and the ladder are shared, so they change only with every framework
 * unlocked. Every edit, lock and unlock is in the history, with who and when.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
const SNAPSHOT_STATUS: Record<SrsFrameworkSnapshot["status"], string> = { draft: "Working", active: "In force", superseded: "Superseded" };
const failure = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) =>
  result.state === "validation_failed" ? { issues: Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])), problem: result.issues.find((issue) => issue.field === "frameworkKey")?.message ?? null }
    : { issues: {}, problem: result.message };

export function SrsFrameworkBoard({ frameworks, snapshots, history, active, working, editing }: {
  frameworks: SrsFrameworkState[]; snapshots: SrsFrameworkSnapshot[]; history: SrsFrameworkHistoryEntry[];
  active: SrsFramework | null; working: SrsFramework | null; editing: Editing;
}) {
  const router = useRouter();
  const shown = working ?? active;
  const [open, setOpen] = useState<{ requirement: SrsRequirement | null } | null>(null);
  const [ladderOpen, setLadderOpen] = useState(false);
  const [pillarOpen, setPillarOpen] = useState(false);
  const [historyOf, setHistoryOf] = useState<SrsFrameworkState | null>(null);
  const [unlocking, setUnlocking] = useState<SrsFrameworkState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const saved = (message: string) => { setOpen(null); setLadderOpen(false); setPillarOpen(false); setUnlocking(null); setNotice(message); setProblem(null); keys.current = {}; router.refresh(); };
  const unlockedKeys = new Set(working && editing.allowed ? frameworks.filter((framework) => !framework.locked).map((framework) => framework.key) : []);
  const allUnlocked = unlockedKeys.size > 0 && frameworks.every((framework) => unlockedKeys.has(framework.key));
  const pinned = snapshots.reduce((count, snapshot) => count + snapshot.assessments, 0);

  async function run(path: string, body: unknown, step: string, message: (data: never) => string) {
    setBusy(true); setProblem(null);
    const result = await postBrowserCommand<never>(path, body, key(step));
    setBusy(false);
    if (result.state !== "success") { setProblem(failure(result).problem ?? (result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message)); return; }
    saved(message(result.data));
  }

  // Every requirement shown, active or retired, in the order an assessment works through them.
  const requirements = shown ? [...orderedRequirements(shown), ...shown.requirements.filter((requirement) => !requirement.active)] : [];
  const label = (keyValue: string, list: Array<{ key: string; label: string }>) => list.find((entry) => entry.key === keyValue)?.label ?? keyValue;
  const list = useLocalList(requirements, (row) => `${row.code} ${row.title}`, { order: (row) => requirements.indexOf(row), code: (row) => row.code, weight: (row) => row.weight });
  const columns: DataListColumn<SrsRequirement>[] = [
    { key: "code", header: "Code", sortKey: "code", cell: (row) => <span className="nz-a-mono">{row.code}</span> },
    { key: "title", header: "Requirement", cell: (row) => <button type="button" className="nz-a-linkish" onClick={() => setOpen({ requirement: row })}>{row.title}</button> },
    { key: "pillar", header: "Framework · pillar", cell: (row) => `${label(row.standardKey, shown?.standards ?? [])} · ${label(row.pillarKey, shown?.pillars ?? [])}` },
    { key: "weight", header: "Weight", sortKey: "weight", numeric: true, cell: (row) => <span className="nz-a-mono">{row.weight}</span> },
    { key: "target", header: "Target", cell: (row) => `${row.targetMaturity} · ${shown?.maturityLevels.find((level) => level.level === row.targetMaturity)?.label ?? ""}` },
    { key: "source", header: "Answered from", cell: (row) => row.source === "nzi-data" ? "NZI data" : "Consultant" },
    { key: "status", header: "Status", cell: (row) => <StatusBadge active={row.active} /> },
  ];

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Disclosure</div>
        <h1>SRS framework</h1>
        <p>UK SRS S2 — Climate and S1 — General: their pillars, requirements, weights and the five-step maturity ladder every readiness assessment is made against. Unlock a framework to edit it; lock it to make its next snapshot. An assessment is made against a locked snapshot and always keeps it.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="admin.lookups" /></div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>{unlockedKeys.size > 0
        ? <>You are editing the working definition. Nothing changes for assessments until you lock; then new assessments are made against the new snapshot and earlier ones keep their own. New assessments wait while a framework is unlocked.</>
        : <>Every framework is locked and read-only. Unlock one to reword, reweight, add or retire its requirements.</>}
        {editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}

    <section className="nz-a-srs-versions" aria-label="Frameworks">
      {frameworks.map((framework) => <div key={framework.key} className={`nz-a-srs-version ${framework.locked ? "active" : "draft"}`}>
        <b>{framework.label}</b> <span className={`nz-a-srs-status ${framework.locked ? "active" : "draft"}`}>{framework.locked ? "Locked" : "Unlocked"}</span>
        <span className="nz-a-muted"> · {framework.locked ? `snapshot ${framework.snapshotVersion ?? "—"}` : `reopened from snapshot ${framework.snapshotVersion ?? "—"}`}
          {framework.changedAt ? ` · ${framework.locked ? "locked" : "unlocked"} by ${framework.changedByName ?? framework.changedBy} on ${formatDateTime(framework.changedAt)}` : ""}</span>
        <span className="nz-a-srs-publish">
          <button type="button" className="nz-a-btn" onClick={() => setHistoryOf(framework)}>History</button>
          {editing.allowed ? framework.locked
            ? <button type="button" className="nz-a-btn" disabled={busy} onClick={() => setUnlocking(framework)}>Unlock</button>
            : <button type="button" className="nz-a-btn pri" disabled={busy} onClick={() => void run("/api/isolated/srs-framework/lock", { frameworkKey: framework.key, expectedVersion: framework.version }, `lock-${framework.key}`,
              (data: { snapshotVersion: number }) => `${framework.label} locked — snapshot ${data.snapshotVersion} is now in force, and the snapshot before it is superseded.`)}>Lock</button>
            : null}
        </span>
      </div>)}
    </section>

    <section className="nz-a-srs-versions" aria-label="Snapshots">
      {snapshots.map((snapshot) => <div key={snapshot.frameworkId} className={`nz-a-srs-version ${snapshot.status}`}>
        <b>Snapshot {snapshot.version}</b> <span className={`nz-a-srs-status ${snapshot.status}`}>{SNAPSHOT_STATUS[snapshot.status]}</span>
        <span className="nz-a-muted"> · {snapshot.label} · {snapshot.requirements} requirements · {snapshot.assessments} assessment{snapshot.assessments === 1 ? "" : "s"}
          {snapshot.effectiveFrom ? ` · in force from ${formatDate(snapshot.effectiveFrom)}` : ""}</span>
      </div>)}
    </section>

    {unlockedKeys.size > 0 ? <div className="nz-a-srs-actions">
      <button type="button" className="nz-a-btn" onClick={() => setOpen({ requirement: null })}>+ Add requirement</button>
      {allUnlocked ? <>
        <button type="button" className="nz-a-btn" onClick={() => setPillarOpen(true)}>Add or rename a pillar</button>
        <button type="button" className="nz-a-btn" onClick={() => setLadderOpen(true)}>Reword the ladder</button>
      </> : <span className="nz-a-muted">Pillars and the ladder are shared — unlock every framework to change them.</span>}
    </div> : null}

    {shown ? <div className="nz-a-lookups">
      <DataList label={working ? "Requirements — working definition" : `Requirements — snapshot ${shown.version}`} rows={list.rows} rowKey={(row) => row.id} columns={columns}
        search={{ ...list.search, label: "Search requirements", placeholder: "Search by code or wording…" }} filters={[]} onFilter={() => {}}
        sort={list.sort} onSort={list.onSort} paging={list.paging} onPage={list.onPage} onPageSize={list.onPageSize}
        onClear={list.clear} onSelect={(row) => setOpen({ requirement: row })}
        noMatches={<><b>No requirements match</b><span>Clear the search to see them all.</span></>} />
      <p className="nz-a-hint nz-a-caption">The ladder: {shown.maturityLevels.map((level) => `${level.level} ${level.label}`).join(" → ")}. Five fixed steps, 0–4 — the one scale every dial, radar and heatmap reads.</p>
    </div> : <section className="nz-a-state"><h1>No framework is published</h1><p>An organisation is provisioned with the UK SRS frameworks; this one has none to show.</p></section>}

    {open && shown ? <RequirementDrawer key={open.requirement?.id ?? "new"} framework={shown} requirement={open.requirement} unlocked={unlockedKeys}
      history={open.requirement ? history.filter((entry) => entry.subject === open.requirement!.id) : []} onClose={() => setOpen(null)} onSaved={saved} /> : null}
    {ladderOpen && working ? <LadderDrawer framework={working} onClose={() => setLadderOpen(false)} onSaved={saved} /> : null}
    {pillarOpen && working ? <PillarDrawer framework={working} onClose={() => setPillarOpen(false)} onSaved={saved} /> : null}
    {historyOf ? <DrawerEditor open onClose={() => setHistoryOf(null)} eyebrow="SRS framework · history" title={historyOf.label}
      audit={<AuditLine version={historyOf.version}>Append-only: every edit, lock and unlock, with who and when</AuditLine>}
      actions={<button type="button" className="nz-a-btn" onClick={() => setHistoryOf(null)}>Close</button>}>
      <HistoryList entries={history.filter((entry) => entry.frameworkKey === historyOf.key || entry.frameworkKey === null)} />
    </DrawerEditor> : null}
    {unlocking ? <DrawerEditor open onClose={() => setUnlocking(null)} eyebrow="SRS framework · unlock" title={`Unlock ${unlocking.label}`}
      audit={<AuditLine version={unlocking.version}>The unlock is recorded in the history, with who and when</AuditLine>}
      actions={<><button type="button" className="nz-a-btn" onClick={() => setUnlocking(null)}>Cancel</button>
        <button type="button" className="nz-a-btn pri" disabled={busy} onClick={() => void run("/api/isolated/srs-framework/unlock", { frameworkKey: unlocking.key, expectedVersion: unlocking.version }, `unlock-${unlocking.key}`,
          () => `${unlocking.label} unlocked — edit it in the working definition, then lock it to make the next snapshot.`)}>Unlock</button></>}>
      <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>
        {pinned > 0 ? <><b>{pinned} assessment{pinned === 1 ? " is" : "s are"} pinned to {pinned === 1 ? "its" : "their"} snapshot.</b> Editing never changes {pinned === 1 ? "it" : "them"}. </> : null}
        While it is unlocked, no new assessment can be started; lock it again to make the next snapshot.
      </div></div>
    </DrawerEditor> : null}
  </>;
}

function describe(entry: SrsFrameworkHistoryEntry): string {
  const after = entry.after ?? {}, before = entry.before ?? {};
  const code = typeof after.code === "string" ? after.code : entry.subject ?? "";
  switch (entry.event) {
    case "locked": return `Locked — snapshot ${entry.snapshotVersion ?? "—"}`;
    case "unlocked": return `Unlocked — reopened from snapshot ${entry.snapshotVersion ?? "—"}`;
    case "requirement_added": return `Added ${code} · ${String(after.title ?? "")}`;
    case "requirement_retired": return `Retired ${code}`;
    case "requirement_restored": return `Restored ${code}`;
    case "requirement_edited": {
      const changed = [
        before.title !== after.title ? "wording" : null, before.helpText !== after.helpText ? "help" : null,
        before.weight !== after.weight ? `weight ${String(before.weight)} → ${String(after.weight)}` : null,
        before.targetMaturity !== after.targetMaturity ? `target ${String(before.targetMaturity)} → ${String(after.targetMaturity)}` : null,
      ].filter(Boolean);
      return `Edited ${code}${changed.length ? `: ${changed.join(", ")}` : ""}`;
    }
    case "pillar_added": return `Added the pillar ${String(after.label ?? entry.subject)}`;
    case "pillar_renamed": return `Renamed the pillar ${String(before.label ?? entry.subject)} → ${String(after.label ?? "")}`;
    case "ladder_reworded": return `Reworded step ${entry.subject ?? ""} · ${String(after.label ?? "")}`;
    default: return entry.event;
  }
}

function HistoryList({ entries }: { entries: SrsFrameworkHistoryEntry[] }) {
  if (entries.length === 0) return <p className="nz-a-hint">Nothing recorded yet.</p>;
  return <ol className="nz-a-srs-versions" aria-label="History">
    {entries.map((entry) => <li key={entry.historyId} className="nz-a-srs-version">
      <b>{describe(entry)}</b>{entry.frameworkKey === null ? <span className="nz-a-srs-status">Shared</span> : null}
      <span className="nz-a-muted"> · {entry.actorName ?? entry.actorId} · {formatDateTime(entry.at)}</span>
    </li>)}
  </ol>;
}

function RequirementDrawer({ framework, requirement, unlocked, history, onClose, onSaved }: {
  framework: SrsFramework; requirement: SrsRequirement | null; unlocked: ReadonlySet<string>; history: SrsFrameworkHistoryEntry[]; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = requirement === null;
  const choices = framework.standards.filter((standard) => unlocked.has(standard.key));
  const [draft, setDraft] = useState({
    frameworkKey: requirement?.standardKey ?? choices[0]?.key ?? "", pillarKey: requirement?.pillarKey ?? framework.pillars[0]?.key ?? "",
    code: requirement?.code ?? "", title: requirement?.title ?? "", helpText: requirement?.helpText ?? "",
    weight: String(requirement?.weight ?? 1), targetMaturity: String(requirement?.targetMaturity ?? 2), active: requirement?.active ?? true,
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useRef(crypto.randomUUID());

  async function save() {
    setIssues({}); setProblem(null); setSaving(true);
    const result = await postBrowserCommand<{ code: string }>("/api/isolated/srs-framework/requirements", {
      ...(requirement ? { requirementId: requirement.id } : {}), frameworkKey: draft.frameworkKey, pillarKey: draft.pillarKey,
      code: draft.code, title: draft.title, helpText: draft.helpText, weight: Number(draft.weight), targetMaturity: Number(draft.targetMaturity), active: draft.active,
    }, idempotency.current);
    setSaving(false);
    if (result.state !== "success") { const failed = failure(result); setIssues(failed.issues); setProblem(failed.problem ?? (result.state === "validation_failed" ? null : result.message)); return; }
    onSaved(isNew ? `Added ${result.data.code} to the working definition.` : `Saved ${result.data.code} in the working definition.`);
  }

  const readOnly = !unlocked.has(draft.frameworkKey);
  const frameworkLabel = framework.standards.find((standard) => standard.key === draft.frameworkKey)?.label ?? draft.frameworkKey;
  return <DrawerEditor open onClose={onClose} eyebrow={`SRS framework · ${frameworkLabel}${readOnly ? " (locked)" : " (unlocked)"}`}
    title={isNew ? "New requirement" : `${requirement.code} · ${requirement.title}`}
    audit={<AuditLine version={framework.version}>{readOnly ? "This framework is locked — unlock it to change a requirement" : "Every change is recorded in the history"}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <FieldRow>
      <SelectField label="Framework" value={draft.frameworkKey} options={(isNew ? choices : framework.standards).map((standard) => ({ value: standard.key, label: standard.label }))}
        disabled={readOnly || !isNew} error={issues.frameworkKey} onChange={(frameworkKey) => setDraft({ ...draft, frameworkKey })} />
      <SelectField label="Pillar" value={draft.pillarKey} options={framework.pillars.map((pillar) => ({ value: pillar.key, label: pillar.label }))}
        disabled={readOnly || !isNew} error={issues.pillarKey} onChange={(pillarKey) => setDraft({ ...draft, pillarKey })} />
    </FieldRow>
    <TextField label="Code" mono hint={isNew ? "e.g. S2 M5. Fixed once added." : "Fixed — retire it and add a new one to change it."} value={draft.code} maxLength={20}
      readOnly={readOnly || !isNew} error={issues.code} onChange={(code) => setDraft({ ...draft, code })} />
    <TextAreaField label="Requirement" value={draft.title} rows={2} required disabled={readOnly} error={issues.title} onChange={(title) => setDraft({ ...draft, title })} />
    <TextAreaField label="Help" hint="Plain-language help shown beside the requirement while assessing." value={draft.helpText} rows={3} disabled={readOnly}
      onChange={(helpText) => setDraft({ ...draft, helpText })} />
    <FieldRow>
      <NumberField label="Weight" hint="Its share of its pillar's score." value={draft.weight} min={0.1} step={0.5} disabled={readOnly} error={issues.weight}
        onChange={(weight) => setDraft({ ...draft, weight })} />
      <SelectField label="Target" value={draft.targetMaturity} options={framework.maturityLevels.map((level) => ({ value: String(level.level), label: `${level.level} · ${level.label}` }))}
        disabled={readOnly} error={issues.targetMaturity} onChange={(targetMaturity) => setDraft({ ...draft, targetMaturity })} />
    </FieldRow>
    {requirement?.source === "nzi-data" ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>Answered from the client&rsquo;s own verified NZI data ({requirement.nziSourceKey}) rather than asked.</div></div> : null}
    {!isNew ? <Switch label="Active" description="A retired requirement leaves new assessments; assessments already made keep it." checked={draft.active} disabled={readOnly}
      onChange={(active) => setDraft({ ...draft, active })} /> : null}
    {!isNew ? <><div className="nz-a-eyebrow">History</div><HistoryList entries={history} /></> : null}
  </DrawerEditor>;
}

function PillarDrawer({ framework, onClose, onSaved }: { framework: SrsFramework; onClose: () => void; onSaved: (message: string) => void }) {
  const [pillarKey, setPillarKey] = useState("");
  const current = framework.pillars.find((pillar) => pillar.key === pillarKey) ?? null;
  const [draft, setDraft] = useState({ label: "", description: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useRef(crypto.randomUUID());

  async function save() {
    setIssues({}); setProblem(null); setSaving(true);
    const result = await postBrowserCommand<{ label: string; created: boolean }>("/api/isolated/srs-framework/pillars",
      { ...(current ? { pillarKey: current.key } : {}), label: draft.label, description: draft.description }, idempotency.current);
    setSaving(false);
    if (result.state !== "success") { const failed = failure(result); setIssues(failed.issues); setProblem(failed.problem ?? (result.state === "validation_failed" ? null : result.message)); return; }
    onSaved(result.data.created ? `Added the pillar ${result.data.label} to the working definition.` : `Renamed the pillar to ${result.data.label} in the working definition.`);
  }

  return <DrawerEditor open onClose={onClose} eyebrow="SRS frameworks · shared by every framework" title={current ? `Rename ${current.label}` : "Add a pillar"}
    audit={<AuditLine version={framework.version}>Every change is recorded in the history</AuditLine>}
    actions={<><button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button></>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <SelectField label="Pillar" value={pillarKey} options={[{ value: "", label: "A new pillar" }, ...framework.pillars.map((pillar) => ({ value: pillar.key, label: pillar.label }))]}
      onChange={(key) => { setPillarKey(key); const chosen = framework.pillars.find((pillar) => pillar.key === key); setDraft({ label: chosen?.label ?? "", description: chosen?.description ?? "" }); }} />
    <TextField label="Name" value={draft.label} maxLength={60} required error={issues.label} onChange={(label) => setDraft({ ...draft, label })} />
    <TextAreaField label="Description" value={draft.description} rows={3} error={issues.description} onChange={(description) => setDraft({ ...draft, description })} />
  </DrawerEditor>;
}

function LadderDrawer({ framework, onClose, onSaved }: { framework: SrsFramework; onClose: () => void; onSaved: (message: string) => void }) {
  const [levels, setLevels] = useState(framework.maturityLevels.map((level) => ({ ...level })));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<number, string>>({});

  async function save() {
    setProblem(null); setSaving(true);
    try {
      for (const level of levels) {
        const before = framework.maturityLevels.find((entry) => entry.level === level.level)!;
        if (before.label === level.label.trim() && before.definition === level.definition.trim()) continue;
        const result = await postBrowserCommand("/api/isolated/srs-framework/maturity", { level: level.level, label: level.label, definition: level.definition },
          (keys.current[level.level] ??= crypto.randomUUID()));
        if (result.state !== "success") { setProblem(`Step ${level.level}: ${result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message}`); return; }
      }
      onSaved("The ladder's wording is saved in the working definition.");
    } finally { setSaving(false); }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="SRS frameworks · shared by every framework" title="The maturity ladder"
    audit={<AuditLine version={framework.version}>Five fixed steps, 0–4; only their names and definitions change</AuditLine>}
    actions={<><button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button></>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {levels.map((level, index) => <div key={level.level} className="nz-a-srs-step">
      <TextField label={`Step ${level.level}`} value={level.label} maxLength={40} required
        onChange={(label) => setLevels(levels.map((entry, at) => at === index ? { ...entry, label } : entry))} />
      <TextAreaField label="Definition" value={level.definition} rows={2} required
        onChange={(definition) => setLevels(levels.map((entry, at) => at === index ? { ...entry, definition } : entry))} />
    </div>)}
  </DrawerEditor>;
}
