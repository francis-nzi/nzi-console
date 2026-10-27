"use client";
// Data entry D3 (R1, R7): the job's Currency & FX. Each site spends in its own currency (or the client's); spend there is entered
// and priced in it — with that country's spend factors — so the emissions never pass through an exchange rate. Where a site's
// currency is not the client's, the CRM sets the job's FX rate for it: the average over the reporting period, used only to express
// the job's spend in the client's currency. Staff-only: the portal never shows money beyond what the client entered (NZC-120).
import { useCallback, useEffect, useRef, useState } from "react";
import { putBrowserCommand } from "@nzi/api-client";
import { currencySymbol, spendInClientCurrency, type JobSiteFxRate, type ScopeRowReadModel } from "@nzi/contracts";

type Currencies = { clientCurrency: string; sites: Array<{ siteId: string; name: string; currency: string; ownCurrency: boolean; needsRate: boolean; rate: JobSiteFxRate | null }> };

const money = (amount: number, currency: string) => `${currencySymbol(currency)}${amount.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

export function JobCurrencyPanel({ jobId, rows, notice, writeEnabled }: {
  jobId: string; rows: ScopeRowReadModel[]; notice: (n: { kind: "ok" | "warn"; text: string }) => void; writeEnabled: boolean;
}) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "failed" } | { kind: "ready"; data: Currencies }>({ kind: "loading" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/fx-rates`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      setState({ kind: "ready", data: await response.json() as Currencies });
    } catch { setState({ kind: "failed" }); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  if (state.kind === "loading") return <section className="nz-panel nz-config-panel nz-fx-panel"><span className="muted">Reading the job&rsquo;s currencies…</span></section>;
  if (state.kind === "failed") return <section className="nz-panel nz-config-panel nz-fx-panel" role="alert">The job&rsquo;s currencies could not be read. No conversion is shown rather than one that might be wrong.</section>;
  const { clientCurrency, sites } = state.data;
  const rates = sites.flatMap((site) => (site.rate ? [site.rate] : []));
  const spend = spendInClientCurrency(rows.map((row) => ({ unit: row.unit ?? null, quantity: row.quantity ?? null, siteId: row.siteId ?? null })), clientCurrency, rates);
  const foreign = sites.filter((site) => site.needsRate);

  async function save(siteId: string, version: number | null) {
    const rate = Number((drafts[siteId] ?? "").replace(/,/g, ""));
    if (!(rate > 0)) { notice({ kind: "warn", text: "Enter the rate as a positive number." }); return; }
    setBusy(siteId);
    const result = await putBrowserCommand(`/api/isolated/jobs/${jobId}/fx-rates`, { siteId, rate, expectedVersion: version }, keys.current[siteId] ??= crypto.randomUUID());
    setBusy(null);
    if (result.state === "success") { delete keys.current[siteId]; notice({ kind: "ok", text: "FX rate saved. It only expresses money in the client's currency — the emissions don't use it." }); await load(); }
    else notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.state === "conflict" ? "The rate changed since this was opened. It has been reloaded." : result.message });
    if (result.state === "conflict") await load();
  }

  return <section className="nz-panel nz-config-panel nz-fx-panel" aria-labelledby={`fx-${jobId}`}>
    <div className="nz-config-head">
      <div><span className="nz-eyebrow">Currency &amp; FX</span><b id={`fx-${jobId}`}>Local currency first</b>
        <div className="sub">Spend is entered in each site&rsquo;s own currency and priced with that country&rsquo;s spend factors — the emissions never go through an exchange rate. A rate here only expresses the job&rsquo;s spend in {clientCurrency}.</div></div>
      <span className="nz-st done">Client currency {clientCurrency}</span>
    </div>
    {foreign.length === 0 ? <p className="muted nz-fx-none">Every site spends in {clientCurrency}, so this job needs no rate. Set a site&rsquo;s own currency on the client&rsquo;s Sites.</p> : (
      <div className="nz-fx-rows">
        {foreign.map((site) => (
          <div key={site.siteId} className="nz-fx-row" data-site={site.siteId}>
            <div><b>{site.name}</b><div className="nz-hint">Spends in {site.currency}</div></div>
            <label className="nz-fl">1 {site.currency} = ? {clientCurrency} <span className="muted">· average over the reporting period</span>
              <input className="nz-inp" inputMode="decimal" disabled={!writeEnabled || busy !== null} placeholder={site.rate ? String(site.rate.rate) : "e.g. 0.86"}
                value={drafts[site.siteId] ?? (site.rate ? String(site.rate.rate) : "")} onChange={(event) => setDrafts({ ...drafts, [site.siteId]: event.target.value })} />
            </label>
            {writeEnabled ? <button type="button" className="nz-btn" disabled={busy !== null || !(drafts[site.siteId] ?? "").trim()} onClick={() => void save(site.siteId, site.rate?.version ?? null)}>{busy === site.siteId ? "Saving…" : site.rate ? "Update rate" : "Set rate"}</button> : null}
          </div>
        ))}
      </div>
    )}
    {spend.lines + spend.unconverted.length > 0 ? (
      <div className="nz-fx-total" role="status">
        <b>Spend on this job, in {clientCurrency}: {money(spend.total, clientCurrency)}</b>
        <span className="nz-hint"> · {spend.lines} line{spend.lines === 1 ? "" : "s"}{spend.converted ? `, ${spend.converted} converted at the job's rates` : ""}</span>
        {spend.unconverted.map((entry) => (
          <div key={`${entry.currency}|${entry.siteId ?? ""}`} className="nz-hint nz-fx-missing">Not included: {money(entry.amount, entry.currency)} in {entry.lines} line{entry.lines === 1 ? "" : "s"} at {sites.find((site) => site.siteId === entry.siteId)?.name ?? "no site"} — {entry.siteId ? `no ${entry.currency} rate is set` : "a line in another currency needs a site to be converted"}.</div>
        ))}
      </div>
    ) : null}
  </section>;
}
