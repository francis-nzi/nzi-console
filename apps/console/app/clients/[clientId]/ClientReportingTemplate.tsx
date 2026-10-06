"use client";

// Redesign Phase 1c (0159) — the client's reporting template: what the client reports, year to year, held on the
// Client. Scopes → categories → lines; a line with no category is "to file" (it came from v7's history, which carries
// none) and is never guessed. A version is the whole template — every save, initialise or withdraw writes the next one.
import { useRef, useState } from "react";
import { Collapsible, GatedButton } from "@nzi/ui";
import { postBrowserCommand, postBrowserCommandWithReason, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { groupReportingTemplateLines, type ReportingTemplateLineInput, type ReportingTemplateScope } from "@nzi/contracts";
import type { ClientWorkspaceReadModel, JobScreenReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

type Template = ClientWorkspaceReadModel["reportingTemplate"];
const SCOPES: ReportingTemplateScope[] = ["1", "2", "3"];
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;
const originText = (template: NonNullable<Template["current"]>) =>
  template.origin === "manual" ? "set by hand" : `${template.origin === "v7-import" ? "imported from v7 history on" : "initialised from"} ${template.originJobNumber ?? "a job"}`;

/** The card on the Overview: the template in force, grouped scope → category → line, or how to start one. */
export function ReportingTemplateCard({ template, access, onEdit, onInitialise }: {
  template: Template; access: EditAccess; onEdit: () => void; onInitialise: () => void;
}) {
  const current = template.current;
  const toFile = current?.lines.filter((line) => line.categoryCode === null).length ?? 0;
  const canEdit = access.state === "allowed";
  return <Collapsible className="nz-panel nz-collapsible-card nz-reporting-template" headingClassName="nz-card-h"
    title={<><span className="eyebrow">Reporting</span><h2>Reporting template</h2></>}
    count={current ? `${current.lines.length} line${current.lines.length === 1 ? "" : "s"}${toFile ? ` · ${toFile} to file` : ""}` : "None set"}>
    <div className="nz-card-b">
      {current
        ? <p className="sub">Version {current.version} · {originText(current)} · {current.setBy}, {formatDate(current.setAt)}. Each year&rsquo;s job captures these lines; quantities stay on the job.</p>
        : <p className="sub">No reporting template yet. It holds what this client reports each year — scopes, categories and the lines under them — so a new job starts from it rather than from a blank page.</p>}
      {canEdit ? <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
        <button type="button" className="nz-editlink" onClick={onInitialise}>Initialise from a job…</button>
        <button type="button" className="nz-editlink" onClick={onEdit}>{current ? "Edit lines" : "Set it up by hand"}</button>
      </div> : null}
    </div>
    {current ? groupReportingTemplateLines(current.lines).map((group) => <div key={group.scope} className="nz-card-b" style={{ paddingTop: 0 }}>
      <div className="nz-sect"><span className={`nz-scope-sw s${group.scope}`} aria-hidden="true" /> Scope {group.scope}</div>
      {group.categories.map((category) => <div key={category.categoryCode ?? "to-file"} style={{ marginBottom: 8 }}>
        <div className="k" style={{ fontWeight: 600 }}>{category.categoryCode === null ? <span className="nz-st est">To file</span> : category.categoryName ?? category.categoryCode}</div>
        {category.lines.map((line) => <div key={line.lineId} className="nz-kv">
          <span className="k">{line.sourceLabel}{line.reportLabel && line.reportLabel !== line.sourceLabel ? <span className="muted"> · reports as {line.reportLabel}</span> : null}</span>
          <span className="v muted">{[line.siteName, line.factorLabel, line.unit].filter(Boolean).join(" · ") || "—"}</span>
        </div>)}
      </div>)}
    </div>) : null}
  </Collapsible>;
}

type EditableLine = ReportingTemplateLineInput & { key: string; siteName: string | null; factorLabel: string | null };

/** The editor: the whole template, line by line — the next version on Save. Withdraw is here too, with a reason. */
export function ReportingTemplateForm({ clientId, template, access, onClose, onSaved }: {
  clientId: string; template: Template; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [lines, setLines] = useState<EditableLine[]>(() => (template.current?.lines ?? []).map((line) => ({
    key: line.lineId, scope: line.scope, categoryCode: line.categoryCode, sourceLabel: line.sourceLabel, reportLabel: line.reportLabel,
    siteId: line.siteId, datasetId: line.datasetId, factorId: line.factorId, unit: line.unit, siteName: line.siteName, factorLabel: line.factorLabel,
  })));
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useRef<string | null>(null);
  const path = `/api/isolated/clients/${encodeURIComponent(clientId)}/reporting-template`;

  const update = (key: string, patch: Partial<EditableLine>) => setLines((all) => all.map((line) => line.key === key ? { ...line, ...patch } : line));
  const add = () => setLines((all) => [...all, { key: crypto.randomUUID(), scope: "1", categoryCode: null, sourceLabel: "", reportLabel: null, siteId: null, datasetId: null, factorId: null, unit: null, siteName: null, factorLabel: null }]);
  const problem = lines.length === 0 ? "Add a line — to clear the template, withdraw it." : lines.some((line) => !line.sourceLabel.trim()) ? "Every line needs a source label." : null;

  async function save() {
    setPending(true); setError(null);
    idempotency.current ??= crypto.randomUUID();
    const body = { expectedVersion: template.latestVersion, lines: lines.map(({ key: _key, siteName: _site, factorLabel: _factor, ...line }) => ({ ...line, sourceLabel: line.sourceLabel.trim(), reportLabel: line.reportLabel?.trim() || null })) };
    const result = await putBrowserCommand<{ version: number }>(path, body, idempotency.current);
    setPending(false);
    if (result.state === "success") onSaved("Reporting template saved.");
    else { setError(errorText(result)); idempotency.current = null; }
  }
  async function withdraw() {
    setPending(true); setError(null);
    const result = await postBrowserCommandWithReason<{ version: number }>(`${path}/deactivate`, { expectedVersion: template.latestVersion }, crypto.randomUUID(), reason.trim());
    setPending(false);
    if (result.state === "success") onSaved("Reporting template withdrawn — kept in the record.");
    else setError(errorText(result));
  }

  const blockedReason = access.state !== "allowed" ? access.reason : problem;
  return <>
    <div className="nz-dh"><div className="k">Reporting</div><h3>Reporting template</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="sub">Saving writes the next version; the one before stays in the record. A line &ldquo;to file&rdquo; has no category yet — choose one when you know it.</p>
      {lines.map((line, index) => {
        const options = template.categories.filter((category) => category.scope === line.scope);
        return <fieldset key={line.key} className="nz-template-line" aria-label={`Line ${index + 1}`} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div className="nz-two">
            <label className="nz-fl"><span>Scope</span>
              <select className="nz-inp" value={line.scope} onChange={(e) => update(line.key, { scope: e.target.value as ReportingTemplateScope, categoryCode: null })}>
                {SCOPES.map((scope) => <option key={scope} value={scope}>Scope {scope}</option>)}
              </select></label>
            <label className="nz-fl"><span>Category</span>
              <select className="nz-inp" value={line.categoryCode ?? ""} onChange={(e) => update(line.key, { categoryCode: e.target.value || null })}>
                <option value="">To file</option>
                {line.categoryCode && !options.some((option) => option.code === line.categoryCode) ? <option value={line.categoryCode}>{line.categoryCode} (retired)</option> : null}
                {options.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
              </select></label>
          </div>
          <div className="nz-two">
            <label className="nz-fl"><span>Source label<span className="nz-req">*</span></span><input className="nz-inp" value={line.sourceLabel} maxLength={200} onChange={(e) => update(line.key, { sourceLabel: e.target.value })} /></label>
            <label className="nz-fl"><span>Report label</span><input className="nz-inp" value={line.reportLabel ?? ""} maxLength={200} placeholder="As the source label" onChange={(e) => update(line.key, { reportLabel: e.target.value || null })} /></label>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="sub" style={{ flex: 1 }}>{[line.siteName, line.factorLabel, line.unit].filter(Boolean).join(" · ") || "No site or factor"}</span>
            <button type="button" className="nz-editlink" onClick={() => setLines((all) => all.filter((item) => item.key !== line.key))} aria-label={`Remove line ${index + 1}`}>Remove</button>
          </div>
        </fieldset>;
      })}
      <button type="button" className="nz-btn" onClick={add}>Add a line</button>
      {withdrawing ? <label className="nz-fl" style={{ marginTop: 10 }}><span>Why withdraw it? <span className="muted">· kept in the audit trail</span></span>
        <input className="nz-inp" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label> : null}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      {template.current && access.state === "allowed"
        ? withdrawing
          ? <button type="button" className="nz-btn" disabled={pending || !reason.trim()} onClick={() => void withdraw()}>Withdraw template</button>
          : <button type="button" className="nz-btn" onClick={() => { setWithdrawing(true); setReason(""); }}>Withdraw…</button>
        : null}
      <span className="sp" />
      {withdrawing ? null : <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : "Save template"}</GatedButton>}
    </div>
  </>;
}

/** Initialise from a job: the job's enabled rows become the next version. v7 history comes in "to file". */
export function ReportingTemplateInitialiseForm({ clientId, template, jobs, access, onClose, onSaved }: {
  clientId: string; template: Template; jobs: JobScreenReadModel[]; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const crp = jobs.filter((job) => job.header.family === "crp").sort((a, b) => b.header.number.localeCompare(a.header.number));
  const [jobId, setJobId] = useState(crp[0]?.header.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function initialise() {
    setPending(true); setError(null);
    const result = await postBrowserCommand<{ version: number; lineCount: number; jobNumber: string; archivedSitesDropped: number }>(
      `/api/isolated/clients/${encodeURIComponent(clientId)}/reporting-template/initialise`, { expectedVersion: template.latestVersion, jobId }, crypto.randomUUID());
    setPending(false);
    if (result.state === "success") onSaved(`Reporting template initialised from ${result.data.jobNumber}: ${result.data.lineCount} line${result.data.lineCount === 1 ? "" : "s"}${result.data.archivedSitesDropped ? ` — archived sites were left off ${result.data.archivedSitesDropped} of them` : ""}.`);
    else setError(errorText(result));
  }

  const blockedReason = access.state !== "allowed" ? access.reason : !jobId ? "Choose a job." : null;
  return <>
    <div className="nz-dh"><div className="k">Reporting</div><h3>Initialise from a job</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="sub">The job&rsquo;s enabled entries become the template&rsquo;s lines — one per distinct activity, with its category, labels, site and factor. Entries imported from v7 have no category, so they come in &ldquo;to file&rdquo;. {template.current ? "This writes a new version; the current one stays in the record." : ""}</p>
      {crp.length === 0
        ? <p className="sub">This client has no CRP jobs to build from.</p>
        : <label className="nz-fl"><span>Job</span>
          <select className="nz-inp" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            {crp.map((job) => <option key={job.header.id} value={job.header.id}>{job.header.number} · {job.header.title}{job.header.reportingYear ? ` · FY${job.header.reportingYear}` : ""}</option>)}
          </select></label>}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      <span className="sp" />
      <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Initialising…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void initialise()}>{pending ? "Initialising…" : "Initialise template"}</GatedButton>
    </div>
  </>;
}
