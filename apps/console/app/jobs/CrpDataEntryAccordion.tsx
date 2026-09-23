"use client";
// UX1b — the CRP scope→category data-entry accordion (NZC-046 / DATA_ENTRY_UX.md §1).
// Behind the `data-entry-accordion` flag. Groups the canonical evidence register
// into collapsed category sections by scope, keeps the exception-first "Needs
// attention" lens as a second view over the same rows, and gives each category a
// slot where its typed adapter (spend / import / commuting / vehicle) is re-homed.
// Reads `listJobApplicableCategories(…, "crm")` for the completeness view — every
// taxonomy category for an included scope, empties shown neutrally.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ApplicableCategory, FactorOption, JobApplicableCategories, ScopeRowReadModel, ScopeRowWriteFields } from "@nzi/contracts";
import { emissionCategoryTaxonomy } from "@nzi/contracts";
import {
  accordionAttentionRows,
  accordionTotals,
  buildDataEntryAccordion,
} from "./dataEntryAccordion";
import { EmissionEntryForm } from "./EmissionEntryForm";
import type { InputSpecCategory } from "@nzi/contracts";
import { emissionEntryDraftToScopeRow, type EntryFactorRef } from "./emissionEntryModel";
import { dataEntryAdapterEnabled } from "../lib/featureFlags";
import { TemplateSearchBar } from "./TemplateSearchBar";
import { ReuseYearPanel } from "./ReuseYearPanel";
import { Drawer, InfoTip, Tabs, TabPanel, type TabDescriptor } from "@nzi/ui";

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

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;

type Props = {
  /** The governed input spec (NZC-102), loaded server-side. Keyed by category code. */
  specs: Record<string, InputSpecCategory>;
  jobId: string;
  rows: ScopeRowReadModel[];
  selectedRowId: string;
  /** Open a row in the drawer. `category` is set when the row sits in a category card. */
  onOpenRow: (rowId: string, category?: ApplicableCategory) => void;
  /**
   * Open the drawer's type-aware quick-add for one category (v2).
   *
   * The accordion says *which* category the user asked to add to and nothing else: the form, its
   * per-type fields and the save live in the drawer, so there is one heavy-detail surface rather than
   * one here and another there.
   */
  onAddEntry: (category: ApplicableCategory) => void;
  /**
   * The site tab in force, as an id; "" is all sites.
   *
   * Read-only here: the tabs above the surface own the selection, and the rows reaching this component
   * are already narrowed to it. Creating an entry is the drawer's job, so the accordion no longer needs
   * a create callback or a way to change the site.
   */
  sites: SiteContextOption[];
  siteId: string;
  /** Scope-tagged factor set (workspace maps FactorOption → EntryFactorRef). */
  factors: EntryFactorRef[];
  /** NZC-062 — the full job factor library (unmapped), for the template search. */
  libraryFactors: FactorOption[];
  reportingMonths: string[];
  purchasedGoodsCategories: { id: string; name: string }[];
  /**
   * Bulk import / templates for a category (spend / CSV / roll-forward / vehicle
   * / commuting). Returns `null` when the category has none. Opened in a modal
   * from the card's "Import & templates" button (data-entry UX review item 4) —
   * the always-open panels no longer sit in the card body.
   */
  categoryImport?: (category: ApplicableCategory) => { title: string; body: ReactNode } | null;
  /** Optional controlled lens — lets the command-centre exception buttons switch to "attention". */
  lens?: AccordionLens;
  onLensChange?: (lens: AccordionLens) => void;
  notice: Notice;
};

export function CrpDataEntryAccordion({ specs, jobId, rows, selectedRowId, onOpenRow, onAddEntry, sites, siteId, factors, libraryFactors, reportingMonths, purchasedGoodsCategories, categoryImport, lens: lensProp, onLensChange, notice }: Props) {
  const [state, setState] = useState<"loading" | "failed" | "ready">("loading");
  const [applicable, setApplicable] = useState<JobApplicableCategories | null>(null);
  const [lensInternal, setLensInternal] = useState<AccordionLens>("category");
  const lens = lensProp ?? lensInternal;
  const setLens = (next: AccordionLens) => { setLensInternal(next); onLensChange?.(next); };
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [addingCode, setAddingCode] = useState<string | null>(null);
  const [importFor, setImportFor] = useState<{ title: string; body: ReactNode } | null>(null);

  const siteContext = { id: siteId === "" || siteId === "none" ? null : siteId, label: sites.find(site => site.id === siteId)?.label ?? null };

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
        {/* The site selector lives in the page's site tabs now (v2), which filter the whole surface
            rather than only choosing where a new entry lands. A second control here would be a second
            answer to the same question. The lens below stays: it is a different question. */}
        <Tabs
          className="nz-seg"
          ariaLabel="Data-entry view"
          idBase="crp-data-entry"
          value={lens}
          onChange={(id) => setLens(id as AccordionLens)}
          items={[
            { id: "category", label: "By category" },
            { id: "attention", label: <>Needs attention <span className="badge att">{totals.needsAttention}</span></> },
          ] satisfies TabDescriptor[]}
        />
      </div>

      {dataEntryAdapterEnabled("data-entry-fast-add") ? (
        <div className="nz-fast-add" id="fast-add">
          <TemplateSearchBar jobId={jobId} factors={libraryFactors} siteId={siteId} siteLabel={siteContext.label} onRowCreated={() => undefined} notice={notice} />
          <ReuseYearPanel jobId={jobId} onRowsCreated={() => undefined} notice={notice} />
        </div>
      ) : null}

      <TabPanel id="attention" idBase="crp-data-entry" active={lens === "attention"} className="nz-panel" style={{ padding: 0 }}>
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
      </TabPanel>

      <TabPanel id="category" idBase="crp-data-entry" active={lens === "category"} className="nz-acc">
          {groups.map(group => (
            <div key={group.scope}>
              <div className="nz-acc-scopehead"><span className="sdot" style={{ background: scopeColour(group.scope) }} />{group.label}</div>
              {group.categories.map(entry => {
                const code = entry.category.code;
                const isOpen = open.has(code);
                const imp = categoryImport?.(entry.category) ?? null;
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
                          {/* Opens the drawer's type-aware quick-add for this category. The form used to
                              unfold inside the card, which put a tall form between the row list and the
                              next category and gave the page two places heavy detail could live. */}
                          <button type="button" className="nz-btn pri"
                            onClick={() => onAddEntry(entry.category)}>
                            + Add entry
                          </button>
                          {imp ? <button type="button" className="nz-btn" onClick={() => setImportFor(imp)}>Import &amp; templates</button> : null}
                          {KIND_NOTE[entry.category.kind] ? <InfoTip label={`${entry.category.name} — how data entry works`}>{KIND_NOTE[entry.category.kind]}</InfoTip> : null}
                        </div>
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
      </TabPanel>
      <p className="nz-hint" style={{ marginTop: 10 }}>{totals.withData} of {totals.categories} categories have data{totals.unsorted ? ` · ${totals.unsorted} row${totals.unsorted === 1 ? "" : "s"} unsorted` : ""}. {emissionCategoryTaxonomy.length}-category GHG taxonomy (NZC-045).</p>

      <Drawer open={importFor !== null} onClose={() => setImportFor(null)} ariaLabel={importFor?.title ?? "Import & templates"} className="nz-import-modal" dismissOnOutsideClick>
        <div className="nz-import-modal-card">
          <div className="nz-import-modal-h">
            <h2>{importFor?.title}</h2>
            <button type="button" className="nz-btn" aria-label="Close import and templates" onClick={() => setImportFor(null)}>✕</button>
          </div>
          <div className="nz-import-modal-b">{importFor?.body}</div>
        </div>
      </Drawer>
    </section>
  );
}
