"use client";
// Portal data-entry phase 2 — the client's Data view (BUILD-portal-dataentry-phase2 §3). It mirrors the CRM's own capture
// surface and reuses its components — the scope → category accordion (`CrpDataEntryAccordion`, given the categories already
// narrowed by the client's profile, with the CRM's own server totals), the entry form (`EmissionEntryForm`, portal audience,
// writing the shared row on save), the source detail (`rowSourceDetail`) and the row History (`RowHistory`) — narrowed by the
// client's portal profile. Writes go to the portal commands, which hold every gate again at the write boundary.
import { useCallback, useEffect, useState } from "react";
import { Drawer } from "@nzi/ui";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import type { ApplicableCategory, InputSpecCategory, ScopeRowReadModel } from "@nzi/contracts";
import type { PortalDataView as View, PortalScopeRow } from "@nzi/isolated-backend";
import { CrpDataEntryAccordion } from "../../../../jobs/CrpDataEntryAccordion";
import {
  EmissionEntryForm, categoryRowScope, declaredOptionFor, emissionEntryDraftToScopeRow, entryFactorRefsFor, optionsForCategory,
  scopeRowToEmissionEntryDraft, type DeclaredFactorPreviewResult, type EmissionEntryDraft,
} from "../../../../jobs/EmissionEntryForm";
import { rowSourceDetail } from "../../../../jobs/rowSourceDetail";
import { RowHistory, type RowHistoryEntry, type RowHistoryState } from "../../../../jobs/RowHistory";
import { formatDate, formatDateTime } from "../../../../lib/formatDate";
import { formatQuantity, formatTonnes } from "../../../../lib/formatNumber";
import { useOrganisationName } from "../../../../lib/OrganisationNameProvider";
import { usePortalSurface } from "../../../portalSurface";
import { historyEntry, isPortalDataView, mayDeactivate, portalScopeRowFields, reviewLabel, rowDrawerSections, windowOpen } from "../../../data/portalDataView";

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; view: View; specs: Record<string, InputSpecCategory> };

export function PortalDataView({ jobId }: { jobId: string }) {
  const org = useOrganisationName();
  const surface = usePortalSurface();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [siteId, setSiteId] = useState("");
  const [adding, setAdding] = useState<ApplicableCategory | null>(null);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [preview, setPreview] = useState<{ code: string; result: DeclaredFactorPreviewResult } | null>(null);
  const base = `${surface.api}/jobs/${encodeURIComponent(jobId)}`;

  const refresh = useCallback(async () => {
    try {
      const [viewResponse, specResponse] = await Promise.all([fetch(`${base}/data-view`, { cache: "no-store" }), fetch(`${surface.api}/input-spec`, { cache: "no-store" })]);
      if (await surface.sessionEnded(viewResponse) || await surface.sessionEnded(specResponse)) return;
      const view: unknown = viewResponse.ok ? await viewResponse.json() : null;
      const spec = specResponse.ok ? (await specResponse.json() as { spec?: InputSpecCategory[] }).spec : undefined;
      if (!isPortalDataView(view) || !Array.isArray(spec)) { setLoad({ state: "failed" }); return; }
      setLoad({ state: "ready", view, specs: Object.fromEntries(spec.map((category) => [category.categoryCode, category])) });
    } catch { setLoad({ state: "failed" }); }
  }, [base, surface]);
  useEffect(() => { void refresh(); }, [refresh]);

  // The category's declared factor, from the same resolution the write uses (Stop 2b) — a convenience the write never needs.
  useEffect(() => {
    if (!adding) return;
    let live = true;
    void fetch(`${base}/declared-factor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ categoryCode: adding.code, scope: categoryRowScope(adding as never) }) })
      .then((response) => (response.ok ? response.json() : null)).then((result) => { if (live) setPreview(result ? { code: adding.code, result } : null); }).catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [adding, base]);

  if (load.state === "loading") return <div className="nz-portal-state loading" role="status"><i>↻</i><div><b>Loading your data</b><span>Reading this job&apos;s categories and entries…</span></div></div>;
  if (load.state === "failed") return <div className="nz-portal-state failed" role="alert"><i>!</i><div><b>Your data is temporarily unavailable</b><span>Nothing has been assumed about your entries.</span><button className="nz-btn" onClick={() => void refresh()}>Try again</button></div></div>;

  const { view, specs } = load;
  const open = windowOpen(view);
  const refs = entryFactorRefsFor(view.factors);
  const site = siteId ? view.sites.find((entry) => entry.id === siteId) ?? null : null;
  const rows = (siteId ? view.rows.filter((row) => row.siteId === siteId) : view.rows) as unknown as ScopeRowReadModel[];
  const openRow = openRowId ? view.rows.find((row) => row.id === openRowId) ?? null : null;
  const optionsFor = (category: ApplicableCategory) => optionsForCategory(refs.filter((option) => option.scope === category.scope), preview?.code === category.code ? preview.result : null);

  async function saveNew(category: ApplicableCategory, draft: EmissionEntryDraft) {
    setBusy(true); setFormError("");
    const fields = portalScopeRowFields(emissionEntryDraftToScopeRow(draft, category, { id: site?.id ?? null, label: site?.name ?? null }, refs, view.reportingMonths));
    const result = await postBrowserCommand<{ rowId: string }>(`${base}/scope-rows`, fields, crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") { setAdding(null); setNotice({ kind: "ok", text: `Saved to ${category.name}. It waits for ${org.your("adviser")}'s review.` }); await refresh(); }
    else setFormError(errorText(result));
  }

  return (
    <div className="nz-pdv">
      <header className="nz-pd-top">
        <div>
          <span className="nz-eyebrow">Your data</span>
          <h1 className="nz-pd-client">Data entry</h1>
          <p className="nz-pd-meta">{surface.readOnly ? "Staff preview · read-only — each portal user's entry window is set in Portal Management" : view.access ? view.access.state === "open" ? `Open for entry until ${formatDate(view.access.expiresAt.slice(0, 10))}` : `Opens for entry on ${formatDate(view.access.startsAt.slice(0, 10))}` : "Not open for entry just now — you can still see your data"}</p>
        </div>
        <label className="nz-pdv-site">Site
          <select className="nz-sel" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
            <option value="">All sites</option>
            {view.sites.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
      </header>
      <p className="nz-pdv-note" role="note">What you enter goes straight into this job&apos;s data and waits for {org.your("adviser")}&apos;s review; it counts once reviewed. You can change an entry you made until it has been reviewed.</p>
      {notice ? <div className={`nz-banner ${notice.kind}`} role={notice.kind === "ok" ? "status" : "alert"}>{notice.text}</div> : null}

      <CrpDataEntryAccordion
        audience="portal" applicable={view.categories} canAdd={open && !surface.readOnly}
        specs={specs} jobId={jobId} rows={rows} selectedRowId={openRowId ?? ""}
        onOpenRow={(rowId) => { setAdding(null); setOpenRowId(rowId); }}
        onAddEntry={(category) => { setOpenRowId(null); setFormError(""); setAdding(category); }}
        sites={view.sites.map((entry) => ({ id: entry.id, label: entry.name }))} siteId={siteId}
        factors={refs} reportingMonths={view.reportingMonths} purchasedGoodsCategories={view.purchasedGoodsCategories}
        notice={setNotice} />

      <Drawer open={adding !== null} onClose={() => setAdding(null)} ariaLabel={adding ? `Add an entry to ${adding.name}` : "Add an entry"} className="nz-pdv-drawer" dismissOnOutsideClick>
        {adding ? <div className="nz-pdv-drawer-b">
          <div className="nz-pdv-drawer-h"><span className="nz-eyebrow">{adding.name}</span><h2>Add an entry</h2></div>
          <EmissionEntryForm key={adding.code} spec={specs[adding.code] ?? null} category={adding} audience="portal" portalDirect
            site={{ id: site?.id ?? null, label: site?.name ?? "No particular site" }}
            factors={optionsFor(adding)} declared={declaredOptionFor(preview?.code === adding.code ? preview.result : null, optionsFor(adding))}
            units={specs[adding.code]?.units ?? []} reportingMonths={view.reportingMonths}
            spendCategories={view.purchasedGoodsCategories} busy={busy} error={formError}
            onCancel={() => setAdding(null)} onSubmit={(draft) => saveNew(adding, draft)} />
        </div> : null}
      </Drawer>

      <Drawer open={openRow !== null} onClose={() => setOpenRowId(null)} ariaLabel={openRow ? openRow.sourceLabel : "Entry"} className="nz-pdv-drawer" dismissOnOutsideClick>
        {openRow ? <PortalRowDrawer key={`${openRow.id}-${openRow.version}`} jobId={jobId} row={openRow} view={view} specs={specs} refs={refs} open={open}
          adviser={org.Your("adviser")} adviserInline={org.your("adviser")} onSaved={async (text) => { setNotice({ kind: "ok", text }); setOpenRowId(null); await refresh(); }} /> : null}
      </Drawer>
    </div>
  );
}

/** One entry, as the client sees it: what it is, where and when; the profile's sections, read-only; changes; History. */
export function PortalRowDrawer({ jobId, row, view, specs, refs, open, adviser, adviserInline = adviser, onSaved }: {
  jobId: string; row: PortalScopeRow; view: View; specs: Record<string, InputSpecCategory>; refs: ReturnType<typeof entryFactorRefsFor>;
  /** `adviser` begins a sentence ("Your NZI adviser"); `adviserInline` sits inside one ("your NZI adviser") — never lower-cased. */
  open: boolean; adviser: string; adviserInline?: string; onSaved: (text: string) => Promise<void>;
}) {
  const [history, setHistory] = useState<RowHistoryEntry[]>([]);
  const [historyState, setHistoryState] = useState<RowHistoryState>("loading");
  const [showHistory, setShowHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const surface = usePortalSurface();
  const base = `${surface.api}/jobs/${encodeURIComponent(jobId)}/scope-rows/${encodeURIComponent(row.id)}`;
  useEffect(() => {
    let live = true;
    void fetch(`${base}/history`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { history?: unknown }) => { if (!live) return; if (!Array.isArray(body.history)) throw new Error(); setHistory(body.history.map((entry, index) => historyEntry(entry, index, adviser))); setHistoryState("ready"); })
      .catch(() => { if (live) setHistoryState("failed"); });
    return () => { live = false; };
  }, [base, adviser]);

  const category = view.categories.categories.find((entry) => entry.code === (row.categoryCode || row.scope)) ?? null;
  const sections = rowDrawerSections(view.profile);
  // The entry form keys its factor options by option id, not by the factor's own id the row stores: find the row's option, so
  // the form opens on the factor the entry has (the CRM edits a row in its own drawer, so only the portal needs this).
  const categoryOptions = category ? optionsForCategory(refs.filter((option) => option.scope === category.scope), null) : [];
  const rowOption = categoryOptions.find((option) => (option.factorId ?? option.id) === row.factorId && (option.datasetId ?? null) === (row.datasetId ?? null))
    ?? categoryOptions.find((option) => (option.factorId ?? option.id) === row.factorId) ?? null;
  const editDraft = { ...scopeRowToEmissionEntryDraft(row as unknown as ScopeRowReadModel), factorId: rowOption?.id ?? "" };
  const source = rowSourceDetail(row as unknown as ScopeRowReadModel);
  const months = (row.monthlyActivity ?? []).filter((slot) => slot.quantity !== null);

  async function save(draft: EmissionEntryDraft) {
    if (!category) return;
    setBusy(true); setError("");
    const site = view.sites.find((entry) => entry.id === row.siteId) ?? null;
    const fields = portalScopeRowFields(emissionEntryDraftToScopeRow(draft, category, { id: site?.id ?? null, label: site?.name ?? null }, refs, view.reportingMonths));
    const result = await patchBrowserCommand(base, { ...fields, expectedVersion: row.version }, crypto.randomUUID());
    setBusy(false);
    if (result.state === "success") await onSaved("Your change is saved. It waits for review.");
    else setError(errorText(result));
  }
  async function deactivate() {
    setBusy(true); setError("");
    const result = await postBrowserCommandWithReason(`${base}/deactivate`, { expectedVersion: row.version }, crypto.randomUUID(), reason.trim());
    setBusy(false);
    if (result.state === "success") await onSaved("The entry is deactivated. It is kept, and no longer counts.");
    else setError(errorText(result));
  }

  return (
    <div className="nz-pdv-drawer-b" data-portal-row-drawer="">
      <div className="nz-pdv-drawer-h">
        <span className="nz-eyebrow">{category?.name ?? row.scope}</span>
        <h2>{row.sourceLabel}</h2>
        <span className={`nz-st ${row.reviewStatus === "approved" ? "done" : row.reviewStatus === "rejected" ? "nof" : "est"}`}>{reviewLabel(row)}</span>
      </div>
      <dl className="nz-pdv-facts">
        <div><dt>Activity</dt><dd>{formatQuantity(row.quantity)} {row.unit ?? ""}</dd></div>
        <div><dt>Factor</dt><dd>{row.factorLabel ?? "—"}</dd></div>
        <div><dt>Emissions</dt><dd>{row.calculatedTco2e === null && row.overrideTco2e === null ? "Calculated on review" : `${formatTonnes(row.overrideTco2e ?? row.calculatedTco2e)} tCO₂e`}</dd></div>
      </dl>

      {sections.includes("site") ? <section className="nz-pdv-sec" aria-label="Site"><h3>Site</h3><p>{row.siteLabel ?? "No particular site"}</p></section> : null}
      {sections.includes("monthly") ? <section className="nz-pdv-sec" aria-label="Monthly activity"><h3>Monthly activity</h3>
        {months.length ? <ul>{months.map((slot) => <li key={slot.month}>{slot.month}: {formatQuantity(slot.quantity)} {row.unit ?? ""}</li>)}</ul> : <p className="muted">Entered as one figure for the year.</p>}</section> : null}
      {sections.includes("factorCalculation") ? <section className="nz-pdv-sec" aria-label="Factor & calculation"><h3>Factor &amp; calculation</h3>
        <p>{row.factorLabel ?? "No factor"}{row.factorVersion ? ` · ${row.factorVersion}` : ""}</p>
        <p className="muted">{row.calculatedTco2e === null ? `Not calculated yet: ${adviserInline} calculates it on review.` : `${formatTonnes(row.calculatedTco2e)} tCO₂e calculated.`}</p></section> : null}
      {sections.includes("dataQuality") ? <section className="nz-pdv-sec" aria-label="Data quality"><h3>Data quality</h3>
        <p>{row.qualityTier ?? `Set by ${adviserInline} on review.`}{row.dataConfidence ? ` · confidence ${row.dataConfidence}` : ""}</p></section> : null}
      {sections.includes("sourceDetail") ? <section className="nz-pdv-sec" aria-label={source.title}><h3>{source.title}</h3>
        {source.fields.length ? <dl className="nz-pdv-facts">{source.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl> : <p className="muted">No further detail recorded.</p>}</section> : null}
      {sections.includes("evidenceProvenance") ? <section className="nz-pdv-sec" aria-label="Evidence & provenance"><h3>Evidence &amp; provenance</h3>
        <ul>{row.lineage.map((step, index) => <li key={index}><b>{step.title}</b> · {step.detail}</li>)}</ul>
        {typeof row.provenance.capturedAt === "string" ? <p className="muted">Captured {formatDateTime(row.provenance.capturedAt)}{row.provenance.capturedAs === "client-portal" ? " in the client portal" : ""}.</p> : null}</section> : null}

      {surface.readOnly ? <p className="muted nz-pdv-ro">Read-only preview. {row.editable ? "The client can change this entry while it waits for review and their entry window is open." : "The client cannot change this entry."}</p>
        : row.editable && open && category ? <section className="nz-pdv-sec" aria-label="Change this entry"><h3>Change this entry</h3>
        <EmissionEntryForm spec={specs[category.code] ?? null} category={category} audience="portal" portalDirect
          site={{ id: row.siteId ?? null, label: row.siteLabel ?? "No particular site" }}
          factors={categoryOptions}
          units={specs[category.code]?.units ?? []} reportingMonths={view.reportingMonths} spendCategories={view.purchasedGoodsCategories}
          entry={editDraft} busy={busy} error={error}
          onCancel={() => undefined} onSubmit={save} /></section>
        : <p className="muted nz-pdv-ro">{row.editable ? "Data entry isn't open just now, so this entry can't be changed." : `This entry can't be changed here. Ask ${adviserInline} if it needs to change.`}</p>}

      {!surface.readOnly && mayDeactivate(view.profile, row, open) ? <section className="nz-pdv-sec" aria-label="Deactivate this entry"><h3>Deactivate this entry</h3>
        <textarea className="nz-inp" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why it no longer applies" />
        <button type="button" className="nz-btn" disabled={busy || !reason.trim()} onClick={() => void deactivate()}>Deactivate</button></section> : null}
      {error && !row.editable ? <div className="nz-banner warn" role="alert">{error}</div> : null}

      {sections.includes("history") ? <RowHistory state={historyState} entries={history} open={showHistory} onOpenChange={setShowHistory} /> : null}
    </div>
  );
}
