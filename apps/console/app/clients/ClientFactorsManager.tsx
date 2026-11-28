"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { patchBrowserCommand, postBrowserCommand } from "@nzi/api-client";
import { formatDate } from "../lib/formatDate";
import { ClientFactorCreateForm } from "./ClientFactorCreateForm";

// S2 — the client-factor management surface (NZC-041, flag `client-factors`). List · versioned edit · archive/un-archive ·
// values by year (GAPS G2) · create (G6). For a client (`clientId`, on the client page and, compact, in a job workspace), or for
// the organisation (`organisation`, the Clients page's Organisation factors tab — G3: factors with no client, offered on every
// client's jobs). Every per-factor act goes through the factor's own route, whoever owns it.
type ClientFactor = {
  clientFactorId: string; clientId: string | null; jobId: string | null; scope: string; reportLabel: string; description: string;
  unit: string; ghgUnit: string; kgco2ePerUnit: number; geography: string; vintageYear: number; version: number; source: string;
  evidenceFileName: string | null; evidenceStorageProvider: "local" | "sharepoint" | null; evidenceUrl: string | null;
  evidenceExternalItemId: string | null; evidenceHash: string | null; archived: boolean; usageCount: number;
  createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string | null;
  /** 0240: V7's id, and the factor a folded re-ingest factor was folded into (archived for good). */
  legacyCustomId?: string | null; foldedInto?: { clientFactorId: string; reportLabel: string | null } | null;
  /** G2: the values by year it is priced from; empty when it has none (priced at its headline). */
  yearValues?: Array<{ year: number; kgco2ePerUnit: number }>;
};
type Edit = { reportLabel: string; description: string; unit: string; kgco2ePerUnit: number; geography: string; vintageYear: number; source: string; evidenceFileName: string; evidenceHash: string };
type YearDraft = Array<{ key: string; year: string; value: string }>;

const failureText = (result: { state: string; issues?: Array<{ message: string }>; message?: string }) =>
  result.state === "validation_failed" ? (result.issues ?? []).map((i) => i.message).join(" ")
    : result.state === "conflict" ? "This factor changed elsewhere — reloaded. Review it before retrying." : result.message ?? "The change was not saved.";

export function ClientFactorsManager({ clientId, jobId, compact = false, organisation = false }: { clientId?: string; jobId?: string; compact?: boolean; organisation?: boolean }) {
  const [factors, setFactors] = useState<ClientFactor[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Edit | null>(null);
  const [years, setYears] = useState<string | null>(null);
  const [yearDraft, setYearDraft] = useState<YearDraft>([]);
  const [pending, setPending] = useState("");
  const listUrl = organisation ? "/api/isolated/client-factors" : `/api/isolated/clients/${clientId}/client-factors`;
  const factorUrl = (id: string) => `/api/isolated/client-factors/${id}`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${listUrl}${jobId ? `?jobId=${jobId}` : ""}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.factors)) throw new Error(body.message ?? "Client factors are unavailable.");
      setFactors(body.factors);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Client factors are unavailable.");
      setFactors(null);
    }
  }, [listUrl, jobId]);
  useEffect(() => { void load(); }, [load]);

  const byYear = (factor: ClientFactor) => (factor.yearValues?.length ?? 0) > 0;

  const startEdit = (factor: ClientFactor) => {
    setEditing(factor.clientFactorId);
    setDraft({ reportLabel: factor.reportLabel, description: factor.description, unit: factor.unit, kgco2ePerUnit: factor.kgco2ePerUnit, geography: factor.geography, vintageYear: factor.vintageYear, source: factor.source, evidenceFileName: factor.evidenceFileName ?? "", evidenceHash: factor.evidenceHash ?? "" });
  };

  const openYears = (factor: ClientFactor) => {
    setYears(factor.clientFactorId);
    const set = factor.yearValues?.length ? factor.yearValues : [{ year: factor.vintageYear, kgco2ePerUnit: factor.kgco2ePerUnit }];
    setYearDraft(set.map((entry) => ({ key: crypto.randomUUID(), year: String(entry.year), value: String(entry.kgco2ePerUnit) })));
  };

  async function save(factor: ClientFactor) {
    if (!draft) return;
    setPending(`save:${factor.clientFactorId}`); setError(""); setNotice("");
    const result = await patchBrowserCommand<{ version: number; versionBumped: boolean }>(
      factorUrl(factor.clientFactorId),
      { expectedVersion: factor.version, reportLabel: draft.reportLabel, description: draft.description, unit: draft.unit, kgco2ePerUnit: draft.kgco2ePerUnit, geography: draft.geography, vintageYear: draft.vintageYear, source: draft.source, evidenceFileName: draft.evidenceFileName || null, evidenceStorageProvider: draft.evidenceFileName ? "sharepoint" : null, evidenceUrl: null, evidenceExternalItemId: null, evidenceHash: draft.evidenceHash || null },
      crypto.randomUUID(),
    );
    setPending("");
    if (result.state === "success") {
      setNotice(result.data.versionBumped ? `Factor updated to v${result.data.version}. Existing rows keep their pinned version until re-calculated.` : "Factor details updated.");
      setEditing(null); setDraft(null); await load();
    } else setError(failureText(result));
    if (result.state === "conflict") await load();
  }

  async function saveYears(factor: ClientFactor) {
    setPending(`years:${factor.clientFactorId}`); setError(""); setNotice("");
    const values = yearDraft.filter((entry) => entry.year.trim() !== "" || entry.value.trim() !== "").map((entry) => ({ year: Number(entry.year), kgco2ePerUnit: Number(entry.value) }));
    const result = await postBrowserCommand<{ version: number; years: number[] }>(`${factorUrl(factor.clientFactorId)}/years`, { expectedVersion: factor.version, values }, crypto.randomUUID());
    setPending("");
    if (result.state === "success") {
      setNotice(`Values by year saved as v${result.data.version} (${result.data.years.join(", ")}). Rows already priced keep their figures until re-priced.`);
      setYears(null); await load();
    } else setError(failureText(result));
    if (result.state === "conflict") await load();
  }

  async function toggleArchive(factor: ClientFactor) {
    if (!factor.archived && !window.confirm(`Archive "${factor.reportLabel}"? It will no longer be selectable on new rows.`)) return;
    setPending(`archive:${factor.clientFactorId}`); setError(""); setNotice("");
    const result = await postBrowserCommand<{ archived: boolean }>(factorUrl(factor.clientFactorId), { archived: !factor.archived }, crypto.randomUUID());
    setPending("");
    if (result.state === "success") { setNotice(result.data.archived ? "Factor archived." : "Factor restored."); await load(); }
    else setError(failureText(result));
  }

  const active = useMemo(() => (factors ?? []).filter((f) => !f.archived), [factors]);

  return (
    <section className="nz-panel" id="client-factors-manager">
      <div style={{ display: "flex", padding: "13px 16px", borderBottom: "1px solid var(--line2)", alignItems: "center" }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{organisation ? "Organisation emission factors" : "Client emission factors"}</h2>
        <span className="sub" style={{ marginLeft: "auto", fontSize: 12 }}>{active.length} active{jobId ? " · this job + reusable" : ""}</span>
      </div>
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}
      {compact ? <p className="sub" style={{ padding: "8px 16px 0" }}>Reusable or job-pinned factors with EPD evidence hashed into calculation provenance. Manage the full set on the <a href={`/clients/${clientId}`}>client page</a>.</p> : null}
      {organisation ? <p className="sub" style={{ padding: "8px 16px 0" }}>Factors with no client, offered on every client&rsquo;s jobs.</p> : null}
      <div style={{ overflowX: "auto" }}>
        <table className="nz-tbl">
          <thead><tr><th>Factor</th><th>Scope</th><th className="num">kgCO₂e / unit</th><th>Geography</th><th className="num">Vintage</th><th className="num">Version</th><th className="num">In use</th><th>Evidence</th><th /></tr></thead>
          <tbody>
            {(factors ?? []).map((factor) => {
              const isEditing = editing === factor.clientFactorId && draft;
              const showYears = years === factor.clientFactorId;
              return (
                <Fragment key={factor.clientFactorId}>
                <tr style={factor.archived ? { opacity: 0.6 } : undefined}>
                  <td>
                    {isEditing ? <input className="nz-inp" aria-label="Factor label" value={draft.reportLabel} onChange={(e) => setDraft({ ...draft, reportLabel: e.target.value })} /> : <b>{factor.reportLabel}</b>}
                    <div className="muted">{organisation ? "Organisation" : factor.jobId ? "Job-pinned" : "Reusable"}{factor.archived ? " · Archived" : ""}{factor.description ? ` · ${factor.description}` : ""}</div>
                  </td>
                  <td>{factor.scope}</td>
                  <td className="num">
                    {isEditing && !byYear(factor) ? <input className="nz-inp" type="number" min="0" step="any" aria-label="kgCO2e per unit" value={draft.kgco2ePerUnit} onChange={(e) => setDraft({ ...draft, kgco2ePerUnit: Number(e.target.value) })} />
                      : isEditing ? <><input className="nz-inp" type="number" aria-label="kgCO2e per unit" value={draft.kgco2ePerUnit} disabled /><div className="muted">Priced by year · <button type="button" className="nz-editlink" onClick={() => openYears(factor)}>change in Years</button></div></>
                      : factor.kgco2ePerUnit}
                    <div className="muted">/ {isEditing ? <input className="nz-inp" aria-label="Activity unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /> : factor.unit}</div>
                    {!isEditing && byYear(factor) ? <div className="muted">by year: {factor.yearValues!.length}</div> : null}
                  </td>
                  <td>{isEditing ? <input className="nz-inp" aria-label="Geography" value={draft.geography} onChange={(e) => setDraft({ ...draft, geography: e.target.value })} /> : factor.geography}</td>
                  <td className="num">{isEditing ? <input className="nz-inp" type="number" aria-label="Vintage year" value={draft.vintageYear} onChange={(e) => setDraft({ ...draft, vintageYear: Number(e.target.value) })} /> : factor.vintageYear}</td>
                  <td className="num">v{factor.version}</td>
                  <td className="num">{factor.usageCount}</td>
                  <td>{factor.evidenceHash ? <span title={factor.evidenceHash}>{factor.evidenceFileName ?? "hash"} · {factor.evidenceHash.slice(0, 14)}…</span> : <span className="muted">None</span>}{factor.updatedAt ? <div className="muted">Updated {formatDate(factor.updatedAt.slice(0, 10))}</div> : null}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {isEditing ? <>
                      <button className="nz-btn" disabled={pending !== ""} onClick={() => { setEditing(null); setDraft(null); }}>Cancel</button>{" "}
                      <button className="nz-btn pri" disabled={pending !== "" || !draft.reportLabel.trim()} onClick={() => void save(factor)}>{pending === `save:${factor.clientFactorId}` ? "Saving…" : "Save"}</button>
                    </> : <>
                      {factor.archived ? null : <><button className="nz-btn" disabled={pending !== ""} onClick={() => startEdit(factor)}>Edit</button>{" "}
                        <button className="nz-btn" disabled={pending !== ""} aria-expanded={showYears} onClick={() => showYears ? setYears(null) : openYears(factor)}>Years</button>{" "}</>}
                      {factor.foldedInto
                        ? <span className="muted">Folded into {factor.foldedInto.reportLabel ?? factor.foldedInto.clientFactorId}</span>
                        : <button className="nz-btn" disabled={pending !== ""} onClick={() => void toggleArchive(factor)}>{pending === `archive:${factor.clientFactorId}` ? "…" : factor.archived ? "Restore" : "Archive"}</button>}
                    </>}
                  </td>
                </tr>
                {showYears ? <tr className="nz-factor-years">
                  <td colSpan={9}>
                    <div className="sub" style={{ marginBottom: 6 }}>{byYear(factor) ? "Each month is priced at its year's value, else the closest earlier year's, else the earliest." : "No values by year yet: it is priced at its headline. Saving these prices it by year."} Saving makes a new version; rows already priced keep their figures until re-priced.</div>
                    <table className="nz-tbl" style={{ width: "auto" }}>
                      <thead><tr><th className="num">Year</th><th className="num">kgCO₂e / {factor.unit}</th><th /></tr></thead>
                      <tbody>{yearDraft.map((entry) => <tr key={entry.key}>
                        <td className="num"><input className="nz-inp" type="number" aria-label="Year" value={entry.year} onChange={(e) => setYearDraft(yearDraft.map((other) => other.key === entry.key ? { ...other, year: e.target.value } : other))} /></td>
                        <td className="num"><input className="nz-inp" type="number" min="0" step="any" aria-label="kgCO2e per unit for the year" value={entry.value} onChange={(e) => setYearDraft(yearDraft.map((other) => other.key === entry.key ? { ...other, value: e.target.value } : other))} /></td>
                        <td><button type="button" className="nz-btn" disabled={yearDraft.length <= 1} onClick={() => setYearDraft(yearDraft.filter((other) => other.key !== entry.key))}>Remove</button></td>
                      </tr>)}</tbody>
                    </table>
                    <div className="nz-config-actions" style={{ marginTop: 8 }}>
                      <button type="button" className="nz-btn" onClick={() => setYearDraft([...yearDraft, { key: crypto.randomUUID(), year: String(Math.max(0, ...yearDraft.map((entry) => Number(entry.year) || 0)) + 1), value: "" }])}>+ Add a year</button>
                      <button type="button" className="nz-btn" disabled={pending !== ""} onClick={() => setYears(null)}>Cancel</button>
                      <button type="button" className="nz-btn pri" disabled={pending !== ""} onClick={() => void saveYears(factor)}>{pending === `years:${factor.clientFactorId}` ? "Saving…" : "Save years"}</button>
                    </div>
                  </td>
                </tr> : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {factors === null ? <div className="nz-table-empty">Client factors are unavailable.</div> : factors.length === 0 ? <div className="nz-table-empty">{organisation ? "No organisation factors yet." : "No client factors yet."}</div> : null}
      {!compact && (organisation || clientId) ? <div style={{ padding: "10px 16px 14px" }}>
        <ClientFactorCreateForm endpoint={organisation ? "/api/isolated/client-factors" : `/api/isolated/clients/${clientId}/client-factors`} reusableChoice={false}
          label={organisation ? "+ Add organisation factor" : "+ Add client factor"} onCreated={() => void load()} notice={(n) => n.kind === "ok" ? setNotice(n.text) : setError(n.text)} />
      </div> : null}
    </section>
  );
}
