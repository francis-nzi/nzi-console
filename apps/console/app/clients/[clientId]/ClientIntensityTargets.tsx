"use client";

// Redesign Phase 1b (0158) — a client's intensity targets, beside net zero on the Baseline & targets card. One per active
// intensity metric: the baseline intensity it is measured from, and an interim and a final reduction. The job keeps
// only the year's Value (Phase 3 moves its reads here); nothing is set on the job any more.
import { useRef, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { postBrowserCommandWithReason, putBrowserCommand, putBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import type { ClientIntensityTarget, IntensityMetricDefinition } from "@nzi/contracts";
import type { EditAccess } from "../../lib/useEditAccess";

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;
const pct = (value: number | null) => value === null ? null : `−${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
const milestone = (year: number | null, reduction: number | null) => year === null ? null : `${year} ${pct(reduction)}`;

/** The section on the Baseline & targets card: each active metric, its target or "No target", and Set / Edit. */
export function ClientIntensityTargets({ metrics, targets, access, onEdit }: {
  metrics: IntensityMetricDefinition[]; targets: ClientIntensityTarget[]; access: EditAccess; onEdit: (metricKey: string) => void;
}) {
  const active = metrics.filter((metric) => metric.active);
  return <div className="nz-card-b nz-intensity-targets">
    <div className="nz-sect">Intensity metrics</div>
    {active.length === 0
      ? <p className="sub">No intensity metrics are defined for this client — add them from Analytics → Manage metrics.</p>
      : active.map((metric) => {
        const target = targets.find((item) => item.metricKey === metric.key) ?? null;
        return <div key={metric.key} className="nz-kv">
          <span className="k">{metric.label} <span className="muted">· tCO₂e per {metric.unitWording}</span></span>
          <span className="v">{target
            ? [`from ${target.baselineIntensity.toLocaleString("en-GB", { maximumFractionDigits: 6 })} (${target.baselineYear})`, milestone(target.interimYear, target.interimReductionPct), milestone(target.targetYear, target.targetReductionPct)].filter(Boolean).join(" → ")
            : <span className="muted">No target</span>}
            {access.state === "allowed" ? <> · <button type="button" className="nz-editlink" onClick={() => onEdit(metric.key)} aria-label={`${target ? "Edit" : "Set"} the ${metric.label} target`}>{target ? "Edit" : "Set"}</button></> : null}</span>
        </div>;
      })}
  </div>;
}

/** The drawer: set or edit one metric's target, or withdraw it. */
export function IntensityTargetForm({ clientId, metric, target, access, onClose, onSaved }: {
  clientId: string; metric: IntensityMetricDefinition; target: ClientIntensityTarget | null; access: EditAccess;
  onClose: () => void; onSaved: (text: string) => void;
}) {
  const field = (value: number | null | undefined) => value === null || value === undefined ? "" : String(value);
  const [baselineYear, setBaselineYear] = useState(field(target?.baselineYear));
  const [baselineIntensity, setBaselineIntensity] = useState(field(target?.baselineIntensity));
  const [interimYear, setInterimYear] = useState(field(target?.interimYear));
  const [interimPct, setInterimPct] = useState(field(target?.interimReductionPct));
  const [targetYear, setTargetYear] = useState(field(target?.targetYear));
  const [targetPct, setTargetPct] = useState(field(target?.targetReductionPct));
  const [reason, setReason] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  const num = (value: string) => value.trim() === "" ? null : Number(value);
  const input = {
    metricKey: metric.key, expectedVersion: target?.version ?? 0,
    baselineYear: num(baselineYear), baselineIntensity: num(baselineIntensity),
    interimYear: num(interimYear), interimReductionPct: num(interimPct), targetYear: num(targetYear), targetReductionPct: num(targetPct),
  };
  // Moving the baseline of a held target restates what the client committed to measure from — the write asks why.
  const movesBaseline = target !== null && (input.baselineYear !== target.baselineYear || input.baselineIntensity !== target.baselineIntensity);
  const problem = (() => {
    if (input.baselineYear === null || input.baselineIntensity === null) return "Give the baseline year and its intensity.";
    if ((input.interimYear === null) !== (input.interimReductionPct === null)) return "The interim needs both a year and a reduction, or neither.";
    if ((input.targetYear === null) !== (input.targetReductionPct === null)) return "The target needs both a year and a reduction, or neither.";
    if (input.interimYear === null && input.targetYear === null) return "Set an interim or a final target.";
    if (movesBaseline && !reason.trim()) return "Say why the baseline moves.";
    return null;
  })();

  async function save() {
    setPending(true); setError(null);
    key.current ??= crypto.randomUUID();
    const path = `/api/isolated/clients/${encodeURIComponent(clientId)}/intensity-targets`;
    const result = movesBaseline ? await putBrowserCommandWithReason<{ version: number }>(path, input, key.current, reason.trim()) : await putBrowserCommand<{ version: number }>(path, input, key.current);
    setPending(false);
    if (result.state === "success") onSaved(`${metric.label} target saved.`);
    else { setError(errorText(result)); key.current = null; }
  }
  async function withdraw() {
    if (!target) return;
    setPending(true); setError(null);
    const result = await postBrowserCommandWithReason<{ version: number }>(`/api/isolated/clients/${encodeURIComponent(clientId)}/intensity-targets`, { metricKey: metric.key, expectedVersion: target.version }, crypto.randomUUID(), reason.trim());
    setPending(false);
    if (result.state === "success") onSaved(`${metric.label} target withdrawn — kept in the record.`);
    else setError(errorText(result));
  }

  const blockedReason = access.state !== "allowed" ? access.reason : problem;
  return <>
    <div className="nz-dh"><div className="k">Commitment · intensity</div><h3>{metric.label} target</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="sub">Measured as tCO₂e per {metric.unitWording}. Each job records the year&rsquo;s Value; the intensity is its emissions divided by that.</p>
      <div className="nz-two">
        <label className="nz-fl"><span>Baseline year<span className="nz-req">*</span></span><input className="nz-inp" inputMode="numeric" value={baselineYear} onChange={(e) => setBaselineYear(e.target.value)} /></label>
        <label className="nz-fl"><span>Baseline intensity<span className="nz-req">*</span></span><input className="nz-inp num" inputMode="decimal" value={baselineIntensity} onChange={(e) => setBaselineIntensity(e.target.value)} /></label>
      </div>
      <div className="nz-two">
        <label className="nz-fl"><span>Interim year</span><input className="nz-inp" inputMode="numeric" value={interimYear} onChange={(e) => setInterimYear(e.target.value)} /></label>
        <label className="nz-fl"><span>Interim reduction %</span><input className="nz-inp num" inputMode="decimal" value={interimPct} onChange={(e) => setInterimPct(e.target.value)} /></label>
      </div>
      <div className="nz-two">
        <label className="nz-fl"><span>Target year</span><input className="nz-inp" inputMode="numeric" value={targetYear} onChange={(e) => setTargetYear(e.target.value)} /></label>
        <label className="nz-fl"><span>Target reduction %</span><input className="nz-inp num" inputMode="decimal" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} /></label>
      </div>
      {movesBaseline || withdrawing ? <label className="nz-fl"><span>{withdrawing ? "Why withdraw it?" : "Why does the baseline move?"} <span className="muted">· kept in the audit trail</span></span>
        <input className="nz-inp" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label> : null}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
      {target && access.state === "allowed"
        ? withdrawing
          ? <button type="button" className="nz-btn" disabled={pending || !reason.trim()} onClick={() => void withdraw()}>Withdraw target</button>
          : <button type="button" className="nz-btn" onClick={() => { setWithdrawing(true); setReason(""); }}>Withdraw…</button>
        : null}
      <span className="sp" />
      {withdrawing ? null : <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : "Save target"}</GatedButton>}
    </div>
  </>;
}
