"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { emissionCategoryTaxonomy, V7_IMPORT_SOURCE_SYSTEM, type V7ImportDecision, type V7ImportResolution, type V7ImportRowStatus, type V7ImportScope } from "@nzi/contracts";
import { SmartSearch, type SmartSearchOption } from "@nzi/ui";

/**
 * One row's resolution control (import workbench, Phase 2), inline in the three-way table:
 *   new / needs-mapping — a category (of the row's scope) and a factor that category offers, saved as the row's mapping;
 *   withdrawn           — a confirm: gone from the previous system, so it switches off at ingest;
 *   changed / matched   — nothing to do: the re-plan carries a changed row as it stands.
 * A member of a linked pair resolves here under its own status; its group's carry is `ImportPairCarry`.
 * Each save or clear is one command; nothing here ingests.
 */
type Props = {
  /** The row's own status: a pair member's is the one it has outside the pair. */
  jobId: string; legacyDbId: string; status: Exclude<V7ImportRowStatus, "linked-pair-changed">; scope: V7ImportScope;
  resolution: V7ImportResolution; decision: V7ImportDecision | null; invalid: string | null;
};

export const errorText = (result: BrowserCommandResult<unknown>) => result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ")
  : result.state === "conflict" ? "This row changed since the page loaded. Reload to see the latest." : result.state === "success" ? "" : result.message;
const categoryName = (code: string | null) => emissionCategoryTaxonomy.find((entry) => entry.code === code)?.name ?? code ?? "";

export function ImportResolution({ jobId, legacyDbId, status, scope, resolution, decision, invalid }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState("");
  const [factor, setFactor] = useState("");
  const [options, setOptions] = useState<{ category: string; list: SmartSearchOption[]; notice: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const identity = { jobId, sourceSystem: V7_IMPORT_SOURCE_SYSTEM, legacyDbId };
  const fieldId = `import-${legacyDbId.replace(/[^0-9A-Za-z_-]/g, "-")}`;

  if (resolution === "matched") return <span className="nz-a-hint">—</span>;
  if (resolution === "auto-accepted") return <span className="nz-a-hint" data-resolution="auto-accepted">Accepted — the mapping still holds, so the re-plan carries it.</span>;

  async function run(action: () => Promise<BrowserCommandResult<unknown>>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await action();
      // A refused command is answered: the next click is a new attempt, so it takes a new key. A transport failure keeps it.
      if (result.state === "validation_failed" || result.state === "conflict") key.current = null;
      if (result.state !== "success") { setError(errorText(result)); return; }
      key.current = null; setEditing(false); router.refresh();
    } finally { setBusy(false); }
  }
  async function chooseCategory(code: string) {
    setCategory(code); setFactor(""); setLoadError(null);
    if (!code) { setOptions(null); return; }
    try {
      const response = await fetch(`/api/isolated/import/factors?category=${encodeURIComponent(code)}`, { headers: { Accept: "application/json" } });
      if (!response.ok) { setOptions(null); setLoadError("The category's factors could not be read just now."); return; }
      const body = await response.json() as { options: Array<{ datasetId: string; factorId: string; label: string; unit: string; dataset: string }>; notice: string | null };
      setOptions({ category: code, notice: body.notice,
        list: body.options.map((option) => ({ id: `${option.datasetId}|${option.factorId}`, label: option.label, hint: `${option.unit} · ${option.dataset} · ${option.factorId}` })) });
    } catch { setOptions(null); setLoadError("The category's factors could not be read just now."); }
  }
  const clear = decision ? <button type="button" className="nz-a-btn" disabled={busy}
    onClick={() => void run(() => postBrowserCommand("/api/isolated/import/decisions/clear", { ...identity, expectedDecisionId: decision.decisionId }, key.current ??= crypto.randomUUID()))}>Clear</button> : null;
  const errorLine = error ? <div className="nz-a-error" role="alert">{error}</div> : null;
  const staleLine = resolution === "stale" ? <div className="nz-a-hint" data-resolution="stale">{invalid
    ? `The saved decision no longer stands: ${invalid}`
    : "Decided when the record stood otherwise; it has moved since, so it needs a decision again."}</div> : null;

  if (status === "withdrawn") {
    return <div data-resolution={resolution}>
      {resolution === "resolved" ? <div><span className="nz-a-badge ok">Confirmed off</span> <span className="nz-a-hint">switches off at ingest</span> {clear}</div> : <>
        {staleLine}
        <div className="nz-a-hint">Gone from the previous system — switch off at ingest.</div>
        <button type="button" className="nz-a-btn pri" disabled={busy}
          onClick={() => void run(() => postBrowserCommand("/api/isolated/import/decisions", { ...identity, kind: "withdraw", expectedDecisionId: decision?.decisionId ?? null }, key.current ??= crypto.randomUUID()))}>Confirm withdrawal</button>
      </>}
      {errorLine}
    </div>;
  }

  // new / needs-mapping
  const mapped = resolution === "resolved" && decision?.kind === "map";
  if (mapped && !editing) {
    return <div data-resolution="resolved">
      <div><span className="nz-a-badge ok">Mapped</span> → <span className="nz-a-mono">{decision!.categoryCode}</span> {categoryName(decision!.categoryCode)} · <span className="nz-a-mono">{decision!.factorId}</span></div>
      <button type="button" className="nz-a-btn" disabled={busy} onClick={() => setEditing(true)}>Change</button> {clear}
      {errorLine}
    </div>;
  }
  const [datasetId, factorId] = factor ? factor.split("|") : [null, null];
  return <div data-resolution={resolution}>
    {staleLine}
    <label className="nz-a-field" htmlFor={`${fieldId}-category`}>Category
      <select id={`${fieldId}-category`} value={category} disabled={busy} onChange={(event) => void chooseCategory(event.target.value)}>
        <option value="">Choose a Scope {scope} category</option>
        {emissionCategoryTaxonomy.filter((entry) => entry.scope === scope).map((entry) => <option key={entry.code} value={entry.code}>{entry.name} ({entry.code})</option>)}
      </select>
    </label>
    {loadError ? <div className="nz-a-error" role="alert">{loadError}</div> : null}
    {options && options.category === category ? <>
      <label className="nz-a-field" htmlFor={`${fieldId}-factor`}>Factor</label>
      <SmartSearch id={`${fieldId}-factor`} label={`Factors for ${categoryName(category)}`} options={options.list} value={factor}
        onChange={(id) => setFactor(id)} placeholder="Search the category's factors" disabled={busy} emptyHint="This category offers no active factor." />
      {options.notice ? <div className="nz-a-hint">{options.notice}</div> : null}
    </> : null}
    <button type="button" className="nz-a-btn pri" disabled={busy || !category || !datasetId}
      onClick={() => void run(() => postBrowserCommand("/api/isolated/import/decisions",
        { ...identity, kind: "map", categoryCode: category, datasetId, factorId, expectedDecisionId: decision?.decisionId ?? null }, key.current ??= crypto.randomUUID()))}>Save mapping</button>
    {mapped ? <button type="button" className="nz-a-btn" disabled={busy} onClick={() => setEditing(false)}>Cancel</button> : null}
    {resolution === "stale" ? clear : null}
    {errorLine}
  </div>;
}
