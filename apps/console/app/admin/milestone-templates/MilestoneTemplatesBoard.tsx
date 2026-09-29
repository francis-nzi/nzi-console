"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, postBrowserCommandWithReason, patchBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { MILESTONE_KIND_META, MILESTONE_KINDS, MILESTONE_OFFSET_MAX, type MilestoneKind, type MilestoneTemplateItemInput } from "@nzi/contracts";
import type { MilestoneTemplateCard } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, DrawerEditor, ProvenanceBadge, StatusBadge, Switch, TextAreaField, TextField } from "@nzi/ui";

/**
 * The Milestone templates screen (admin Phase C2; docs/design/admin-prototype.html → Milestone templates): a card per
 * template showing its schedule, and the child-row drawer — one row per milestone kind, each with its label, its
 * offset from the job's anchor, and whether it is scheduled. One template is the default; it moves, never lapses.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type ItemDraft = { included: boolean; label: string; offset: string };
type Draft = { name: string; description: string; items: Record<MilestoneKind, ItemDraft>; makeDefault: boolean; active: boolean; reason: string };
const count = new Intl.NumberFormat("en-GB");
const plural = (n: number, one: string, many = `${one}s`) => `${count.format(n)} ${n === 1 ? one : many}`;

export function MilestoneTemplatesBoard({ templates, editing }: { templates: MilestoneTemplateCard[]; editing: Editing }) {
  const router = useRouter();
  const [open, setOpen] = useState<{ template: MilestoneTemplateCard | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasDefault = templates.some((template) => template.isDefault);

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Delivery</div>
        <h1>Milestone templates</h1>
        <p>Each template sets the three delivery milestones a new job is scheduled from. These drive the Risk traffic-light on clients and jobs.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.templates" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ template: null })}>+ New template</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>Offsets count days from a job’s anchor — the later of its start date and reporting-period start, as v7 counts them. A new job will be scheduled from its job type’s template, else the default, once the milestone command lands; editing a template never moves an existing job’s dates.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {templates.length > 0 && !hasDefault ? <div className="nz-a-hint-strip warn" role="note">
      <span aria-hidden="true">!</span>
      <div><b>No default template yet.</b> A job whose type names no template will have no milestones until one is made the default.</div>
    </div> : null}

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    {templates.length === 0
      ? <div className="nz-a-placeholder"><h2>No milestone templates yet</h2><p>{editing.allowed ? "Add the first one, or import v7’s with the jobs-configuration import." : "Templates arrive with the v7 jobs-configuration import."}</p></div>
      : <ul className="nz-a-mt-grid" aria-label="Milestone templates">
        {templates.map((template) => {
          const scheduled = template.items.filter((item) => item.included);
          return <li key={template.templateId}>
            <button type="button" className={`nz-a-mt-card${template.active ? "" : " inactive"}`} onClick={() => setOpen({ template })}
              aria-label={`${template.name}${template.isDefault ? ", the default" : ""}${template.active ? "" : ", inactive"} — edit`}>
              <span className="nz-a-mt-head">
                <span className="nz-a-mt-ic" aria-hidden="true">⚑</span>
                <span className="nz-a-mt-title"><b>{template.name}</b><span className="nz-a-sub nz-a-mono">{plural(scheduled.length, "milestone")}</span></span>
                {template.isDefault ? <span className="nz-a-badge ok"><i aria-hidden="true" />Default</span> : !template.active ? <StatusBadge active={false} /> : null}
              </span>
              <span className="nz-a-mitems">
                {scheduled.map((item) => <span key={item.kind} className="nz-a-mitem">
                  <span className="k">{MILESTONE_KIND_META[item.kind].mark}</span>
                  <span><b>{item.label}</b><span className="kind">{item.kind}</span></span>
                  <span className="off">+{count.format(item.daysOffset)}d</span>
                </span>)}
              </span>
              <span className="foot">
                {template.jobTypes.length ? plural(template.jobTypes.length, "job type") : "No job types linked"} · {plural(template.jobs, "job")}
                <ProvenanceBadge provenance={template.provenance} />
              </span>
            </button>
          </li>;
        })}
      </ul>}

    {open ? <TemplateDrawer key={open.template?.templateId ?? "new"} template={open.template} hasDefault={hasDefault} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function draftOf(template: MilestoneTemplateCard | null, makeDefault: boolean): Draft {
  const items = Object.fromEntries(MILESTONE_KINDS.map((kind) => {
    const item = template?.items.find((candidate) => candidate.kind === kind);
    return [kind, item
      ? { included: item.included, label: item.label, offset: String(item.daysOffset) }
      : { included: template === null, label: MILESTONE_KIND_META[kind].defaultLabel, offset: "" }];
  })) as Record<MilestoneKind, ItemDraft>;
  return { name: template?.name ?? "", description: template?.description ?? "", items, makeDefault, active: template?.active ?? true, reason: "" };
}

function TemplateDrawer({ template, hasDefault, editing, onClose, onSaved }: {
  template: MilestoneTemplateCard | null; hasDefault: boolean; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = template === null;
  const [draft, setDraft] = useState<Draft>(() => draftOf(template, template?.isDefault ?? false));
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;
  const isDefault = template?.isDefault === true;

  const makingDefault = draft.makeDefault && !isDefault;
  const deactivating = template?.active === true && !draft.active;
  const reinstating = template?.active === false && draft.active;
  const setItem = (kind: MilestoneKind, change: Partial<ItemDraft>) => setDraft({ ...draft, items: { ...draft.items, [kind]: { ...draft.items[kind], ...change } } });

  /** The schedule as the command takes it: every kind that is scheduled, and every kind the template already carries. */
  function schedule(): MilestoneTemplateItemInput[] | Record<string, string> {
    const problems: Record<string, string> = {};
    const items: MilestoneTemplateItemInput[] = [];
    for (const kind of MILESTONE_KINDS) {
      const item = draft.items[kind];
      const stored = template?.items.find((candidate) => candidate.kind === kind);
      if (!item.included && !stored) continue;
      const offsetText = item.offset.trim();
      const offset = offsetText === "" && !item.included && stored ? stored.daysOffset : Number(offsetText);
      if (!Number.isInteger(offset) || offset < 0 || offset > MILESTONE_OFFSET_MAX) problems[`items.${kind}.daysOffset`] = `Whole days, 0–${count.format(MILESTONE_OFFSET_MAX)}.`;
      if (!item.label.trim()) problems[`items.${kind}.label`] = "A label is required.";
      items.push({ kind, label: item.label, daysOffset: offset, included: item.included });
    }
    if (!items.some((item) => item.included)) problems.items = "Schedule at least one milestone.";
    return Object.keys(problems).length ? problems : items;
  }

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["name", "description", "reason"].includes(issue.field) && !issue.field.startsWith("items."))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This template changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const items = schedule();
    const local: Record<string, string> = Array.isArray(items) ? {} : { ...items };
    if (!draft.name.trim()) local.name = "A name is required.";
    if ((makingDefault || deactivating) && !draft.reason.trim()) {
      local.reason = makingDefault ? "Say why this becomes the default — new jobs will be scheduled from it." : "Say why this template is being deactivated — it leaves every picker.";
    }
    if (Object.keys(local).length || !Array.isArray(items)) { setIssues(local); return; }
    const fields = { name: draft.name, description: draft.description.trim() || null, items };
    const fieldsChanged = template !== null && JSON.stringify({ name: template.name, description: template.description, items: template.items })
      !== JSON.stringify({ name: draft.name.trim().replace(/\s+/g, " "), description: fields.description, items: items.map((item) => ({ ...item, label: item.label.trim().replace(/\s+/g, " ") })) });
    setSaving(true);
    try {
      let templateId = template?.templateId ?? "";
      let version = template?.version ?? 1;
      if (isNew) {
        const result = await postBrowserCommand<{ templateId: string; version: number }>("/api/isolated/milestone-templates", fields, key("create"));
        if (result.state !== "success") return fail(result);
        ({ templateId, version } = result.data);
      } else if (fieldsChanged) {
        const result = await patchBrowserCommand<{ version: number }>(`/api/isolated/milestone-templates/${encodeURIComponent(templateId)}`, { ...fields, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version;
      }
      const path = `/api/isolated/milestone-templates/${encodeURIComponent(templateId)}`;
      if (makingDefault) {
        const result = await postBrowserCommandWithReason<{ version: number }>(`${path}/set-default`, { expectedVersion: version }, key("default"), draft.reason);
        if (result.state !== "success") return fail(result);
        version = result.data.version;
        return onSaved(`${isNew ? "Added" : "Saved"} “${draft.name.trim()}”, now the default template.`);
      }
      if (deactivating) {
        const result = await postBrowserCommandWithReason<{ jobs: number; jobTypes: number }>(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        const { jobs, jobTypes } = result.data;
        return onSaved(`Deactivated “${draft.name.trim()}”.${jobs || jobTypes ? ` It still shows on ${[jobTypes ? plural(jobTypes, "job type") : "", jobs ? plural(jobs, "job") : ""].filter(Boolean).join(" and ")}, and is never applied again.` : ""}`);
      }
      if (reinstating) {
        const result = await postBrowserCommand(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Reinstated “${draft.name.trim()}”.`);
      }
      return onSaved(isNew ? `Added the template “${draft.name.trim()}”.` : fieldsChanged ? `Saved “${draft.name.trim()}”.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Milestone template" title={isNew ? "New template" : template.name}
    audit={<AuditLine version={isNew ? "new" : template.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew || isDefault ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${draft.active ? " danger" : ""}`} onClick={() => setDraft({ ...draft, active: !draft.active, makeDefault: false, reason: "" })}>
          {draft.active ? "Deactivate…" : template.active ? "Keep active" : "Reinstate"}
        </button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate template" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Template name" value={draft.name} placeholder="e.g. Standard CRP" required maxLength={120}
      error={issues.name} readOnly={readOnly} onChange={(name) => setDraft({ ...draft, name })} />
    <Switch label="Default template" checked={draft.makeDefault} disabled={readOnly || isDefault || !draft.active}
      description={isDefault ? "This is the default. It moves when another template is made the default — it never lapses, and cannot be deactivated."
        : hasDefault ? "New jobs use this unless their job type sets another. Making it the default replaces the current one." : "New jobs use this unless their job type sets another. There is no default yet."}
      onChange={(makeDefault) => setDraft({ ...draft, makeDefault, reason: "" })} />

    <fieldset className="nz-a-mt-editor" disabled={readOnly}>
      <legend>Milestones · offset from the job’s anchor</legend>
      <div className="nz-a-mitems">
        {MILESTONE_KINDS.map((kind) => {
          const item = draft.items[kind];
          const labelError = issues[`items.${kind}.label`];
          const offsetError = issues[`items.${kind}.daysOffset`];
          return <div key={kind} className={`nz-a-mitem edit${item.included ? "" : " excluded"}`}>
            <span className="k" aria-hidden="true">{MILESTONE_KIND_META[kind].mark}</span>
            <span className="body">
              <input aria-label={`${MILESTONE_KIND_META[kind].defaultLabel} — label`} value={item.label} maxLength={120}
                aria-invalid={labelError ? true : undefined} onChange={(event) => setItem(kind, { label: event.target.value })} />
              <span className="kind">{kind}{item.included ? "" : " · not scheduled"}</span>
              {labelError ? <span className="nz-a-error" role="alert">{labelError}</span> : null}
            </span>
            <span className="off">
              <span aria-hidden="true">+</span>
              <input type="number" inputMode="numeric" min={0} max={MILESTONE_OFFSET_MAX} step={1} value={item.offset}
                aria-label={`${MILESTONE_KIND_META[kind].defaultLabel} — days after the anchor`} aria-invalid={offsetError ? true : undefined}
                onChange={(event) => setItem(kind, { offset: event.target.value })} />
              <span aria-hidden="true">d</span>
              {offsetError ? <span className="nz-a-error" role="alert">{offsetError}</span> : null}
            </span>
            <label className="inc"><input type="checkbox" checked={item.included} onChange={(event) => setItem(kind, { included: event.target.checked })} /> Scheduled</label>
          </div>;
        })}
      </div>
      {issues.items ? <div className="nz-a-error" role="alert">{issues.items}</div> : null}
      <div className="nz-a-hint">The three kinds map to the Risk rule. Each carries its own offset; a kind that is not scheduled is kept, never deleted.</div>
    </fieldset>

    <TextAreaField label="Description" value={draft.description} rows={2} disabled={readOnly} error={issues.description}
      onChange={(description) => setDraft({ ...draft, description })} />
    {!isNew ? <TextField label="Linked job types" readOnly hint="Set on each job type — its drawer names the template a new job of that type starts from."
      value={template.jobTypes.length ? template.jobTypes.map((type) => `${type.name}${type.active ? "" : " (inactive)"}`).join(", ") : "None"} /> : null}
    {!isNew && !isDefault ? <Switch label="Active" description="Inactive templates leave the pickers and are never applied, but still show where they are named." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, makeDefault: false, reason: "" })} /> : null}
    {makingDefault || deactivating ? <TextAreaField label={makingDefault ? "Reason for making this the default" : "Reason for deactivating"} hint="Required — it is recorded in the audit log."
      value={draft.reason} rows={2} required error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
    {template && template.jobs > 0 ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>Recorded on <b>{plural(template.jobs, "job")}</b>. Editing the schedule does not move their dates; it cannot be deleted.</div></div> : null}
  </DrawerEditor>;
}
