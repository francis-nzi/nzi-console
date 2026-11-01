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
  accordionKeysForRow,
  buildDataEntryAccordion,
  scopeHasNoData,
  scopeOpenByDefault,
  scopeSummary,
  visibleAccordionRows,
} from "./dataEntryAccordion";
import { formatQuantity, formatTco2e } from "../lib/formatNumber";
import { EmissionEntryForm } from "./EmissionEntryForm";
import type { InputSpecCategory } from "@nzi/contracts";
import { emissionEntryDraftToScopeRow, type EntryFactorRef } from "./emissionEntryModel";
import { JobTemplateSeeding } from "./JobTemplateSeeding";
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
const num = formatTco2e;

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
  reportingMonths: string[];
  purchasedGoodsCategories: { id: string; name: string }[];
  /**
   * Bulk import / templates for a category (spend / CSV / roll-forward / vehicle
   * / commuting). Returns `null` when the category has none. Opened in a modal
   * from the card's "Import & templates" button (data-entry UX review item 4) —
   * the always-open panels no longer sit in the card body.
   */
  categoryImport?: (category: ApplicableCategory) => { title: string; body: ReactNode } | null;
  /**
   * Phase 3d (JW-12 fold): a source-writing category's own Sources view — its per-entity register records and roll-ups — opened
   * like Import & templates. `null` for a category whose adapters write no sources. `done` closes the view — opening a source's
   * row hands over to the detail drawer.
   */
  categorySources?: (category: ApplicableCategory, done: () => void) => { title: string; body: ReactNode } | null;
  /**
   * A row to bring into view — set once a row is added from the Setup drawer (DESIGN-job-data-entry-usability E): its scope and
   * section are opened and the row scrolled to and marked, so the new entry is visible where it lives.
   */
  revealRowId?: string | null;
  /** Optional controlled lens — lets the command-centre exception buttons switch to "attention". */
  lens?: AccordionLens;
  onLensChange?: (lens: AccordionLens) => void;
  notice: Notice;
  /**
   * Portal data-entry phase 2: the client's Data view reuses this accordion. It passes the categories already narrowed by the
   * client's profile (the CRM's own server totals, never recomputed), so nothing here fetches the staff route; it drops the
   * staff-only template seeding and taxonomy note; and it offers Add only while the data-entry window is open.
   */
  applicable?: JobApplicableCategories;
  audience?: "crm" | "portal";
  canAdd?: boolean;
};

export function CrpDataEntryAccordion({ specs, jobId, rows, selectedRowId, onOpenRow, onAddEntry, sites, siteId, factors, reportingMonths, purchasedGoodsCategories, categoryImport, categorySources, revealRowId, lens: lensProp, onLensChange, notice, applicable: given, audience = "crm", canAdd = true }: Props) {
  // Given its categories (the portal), it draws them on the first paint; otherwise it reads the CRM route.
  const [state, setState] = useState<"loading" | "failed" | "ready">(given ? "ready" : "loading");
  const [applicable, setApplicable] = useState<JobApplicableCategories | null>(given ?? null);
  const [lensInternal, setLensInternal] = useState<AccordionLens>("category");
  const lens = lensProp ?? lensInternal;
  const setLens = (next: AccordionLens) => { setLensInternal(next); onLensChange?.(next); };
  // C: what a person opened or closed, by key (a category code, "imported-1", "unsorted-3", "scope-2"). Anything they have not
  // touched follows its default — so a category that becomes complete collapses, and one that gains work opens.
  const [opened, setOpened] = useState<Map<string, boolean>>(new Map());
  const [addingCode, setAddingCode] = useState<string | null>(null);
  const [importFor, setImportFor] = useState<{ title: string; body: ReactNode } | null>(null);
  // SPEC §1: switched-off rows are hidden by default, one click away, never deleted.
  const [showSwitchedOff, setShowSwitchedOff] = useState(false);


  const load = useCallback(async () => {
    if (given) { setApplicable(given); setState("ready"); return; }
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
  }, [jobId, given]);
  useEffect(() => { void load(); }, [load]);
  // E: open what holds the row being revealed, then scroll to it once it is drawn.
  useEffect(() => {
    if (!revealRowId || !applicable) return;
    const keys = accordionKeysForRow(buildDataEntryAccordion(visibleAccordionRows(rows, true).rows, applicable), revealRowId);
    if (!keys) return;
    setLens("category");
    setOpened(current => { const next = new Map(current); for (const key of keys) next.set(key, true); return next; });
    requestAnimationFrame(() => document.querySelector(`[data-row-id="${CSS.escape(revealRowId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    // setLens is stable in effect; the reveal runs when a new row is asked for or the rows it needs arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRowId, applicable, rows]);

  if (state === "loading") return <div className="nz-panel" style={{ padding: 16 }} role="status">Loading the category view…</div>;
  if (state === "failed" || !applicable) {
    return (
      <div className="nz-banner warn" role="alert" style={{ margin: 0 }}>
        <div>The category view is unavailable. <button type="button" className="nz-btn" onClick={() => void load()}>Retry</button></div>
      </div>
    );
  }

  const visible = visibleAccordionRows(rows, showSwitchedOff);
  const groups = buildDataEntryAccordion(visible.rows, applicable);
  const totals = accordionTotals(groups);
  const attentionRows = accordionAttentionRows(rows);
  const isOpen = (key: string, byDefault = false) => opened.get(key) ?? byDefault;
  const toggle = (key: string, byDefault = false) => setOpened(current => new Map(current).set(key, !(current.get(key) ?? byDefault)));
  // Collapse all / Expand all: every scope and every section in it, set explicitly.
  const setAll = (value: boolean) => setOpened(new Map(groups.flatMap(group => [
    `scope-${group.scope}`, ...group.categories.map(entry => entry.category.code),
    ...(group.imported.length ? [`imported-${group.scope}`] : []), ...(group.unsorted.length ? [`unsorted-${group.scope}`] : []),
  ]).map(key => [key, value])));

  return (
    <section aria-label="Data entry by category" id="data-entry-accordion">
      <div className="nz-acc-tool">
        {/* The site selector lives in the page's site tabs now (v2), which filter the whole surface
            rather than only choosing where a new entry lands. A second control here would be a second
            answer to the same question. The lens below stays: it is a different question. */}
        {/* The lens is staff's work queue (calculate, quality tier, approve): the client's view shows the categories only. */}
        {audience === "crm" ? <Tabs
          className="nz-seg"
          ariaLabel="Data-entry view"
          idBase="crp-data-entry"
          value={lens}
          onChange={(id) => setLens(id as AccordionLens)}
          items={[
            { id: "category", label: "By category" },
            { id: "attention", label: <>Needs attention <span className="badge att">{totals.needsAttention}</span></> },
          ] satisfies TabDescriptor[]}
        /> : null}
        {visible.switchedOff > 0 ? (
          <label className="nz-acc-history">
            <input type="checkbox" checked={showSwitchedOff} onChange={event => setShowSwitchedOff(event.target.checked)} />
            {" "}Show switched-off history ({visible.switchedOff} row{visible.switchedOff === 1 ? "" : "s"})
            <InfoTip label="Switched-off rows">Rows that are switched off — deactivated, superseded by a re-ingest, or v7 rows a re-ingest replaced. They are kept, never deleted, and are not in any total or the report.</InfoTip>
          </label>
        ) : null}
        {lens === "category" && groups.length ? (
          <span className="nz-acc-bulk">
            <button type="button" className="nz-btn" onClick={() => setAll(false)}>Collapse all</button>
            <button type="button" className="nz-btn" onClick={() => setAll(true)}>Expand all</button>
          </span>
        ) : null}
      </div>

      {/* Phase 3b: the client's reporting template — seed, or fill the gaps. It replaces JW-6's "Add rows from template"
          search and "Reuse Previous Year Rows" (retired: the rows come from the template). Renders nothing when the
          client has no template in force. */}
      {audience === "crm" ? <JobTemplateSeeding jobId={jobId} notice={notice} /> : null}


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
          {groups.map(group => {
            const scopeKey = `scope-${group.scope}`, scopeOpen = isOpen(scopeKey, scopeOpenByDefault(group)), summary = scopeSummary(group, groups);
            return (
            <div key={group.scope}>
              {/* C: the scope is the first level — its header collapses the whole group and carries its summary. */}
              <button type="button" className={`nz-acc-scopehead toggle${scopeOpen ? " open" : ""}`} aria-expanded={scopeOpen} onClick={() => toggle(scopeKey, scopeOpenByDefault(group))}>
                <span className="sdot" style={{ background: scopeColour(group.scope) }} />{group.label}
                {/* JW-10 — a scope with nothing in it is shown, and says so; it is never left out. */}
                {scopeHasNoData(group) ? <span className="nz-chip-mini nodata" style={{ marginLeft: 8 }}>No data yet</span>
                  : <>
                    <span className="ssum">{summary.entries} {summary.entries === 1 ? "entry" : "entries"}{summary.sharePercent === null ? "" : ` · ${summary.sharePercent}% of total`}</span>
                    {/* The total is the headline figure, at the right of the rule; the share moved into its old slot in the meta. */}
                    <span className="stot"><b>{num(summary.tco2e)}</b> tCO₂e</span>
                  </>}
                <svg className="schev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {scopeOpen ? <>
              {group.categories.map(entry => {
                const code = entry.category.code;
                const categoryOpen = isOpen(code);
                const imp = categoryImport?.(entry.category) ?? null;
                const sources = categorySources?.(entry.category, () => setImportFor(null)) ?? null;
                return (
                  <div key={code} className={`nz-acc-cat${categoryOpen ? " open" : ""}`} style={{ "--cc": scopeColour(group.scope) } as React.CSSProperties}>
                    <button type="button" className="nz-acc-h" aria-expanded={categoryOpen} onClick={() => toggle(code)}>
                      <span className="nz-acc-badge">{entry.category.name.slice(0, 1)}</span>
                      <span className="nz-acc-tt">
                        <b>{entry.category.name}
                          {entry.noData ? <span className="nz-chip-mini nodata">no data</span> : entry.needsAttention && audience === "crm" ? <span className="nz-chip-mini todo">{entry.needsAttention} to do</span> : null}
                        </b>
                        <span className="sum">{entry.entryCount} {entry.entryCount === 1 ? "entry" : "entries"} · <span className="nz-acc-compl"><span className="bar"><i style={{ width: `${entry.completeness}%` }} /></span>{entry.completeness}%</span></span>
                      </span>
                      <span className="nz-acc-total"><b>{num(entry.tco2e)}</b> tCO₂e</span>
                      <svg className="nz-acc-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                    {categoryOpen ? (
                      <div className="nz-acc-body">
                        {entry.rows.length ? (
                          <div className="nz-table-wrap">
                            <table className="nz-tbl">
                              <thead><tr><th>Source</th><th>Site</th><th className="num">Activity</th><th>Unit</th><th>Factor</th><th className="num">tCO₂e</th><th>Review</th></tr></thead>
                              <tbody>
                                {entry.rows.map(row => (
                                  <tr key={row.id} data-row-id={row.id} tabIndex={0} className={`row${row.id === selectedRowId ? " sel" : ""}`}
                                    onClick={() => onOpenRow(row.id, entry.category)}
                                    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenRow(row.id, entry.category); } }}>
                                    <td>{row.sourceLabel}{row.assetIdentifier ? <div className="muted">ID / Ref: {row.assetIdentifier}</div> : null}{row.enabled ? null : <div className="muted">Disabled</div>}</td>
                                    <td>{row.siteLabel ?? "Unallocated"}</td>
                                    <td className="num">{formatQuantity(row.quantity)}</td>
                                    <td>{row.unit ?? "—"}</td>
                                    <td>{row.factorLabel ?? <span className="nz-st nof">No factor</span>}</td>
                                    <td className="num">{formatTco2e(row.overrideTco2e ?? row.calculatedTco2e)}</td>
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
                          {canAdd ? <button type="button" className="nz-btn pri"
                            onClick={() => onAddEntry(entry.category)}>
                            + Add entry
                          </button> : null}
                          {imp ? <button type="button" className="nz-btn" onClick={() => setImportFor(imp)}>Import &amp; templates</button> : null}
                          {sources ? <button type="button" className="nz-btn" onClick={() => setImportFor(sources)}>Sources</button> : null}
                          {KIND_NOTE[entry.category.kind] ? <InfoTip label={`${entry.category.name} — how data entry works`}>{KIND_NOTE[entry.category.kind]}</InfoTip> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {group.imported.length ? (
                <div className="nz-acc-cat" style={{ "--cc": "var(--t3)" } as React.CSSProperties}>
                  <button type="button" className="nz-acc-h" aria-expanded={isOpen(`imported-${group.scope}`)} onClick={() => toggle(`imported-${group.scope}`)}>
                    <span className="nz-acc-badge">v7</span>
                    <span className="nz-acc-tt"><b>Imported from v7<span className="nz-chip-mini">{group.imported.length}</span></b>
                      <span className="sum">This period&rsquo;s figures as recorded in NZ Insights Pro v7 — fixed history, shown under v7&rsquo;s own labels.</span></span>
                    <svg className="nz-acc-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  {isOpen(`imported-${group.scope}`) ? (
                    <div className="nz-acc-body">
                      <div className="nz-table-wrap">
                        <table className="nz-tbl">
                          <thead><tr><th>Source</th><th>v7 category</th><th>Site</th><th className="num">tCO₂e</th><th>Review</th></tr></thead>
                          <tbody>
                            {group.imported.map(row => (
                              <tr key={row.id} tabIndex={0} className={`row${row.id === selectedRowId ? " sel" : ""}`}
                                onClick={() => onOpenRow(row.id)}
                                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenRow(row.id); } }}>
                                <td>{row.sourceLabel}{row.enabled ? null : <div className="muted">Disabled</div>}</td>
                                <td>{row.categoryPath.slice(0, 2).join(" › ") || "—"}</td>
                                <td>{row.siteLabel ?? "Unallocated"}</td>
                                <td className="num">{formatTco2e(row.overrideTco2e ?? row.calculatedTco2e)}</td>
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
              {group.unsorted.length ? (
                <div className="nz-acc-cat" style={{ "--cc": "var(--t3)" } as React.CSSProperties}>
                  <button type="button" className="nz-acc-h" aria-expanded={isOpen(`unsorted-${group.scope}`)} onClick={() => toggle(`unsorted-${group.scope}`)}>
                    <span className="nz-acc-badge">?</span>
                    <span className="nz-acc-tt"><b>Unsorted<span className="nz-chip-mini todo">{group.unsorted.length}</span></b>
                      <span className="sum">{audience === "crm" ? "Rows not yet filed under a category — a category is stamped when you next save the row." : "Entries not yet filed under a category by your adviser."}</span></span>
                    <svg className="nz-acc-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  {isOpen(`unsorted-${group.scope}`) ? (
                    <div className="nz-acc-body">
                      <div className="nz-table-wrap">
                        <table className="nz-tbl">
                          <thead><tr><th>Source</th><th>Scope</th><th>Site</th><th>Factor</th><th>Review</th></tr></thead>
                          <tbody>
                            {group.unsorted.map(row => (
                              <tr key={row.id} data-row-id={row.id} tabIndex={0} className={`row${row.id === selectedRowId ? " sel" : ""}`}
                                onClick={() => onOpenRow(row.id)}
                                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenRow(row.id); } }}>
                                <td>{row.sourceLabel}{row.enabled ? null : <div className="muted">Disabled</div>}</td>
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
              </> : null}
            </div>
            );
          })}
          {groups.length === 0 ? (
            <div className="nz-acc-empty">No scopes are included for this job yet. Select reporting datasets to populate the category view.</div>
          ) : null}
      </TabPanel>
      <p className="nz-hint" style={{ marginTop: 10 }}>{totals.withData} of {totals.categories} categories have data{totals.imported ? ` · ${totals.imported} row${totals.imported === 1 ? "" : "s"} imported from v7` : ""}{totals.unsorted ?` · ${totals.unsorted} row${totals.unsorted === 1 ? "" : "s"} unsorted` : ""}. {audience === "crm" ? `${emissionCategoryTaxonomy.length}-category GHG taxonomy (NZC-045).` : null}</p>

      <Drawer open={importFor !== null} onClose={() => setImportFor(null)} ariaLabel={importFor?.title ?? "Import & templates"} className="nz-import-modal" dismissOnOutsideClick>
        <div className="nz-import-modal-card">
          <div className="nz-import-modal-h">
            <h2>{importFor?.title}</h2>
            <button type="button" className="nz-btn" aria-label={`Close ${importFor?.title ?? "import and templates"}`} onClick={() => setImportFor(null)}>✕</button>
          </div>
          <div className="nz-import-modal-b">{importFor?.body}</div>
        </div>
      </Drawer>
    </section>
  );
}
