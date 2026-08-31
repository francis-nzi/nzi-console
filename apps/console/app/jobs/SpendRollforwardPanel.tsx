"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand } from "@nzi/api-client";
import type { SpendRollforwardPreview } from "@nzi/contracts";

type Notice = (value: { kind: "ok" | "warn"; text: string }) => void;

export function SpendRollforwardPanel({ jobId, notice }: { jobId: string; notice: Notice }) {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [preview, setPreview] = useState<SpendRollforwardPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/spend-rollforward`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = (await response.json()) as SpendRollforwardPreview;
      setPreview(body);
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = preview?.lines.filter((line) => !line.alreadyRolledForward) ?? [];
  const moved = pending.filter((line) => line.factorVersionMoved).length;

  async function rollForward() {
    if (busy || pending.length === 0) return;
    setBusy(true);
    const result = await postBrowserCommand<{ rolledForward: number; skipped: number; priorJobNumber: string | null }>(
      `/api/isolated/jobs/${jobId}/spend-rollforward`,
      { fromJobId: null },
      crypto.randomUUID(),
    );
    setBusy(false);
    if (result.state !== "success") {
      notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.message });
      return;
    }
    const { rolledForward, skipped } = result.data;
    notice({
      kind: rolledForward ? "ok" : "warn",
      text: rolledForward
        ? `${rolledForward} spend mapping${rolledForward === 1 ? "" : "s"} rolled forward as pending sources${skipped ? ` (${skipped} skipped)` : ""}. Enter this year's figures, then each row runs the standard calculation and independent review.`
        : "No new spend mappings to roll forward.",
    });
    await load();
    router.refresh();
  }

  return (
    <section className="nz-panel nz-config-panel" id="spend-rollforward">
      <div className="nz-config-head">
        <div>
          <span className="nz-eyebrow">Data entry · spend (flagged preview)</span>
          <b>Roll forward last year's spend</b>
          <div className="sub">
            Copy the prior reporting year's spend mappings — description, controlled category and emission factor — forward as fresh, unreviewed sources, re-pinning the factor version last year's report used. Amounts are not carried; enter this year's figures.
          </div>
        </div>
        <span className={`nz-st ${pending.length ? "need" : "done"}`}>
          {state === "loading" ? "…" : `${pending.length} to roll forward`}
        </span>
      </div>

      {state === "loading" ? (
        <div className="nz-table-empty" role="status">Looking for a prior reporting year…</div>
      ) : state === "failed" ? (
        <div className="nz-banner warn" role="alert">The previous-year lookup is unavailable.</div>
      ) : !preview?.priorJob ? (
        <div className="nz-table-empty">No prior-year CRP job with spend mappings was found for this client. Nothing to roll forward.</div>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            From <b>{preview.priorJob.number}</b> · FY{preview.priorJob.reportingYear}
            {moved > 0 ? <> · <span style={{ color: "#8A6410" }}>{moved} factor version{moved === 1 ? "" : "s"} moved since — flagged for re-review</span></> : null}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="nz-tbl">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Factor</th>
                  <th>Pinned version</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <tr key={line.priorSourceId}>
                    <td>{line.description}{line.glCode ? <div className="muted">GL {line.glCode}</div> : null}</td>
                    <td>{line.purchasedGoodsCategoryLabel ?? <span className="muted">— none —</span>}</td>
                    <td>{line.factorLabel ?? <span className="muted">No factor</span>}</td>
                    <td>
                      {line.pinnedFactorVersion ?? "—"}
                      {line.factorVersionMoved ? (
                        <div className="nz-hint" style={{ color: "#8A6410" }} role="note">⚠ now {line.currentFactorVersion} — re-review</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`nz-st ${line.alreadyRolledForward ? "done" : "need"}`}>
                        {line.alreadyRolledForward ? "Already rolled forward" : "Pending"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="nz-config-actions" style={{ marginTop: 12 }}>
            <button type="button" className="nz-btn pri" disabled={busy || pending.length === 0} onClick={() => void rollForward()}>
              {busy ? "Rolling forward…" : `Roll forward ${pending.length} mapping${pending.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
