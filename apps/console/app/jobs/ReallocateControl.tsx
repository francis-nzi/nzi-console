"use client";
// Data entry D2 (R4): a reviewer moves a spend line to the category it belongs in. The line is re-filed there, goes back to pending
// review, and the client's allocation map records the move for the line's GL code (else its description) — so the same code routes
// there on the next job. A spend line only: an activity entry belongs where its factor is.
import { useRef, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import { emissionCategoryTaxonomy, isCurrencyUnit, spendCategoryOf, type FactorOption, type ScopeRowReadModel } from "@nzi/contracts";
import { SpendSuggestionCard } from "./SpendSuggestionCard";

export function ReallocateControl({ jobId, row, factors, notice, onMoved }: {
  jobId: string; row: ScopeRowReadModel; factors: FactorOption[];
  notice: (n: { kind: "ok" | "warn"; text: string }) => void; onMoved: () => void;
}) {
  const current = row.categoryCode ?? (/^3\.\d+$/.test(row.scope) ? row.scope : null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [factor, setFactor] = useState("");
  const [busy, setBusy] = useState(false);
  // D2 R5: an AI suggestion the person chose to use — the move confirms it if it lands where the suggestion said.
  const [suggestion, setSuggestion] = useState<{ suggestionId: string; categoryCode: string } | null>(null);
  const key = useRef<string | null>(null);
  if (!isCurrencyUnit(row.unit)) return null;

  const targetScope = target ? spendCategoryOf(target)?.scope : undefined;
  // The line keeps its factor where that can price a line in the new scope; otherwise a spend factor in its currency is chosen.
  const ownFactor = factors.find((option) => option.factorId === row.factorId && option.datasetId === row.datasetId);
  const ownFits = Boolean(targetScope && ownFactor?.scopes.some((tag) => tag.split(".")[0] === targetScope));
  const candidates = targetScope ? factors.filter((option) => option.factorSource === "dataset" && option.activityUnit === row.unit
    && option.scopes.some((tag) => tag.split(".")[0] === targetScope)) : [];
  const needsFactor = Boolean(target) && !ownFits;

  async function move() {
    if (!target || busy || (needsFactor && !factor)) return;
    setBusy(true);
    const chosen = needsFactor ? candidates.find((option) => `${option.datasetId}|${option.factorId}` === factor) : undefined;
    const result = await postBrowserCommand<{ allocation: { created: boolean; key: string } | null }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.id}/reallocate`,
      { expectedVersion: row.version, categoryCode: target, ...(chosen ? { datasetId: chosen.datasetId, factorId: chosen.factorId } : {}),
        ...(suggestion && suggestion.categoryCode === target ? { suggestionId: suggestion.suggestionId } : {}) },
      key.current ??= crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") {
      key.current = null;
      const name = spendCategoryOf(target)?.name ?? target;
      notice({ kind: "ok", text: result.data.allocation
        ? `Moved to ${name}. This client's map now routes ${result.data.allocation.key} there, so it lands there next time.`
        : `Moved to ${name}.` });
      setOpen(false);
      onMoved();
    } else {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ")
        : result.state === "conflict" ? "This entry changed since it was opened. Reload to see the latest." : result.message });
    }
  }

  return <section className="nz-reallocate" aria-label="Move to another category">
    {!open ? <button type="button" className="nz-btn" onClick={() => setOpen(true)}>Move to another category</button> : <>
      <span className="nz-eyebrow">Move this spend line</span>
      <p className="nz-hint">Re-files the line, returns it to pending review, and teaches this client&rsquo;s map, so its GL code (or description) lands in the new category next time.</p>
      {/* D2 R5: for a line the client's map does not know, an AI suggestion — labelled, never applied; the person chooses. */}
      <SpendSuggestionCard jobId={jobId} line={{ glCode: row.columnText ?? null, description: row.sourceLabel }} mode="use"
        onUse={(shown) => { setSuggestion(shown); setTarget(shown.categoryCode); setFactor(""); }} />
      <label className="nz-fl">Category
        <select className="nz-sel" value={target} onChange={(event) => { setTarget(event.target.value); setFactor(""); }}>
          <option value="">Choose a category</option>
          {emissionCategoryTaxonomy.filter((entry) => entry.code !== current).map((entry) => <option key={entry.code} value={entry.code}>{entry.name} ({entry.code})</option>)}
        </select>
      </label>
      {needsFactor ? <label className="nz-fl">Spend factor for {spendCategoryOf(target)?.name}
        <select className="nz-sel" value={factor} onChange={(event) => setFactor(event.target.value)}>
          <option value="">{candidates.length ? "Choose a spend factor" : `No Scope ${targetScope} spend factor in ${row.unit} is selected for this job`}</option>
          {candidates.map((option) => <option key={`${option.datasetId}|${option.factorId}`} value={`${option.datasetId}|${option.factorId}`}>{option.label} · {option.datasetLabel}</option>)}
        </select>
        <span className="nz-hint">Its current factor cannot price a Scope {targetScope} line.</span>
      </label> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button type="button" className="nz-btn" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="nz-btn pri" disabled={busy || !target || (needsFactor && !factor)} onClick={() => void move()}>{busy ? "Moving…" : "Move"}</button>
      </div>
    </>}
  </section>;
}
