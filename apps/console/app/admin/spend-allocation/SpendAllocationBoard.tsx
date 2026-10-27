"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  emissionCategoryTaxonomy, spendCategoryOf, vatAppliesByDefault,
  type SpendAllocationKeyKind, type SpendAllocationRow, type SpendAllocationSource,
} from "@nzi/contracts";

type SpendFactor = { datasetId: string; factorId: string; label: string; unit: string; scopes: string[]; dataset: string };
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = { targetCategoryCode: string; vatApplies: boolean; factor: string };

const SOURCE_LABEL: Record<SpendAllocationSource, string> = { admin: "Set in Admin", reallocation: "Learnt from a move at review", "suggestion-confirmed": "Confirmed suggestion" };
const errorText = (result: BrowserCommandResult<unknown>) => result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ")
  : result.state === "conflict" ? "This entry changed since the page loaded. Reload to see the latest." : result.state === "success" ? "" : result.message;
const factorKey = (datasetId: string | null, factorId: string | null) => (datasetId && factorId ? `${datasetId}|${factorId}` : "");

function TargetFields({ draft, setDraft, factors, disabled }: { draft: Draft; setDraft: (next: Draft) => void; factors: SpendFactor[]; disabled: boolean }) {
  const scope = spendCategoryOf(draft.targetCategoryCode)?.scope;
  const fits = factors.filter((factor) => factor.scopes.some((tag) => tag.split(".")[0] === scope));
  return <>
    <label className="nz-a-field">Category
      <select value={draft.targetCategoryCode} disabled={disabled}
        onChange={(event) => setDraft({ targetCategoryCode: event.target.value, vatApplies: vatAppliesByDefault(event.target.value), factor: "" })}>
        {emissionCategoryTaxonomy.map((entry) => <option key={entry.code} value={entry.code}>{entry.name} ({entry.code})</option>)}
      </select>
    </label>
    <label className="nz-a-field nz-a-check"><input type="checkbox" checked={draft.vatApplies} disabled={disabled} onChange={(event) => setDraft({ ...draft, vatApplies: event.target.checked })} /> VAT applies</label>
    <label className="nz-a-field">Default spend factor <span className="nz-a-hint">optional — prices a line that names none</span>
      <select value={draft.factor} disabled={disabled} onChange={(event) => setDraft({ ...draft, factor: event.target.value })}>
        <option value="">None</option>
        {fits.map((factor) => <option key={`${factor.datasetId}|${factor.factorId}`} value={`${factor.datasetId}|${factor.factorId}`}>{factor.label} · {factor.unit} · {factor.dataset}</option>)}
      </select>
    </label>
  </>;
}

/** A client's allocation map (D2, R1): pick a client; add, change, archive and reinstate its entries. Every change is versioned and audited. */
export function SpendAllocationBoard({ clients, client, rows, factors, editing }: {
  clients: Array<{ clientId: string; name: string; entries: number }>; client: { clientId: string; name: string } | null;
  rows: SpendAllocationRow[]; factors: SpendFactor[]; editing: Editing;
}) {
  const router = useRouter();
  const readOnly = !editing.allowed;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ keyKind: SpendAllocationKeyKind; key: string } & Draft>({ keyKind: "gl", key: "", targetCategoryCode: "3.1", vatApplies: true, factor: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>({ targetCategoryCode: "3.1", vatApplies: true, factor: "" });
  const key = useRef<string | null>(null);

  async function run(action: () => Promise<BrowserCommandResult<unknown>>, done: string) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await action();
      if (result.state !== "success") { setError(errorText(result)); return; }
      key.current = null; setNotice(done); setEditingId(null); router.refresh();
    } finally { setBusy(false); }
  }
  const factorFields = (draft: Draft) => {
    const [datasetId, factorId] = draft.factor ? draft.factor.split("|") : [null, null];
    return { targetCategoryCode: draft.targetCategoryCode, vatApplies: draft.vatApplies, defaultDatasetId: datasetId, defaultFactorId: factorId };
  };

  return <section className="nz-a-card nz-a-alloc" aria-labelledby="alloc-title">
    <div className="nz-a-panel-title">
      <h2 id="alloc-title">{client ? `${client.name} — allocation map` : "Choose a client"}</h2>
      <label className="nz-a-field nz-a-alloc-client">Client
        <select value={client?.clientId ?? ""} onChange={(event) => router.push(event.target.value ? `/admin/spend-allocation?client=${encodeURIComponent(event.target.value)}` : "/admin/spend-allocation")}>
          <option value="">Choose a client</option>
          {clients.map((entry) => <option key={entry.clientId} value={entry.clientId}>{entry.name}{entry.entries ? ` (${entry.entries})` : ""}</option>)}
        </select>
      </label>
    </div>
    {error ? <div className="nz-a-error" role="alert">{error}</div> : null}
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}
    {readOnly ? <p className="nz-a-hint nz-a-alloc-pad">{editing.reason}</p> : null}
    {!client ? <p className="nz-a-hint nz-a-alloc-pad">The map is held per client: it learns that client&rsquo;s chart of accounts. Choose one to see and change its entries.</p> : <>
      {readOnly ? null : <div className="nz-a-alloc-add">
        <div className="nz-a-subhead">Add an entry</div>
        <label className="nz-a-field">Match by
          <select value={adding.keyKind} onChange={(event) => setAdding({ ...adding, keyKind: event.target.value as SpendAllocationKeyKind })}>
            <option value="gl">GL code</option><option value="description">Description (no GL codes)</option>
          </select>
        </label>
        <label className="nz-a-field">{adding.keyKind === "gl" ? "GL code" : "Description"}
          <input value={adding.key} maxLength={200} placeholder={adding.keyKind === "gl" ? "7420" : "Pension administration"} onChange={(event) => setAdding({ ...adding, key: event.target.value })} />
        </label>
        <TargetFields draft={adding} setDraft={(next) => setAdding({ ...adding, ...next })} factors={factors} disabled={busy} />
        <button type="button" className="nz-a-btn pri" disabled={busy || !adding.key.trim()}
          onClick={() => void run(() => postBrowserCommand("/api/isolated/spend-allocations",
            { clientId: client.clientId, keyKind: adding.keyKind, key: adding.key, ...factorFields(adding) }, key.current ??= crypto.randomUUID()),
            `${adding.keyKind === "gl" ? "GL code" : "Description"} “${adding.key.trim()}” now routes to ${spendCategoryOf(adding.targetCategoryCode)?.name}.`)
            .then(() => setAdding({ ...adding, key: "" }))}>Add</button>
      </div>}
      {rows.length === 0 ? <p className="nz-a-hint nz-a-alloc-pad">No entries yet. Every spend line for this client lands in PG&amp;S until the map, a reviewer&rsquo;s move, or a confirmed suggestion says otherwise.</p> : (
        <div className="nz-a-alloc-list">
          {rows.map((row) => <div key={row.allocationId} className={`nz-a-alloc-row${row.active ? "" : " archived"}`} data-allocation={row.allocationId}>
            <div className="nz-a-alloc-key"><span className="nz-a-badge">{row.keyKind === "gl" ? "GL" : "Description"}</span> <b>{row.displayKey}</b>
              <div className="nz-a-hint">{SOURCE_LABEL[row.source]} · v{row.version}{row.active ? "" : " · archived"}</div></div>
            {editingId === row.allocationId ? <div className="nz-a-alloc-edit">
              <TargetFields draft={edit} setDraft={setEdit} factors={factors} disabled={busy} />
              <div className="nz-a-alloc-actions">
                <button type="button" className="nz-a-btn" onClick={() => setEditingId(null)}>Cancel</button>
                <button type="button" className="nz-a-btn pri" disabled={busy} onClick={() => void run(() => patchBrowserCommand(`/api/isolated/spend-allocations/${row.allocationId}`,
                  { expectedVersion: row.version, ...factorFields(edit) }, key.current ??= crypto.randomUUID()), `${row.displayKey} now routes to ${spendCategoryOf(edit.targetCategoryCode)?.name}.`)}>Save</button>
              </div>
            </div> : <>
              <div className="nz-a-alloc-target"><b>{spendCategoryOf(row.targetCategoryCode)?.name ?? row.targetCategoryCode}</b> <span className="nz-a-mono">{row.targetCategoryCode}</span>
                <div className="nz-a-hint">{row.vatApplies ? "VAT applies" : "No VAT"}{row.defaultFactorLabel ? ` · default factor: ${row.defaultFactorLabel}` : ""}</div></div>
              {readOnly ? null : <div className="nz-a-alloc-actions">
                {row.active ? <button type="button" className="nz-a-btn" disabled={busy} onClick={() => { setEditingId(row.allocationId); setEdit({ targetCategoryCode: row.targetCategoryCode, vatApplies: row.vatApplies, factor: factorKey(row.defaultDatasetId, row.defaultFactorId) }); }}>Change</button> : null}
                <button type="button" className="nz-a-btn" disabled={busy} onClick={() => void run(() => postBrowserCommand(`/api/isolated/spend-allocations/${row.allocationId}/${row.active ? "archive" : "reinstate"}`,
                  { expectedVersion: row.version }, key.current ??= crypto.randomUUID()), row.active ? `${row.displayKey} archived — it no longer routes lines.` : `${row.displayKey} routes lines again.`)}>{row.active ? "Archive" : "Reinstate"}</button>
              </div>}
            </>}
          </div>)}
        </div>
      )}
    </>}
  </section>;
}
