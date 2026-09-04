"use client";
// UX1b — the CRP scope→category data-entry accordion (NZC-046 / DATA_ENTRY_UX.md §1).
// Behind the `data-entry-accordion` flag. Groups the canonical evidence register
// into collapsed category sections by scope, keeps the exception-first "Needs
// attention" lens as a second view over the same rows, and gives each category a
// slot where its typed adapter (spend / import / commuting / vehicle) is re-homed.
// Reads `listJobApplicableCategories(…, "crm")` for the completeness view — every
// taxonomy category for an included scope, empties shown neutrally.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ApplicableCategory, JobApplicableCategories, ScopeRowReadModel, ScopeRowWriteFields } from "@nzi/contracts";
import { emissionCategoryTaxonomy } from "@nzi/contracts";
import {
  accordionAttentionRows,
  accordionTotals,
  buildDataEntryAccordion,
} from "./dataEntryAccordion";
import { EmissionEntryForm } from "./EmissionEntryForm";
import { emissionEntryDraftToScopeRow, entryUnitsForCategory, type EntryFactorRef } from "./emissionEntryModel";
import { dataEntryAdapterEnabled } from "../lib/featureFlags";

const KIND_NOTE: Record<string, string> = {
  spend: "Spend adapter — ledger value, VAT, GL code & PG&S category. Consultant maps factors and syncs to Scope 3.1.",
  vehicle: "DVLA registration lookup or manual entry (make · model · fuel).",
  travel: "Registration lookup, air, rail & other travel types — lookup or manual.",
  commuting: "By vehicle / registration, mode, or working-from-home — with monthly.",
  fugitive: "Refrigerant top-ups (fugitive). Manual quantity.",
  manual: "Manual activity — quantity & unit, optional monthly.",
};

const scopeColour = (scope: string) => (scope === "1" ? "var(--s1)" : scope === "2" ? "var(--s2)" : "var(--s3)");
const num = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });

export type AccordionLens = "category" | "attention";
export type SiteContextOption = { id: string; label: string };

type Props = {
  jobId: string;
  rows: ScopeRowReadModel[];
  selectedRowId: string;
  /** Open a row in the drawer. `category` is set when the row sits in a category card. */
  onOpenRow: (rowId: string, category?: ApplicableCategory) => void;
  /** Persist a new scope row from the shared capture form. */
  onCreateEntry: (input: ScopeRowWriteFields) => Promise<{ ok: boolean; message?: string }>;
  /** Controlled site-as-context (§2): "" = all sites, "none" = unallocated, else a site id. */
  sites: SiteContextOption[];
  siteId: string;
  onSiteChange: (siteId: string) => void;
  /** Scope-tagged factor set (workspace maps FactorOption → EntryFactorRef). */
  factors: EntryFactorRef[];
  reportingMonths: string[];
  purchasedGoodsCategories: { id: string; name: string }[];
  /** Re-homed typed adapter for a category (spend / import / commuting / vehicle). */
  categoryExtras?: (category: ApplicableCategory) => ReactNode;
  /** Optional controlled lens — lets the command-centre exception buttons switch to "attention". */
  lens?: AccordionLens;
  onLensChange?: (lens: AccordionLens) => void;
};

export function CrpDataEntryAccordion({ jobId, rows, selectedRowId, onOpenRow, onCreateEntry, sites, siteId, onSiteChange, factors, reportingMonths, purchasedGoodsCategories, categoryExtras, lens: lensProp, onLensChange }: Props) {
  const [state, setState] = useState<"loading" | "failed" | "ready">("loading");
  const [applicable, setApplicable] = useState<JobApplicableCategories | null>(null);
  const [lensInternal, setLensInternal] = useState<AccordionLens>("category");
  const lens = lensProp ?? lensInternal;
  const setLens = (next: AccordionLens) => { setLensInternal(next); onLensChange?.(next); };
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [addingCode, setAddingCode] = useState<string | null>(null);
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryError, setEntryError] = useState("");

  const siteContext = { id: siteId === "" || siteId === "none" ? null : siteId, label: sites.find(site => site.id === siteId)?.label ?? null };
  const lookupRegistration = async (registration: string): Promise<import("./emissionEntryModel").RegistrationLookupOutcome> => {
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/vehicle-lookup`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registration }),
      });
      const body = await response.json();
      if (!response.ok) return { ok: false, message: body.message ?? "Vehicle lookup failed — enter it manually." };
      return {
        ok: true,
        make: body.vehicle?.make ?? null,
        fuelType: body.vehicle?.fuelType ?? null,
        suggestedClass: body.suggestedClass ?? "vehicle",
        year: body.vehicle?.yearOfManufacture ?? null,
        factorId: body.factor ? `dataset:${body.factor.datasetId}|${body.factor.factorId}` : null,
        factorLabel: body.factor?.label ?? null,
      };
    } catch {
      return { ok: false, message: "Vehicle lookup failed — enter it manually." };
    }
  };
  const submitEntry = (category: ApplicableCategory) => async (draft: Parameters<typeof emissionEntryDraftToScopeRow>[0]) => {
    if (entryBusy) return;
    setEntryBusy(true); setEntryError("");
    const result = await onCreateEntry(emissionEntryDraftToScopeRow(draft, category, siteContext, factors, reportingMonths));
    setEntryBusy(false);
    if (result.ok) setAddingCode(null);
    else setEntryError(result.message ?? "The entry could not be saved.");
  };

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/applicable-categories`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.categories)) throw new Error();
      setApplicable(body as JobApplicableCategories);
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  if (state === "loading") return <div className="nz-panel" style={{ padding: 16 }} role="status">Loading the category view…</div>;
  if (state === "failed" || !applicable) {
    return (
      <div className="nz-banner warn" role="alert" style={{ margin: 0 }}>
        <div>The category view is unavailable. <button type="button" className="nz-btn" onClick={() => void load()}>Retry</button></div>
      </div>
    );
  }

  const groups = buildDataEntryAccordion(rows, applicable);
  const totals = accordionTotals(groups);
  const attentionRows = accordionAttentionRows(rows);
  const toggle = (code: string) => setOpen(current => {
    const next = new Set(current);
    next.has(code) ? next.delete(code) : next.add(code);
    return next;
  });

  return (
    <section aria-label="Data entry by category" id="data-entry-accordion">
      <div className="nz-acc-tool">
        <label className="nz-fl" style={{ margin: 0, minWidth: 210 }}>Site
          <select className="nz-sel" value={siteId} onChange={event => onSiteChange(event.target.value)} aria-label="Site context for new entries">
            <option value="">All sites</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.label}</option>)}
            <option value="none">Unallocated</option>
          </select>
        </label>
        <span className="hint">{siteId === "" ? "Showing every site. New entries ask for a site." : siteId === "none" ? "New entries are left unallocated." : `New entries are allocated to ${sites.find(site => site.id === siteId)?.label ?? "this site"}.`}</span>
        <div className="nz-seg" role="tablist" aria-label="Data-entry view">
          <button type="button" role="tab" aria-selected={lens === "category"} className={lens === "category" ? "on" : ""} onClick={() => setLens("category")}>By category</button>
          <button type="button" role="tab" aria-selected={lens === "attention"} className={lens === "attention" ? "on" : ""} onClick={() => setLens("attention")}>
            Needs attention <span className="badge att">{totals.needsAttention}</span>
          </button>
        </div>
      </div>

      {lens === "attention" ? (
        <div className="nz-panel" style={{ padding: 0 }}>
          <table className="nz-tbl">
            <thead><tr><th>Source</th><th>Scope</th><th>Site</th><th>Factor</th><th>Review</th></tr></thead>
            <tbody>
              {attentionRows.map(row => (
                <tr key={row.id} tabIndex={0} className={`row${row.id === selectedRowId ? " sel" : ""}`}
                  onClick={() => onOpenRow(row.id)}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenRow(row.id); } }}>
                  <td>{row.sourceLabel}</td>
                  <td>{row.scope}</td>
                  <td>{row.siteLabel ?? "Unallocated"}</td>
                  <td>{row.factorLabel ?? <span className="nz-st nof">No factor</span>}</td>
                  <td><span className={`nz-st ${row.reviewStatus === "approved" ? "done" : row.reviewStatus === "rejected" ? "nof" : "est"}`}>{row.reviewStatus}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {attentionRows.length === 0 ? <div className="nz-table-empty">Nothing needs attention — every enabled row is calculated, has a quality tier and is approved.</div> : null}
        </div>
      ) : (
        <div className="nz-acc">
          {groups.map(group => (
            <div key={group.scope}>
              <div className="nz-acc-scopehead"><span className="sdot" style={{ background: scopeColour(group.scope) }} />{group.label}</div>
              {group.categories.map(entry => {
                const code = entry.category.code;
                const isOpen = open.has(code);
                return (
                  <div key={code} className={`nz-acc-cat${isOpen ? " open" : ""}`} style={{ "--cc": scopeColour(group.scope) } as React.CSSProperties}>
                    <button type="button" className="nz-acc-h" aria-expanded={isOpen} onClick={() => toggle(code)}>
                      <span className="nz-acc-badge">{entry.category.name.slice(0, 1)}</span>
                      <span className="nz-acc-tt">
                        <b>{entry.category.name}
                          {entry.noData ? <span className="nz-chip-mini nodata">no data</span> : entry.needsAttention ? <span className="nz-chip-mini todo">{entry.needsAttention} to do</span> : null}
                        </b>
                        <span className="sum">{entry.entryCount} {entry.entryCount === 1 ? "entry" : "entries"} · {num(entry.tco2e)} tCO₂e</span>
                      </span>
                      <span className="nz-acc-compl"><span className="bar"><i style={{ width: `${entry.completeness}%` }} /></span>{entry.completeness}%</span>
                      <svg className="nz-acc-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                    {isOpen ? (
                      <div className="nz-acc-body">
                        <div className="nz-acc-kindnote">⌁ {KIND_NOTE[entry.category.kind]}</div>
                        {entry.rows.length ? (
                          <div className="nz-table-wrap">
                            <table className="nz-tbl">
                              <thead><tr><th>Source</th><th>Site</th><th className="num">Activity</th><th>Unit</th><th>Factor</th><th className="num">tCO₂e</th><th>Review</th></tr></thead>
                              <tbody>
                                {entry.rows.map(row => (
                                  <tr key={row.id} tabIndex={0} className={`row${row.id === selectedRowId ? " sel" : ""}`}
                                    onClick={() => onOpenRow(row.id, entry.category)}
                                    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenRow(row.id, entry.category); } }}>
                                    <td>{row.sourceLabel}{row.assetIdentifier ? <div className="muted">ID / Ref: {row.assetIdentifier}</div> : null}{row.enabled ? null : <div className="muted">Disabled</div>}</td>
                                    <td>{row.siteLabel ?? "Unallocated"}</td>
                                    <td className="num">{row.quantity ?? "—"}</td>
                                    <td>{row.unit ?? "—"}</td>
                                    <td>{row.factorLabel ?? <span className="nz-st nof">No factor</span>}</td>
                                    <td className="num">{row.overrideTco2e ?? row.calculatedTco2e ?? "—"}</td>
                                    <td><span className={`nz-st ${row.reviewStatus === "approved" ? "done" : row.reviewStatus === "rejected" ? "nof" : "est"}`}>{row.reviewStatus}</span></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="nz-acc-empty">No data yet — shown for completeness. Empty categories are excluded from the report.</div>
                        )}
                        <div className="nz-acc-foot">
                          <button type="button" className="nz-btn pri" aria-expanded={addingCode === code}
                            onClick={() => { setEntryError(""); setAddingCode(addingCode === code ? null : code); }}>
                            {addingCode === code ? "Close" : "+ Add entry"}
                          </button>
                        </div>
                        {addingCode === code ? (
                          <div className="nz-acc-extra">
                            <EmissionEntryForm
                              key={code}
                              category={entry.category}
                              audience="crm"
                              site={{ id: siteContext.id, label: siteContext.label ?? "Unallocated" }}
                              factors={factors.filter(option => option.scope === entry.category.scope)}
                              units={entryUnitsForCategory(entry.category)}
                              reportingMonths={reportingMonths}
                              spendCategories={purchasedGoodsCategories}
                              busy={entryBusy}
                              error={entryError}
                              onCancel={() => setAddingCode(null)}
                              onSubmit={submitEntry(entry.category)}
                              onSaveDraft={submitEntry(entry.category)}
                              onLookupRegistration={lookupRegistration}
                              leanCapture={dataEntryAdapterEnabled("entry-lean-capture")}
                            />
                          </div>
                        ) : null}
                        {categoryExtras ? <div className="nz-acc-extra">{categoryExtras(entry.category)}</div> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {group.unsorted.length ? (
                <div className="nz-acc-cat" style={{ "--cc": "var(--t3)" } as React.CSSProperties}>
                  <button type="button" className="nz-acc-h" aria-expanded={open.has(`unsorted-${group.scope}`)} onClick={() => toggle(`unsorted-${group.scope}`)}>
                    <span className="nz-acc-badge">?</span>
                    <span className="nz-acc-tt"><b>Unsorted<span className="nz-chip-mini todo">{group.unsorted.length}</span></b>
                      <span className="sum">Rows not yet filed under a category — a category is stamped when you next save the row.</span></span>
                    <svg className="nz-acc-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  {open.has(`unsorted-${group.scope}`) ? (
                    <div className="nz-acc-body">
                      <div className="nz-table-wrap">
                        <table className="nz-tbl">
                          <thead><tr><th>Source</th><th>Scope</th><th>Site</th><th>Factor</th><th>Review</th></tr></thead>
                          <tbody>
                            {group.unsorted.map(row => (
                              <tr key={row.id} tabIndex={0} className={`row${row.id === selectedRowId ? " sel" : ""}`}
                                onClick={() => onOpenRow(row.id)}
                                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenRow(row.id); } }}>
                                <td>{row.sourceLabel}</td>
                                <td>{row.scope}</td>
                                <td>{row.siteLabel ?? "Unallocated"}</td>
                                <td>{row.factorLabel ?? <span className="nz-st nof">No factor</span>}</td>
                                <td><span className={`nz-st ${row.reviewStatus === "approved" ? "done" : row.reviewStatus === "rejected" ? "nof" : "est"}`}>{row.reviewStatus}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {groups.length === 0 ? (
            <div className="nz-acc-empty">No scopes are included for this job yet. Select reporting datasets to populate the category view.</div>
          ) : null}
        </div>
      )}
      <p className="nz-hint" style={{ marginTop: 10 }}>{totals.withData} of {totals.categories} categories have data{totals.unsorted ? ` · ${totals.unsorted} row${totals.unsorted === 1 ? "" : "s"} unsorted` : ""}. {emissionCategoryTaxonomy.length}-category GHG taxonomy (NZC-045).</p>
    </section>
  );
}
