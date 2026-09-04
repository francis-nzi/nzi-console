"use client";

// NZC-062 — "Add rows from template": a global, fuzzy-matched search across
// the whole job factor library (every selected dataset + client factor,
// every scope/category) — the unscoped power-user path alongside the
// per-category smart-search. A pick creates a prefilled, enabled, pending row
// via the existing scope.row.create (unforked) and the search stays open for
// a multi-add run.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand } from "@nzi/api-client";
import type { FactorOption } from "@nzi/contracts";
import { buildTemplateSearchIndex, searchTemplateIndex, type TemplateSearchResult } from "./templateSearch";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;

export function TemplateSearchBar({ jobId, factors, siteId, siteLabel, onRowCreated, notice }: {
  jobId: string;
  factors: FactorOption[];
  /** Site-as-context (§2, same convention as the accordion): "" = All sites, "none" = Unallocated, else a site id. */
  siteId: string;
  siteLabel: string | null;
  onRowCreated: (rowId: string) => void;
  notice: Notice;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [busy, setBusy] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const index = useMemo(() => buildTemplateSearchIndex(factors), [factors]);
  const results = useMemo(() => searchTemplateIndex(index, query), [index, query]);
  useEffect(() => { setHighlighted(0); }, [query]);

  async function pick(result: TemplateSearchResult) {
    if (busy) return;
    setBusy(true);
    const site = siteId === "" || siteId === "none" ? null : siteId;
    const r = await postBrowserCommand<{ rowId: string }>(
      `/api/isolated/jobs/${jobId}/scope-rows`,
      {
        scope: result.scope,
        categoryCode: result.categoryCode,
        sourceLabel: result.factor.label,
        reportLabel: result.factor.label,
        siteId: site,
        siteLabel: site ? siteLabel : null,
        quantity: null,
        unit: result.factor.activityUnit,
        datasetId: result.factor.datasetId,
        factorId: result.factor.factorId,
        factorVersion: result.factor.datasetVersion,
        factorLabel: result.factor.label,
        qualityTier: null,
        factorSource: result.factor.factorSource,
        clientFactorId: result.factor.clientFactorId,
        isCustomEntry: result.factor.factorSource === "client",
      },
      crypto.randomUUID(),
    );
    setBusy(false);
    if (r.state !== "success") {
      notice({ kind: "warn", text: r.state === "validation_failed" ? r.issues.map((issue) => issue.message).join(" ") : r.message });
      return;
    }
    setAddedCount((count) => count + 1);
    notice({ kind: "ok", text: `${result.factor.label} added to ${result.categoryLabel}. Enter a quantity next.` });
    onRowCreated(r.data.rowId);
    router.refresh();
    // Multi-add: clear the query so the next search starts fresh, keep focus.
    setQuery("");
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlighted((i) => Math.min(i + 1, results.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlighted((i) => Math.max(i - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const picked = results[highlighted]; if (picked) void pick(picked); }
    else if (event.key === "Escape") { setQuery(""); }
  }

  return (
    <div className="nz-fast-add-search" id="template-search">
      <label className="nz-fl" style={{ margin: 0 }}>
        Add rows from template <span className="muted">· whole job factor library</span>
        <input
          ref={inputRef}
          className="nz-inp"
          role="combobox"
          aria-expanded={query.trim().length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          value={query}
          disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search every factor — label, scope, category, dataset…"
        />
      </label>
      {addedCount > 0 && <span className="nz-hint">✓ {addedCount} row{addedCount === 1 ? "" : "s"} added this run.</span>}
      {query.trim() && (
        <ul className="nz-template-results" id={listId} role="listbox">
          {results.length === 0 && <li className="nz-template-empty">No factor matches "{query}".</li>}
          {results.map((result, index) => (
            <li key={`${result.factor.factorSource}:${result.factor.clientFactorId ?? result.factor.datasetId}|${result.factor.factorId}|${result.categoryCode ?? result.scope}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={index === highlighted ? "on" : ""}
                disabled={busy}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => void pick(result)}
              >
                <b>{result.factor.label}</b>
                <span className="nz-template-meta">
                  Scope {result.scope} · {result.categoryLabel} · {result.factor.activityUnit} · {result.factor.datasetName}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
