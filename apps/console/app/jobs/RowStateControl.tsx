"use client";
// JW-14 — remove a data-entry row, by what it holds: a draft with no saved data is discarded outright; a console row
// with data is deactivated (kept, figures and all, with a reason) and can be reactivated; a row imported from v7 is
// locked, so nothing is offered. The write decides — this mirrors it (scopeRowIsDiscardable), so a person is offered
// only what the server will accept.
import { useState } from "react";
import { postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { scopeRowIsDiscardable, type ScopeRowReadModel } from "@nzi/contracts";

type Props = {
  jobId: string;
  row: ScopeRowReadModel;
  /** Called after the row is discarded — the drawer that showed it must close. */
  onDiscarded: () => void;
  /** Called after a deactivate or reactivate — the page refreshes. */
  onChanged: () => void;
  notice: (n: { kind: "ok" | "warn"; text: string }) => void;
};

/** The write's own reason when it gives one (ROW_HAS_DATA, ROW_IN_USE…), else its message. */
const failure = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>) =>
  (result.state === "validation_failed" ? result.issues[0]?.message : undefined) ?? result.message;

export function RowStateControl({ jobId, row, onDiscarded, onChanged, notice }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  if (row.origin === "migrated") return null;

  const path = (action: string) => `/api/isolated/jobs/${jobId}/scope-rows/${row.id}/${action}`;
  const discardable = scopeRowIsDiscardable(row);

  async function discard() {
    if (pending) return;
    setPending(true);
    const result = await postBrowserCommand<{ discarded: boolean }>(path("discard"), { expectedVersion: row.version }, crypto.randomUUID());
    setPending(false);
    if (result.state === "success") { notice({ kind: "ok", text: "Draft entry discarded." }); onDiscarded(); }
    else notice({ kind: "warn", text: failure(result) });
  }
  async function setActive(active: boolean) {
    if (pending) return;
    setPending(true);
    const result = active
      ? await postBrowserCommand<{ version: number }>(path("reactivate"), { expectedVersion: row.version }, crypto.randomUUID())
      : await postBrowserCommandWithReason<{ version: number }>(path("deactivate"), { expectedVersion: row.version }, crypto.randomUUID(), reason.trim());
    setPending(false);
    if (result.state === "success") {
      notice({ kind: "ok", text: active ? "Entry reactivated — it counts in the totals again." : "Entry deactivated — kept, and out of the totals." });
      setConfirming(false); setReason(""); onChanged();
    } else notice({ kind: "warn", text: failure(result) });
  }

  if (discardable) {
    return (
      <div className="nz-row-state">
        <button type="button" className="nz-btn" disabled={pending} onClick={discard}>Discard draft</button>
        <span className="nz-hint">Nothing has been saved to this entry yet, so it is removed outright.</span>
      </div>
    );
  }
  if (!row.enabled) {
    return (
      <div className="nz-row-state">
        <span className="nz-st nof">Deactivated</span>
        <button type="button" className="nz-btn" disabled={pending} onClick={() => setActive(true)}>Reactivate</button>
      </div>
    );
  }
  return (
    <div className="nz-row-state">
      {confirming ? (
        <div role="group" aria-label="Deactivate this entry">
          <label className="nz-fl">Why deactivate it? <span className="muted">· kept in the audit trail</span>
            <input className="nz-inp" value={reason} maxLength={500} autoFocus onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. entered twice; duplicate of the March invoice" />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" className="nz-btn pri" disabled={pending || !reason.trim()} onClick={() => setActive(false)}>Deactivate entry</button>
            <button type="button" className="nz-btn" disabled={pending} onClick={() => { setConfirming(false); setReason(""); }}>Cancel</button>
          </div>
          <span className="nz-hint">It leaves data entry and the totals, keeps its figures and review, and can be reactivated.</span>
        </div>
      ) : (
        <button type="button" className="nz-btn" onClick={() => setConfirming(true)}>Deactivate…</button>
      )}
    </div>
  );
}
