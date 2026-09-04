"use client";

// NZC-063 — "Reuse Previous Year Rows": roll last year's canonical rows
// forward, factor + hierarchy copied in, ready for this year's quantities.
// Generalises the spend-only rollforward (SpendRollforwardPanel,
// job_emission_sources) to every row type via job_scope_rows directly, so a
// plain manually-added row rolls forward exactly like a synced one.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand } from "@nzi/api-client";
import type { ScopeRowRollforwardPreview } from "@nzi/contracts";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;

export function ReuseYearPanel({ jobId, onRowsCreated, notice }: { jobId: string; onRowsCreated: (rowIds: string[]) => void; notice: Notice }) {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [preview, setPreview] = useState<ScopeRowRollforwardPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/scope-rows/rollforward`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = (await response.json()) as ScopeRowRollforwardPreview;
      setPreview(body);
      setSelected(new Set());
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  const pending = preview?.rows.filter((row) => !row.alreadyRolledForward) ?? [];
  const moved = pending.filter((row) => row.factorVersionMoved).length;
  const allSelected = pending.length > 0 && pending.every((row) => selected.has(row.priorRowId));

  function toggle(rowId: string) {
    setSelected((current) => { const next = new Set(current); next.has(rowId) ? next.delete(rowId) : next.add(rowId); return next; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(pending.map((row) => row.priorRowId)));
  }

  async function rollForward() {
    if (busy || selected.size === 0 || !preview?.priorJob) return;
    setBusy(true);
    const result = await postBrowserCommand<{ rolledForward: number; skipped: number; createdRowIds: string[]; priorJobNumber: string | null }>(
      `/api/isolated/jobs/${jobId}/scope-rows/rollforward`,
      { priorJobId: preview.priorJob.id, rowIds: [...selected] },
      crypto.randomUUID(),
    );
    setBusy(false);
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    const { rolledForward, skipped, createdRowIds } = result.data;
    notice({
      kind: rolledForward ? "ok" : "warn",
      text: rolledForward
        ? `${rolledForward} row${rolledForward === 1 ? "" : "s"} rolled forward as pending — factor and hierarchy carried in, quantity empty${skipped ? ` (${skipped} already rolled forward, skipped)` : ""}.`
        : "No new rows to roll forward.",
    });
    if (createdRowIds.length) onRowsCreated(createdRowIds);
    await load();
    router.refresh();
  }

  return (
    <div className="nz-fast-add-reuse" id="reuse-year-panel">
      <div className="nz-fast-add-reuse-h">
        <b>Reuse Previous Year Rows</b>
        <span className={`nz-st ${pending.length ? "need" : "done"}`}>{state === "loading" ? "…" : `${pending.length} available`}</span>
      </div>
      <p className="sub">Copy last year's rows forward — factor and hierarchy carried in, amounts not. Enter this year's figures next.</p>

      {state === "loading" ? (
        <div className="nz-table-empty" role="status">Looking for a prior reporting year…</div>
      ) : state === "failed" ? (
        <div className="nz-banner warn" role="alert">The previous-year lookup is unavailable.</div>
      ) : !preview?.priorJob ? (
        <div className="nz-table-empty">No prior-year CRP job with rows was found for this client.</div>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            From <b>{preview.priorJob.number}</b> · FY{preview.priorJob.reportingYear}
            {moved > 0 ? <> · <span className="nz-reuse-moved">{moved} factor version{moved === 1 ? "" : "s"} moved — re-check</span></> : null}
          </p>
          <div className="nz-reuse-list">
            <label className="nz-reuse-row nz-reuse-all">
              <input type="checkbox" checked={allSelected} disabled={pending.length === 0} onChange={toggleAll} />
              <span>Select all ({pending.length})</span>
            </label>
            {preview.rows.map((row) => (
              <label key={row.priorRowId} className={`nz-reuse-row${row.alreadyRolledForward ? " done" : ""}`}>
                <input type="checkbox" checked={selected.has(row.priorRowId)} disabled={row.alreadyRolledForward} onChange={() => toggle(row.priorRowId)} />
                <span className="nz-reuse-info">
                  <b>{row.sourceLabel}</b>
                  <span className="nz-reuse-meta">Scope {row.scope} · {row.categoryLabel}{row.siteLabel ? ` · ${row.siteLabel}` : ""} · {row.factorLabel ?? "No factor"}</span>
                </span>
                {row.alreadyRolledForward
                  ? <span className="nz-st done">Already rolled forward</span>
                  : row.factorVersionMoved
                    ? <span className="nz-st need" title={`Pinned ${row.pinnedFactorVersion ?? "—"}, now ${row.currentFactorVersion ?? "—"}`}>⚠ factor moved</span>
                    : !row.datasetInJobSelection
                      ? <span className="nz-st need">dataset not in selection</span>
                      : null}
              </label>
            ))}
          </div>
          <div className="nz-config-actions" style={{ marginTop: 10 }}>
            <button type="button" className="nz-btn pri" disabled={busy || selected.size === 0} onClick={() => void rollForward()}>
              {busy ? "Rolling forward…" : `Roll forward ${selected.size || ""} row${selected.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
