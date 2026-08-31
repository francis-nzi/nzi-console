"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { patchBrowserCommand, postBrowserCommand } from "@nzi/api-client";
import { formatDate } from "../lib/formatDate";

// S2 — the client-level client-factor management surface (NZC-041, flag
// `client-factors`). List · versioned edit · archive/un-archive. Creation stays
// in a job workspace (a factor is authored in the context of methodology work);
// this surface links there.
type ClientFactor = {
  clientFactorId: string; clientId: string; jobId: string | null; scope: string; reportLabel: string; description: string;
  unit: string; ghgUnit: string; kgco2ePerUnit: number; geography: string; vintageYear: number; version: number; source: string;
  evidenceFileName: string | null; evidenceStorageProvider: "local" | "sharepoint" | null; evidenceUrl: string | null;
  evidenceExternalItemId: string | null; evidenceHash: string | null; archived: boolean; usageCount: number;
  createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string | null;
};
type Edit = { reportLabel: string; description: string; unit: string; kgco2ePerUnit: number; geography: string; vintageYear: number; source: string; evidenceFileName: string; evidenceHash: string };

export function ClientFactorsManager({ clientId, jobId, compact = false }: { clientId: string; jobId?: string; compact?: boolean }) {
  const [factors, setFactors] = useState<ClientFactor[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Edit | null>(null);
  const [pending, setPending] = useState("");

  const load = useCallback(async () => {
    try {
      const url = `/api/isolated/clients/${clientId}/client-factors${jobId ? `?jobId=${jobId}` : ""}`;
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.factors)) throw new Error(body.message ?? "Client factors are unavailable.");
      setFactors(body.factors);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Client factors are unavailable.");
      setFactors(null);
    }
  }, [clientId, jobId]);
  useEffect(() => { void load(); }, [load]);

  const startEdit = (factor: ClientFactor) => {
    setEditing(factor.clientFactorId);
    setDraft({ reportLabel: factor.reportLabel, description: factor.description, unit: factor.unit, kgco2ePerUnit: factor.kgco2ePerUnit, geography: factor.geography, vintageYear: factor.vintageYear, source: factor.source, evidenceFileName: factor.evidenceFileName ?? "", evidenceHash: factor.evidenceHash ?? "" });
  };

  async function save(factor: ClientFactor) {
    if (!draft) return;
    setPending(`save:${factor.clientFactorId}`); setError(""); setNotice("");
    const result = await patchBrowserCommand<{ version: number; versionBumped: boolean }>(
      `/api/isolated/clients/${clientId}/client-factors/${factor.clientFactorId}`,
      { expectedVersion: factor.version, reportLabel: draft.reportLabel, description: draft.description, unit: draft.unit, kgco2ePerUnit: draft.kgco2ePerUnit, geography: draft.geography, vintageYear: draft.vintageYear, source: draft.source, evidenceFileName: draft.evidenceFileName || null, evidenceStorageProvider: draft.evidenceFileName ? "sharepoint" : null, evidenceUrl: null, evidenceExternalItemId: null, evidenceHash: draft.evidenceHash || null },
      crypto.randomUUID(),
    );
    setPending("");
    if (result.state === "success") {
      setNotice(result.data.versionBumped ? `Factor updated to v${result.data.version}. Existing rows keep their pinned version until re-calculated.` : "Factor details updated.");
      setEditing(null); setDraft(null); await load();
    } else setError(result.state === "validation_failed" ? result.issues.map((i) => i.message).join(" ") : result.state === "conflict" ? "This factor changed elsewhere — reloaded. Review it before retrying." : result.message);
    if (result.state === "conflict") await load();
  }

  async function toggleArchive(factor: ClientFactor) {
    if (!factor.archived && !window.confirm(`Archive "${factor.reportLabel}"? It will no longer be selectable on new rows.`)) return;
    setPending(`archive:${factor.clientFactorId}`); setError(""); setNotice("");
    const result = await postBrowserCommand<{ archived: boolean }>(`/api/isolated/clients/${clientId}/client-factors/${factor.clientFactorId}`, { archived: !factor.archived }, crypto.randomUUID());
    setPending("");
    if (result.state === "success") { setNotice(result.data.archived ? "Factor archived." : "Factor restored."); await load(); }
    else setError(result.state === "validation_failed" ? result.issues.map((i) => i.message).join(" ") : result.message);
  }

  const active = useMemo(() => (factors ?? []).filter((f) => !f.archived), [factors]);

  return (
    <section className="nz-panel" id="client-factors-manager">
      <div style={{ display: "flex", padding: "13px 16px", borderBottom: "1px solid var(--line2)", alignItems: "center" }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Client emission factors</h2>
        <span className="sub" style={{ marginLeft: "auto", fontSize: 12 }}>{active.length} active{jobId ? " · this job + reusable" : ""}</span>
      </div>
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}
      {compact ? <p className="sub" style={{ padding: "8px 16px 0" }}>Reusable or job-pinned factors with EPD evidence hashed into calculation provenance. Manage the full set on the <a href={`/clients/${clientId}`}>client page</a>.</p> : null}
      <div style={{ overflowX: "auto" }}>
        <table className="nz-tbl">
          <thead><tr><th>Factor</th><th>Scope</th><th className="num">kgCO₂e / unit</th><th>Geography</th><th className="num">Vintage</th><th className="num">Version</th><th className="num">In use</th><th>Evidence</th><th /></tr></thead>
          <tbody>
            {(factors ?? []).map((factor) => {
              const isEditing = editing === factor.clientFactorId && draft;
              return (
                <tr key={factor.clientFactorId} style={factor.archived ? { opacity: 0.6 } : undefined}>
                  <td>
                    {isEditing ? <input className="nz-inp" aria-label="Factor label" value={draft.reportLabel} onChange={(e) => setDraft({ ...draft, reportLabel: e.target.value })} /> : <b>{factor.reportLabel}</b>}
                    <div className="muted">{factor.jobId ? "Job-pinned" : "Reusable"}{factor.archived ? " · Archived" : ""}{factor.description ? ` · ${factor.description}` : ""}</div>
                  </td>
                  <td>{factor.scope}</td>
                  <td className="num">{isEditing ? <input className="nz-inp" type="number" min="0" step="any" aria-label="kgCO2e per unit" value={draft.kgco2ePerUnit} onChange={(e) => setDraft({ ...draft, kgco2ePerUnit: Number(e.target.value) })} /> : factor.kgco2ePerUnit}<div className="muted">/ {isEditing ? <input className="nz-inp" aria-label="Activity unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /> : factor.unit}</div></td>
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
                      {factor.archived ? null : <><button className="nz-btn" disabled={pending !== ""} onClick={() => startEdit(factor)}>Edit</button>{" "}</>}
                      <button className="nz-btn" disabled={pending !== ""} onClick={() => void toggleArchive(factor)}>{pending === `archive:${factor.clientFactorId}` ? "…" : factor.archived ? "Restore" : "Archive"}</button>
                    </>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {factors === null ? <div className="nz-table-empty">Client factors are unavailable.</div> : factors.length === 0 ? <div className="nz-table-empty">No client factors yet. Add one from a job workspace.</div> : null}
    </section>
  );
}
