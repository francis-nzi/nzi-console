"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { PAGE_SIZES, ROLE_CAPABILITY_MATRIX, roleLabels, staffListSpec, staffRoles, todayInLondon, type StaffListQuery, type StaffRole } from "@nzi/contracts";
import type { StaffHistoryEntry, StaffPage, StaffPickers, StaffRates, StaffRow, StaffSignIn } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, DataList, DrawerEditor, FieldRow, NumberField, ProvenanceBadge, SelectField, TextAreaField, TextField, type DataListColumn } from "@nzi/ui";
import { formatDate, formatDateTime } from "../../lib/formatDate";
import { useListNavigation } from "../../lib/useListNavigation";

/**
 * The Team & access screen (admin Phase B, B1): DataList → drawer → audit. A person's name and position are edited; their
 * role is changed and they are deactivated or reinstated with a reason. Never yourself, never the last active admin —
 * the drawer says so before it asks, and the command refuses regardless. Rates appear only with finance.manage.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
const count = new Intl.NumberFormat("en-GB");
const dash = <span className="nz-a-muted">—</span>;
const SIGN_IN: Record<StaffSignIn, string> = { enrolled: "Enrolled", invited: "Invited", expired: "Invitation expired", revoked: "Invitation withdrawn", none: "No invitation on record" };
const STATUS_LABEL = { active: "Active", deactivated: "Deactivated", invited: "Invited", suspended: "Suspended" } as const;

export function TeamBoard({ page, pickers, query, editing, self, activeAdmins, rates }: {
  page: StaffPage; pickers: StaffPickers; query: StaffListQuery; editing: Editing; self: string; activeAdmins: number; rates: boolean;
}) {
  const router = useRouter();
  const nav = useListNavigation(staffListSpec, query, "/admin/team");
  const [open, setOpen] = useState<{ row: StaffRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = query.filters.status?.[0] ?? "";
  const role = query.filters.role?.[0] ?? "";
  const position = query.filters.position?.[0] ?? "";
  const positionLabel = (valueId: string) => pickers.positions.find((option) => option.valueId === valueId)?.label ?? valueId;

  const columns: DataListColumn<StaffRow>[] = [
    { key: "name", header: "Name", sortKey: "name", cell: (row) => <div>
      <button type="button" className="nz-a-linkish" onClick={() => setOpen({ row })}>{row.displayName}</button>{row.userId === self ? <span className="nz-a-muted"> (you)</span> : null}
      {row.email ? <div className="nz-a-sub">{row.email}</div> : null}
    </div> },
    { key: "role", header: "Role", sortKey: "role", cell: (row) => <span className="nz-a-prov">{roleLabels[row.role]}</span> },
    { key: "position", header: "Position", sortKey: "position", cell: (row) => row.positionLabel ? <>{row.positionLabel}{row.positionActive === false ? <span className="nz-a-muted"> (inactive)</span> : null}</> : dash },
    { key: "signIn", header: "Sign-in", cell: (row) => <span className={row.signIn === "enrolled" ? undefined : "nz-a-muted"}>{SIGN_IN[row.signIn]}</span> },
    { key: "source", header: "Source", cell: (row) => <ProvenanceBadge provenance={row.provenance} /> },
    { key: "status", header: "Status", sortKey: "status", cell: (row) => <span className={`nz-a-badge ${row.status === "active" ? "ok" : "off"}`}><i aria-hidden="true" />{STATUS_LABEL[row.status]}</span> },
  ];
  const statusCount = (value: string) => page.filterOptions.status.find((option) => option.value === value)?.count ?? 0;

  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Foundation</div>
        <h1>Team & access</h1>
        <p>The people who sign in to the console, their positions and their roles. Roles resolve against permission matrix v{pickers.matrixVersion ?? "—"}. People are deactivated, never deleted, and stay named on everything they touched.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.users" />
        {editing.allowed ? <button type="button" className="nz-a-btn pri" onClick={() => setOpen({ row: null })}>+ Add a member</button> : null}
      </div>
    </div>

    <div className="nz-a-hint-strip">
      <span aria-hidden="true">i</span>
      <div>A new member starts as <b>Viewer</b>; a role is granted afterwards, with a reason. Nobody changes their own role or deactivates themselves, and the organisation always keeps an active admin ({count.format(activeAdmins)} today). Invitations to sign in are sent from Platform & audit → Access.{editing.allowed ? null : <> <b>{editing.reason}</b></>}</div>
    </div>

    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}

    <div className="nz-a-lookups">
      <DataList
        label="Team"
        rows={page.rows}
        rowKey={(row) => row.userId}
        columns={columns}
        search={{ value: query.search, label: "Search the team", placeholder: "Search by name…", onChange: nav.search }}
        filters={[
          { key: "role", label: "Role", value: role, allLabel: "All roles",
            options: staffRoles.map((value) => ({ value, label: roleLabels[value], count: page.filterOptions.role.find((option) => option.value === value)?.count ?? 0 })) },
          { key: "position", label: "Position", value: position, allLabel: "All positions",
            options: page.filterOptions.position.map((option) => ({ value: option.value, label: option.value ? positionLabel(option.value) : "No position", count: option.count })) },
        ]}
        onFilter={(key, value) => nav.filter(key as "role" | "position", value)}
        extraControls={<div className="nz-a-seg" role="group" aria-label="Show">
          {[["", "Active", statusCount("active")], ["deactivated", "Deactivated", statusCount("deactivated")], ["all", "All", statusCount("active") + statusCount("deactivated")]].map(([value, label, total]) =>
            <button key={String(value)} type="button" aria-pressed={status === value} className={status === value ? "on" : undefined} onClick={() => nav.filter("status", String(value))}>
              {label} <span className="n">{count.format(Number(total))}</span>
            </button>)}
        </div>}
        sort={query.sort}
        onSort={(key) => nav.sort(key as StaffListQuery["sort"]["key"])}
        paging={{ page: page.page, pageCount: page.pageCount, pageSize: page.pageSize, pageSizes: PAGE_SIZES, total: page.total }}
        onPage={nav.page}
        onPageSize={nav.pageSize}
        onClear={query.search || status || role || position ? () => nav.clear({}) : undefined}
        noMatches={page.unfilteredTotal === 0
          ? <><b>No staff yet</b><span>{editing.allowed ? "Add the first member, or import v7’s roster." : "The roster arrives with the v7 staff import."}</span></>
          : <><b>Nobody matches</b><span>Clear the search or the filters — deactivated people are shown under “Deactivated”.</span></>}
        onSelect={(row) => setOpen({ row })}
        busy={nav.pending}
      />
      <p className="nz-a-hint nz-a-caption">Sign-in reflects the latest enrolment invitation; an account set up before invitations existed shows none. Work addresses are shown only here, to admin.users holders.</p>
    </div>

    {open ? <StaffDrawer key={open.row?.userId ?? "new"} row={open.row} pickers={pickers} editing={editing} self={self} activeAdmins={activeAdmins} rates={rates}
      onClose={() => setOpen(null)}
      onSaved={(message) => { setOpen(null); setNotice(message); router.refresh(); }} /> : null}
  </>;
}

type Draft = { displayName: string; email: string; positionValueId: string; role: StaffRole; active: boolean; reason: string };

function StaffDrawer({ row, pickers, editing, self, activeAdmins, rates, onClose, onSaved }: {
  row: StaffRow | null; pickers: StaffPickers; editing: Editing; self: string; activeAdmins: number; rates: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isNew = row === null;
  const [draft, setDraft] = useState<Draft>({
    displayName: row?.named ? row.displayName : "", email: row?.email ?? "", positionValueId: row?.positionValueId ?? "",
    role: row?.role ?? "viewer", active: row ? row.status !== "deactivated" : true, reason: "",
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const key = (step: string) => (keys.current[step] ??= crypto.randomUUID());
  const readOnly = !editing.allowed;
  const isSelf = row?.userId === self;
  const onlyAdmin = row?.role === "admin" && row.status === "active" && activeAdmins <= 1;

  const positionOptions = pickers.positions.filter((option) => option.active || option.valueId === row?.positionValueId)
    .map((option) => ({ value: option.valueId, label: `${option.label}${option.active ? "" : " (inactive)"}` }));
  const roleChanged = row !== null && draft.role !== row.role;
  const deactivating = row !== null && row.status !== "deactivated" && !draft.active;
  const reinstating = row?.status === "deactivated" && draft.active;
  const fieldsChanged = row !== null && (draft.displayName.trim() !== (row.named ? row.displayName : "") || (draft.positionValueId || null) !== row.positionValueId);
  const needsReason = roleChanged || deactivating || reinstating;

  const fail = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) => {
    const own = ["displayName", "email", "positionValueId", "role", "reason"];
    if (result.state === "validation_failed") {
      setIssues(Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])));
      setProblem(result.issues.find((issue) => !own.includes(issue.field))?.message ?? null);
    } else setProblem(result.state === "conflict" ? "This person’s record changed since you opened it. Close the panel and open it again to see the latest." : result.message);
  };

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null);
    const local: Record<string, string> = {};
    if (!draft.displayName.trim()) local.displayName = "A name is required.";
    if (isNew && !draft.email.trim()) local.email = "A work email address is required.";
    if (needsReason && !draft.reason.trim()) local.reason = "Say why — it is recorded in the audit log.";
    if (Object.keys(local).length) { setIssues(local); return; }
    setSaving(true);
    try {
      if (isNew) {
        const result = await postBrowserCommand("/api/isolated/staff", { displayName: draft.displayName, email: draft.email, positionValueId: draft.positionValueId || null }, key("add"));
        if (result.state !== "success") return fail(result);
        return onSaved(`Added ${draft.displayName.trim()} as a Viewer. Grant a role, then invite them from Platform & audit → Access.`);
      }
      const path = `/api/isolated/staff/${encodeURIComponent(row.userId)}`;
      let version = row.version;
      const done: string[] = [];
      if (fieldsChanged) {
        const result = await patchBrowserCommand<{ version: number }>(path, { displayName: draft.displayName, positionValueId: draft.positionValueId || null, expectedVersion: version }, key("update"));
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("details saved");
      }
      if (reinstating) {
        const result = await postBrowserCommandWithReason<{ version: number }>(`${path}/reinstate`, { expectedVersion: version }, key("reinstate"), draft.reason);
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push("reinstated — their existing sign-in works again");
      }
      if (roleChanged) {
        const result = await postBrowserCommandWithReason<{ version: number }>(`${path}/role`, { role: draft.role, expectedVersion: version }, key(`role-${draft.role}`), draft.reason);
        if (result.state !== "success") return fail(result);
        version = result.data.version; done.push(`now ${roleLabels[draft.role]}`);
      }
      if (deactivating) {
        const result = await postBrowserCommandWithReason<{ version: number }>(`${path}/deactivate`, { expectedVersion: version }, key("deactivate"), draft.reason);
        if (result.state !== "success") return fail(result);
        done.push("deactivated — signed out, and gone from the pickers, but still named on everything they touched");
      }
      return onSaved(done.length ? `${draft.displayName.trim()}: ${done.join("; ")}.` : "No changes to save.");
    } finally {
      setSaving(false);
    }
  }

  const capabilitiesOf = (value: StaffRole) => Object.keys(ROLE_CAPABILITY_MATRIX[value]).sort();
  return <DrawerEditor open onClose={onClose} eyebrow="Member of staff" title={isNew ? "Add a member" : row.displayName}
    audit={<AuditLine version={isNew ? "new" : row.version}>{readOnly ? "Read-only here — every change is recorded in the audit log" : undefined}</AuditLine>}
    actions={readOnly ? <button type="button" className="nz-a-btn" onClick={onClose}>Close</button> : <>
      {isNew ? <button type="button" className="nz-a-btn" onClick={onClose}>Cancel</button>
        : <button type="button" className={`nz-a-btn${draft.active ? " danger" : ""}`} disabled={draft.active && (isSelf || onlyAdmin)}
            onClick={() => setDraft({ ...draft, active: !draft.active, reason: "" })}>
          {draft.active ? (row.status === "deactivated" ? "Keep deactivated" : "Deactivate…") : row.status === "deactivated" ? "Reinstate…" : "Keep active"}
        </button>}
      <button type="button" className="nz-a-btn pri" onClick={save} disabled={saving}>{saving ? "Saving…" : deactivating ? "Deactivate" : "Save"}</button>
    </>}>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <TextField label="Name" value={draft.displayName} required maxLength={120} error={issues.displayName} readOnly={readOnly} onChange={(displayName) => setDraft({ ...draft, displayName })} />
    <TextField label="Work email" value={draft.email} required={isNew} maxLength={254} error={issues.email} readOnly={readOnly || !isNew}
      hint={isNew ? "Fixed once added: it is the address sign-in and invitations go to." : "Read-only here — the sign-in address is changed with sign-in, not on the roster."}
      onChange={(email) => setDraft({ ...draft, email })} />
    <SelectField label="Position" value={draft.positionValueId} placeholder="None" options={positionOptions} error={issues.positionValueId} disabled={readOnly}
      hint={pickers.positions.length === 0 ? "No positions yet — they are managed in Lookups." : undefined} onChange={(positionValueId) => setDraft({ ...draft, positionValueId })} />
    {!isNew ? <>
      <SelectField label="Role" value={draft.role} options={staffRoles.map((value) => ({ value, label: roleLabels[value] }))} error={issues.role}
        disabled={readOnly || isSelf || row.status === "deactivated" || onlyAdmin}
        hint={isSelf ? "Your own role is changed by another admin." : row.status === "deactivated" ? "Reinstate them to change their role." : onlyAdmin ? "The only active admin: make someone else an admin before choosing another role." : undefined}
        onChange={(value) => setDraft({ ...draft, role: value as StaffRole })} />
      <div className="nz-a-hint nz-a-mono" aria-label={`What ${roleLabels[draft.role]} can do`}>{capabilitiesOf(draft.role).join(" · ")}</div>
      <FieldRow>
        <TextField label="Sign-in" value={SIGN_IN[row.signIn]} readOnly />
        <TextField label="Source" value={row.provenance === "v7" ? "Imported · v7" : "Added here"} readOnly />
      </FieldRow>
      {isSelf ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>This is you. Your role and your deactivation are another admin’s to change.</div></div> : null}
      {onlyAdmin && !isSelf ? <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div>The organisation’s only active admin: they cannot be deactivated or moved to another role until someone else is an admin.</div></div> : null}
      {needsReason ? <TextAreaField label={deactivating ? "Reason for deactivating" : reinstating ? "Reason for reinstating" : "Reason for the role change"} hint="Required — it is recorded in the audit log."
        value={draft.reason} rows={2} required error={issues.reason} onChange={(reason) => setDraft({ ...draft, reason })} /> : null}
      {rates ? <RatesPanel userId={row.userId} readOnly={readOnly} /> : null}
      <HistoryPanel userId={row.userId} />
    </> : null}
  </DrawerEditor>;
}

function useJson<T>(url: string, refresh: number): { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; data: T } {
  const [result, setResult] = useState<{ state: "loading" } | { state: "failed"; message: string } | { state: "ready"; data: T }>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setResult({ state: "loading" });
    fetch(url, { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => null) as (T & { message?: string }) | null;
      if (!live) return;
      setResult(response.ok && body ? { state: "ready", data: body } : { state: "failed", message: body?.message ?? "It could not be read just now." });
    }).catch(() => { if (live) setResult({ state: "failed", message: "It could not be read just now." }); });
    return () => { live = false; };
  }, [url, refresh]);
  return result;
}

const ACTION_LABEL: Record<string, string> = {
  "staff.added": "Added", "staff.updated": "Details changed", "staff.role.assign": "Role changed", "staff.deactivated": "Deactivated",
  "staff.reinstated": "Reinstated", "staff.imported": "Imported from v7",
};

function HistoryPanel({ userId }: { userId: string }) {
  const history = useJson<{ history: StaffHistoryEntry[] }>(`/api/isolated/staff/${encodeURIComponent(userId)}/history`, 0);
  const describe = (entry: StaffHistoryEntry) => {
    const before = entry.before as { role?: StaffRole } | null, after = entry.after as { role?: StaffRole; changed?: string[] } | null;
    if (entry.action === "staff.role.assign" && before?.role && after?.role) return `${roleLabels[before.role]} → ${roleLabels[after.role]}`;
    if (entry.action === "staff.updated" && after?.changed) return after.changed.map((field) => field === "displayName" ? "name" : field === "positionValueId" ? "position" : field).join(", ");
    return null;
  };
  return <div className="nz-a-section">
    <h3>History</h3>
    {history.state === "loading" ? <p className="nz-a-muted">Reading the audit log…</p>
      : history.state === "failed" ? <p className="nz-a-error" role="alert">The history could not be read — this is not the same as there being none.</p>
      : history.data.history.length === 0 ? <p className="nz-a-muted">No changes recorded on this person yet.</p>
      : <ul className="nz-a-history">{history.data.history.map((entry, index) => <li key={index}>
        <b>{ACTION_LABEL[entry.action] ?? entry.action}</b>{describe(entry) ? <> · {describe(entry)}</> : null}
        <div className="nz-a-sub">{formatDateTime(entry.at)} · {entry.actor}{entry.reason ? <> · “{entry.reason}”</> : null}</div>
      </li>)}</ul>}
  </div>;
}

const rateFormat = (amount: number | null, currency: string) => amount === null ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);

function RatesPanel({ userId, readOnly }: { userId: string; readOnly: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const rates = useJson<StaffRates>(`/api/isolated/staff/${encodeURIComponent(userId)}/rates`, refresh);
  const [form, setForm] = useState<{ correcting: string | null; effectiveFrom: string; cost: string; sell: string; currency: string; reason: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useRef(crypto.randomUUID());
  const amount = (value: string) => value.trim() === "" ? null : Number(value);

  async function submit() {
    if (!form || saving) return;
    setProblem(null); setSaving(true);
    const body = { effectiveFrom: form.effectiveFrom, costPerHour: amount(form.cost), sellPerHour: amount(form.sell), currency: form.currency.trim().toUpperCase() || "GBP", supersedesRateId: form.correcting };
    const path = `/api/isolated/staff/${encodeURIComponent(userId)}/rates`;
    const result = form.correcting ? await postBrowserCommandWithReason(path, body, idempotency.current, form.reason) : await postBrowserCommand(path, body, idempotency.current);
    setSaving(false);
    if (result.state !== "success") { setProblem(result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message); return; }
    idempotency.current = crypto.randomUUID(); setForm(null); setRefresh((value) => value + 1);
  }

  return <div className="nz-a-section">
    <h3>Rates <CapabilityChip capability="finance.manage" /></h3>
    {rates.state === "loading" ? <p className="nz-a-muted">Reading rates…</p>
      : rates.state === "failed" ? <p className="nz-a-error" role="alert">The rates could not be read — this is not the same as there being none.</p>
      : <>
        <p>{rates.data.current ? <>In force today: cost <b>{rateFormat(rates.data.current.costPerHour, rates.data.current.currency)}</b>/h · sell <b>{rateFormat(rates.data.current.sellPerHour, rates.data.current.currency)}</b>/h, from {formatDate(rates.data.current.effectiveFrom)}.</> : "No rate in force today."}</p>
        {rates.data.rates.length ? <ul className="nz-a-history">{rates.data.rates.map((rate) => <li key={rate.rateId} className={rate.supersededBy ? "nz-a-muted" : undefined}>
          From {formatDate(rate.effectiveFrom)}: cost {rateFormat(rate.costPerHour, rate.currency)} · sell {rateFormat(rate.sellPerHour, rate.currency)}{rate.supersededBy ? " — corrected" : ""}
          {!readOnly && !rate.supersededBy && !form ? <> <button type="button" className="nz-a-linkish" onClick={() => setForm({ correcting: rate.rateId, effectiveFrom: rate.effectiveFrom, cost: rate.costPerHour === null ? "" : String(rate.costPerHour), sell: rate.sellPerHour === null ? "" : String(rate.sellPerHour), currency: rate.currency, reason: "" })}>Correct…</button></> : null}
        </li>)}</ul> : null}
        {!readOnly && !form ? <button type="button" className="nz-a-btn" onClick={() => setForm({ correcting: null, effectiveFrom: todayInLondon(), cost: "", sell: "", currency: "GBP", reason: "" })}>+ Rate from a date</button> : null}
        {form ? <div className="nz-a-subform">
          {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
          <FieldRow>
            <TextField label="Applies from" value={form.effectiveFrom} placeholder="YYYY-MM-DD" onChange={(effectiveFrom) => setForm({ ...form, effectiveFrom })} />
            <TextField label="Currency" mono value={form.currency} maxLength={3} onChange={(currency) => setForm({ ...form, currency })} />
          </FieldRow>
          <FieldRow>
            <NumberField label="Cost per hour" value={form.cost} min={0} step={0.01} onChange={(cost) => setForm({ ...form, cost })} />
            <NumberField label="Sell per hour" value={form.sell} min={0} step={0.01} onChange={(sell) => setForm({ ...form, sell })} />
          </FieldRow>
          {form.correcting ? <TextAreaField label="Reason for the correction" hint="Required — the corrected rate is kept, marked corrected." value={form.reason} rows={2} required onChange={(reason) => setForm({ ...form, reason })} /> : null}
          <div><button type="button" className="nz-a-btn pri" disabled={saving} onClick={submit}>{saving ? "Saving…" : form.correcting ? "Record the correction" : "Record the rate"}</button> <button type="button" className="nz-a-btn" onClick={() => { setForm(null); setProblem(null); }}>Cancel</button></div>
        </div> : null}
      </>}
  </div>;
}
