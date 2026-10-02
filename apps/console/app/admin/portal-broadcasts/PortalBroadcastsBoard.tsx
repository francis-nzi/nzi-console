"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  instantFromPlatformDateTimeLocal, isAllowedBroadcastLink, PAGE_SIZES, platformDateTimeLocal, PORTAL_BROADCAST_BODY_MAX, PORTAL_BROADCAST_LINK_LABEL_MAX,
  PORTAL_BROADCAST_LINK_URL_MAX, PORTAL_BROADCAST_PHASE_LABELS, PORTAL_BROADCAST_STYLE_LABELS, PORTAL_BROADCAST_STYLES, PORTAL_BROADCAST_TITLE_MAX, portalBroadcastListSpec,
  type PortalBroadcastListQuery, type PortalBroadcastPhase, type PortalBroadcastStyle,
} from "@nzi/contracts";
import type { PortalBroadcastPage, PortalBroadcastRow } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, DataList, DateTimeField, DrawerEditor, FieldRow, SelectField, Switch, TextAreaField, TextField, type DataListColumn } from "@nzi/ui";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * Portal broadcasts (admin Phase F4): DataList → drawer editor → audit. A broadcast is a title and message, a style, an
 * optional link (an https:// address or one of the console's pages, with a label), a window on the platform's London
 * clock (a start, and an end or none — until taken down), and everyone or one client. The portal shows what is live.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = { title: string; body: string; style: PortalBroadcastStyle; linkUrl: string; linkLabel: string; starts: string; ends: string; targetClientId: string; active: boolean; reason: string };
const count = new Intl.NumberFormat("en-GB");
const when = (instant: string | null) => instant === null ? "until taken down" : platformDateTimeLocal(instant).replace("T", " ");
const PHASE_CLASS: Record<PortalBroadcastPhase, string> = { live: "ok", scheduled: "", ended: "", inactive: "" };

export function PortalBroadcastsBoard({ page, targets, query, editing }: {
  page: PortalBroadcastPage; targets: Array<{ clientId: string; name: string }>; query: PortalBroadcastListQuery; editing: Editing;
}) {
  const router = useRouter();
  const nav = useListNavigation(portalBroadcastListSpec, query, "/admin/portal-broadcasts");
  const [open, setOpen] = useState<{ row: PortalBroadcastRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const phase = query.filters.phase?.[0] ?? "";
  const style = query.filters.style?.[0] ?? "";

  const columns: DataListColumn<PortalBroadcastRow>[] = [
    { key: "title", header: "Broadcast", sortKey: "title", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.title}</button>
      <div className="nz-a-sub">{row.targetClientId === null ? "Every portal client" : row.targetClientName ?? row.targetClientId}</div>
    </div> },
    { key: "style", header: "Style", sortKey: "style", cell: (row) => PORTAL_BROADCAST_STYLE_LABELS[row.style] },
    { key: "window", header: "Window (London)", sortKey: "startsAt", cell: (row) => <span className="nz-a-mono">{when(row.startsAt)} → {when(row.endsAt)}</span> },
    { key: "phase", header: "Now", sortKey: "phase", cell: (row) => <span className={`nz-a-badge ${PHASE_CLASS[row.phase]}`}><i aria-hidden="true" />{PORTAL_BROADCAST_PHASE_LABELS[row.phase]}</span> },
  ];
  const phaseCount = (value: string) => page.filterOptions.phase.find((option) => option.value === value)?.count ?? 0;
  const styleOptions = page.filterOptions.style.map((option) => ({ ...option, label: PORTAL_BROADCAST_STYLE_LABELS[option.value as PortalBroadcastStyle] ?? option.label }));

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Client portal</div>
        <h1>Portal broadcasts</h1>
        <p>Notices for the client portal — to every client, or to one. A broadcast shows from its start until its end, or until it is taken down; several can show at once, warnings first.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.settings" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ New broadcast</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>Times are on the platform’s London clock. Taking a broadcast down removes it from the portal at once, whatever its window; it is kept, to put back.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Portal broadcasts"
        rows={page.rows}
        rowKey={(row) => row.broadcastId}
        columns={columns}
        search={{ value: query.search, label: "Search broadcasts", placeholder: "Search by title…", onChange: nav.search }}
        filters={[{ key: "style", label: "Style", value: style, allLabel: "Every style", options: styleOptions }]}
        onFilter={(key, value) => nav.filter(key as "style", value)}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {([["", "All", phaseCount("live") + phaseCount("scheduled") + phaseCount("ended") + phaseCount("inactive")], ["live", "Live", phaseCount("live")],
            ["scheduled", "Scheduled", phaseCount("scheduled")], ["ended", "Ended", phaseCount("ended")], ["inactive", "Taken down", phaseCount("inactive")]] as const).map(([value, label, total]) =>
            <button key={value} type="button" aria-pressed={phase === value} className={phase === value ? "on" : undefined} onClick={() => nav.filter("phase", value)}>
              {label} <span className="n">{count.format(total)}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as PortalBroadcastListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || phase || style ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No broadcasts yet</b><span>{editing.allowed ? "Write the first one." : "Nothing has been broadcast to the portal."}</span></>
          : <><b>No broadcasts match</b><span>Clear the search or the filters to see them all.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
    </div>

    {open ? <BroadcastDrawer key={open.row?.broadcastId ?? "new"} row={open.row} targets={targets} editing={editing}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

function BroadcastDrawer({ row, targets, editing, onClose, onSaved }: {
  row: PortalBroadcastRow | null; targets: Array<{ clientId: string; name: string }>; editing: Editing; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  // A new broadcast starts now (R4); post-dating is allowed.
  const [draft, setDraft] = useState<Draft>({
    title: row?.title ?? "", body: row?.body ?? "", style: row?.style ?? "info", linkUrl: row?.linkUrl ?? "", linkLabel: row?.linkLabel ?? "",
    starts: platformDateTimeLocal(row?.startsAt ?? new Date()), ends: row?.endsAt ? platformDateTimeLocal(row.endsAt) : "", targetClientId: row?.targetClientId ?? "",
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

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field === "startsAt" ? "starts" : issue.field === "endsAt" ? "ends" : issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !["title", "body", "style", "linkUrl", "linkLabel", "startsAt", "endsAt", "targetClientId", "reason"].includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This broadcast changed since you opened it. Close the panel and open it again to see the latest." : result.message);
    keys.current = {};
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const local: Record<string, string> = {};
    const startsAt = instantFromPlatformDateTimeLocal(draft.starts);
    const endsAt = draft.ends.trim() === "" ? null : instantFromPlatformDateTimeLocal(draft.ends);
    const linkUrl = draft.linkUrl.trim() || null;
    const linkLabel = draft.linkLabel.trim() || null;
    if (!draft.title.trim()) local.title = "A title is required.";
    if (!draft.body.trim()) local.body = "A message is required.";
    if (startsAt === null) local.starts = "A start date and time is required.";
    if (draft.ends.trim() !== "" && endsAt === null) local.ends = "Not a date and time — or clear it: until taken down.";
    else if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) local.ends = "The end must be after the start.";
    if (linkUrl !== null && !isAllowedBroadcastLink(linkUrl)) local.linkUrl = "An https:// address, or one of the console's own pages starting with /.";
    if (linkUrl !== null && linkLabel === null) local.linkLabel = "A link needs a label.";
    if (linkUrl === null && linkLabel !== null) local.linkUrl = "A label needs a link — or clear both.";
    if (deactivating && !draft.reason.trim()) local.reason = "Say why this broadcast is being taken down.";
    if (Object.keys(local).length) { setIssues(local); return; }
    const fields = { title: draft.title, body: draft.body, style: draft.style, linkUrl, linkLabel, startsAt: startsAt!, endsAt, targetClientId: draft.targetClientId || null };
    const changed = row !== null && (draft.title.trim() !== row.title || draft.body.trim() !== row.body || draft.style !== row.style || linkUrl !== row.linkUrl
      || linkLabel !== row.linkLabel || startsAt !== new Date(row.startsAt).toISOString() || endsAt !== (row.endsAt === null ? null : new Date(row.endsAt).toISOString())
      || (draft.targetClientId || null) !== row.targetClientId);
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/portal-broadcasts", fields, key("create"));
        if (result.state !== "success") return fail(result);
        return onSaved(`“${draft.title.trim()}” broadcast to ${draft.targetClientId ? targets.find((target) => target.clientId === draft.targetClientId)?.name ?? "one client" : "every portal client"}.`);
      }
      const path = `/api/isolated/portal-broadcasts/${encodeURIComponent(row.broadcastId)}`;
      let version = row.version;
      const done: string[] = [];
      if (changed) {
        const result = await patchBrowserCommand<{ version: number }>(path, { ...fields, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("saved");
      }
      if (reinstating) {
        const result = await postBrowserCommand(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"));
        if (result.state !== "success") return fail(result);
        done.push("put back up");
      } else if (deactivating) {
        const result = await postBrowserCommandWithReason(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        done.push("taken down");
      }
      return onSaved(done.length ? `“${draft.title.trim()}” ${done.join(", ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  return <DrawerEditor open onClose={onClose} eyebrow="Portal broadcast" title={isNew ? "New portal broadcast" : row.title}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Take down" : isNew ? "Broadcast" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Title" value={draft.title} required maxLength={PORTAL_BROADCAST_TITLE_MAX} placeholder="e.g. Planned maintenance" error={issues.title}
      readOnly={readOnly} onChange={(title) => setDraft({ ...draft, title })} />
    <TextAreaField label="Message" value={draft.body} rows={4} required error={issues.body} disabled={readOnly} hint={`Up to ${PORTAL_BROADCAST_BODY_MAX.toLocaleString("en-GB")} characters.`}
      onChange={(body) => setDraft({ ...draft, body })} />
    <FieldRow>
      <SelectField label="Style" value={draft.style} disabled={readOnly} error={issues.style}
        options={PORTAL_BROADCAST_STYLES.map((value) => ({ value, label: PORTAL_BROADCAST_STYLE_LABELS[value] }))} onChange={(style) => setDraft({ ...draft, style: style as PortalBroadcastStyle })} />
      <SelectField label="To" value={draft.targetClientId} placeholder="Every portal client" disabled={readOnly} error={issues.targetClientId}
        options={targets.map((target) => ({ value: target.clientId, label: target.name }))} onChange={(targetClientId) => setDraft({ ...draft, targetClientId })} />
    </FieldRow>
    <FieldRow>
      <DateTimeField label="Starts (London)" value={draft.starts} required disabled={readOnly} error={issues.starts} onChange={(starts) => setDraft({ ...draft, starts })} />
      <DateTimeField label="Ends (London)" value={draft.ends} disabled={readOnly} error={issues.ends} hint="Optional — none keeps it up until it is taken down."
        onChange={(ends) => setDraft({ ...draft, ends })} />
    </FieldRow>
    <FieldRow>
      <TextField label="Link" mono value={draft.linkUrl} maxLength={PORTAL_BROADCAST_LINK_URL_MAX} placeholder="https://… or /portal/…" error={issues.linkUrl} readOnly={readOnly}
        hint="Optional — an https:// address or one of the console's own pages." onChange={(linkUrl) => setDraft({ ...draft, linkUrl })} />
      <TextField label="Link label" value={draft.linkLabel} maxLength={PORTAL_BROADCAST_LINK_LABEL_MAX} placeholder="e.g. Read more" error={issues.linkLabel} readOnly={readOnly}
        onChange={(linkLabel) => setDraft({ ...draft, linkLabel })} />
    </FieldRow>
    {!isNew ? <Switch label="Up" description="Taken down, a broadcast leaves the portal at once; it is kept, to put back." checked={draft.active}
      disabled={readOnly} onChange={(active) => setDraft({ ...draft, active, reason: "" })} /> : null}
    {deactivating ? <TextAreaField label="Reason for taking it down" hint="Required — it is recorded in the audit log." value={draft.reason} rows={2} required
      error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
  </DrawerEditor>;
}
