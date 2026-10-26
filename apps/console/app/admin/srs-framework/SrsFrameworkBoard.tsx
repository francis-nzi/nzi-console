"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { orderedRequirements, todayInLondon, type SrsFramework, type SrsRequirement } from "@nzi/contracts";
import type { SrsFrameworkVersion } from "@nzi/isolated-backend";
import {
  AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, NumberField, SelectField, StatusBadge, Switch, TextAreaField, TextField, type DataListColumn,
} from "@nzi/ui";
import { formatDate } from "../../lib/formatDate";
import { useLocalList } from "../useLocalList";

/**
 * The SRS framework (SRS S1, R1). The version in force is read-only: a change is a new version. An Admin starts a
 * draft — a copy of the version in force — rewords and reweights its requirements, adds or retires them, rewords the
 * ladder, and publishes it, which supersedes the version before. Earlier versions stay listed, with the assessments
 * made against them, because those assessments still mean what they meant.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
const STATUS_LABEL: Record<SrsFrameworkVersion["status"], string> = { draft: "Draft", active: "In force", superseded: "Superseded" };
const failure = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) =>
  result.state === "validation_failed" ? { issues: Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])), problem: result.issues.find((issue) => issue.field === "frameworkId")?.message ?? null }
    : { issues: {}, problem: result.message };

export function SrsFrameworkBoard({ versions, active, draft, editing }: {
  versions: SrsFrameworkVersion[]; active: SrsFramework | null; draft: SrsFramework | null; editing: Editing;
}) {
  const router = useRouter();
  const shown = draft ?? active;
  const [open, setOpen] = useState<{ requirement: SrsRequirement | null } | null>(null);
  const [ladderOpen, setLadderOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(todayInLondon());
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const saved = (message: string) => { setOpen(null); setLadderOpen(false); setNotice(message); setProblem(null); keys.current = {}; router.refresh(); };
  const editable = Boolean(draft) && editing.allowed;

  async function run(path: string, body: unknown, step: string, message: (data: never) => string) {
    setBusy(true); setProblem(null);
    const result = await postBrowserCommand<never>(path, body, key(step));
    setBusy(false);
    if (result.state !== "success") { setProblem(failure(result).problem ?? (result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message)); return; }
    saved(message(result.data));
  }

  // Every requirement of the framework shown, active or retired, in the order an assessment works through them.
  const requirements = shown ? [...orderedRequirements(shown), ...shown.requirements.filter((requirement) => !requirement.active)] : [];
  const label = (keyValue: string, list: Array<{ key: string; label: string }>) => list.find((entry) => entry.key === keyValue)?.label ?? keyValue;
  const list = useLocalList(requirements, (row) => `${row.code} ${row.title}`, { order: (row) => requirements.indexOf(row), code: (row) => row.code, weight: (row) => row.weight });
  const columns: DataListColumn<SrsRequirement>[] = [
    { key: "code", header: "Code", sortKey: "code", cell: (row) => <span className="nz-a-mono">{row.code}</span> },
    { key: "title", header: "Requirement", cell: (row) => <button type="button" className="nz-a-linkish" onClick={() => setOpen({ requirement: row })}>{row.title}</button> },
    { key: "pillar", header: "Standard · pillar", cell: (row) => `${row.standardKey} · ${label(row.pillarKey, shown?.pillars ?? [])}` },
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
        <p>The UK SRS standards, pillars, requirements, weights and the five-step maturity ladder every readiness assessment is made against. Versioned: a change is a new version, published to supersede the one before, and an assessment always keeps the version it was made against.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {editing.allowed && !draft && active
          ? <button type="button" className="nz-a-btn pri" disabled={busy} onClick={() => void run("/api/isolated/srs-framework", {}, "draft",
            (data: { version: number }) => `Version ${data.version} started as a draft — a copy of the version in force. Edit it, then publish it.`)}>+ Start a new version</button>
          : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>{draft
        ? <>You are editing <b>version {draft.version}</b>, a draft. Nothing changes for assessments until it is published; then new assessments are made against it and earlier ones keep their own version.</>
        : <>The version in force is read-only. Start a new version to reword, reweight, add or retire requirements.</>}
        {editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}

    <section className="nz-a-srs-versions" aria-label="Framework versions">
      {versions.map((version) => <div key={version.frameworkId} className={`nz-a-srs-version ${version.status}`}>
        <b>Version {version.version}</b> <span className={`nz-a-srs-status ${version.status}`}>{STATUS_LABEL[version.status]}</span>
        <span className="nz-a-muted"> · {version.label} · {version.requirements} requirements · {version.assessments} assessment{version.assessments === 1 ? "" : "s"}
          {version.effectiveFrom ? ` · in force from ${formatDate(version.effectiveFrom)}` : ""}</span>
      </div>)}
    </section>

    {draft && editing.allowed ? <div className="nz-a-srs-actions">
      <button type="button" className="nz-a-btn" onClick={() => setOpen({ requirement: null })}>+ Add requirement</button>
      <button type="button" className="nz-a-btn" onClick={() => setLadderOpen(true)}>Reword the ladder</button>
      <span className="nz-a-srs-publish">
        <label>In force from <input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
        <button type="button" className="nz-a-btn pri" disabled={busy} onClick={() => void run("/api/isolated/srs-framework/publish", { frameworkId: draft.frameworkId, effectiveFrom }, "publish",
          (data: { version: number }) => `Version ${data.version} published — it is now in force, and the version before it is superseded.`)}>Publish version {draft.version}</button>
      </span>
    </div> : null}

    {shown ? <div className="nz-a-lookups">
      <DataList label={`Requirements — version ${shown.version}`} rows={list.rows} rowKey={(row) => row.id} columns={columns}
        search={{ ...list.search, label: "Search requirements", placeholder: "Search by code or wording…" }} filters={[]} onFilter={() => {}}
        sort={list.sort} onSort={list.onSort} paging={list.paging} onPage={list.onPage} onPageSize={list.onPageSize}
        onClear={list.clear} onSelect={(row) => setOpen({ requirement: row })}
        noMatches={<><b>No requirements match</b><span>Clear the search to see them all.</span></>} />
      <p className="nz-a-hint nz-a-caption">The ladder: {shown.maturityLevels.map((level) => `${level.level} ${level.label}`).join(" → ")}. Five fixed steps, 0–4 — the one scale every dial, radar and heatmap reads.</p>
    </div> : <section className="nz-a-state"><h1>No framework is published</h1><p>An organisation is provisioned with the UK SRS framework; this one has none to show.</p></section>}

    {open && shown ? <RequirementDrawer key={open.requirement?.id ?? "new"} framework={shown} requirement={open.requirement} editable={editable}
      onClose={() => setOpen(null)} onSaved={saved} /> : null}
    {ladderOpen && draft ? <LadderDrawer framework={draft} onClose={() => setLadderOpen(false)} onSaved={saved} /> : null}
  </>;
}

function RequirementDrawer({ framework, requirement, editable, onClose, onSaved }: {
  framework: SrsFramework; requirement: SrsRequirement | null; editable: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = requirement === null;
  const [draft, setDraft] = useState({
    standardKey: requirement?.standardKey ?? framework.standards[0]?.key ?? "", pillarKey: requirement?.pillarKey ?? framework.pillars[0]?.key ?? "",
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
      frameworkId: framework.frameworkId, ...(requirement ? { requirementId: requirement.id } : {}), standardKey: draft.standardKey, pillarKey: draft.pillarKey,
      code: draft.code, title: draft.title, helpText: draft.helpText, weight: Number(draft.weight), targetMaturity: Number(draft.targetMaturity), active: draft.active,
    }, idempotency.current);
    setSaving(false);
    if (result.state !== "success") { const failed = failure(result); setIssues(failed.issues); setProblem(failed.problem ?? (result.state === "validation_failed" ? null : result.message)); return; }
    onSaved(isNew ? `Added ${result.data.code} to the draft.` : `Saved ${result.data.code} in the draft.`);
  }

  const readOnly = !editable;
  return <DrawerEditor open onClose={onClose} eyebrow={`SRS framework · version ${framework.version}${framework.status === "draft" ? " (draft)" : ""}`}
    title={isNew ? "New requirement" : `${requirement.code} · ${requirement.title}`}
    audit={<AuditLine version={framework.version}>{readOnly ? "Published versions are read-only — start a new version to change one" : "Every change is recorded in the audit log"}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <FieldRow>
      <SelectField label="Standard" value={draft.standardKey} options={framework.standards.map((standard) => ({ value: standard.key, label: standard.label }))}
        disabled={readOnly || !isNew} error={issues.standardKey} onChange={(standardKey) => setDraft({ ...draft, standardKey })} />
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
    {requirement?.source === "nzi-data" ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>Answered from the client&rsquo;s own assured NZI data ({requirement.nziSourceKey}) rather than asked.</div></div> : null}
    {!isNew ? <Switch label="Active" description="A retired requirement leaves new assessments; assessments already made keep it." checked={draft.active} disabled={readOnly}
      onChange={(active) => setDraft({ ...draft, active })} /> : null}
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
        const result = await postBrowserCommand("/api/isolated/srs-framework/maturity", { frameworkId: framework.frameworkId, level: level.level, label: level.label, definition: level.definition },
          (keys.current[level.level] ??= crypto.randomUUID()));
        if (result.state !== "success") { setProblem(`Step ${level.level}: ${result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message}`); return; }
      }
      onSaved("The ladder's wording is saved in the draft.");
    } finally { setSaving(false); }
  }

  return <DrawerEditor open onClose={onClose} eyebrow={`SRS framework · version ${framework.version} (draft)`} title="The maturity ladder"
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
