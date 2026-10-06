"use client";

// DATASET-CURRENCY §3 (ruled 6 Oct): a job using a fallback edition is told when its reporting year's own is published,
// and can move to it — previewed first (the write's own code, rolled back), then confirmed. A series moves whole; a row
// that cannot move as it is gets a factor in the new edition, or is deactivated, right here in the preview.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Drawer, GatedButton } from "@nzi/ui";
import { postBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import type { DatasetUpdate, JobDatasetUpdatePreview } from "@nzi/isolated-backend";
import { useEditAccess } from "../lib/useEditAccess";

const REASONS: Record<string, string> = {
  FACTOR_MISSING: "its factor is not in the new edition",
  UNIT_CHANGED: "its factor's unit changed in the new edition",
  SCOPE_DROPPED: "its factor no longer covers this scope",
  SOURCE_MANAGED: "it is managed by an emission-register source — move the source first",
};
const tonnes = (value: number) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 3 })} tCO₂e`;
type Resolution = { rowId: string; action: "factor" | "deactivate"; factorId?: string | null };

export function DatasetUpdateBanner({ jobId, updates, writeEnabled }: { jobId: string; updates: DatasetUpdate[]; writeEnabled: boolean }) {
  const access = useEditAccess("scoperow.edit", writeEnabled);
  const [open, setOpen] = useState(false);
  if (updates.length === 0) return null;
  const names = updates.map((update) => update.toLabel);
  return <>
    <div className="nz-banner nz-dataset-update" role="status">
      <div>
        <b>{names.length === 1 ? `${names[0]} dataset is now available.` : `Newer editions are now available: ${names.join(", ")}.`}</b>
        <div className="sub">This job uses {updates.map((update) => update.fromLabel).join(", ")} until its reporting year&rsquo;s edition was published.</div>
      </div>
      {access.state === "allowed" ? <button type="button" className="nz-btn pri" onClick={() => setOpen(true)}>Update now?</button> : null}
    </div>
    <Drawer open={open} onClose={() => setOpen(false)} ariaLabel="Update to the newer dataset editions" className="nz-site-drawer">
      {open ? <UpdateDrawer jobId={jobId} updates={updates} onClose={() => setOpen(false)} /> : null}
    </Drawer>
  </>;
}

function UpdateDrawer({ jobId, updates, onClose }: { jobId: string; updates: DatasetUpdate[]; onClose: () => void }) {
  const router = useRouter();
  const [series, setSeries] = useState<string[]>(updates.map((update) => update.fromDatasetId));
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [preview, setPreview] = useState<JobDatasetUpdatePreview | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const base = `/api/isolated/jobs/${encodeURIComponent(jobId)}/datasets/update`;

  async function load(nextSeries = series, nextResolutions = resolutions) {
    setState("loading"); setError(null);
    try {
      const response = await fetch(`${base}/preview`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ series: nextSeries, resolutions: nextResolutions }) });
      const body = await response.json();
      if (!response.ok) { setError(body?.issues?.[0]?.message ?? body?.message ?? "The preview could not be read."); setPreview(null); }
      else setPreview(body as JobDatasetUpdatePreview);
    } catch { setError("The preview could not be read."); }
    setState("idle");
  }
  if (preview === null && state === "idle" && error === null) void load();

  const resolve = (resolution: Resolution) => {
    const next = [...resolutions.filter((item) => item.rowId !== resolution.rowId), resolution];
    setResolutions(next); void load(series, next);
  };
  const toggle = (fromDatasetId: string) => {
    const next = series.includes(fromDatasetId) ? series.filter((id) => id !== fromDatasetId) : [...series, fromDatasetId];
    setSeries(next); if (next.length) void load(next, resolutions); else setPreview(null);
  };
  const blocked = preview?.series.some((plan) => plan.blocked.length > 0) ?? true;
  const needsReason = preview?.issued ?? false;
  const blockedReason = state !== "idle" ? "Working…" : !preview ? (error ?? "Loading the preview…") : series.length === 0 ? "Choose at least one dataset."
    : blocked ? "Resolve each row listed before moving." : needsReason && !reason.trim() ? "Say why — this job has issued figures." : null;

  async function confirm() {
    if (!preview) return;
    setState("saving"); setError(null);
    // Preview == write: every row the preview moved or deactivated, at the version it read.
    const expected = preview.series.flatMap((plan) => [...plan.moved.map((row) => row.rowId), ...plan.deactivated].map((rowId) => ({ rowId, version: plan.versions[rowId]! })));
    const result: BrowserCommandResult<{ moved: number }> = await postBrowserCommandWithReason(base, { series, expected, resolutions }, crypto.randomUUID(), reason.trim());
    setState("idle");
    if (result.state === "success") { onClose(); router.refresh(); }
    else setError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message);
  }

  return <>
    <div className="nz-dh"><div className="k">Datasets · newer edition</div><h3>Update to the reporting year&rsquo;s editions</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="sub">Each dataset moves whole: its rows move to the same factor in the newer edition and are recalculated. Approved rows return to review; an override is kept and still wins. Nothing changes until you confirm.</p>
      {preview?.issued ? <div className="nz-banner warn" role="note"><div><b>This job has an issued snapshot or published report.</b><div>Those figures stay exactly as issued. This moves the live job forward; re-issuing needs the normal review → snapshot → publish.</div></div></div> : null}
      {updates.map((update) => {
        const plan = preview?.series.find((item) => item.fromDatasetId === update.fromDatasetId);
        const on = series.includes(update.fromDatasetId);
        return <section key={update.fromDatasetId} className="nz-update-series">
          <label className="nz-check"><input type="checkbox" checked={on} onChange={() => toggle(update.fromDatasetId)} /> <b>{update.fromLabel} → {update.toLabel}</b></label>
          {on && plan ? <ul className="sub">
            <li>{plan.moved.length} row{plan.moved.length === 1 ? "" : "s"} move{plan.moved.length === 1 ? "s" : ""}{plan.moved.length === 0 ? " — updates the datasets for new entries" : ""}</li>
            {plan.moved.some((row) => row.reviewStatus === "approved" && row.recalculated) ? <li>{plan.moved.filter((row) => row.reviewStatus === "approved" && row.recalculated).length} approved row(s) return to review</li> : null}
            {plan.moved.some((row) => row.hasOverride) ? <li>{plan.moved.filter((row) => row.hasOverride).length} override(s) kept</li> : null}
            {plan.deactivated.length ? <li>{plan.deactivated.length} row(s) will be deactivated</li> : null}
          </ul> : null}
          {on && plan?.blocked.length ? <div className="nz-update-blocked" role="group" aria-label={`Rows that cannot move to ${update.toLabel}`}>
            <p className="nz-hint">These rows can&rsquo;t move as they are — give each a factor in {update.toLabel}, or deactivate it:</p>
            {plan.blocked.map((row) => <div key={row.rowId} className="nz-update-row">
              <div><b>{row.label}</b> <span className="muted">· {REASONS[row.reason] ?? row.reason}</span></div>
              {row.reason === "SOURCE_MANAGED" ? null : <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <select className="nz-sel" aria-label={`Factor in ${update.toLabel} for ${row.label}`} defaultValue="" onChange={(e) => e.target.value && resolve({ rowId: row.rowId, action: "factor", factorId: e.target.value })}>
                  <option value="">Pick a factor in {update.toLabel}…</option>
                  {row.candidates.map((factor) => <option key={factor.factorId} value={factor.factorId}>{factor.label} · {factor.unit}</option>)}
                </select>
                <button type="button" className="nz-btn" onClick={() => resolve({ rowId: row.rowId, action: "deactivate" })}>Deactivate</button>
              </div>}
            </div>)}
          </div> : null}
        </section>;
      })}
      {preview ? <div className="nz-kv"><span className="k">Job total</span><span className="v">{tonnes(preview.totals.beforeTco2e)} → <b>{tonnes(preview.totals.afterTco2e)}</b></span></div> : null}
      {preview && (preview.untouched.migrated || preview.untouched.clientFactor) ? <p className="sub">Left as they are: {preview.untouched.migrated} row(s) of v7 history, {preview.untouched.clientFactor} on a client factor.</p> : null}
      {needsReason ? <label className="nz-fl"><span>Why move now? <span className="muted">· kept in the audit trail</span></span><input className="nz-inp" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label> : null}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      <span className="sp" />
      <GatedButton className="nz-btn pri" blocked={blockedReason !== null} blockedReason={blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void confirm()}>{state === "saving" ? "Updating…" : "Update and recalculate"}</GatedButton>
    </div>
  </>;
}
