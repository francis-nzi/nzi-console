"use client";

import { useRef, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { putBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import { forwardTargetFields, type ForwardTargetModel, type TargetBenchmark, type TargetMilestone, type TargetScope } from "@nzi/contracts";
import type { ClientTargetsReadModel } from "@nzi/isolated-backend";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * NZC-072 — Baseline & targets (client workspace v10). The baseline is the past anchor,
 * read here and restated only through Re-baseline; the targets are the forward
 * commitment, edited here and measured against that benchmark. A client with nothing set
 * says "No targets set" — never zeros.
 */

type Draft = Record<(typeof forwardTargetFields)[number], { year: string; pct: string }>;

const SCOPE_LABEL: Record<TargetScope, string> = { "1": "Scope 1", "2": "Scope 2", "3": "Scope 3" };
const FY = (year: number) => `FY${String(year).slice(-2)}`;
const tonnes = (value: number) => `${Math.round(value).toLocaleString("en-GB")} tCO₂e`;
const pct = (value: number) => `−${Number.isInteger(value) ? value : value.toFixed(1)}%`;
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

const draftFrom = (model: ForwardTargetModel | null): Draft => {
  const field = (milestone: TargetMilestone | null | undefined) => ({ year: milestone ? String(milestone.year) : "", pct: milestone ? String(milestone.pct) : "" });
  return {
    nearTerm: field(model?.nearTerm), netZero: field(model?.netZero),
    scope1: field(model?.scopes["1"]), scope2: field(model?.scopes["2"]), scope3: field(model?.scopes["3"]),
  };
};

/** The card. The Reduction targets drawer lives in the workspace's drawer host. */
export function ClientTargets({ targets, access, onEdit, hideHead = false }: { targets: ClientTargetsReadModel; access: EditAccess; onEdit: () => void; hideHead?: boolean }) {
  const benchmark = targets.benchmark ?? targets.benchmarkInForce;
  const model = targets.model;
  const scopeLine = (["1", "2", "3"] as const)
    .map((scope) => { const milestone = model?.scopes[scope]; return milestone ? `${SCOPE_LABEL[scope].replace("Scope ", "S")} ${pct(milestone.pct)} by ${milestone.year}` : null; })
    .filter(Boolean).join(" · ");

  const editButton = <GatedButton className="nz-editlink" blocked={access.state !== "allowed" || !targets.benchmarkInForce}
        blockedReason={access.state === "allowed" ? (targets.benchmarkInForce ? undefined : "Set the client's baseline before its targets.") : access.reason}
        reasonClassName="hint nz-gated-reason" onClick={onEdit}>Edit</GatedButton>;
  return <section className={hideHead ? "nz-panel bare" : "nz-panel"}>
    {hideHead
      ? <div className="nz-card-b" style={{ paddingBottom: 0, display: "flex", justifyContent: "flex-end" }}>{editButton}</div>
      : <div className="nz-card-h"><span className="eyebrow">Commitment</span><h2>Baseline &amp; targets</h2><span className="sp" />{editButton}</div>}
    <div className="nz-card-b">
      <div className="nz-kv"><span className="k">Baseline in force</span><span className="v">{targets.benchmarkInForce
        ? <>{FY(targets.benchmarkInForce.year)} · {tonnes(targets.benchmarkInForce.totalTco2e)}</>
        : "Not set"}</span></div>
      {targets.benchmarkInForce ? null : <p className="nz-maps">Targets are reductions against the baseline, so the baseline comes first — set it on the client record.</p>}

      {model
        ? <>
          <div className="nz-kv" style={{ marginTop: 10 }}><span className="k">Targets</span><span className="v">{benchmark ? `vs ${FY(benchmark.year)} benchmark` : ""}</span></div>
          <div className="nz-tgt">
            {model.nearTerm ? <span className="nz-tgtchip">Near-term <b>{model.nearTerm.year} · {pct(model.nearTerm.pct)}</b></span> : null}
            {model.netZero ? <span className="nz-tgtchip">Net zero <b>{model.netZero.year} · {pct(model.netZero.pct)}</b></span> : null}
          </div>
          {scopeLine ? <div className="nz-scopetgts">{scopeLine}</div> : null}
          {targets.latestGap && targets.latestGap.targetTco2e !== null
            ? <div className={`nz-kv`} style={{ marginTop: 8 }}><span className="k">{FY(targets.latestGap.year)} vs target line</span><span className={`v ${targets.latestGap.status === "behind" ? "up" : "ok"}`}>
              {tonnes(targets.latestGap.actualTco2e)} vs {tonnes(targets.latestGap.targetTco2e)} · {targets.latestGap.status === "on-track" ? "on track" : targets.latestGap.status === "behind" ? `${Math.abs(targets.latestGap.gapPct ?? 0).toFixed(1)}% above` : `${Math.abs(targets.latestGap.gapPct ?? 0).toFixed(1)}% below`}
            </span></div>
            : null}
        </>
        : <p className="sub" style={{ margin: "10px 0 0" }}><b>No targets set.</b> The reduction pathway and the gap engine need a near-term or net-zero commitment before they can measure progress.</p>}

      {targets.benchmarkStale && targets.benchmark
        ? <div className="nz-banner warn" role="status" style={{ marginTop: 12 }}>
          <div><b>Targets held on a superseded benchmark.</b><div style={{ marginTop: 4 }}>They were set against {FY(targets.benchmark.year)} · {tonnes(targets.benchmark.totalTco2e)}, and the baseline in force is now {targets.benchmarkInForce ? `${FY(targets.benchmarkInForce.year)} · ${tonnes(targets.benchmarkInForce.totalTco2e)}` : "unset"}. They keep measuring against the benchmark they were set against until they are restated deliberately.</div></div>
        </div>
        : null}
    </div>
  </section>;
}

export function TargetsForm({ clientId, targets, access, onClose, onSaved }: {
  clientId: string; targets: ClientTargetsReadModel; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(draftFrom(targets.model));
  const [reason, setReason] = useState("");
  const [restate, setRestate] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const benchmark = targets.benchmarkInForce as TargetBenchmark;
  const stale = targets.benchmarkStale && targets.model !== null;

  const set = (field: keyof Draft, part: "year" | "pct", value: string) => setDraft((current) => ({ ...current, [field]: { ...current[field], [part]: value } }));
  const milestone = (field: keyof Draft) => {
    const { year, pct: percent } = draft[field];
    return { year: year.trim() === "" ? null : Number(year), pct: percent.trim() === "" ? null : Number(percent) };
  };
  const problem = (() => {
    for (const field of forwardTargetFields) {
      const { year, pct: percent } = milestone(field);
      if ((year === null) !== (percent === null)) return "Each target needs both its year and its reduction.";
      if (year !== null && (!Number.isInteger(year) || year <= benchmark.year)) return `Target years come after the ${benchmark.year} benchmark year.`;
      if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) return "Reductions are between 0 and 100%.";
    }
    const near = milestone("nearTerm"), net = milestone("netZero");
    if (near.year !== null && net.year !== null && net.year < near.year) return "The net-zero year cannot come before the near-term year.";
    if (near.pct !== null && net.pct !== null && net.pct < near.pct) return "The net-zero reduction cannot be smaller than the near-term one.";
    if (stale && !restate) return "Confirm that you are restating these targets against the new benchmark.";
    if (stale && restate && !reason.trim()) return "Give a reason for restating the targets.";
    return null;
  })();

  async function save() {
    setPending(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    const input = {
      expectedVersion: targets.version,
      ...Object.fromEntries(forwardTargetFields.map((field) => [field, milestone(field)])),
      ...(stale ? { restateAgainstBenchmark: restate } : {}),
    };
    const result = await putBrowserCommandWithReason<{ version: number }>(`/api/isolated/clients/${encodeURIComponent(clientId)}/targets`, input, key.current, stale ? reason : "");
    setPending(false);
    if (result.state !== "success") {
      key.current = null;
      setError(result.state === "conflict" ? "The targets changed since this was opened. Close and reopen to see the latest." : errorText(result));
      return;
    }
    key.current = null;
    onSaved(stale ? "Targets restated against the new benchmark." : "Targets saved.");
  }

  const blockedReason = access.state !== "allowed" ? access.reason : problem;
  const pair = (field: keyof Draft, label: string, yearLabel = "Target year", required = false) => <div className="nz-two" key={field}>
    <label className="nz-fl"><span>{label} year{required ? <span className="nz-req">*</span> : null}</span><input className="nz-inp num" inputMode="numeric" value={draft[field].year} placeholder={yearLabel} onChange={(event) => set(field, "year", event.target.value)} /></label>
    <label className="nz-fl"><span>Reduction vs benchmark{required ? <span className="nz-req">*</span> : null}</span><input className="nz-inp num" inputMode="decimal" value={draft[field].pct} placeholder="%" onChange={(event) => set(field, "pct", event.target.value)} /></label>
  </div>;

  return <>
    <div className="nz-dh"><div className="k">Baseline &amp; targets</div><h3>Reduction targets</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <p className="nz-hint" style={{ marginTop: 0 }}>The forward commitment. These drive the reduction pathway and the gap engine. The <b>baseline</b> — the past anchor — is set separately through Re-baseline; change it there, not here.</p>
      <label className="nz-fl"><span>Benchmark year</span>
        <input className="nz-inp" value={`FY${benchmark.year} · ${tonnes(benchmark.totalTco2e)}`} disabled readOnly />
        <span className="nz-hint">Read from the baseline in force. Targets are measured as reductions against this.</span>
      </label>
      <div className="nz-sect">Near-term target</div>
      {pair("nearTerm", "Target")}
      <div className="nz-sect">Net-zero target</div>
      {pair("netZero", "Net-zero")}
      <span className="nz-hint">A 90% reduction leaves a 10% residual to address through removals — the pathway ends where the commitment does, not at zero.</span>
      <div className="nz-sect">Per-scope targets</div>
      {(["1", "2", "3"] as const).map((scope) => pair(`scope${scope}` as keyof Draft, SCOPE_LABEL[scope]))}

      {stale ? <div className="nz-banner warn" role="status" style={{ marginTop: 12 }}>
        <div><b>The benchmark has moved since these targets were set.</b>
          <div style={{ marginTop: 4 }}>They are held against {FY(targets.benchmark!.year)} · {tonnes(targets.benchmark!.totalTco2e)}. Saving restates them against {FY(benchmark.year)} · {tonnes(benchmark.totalTco2e)}, which changes the pathway and the gap.</div>
          <label className="nz-check"><input type="checkbox" checked={restate} onChange={(event) => setRestate(event.target.checked)} /> Restate these targets against the new benchmark</label>
          {restate ? <label className="nz-fl" style={{ marginTop: 8 }}><span>Reason for restating</span><input className="nz-inp" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Base year restated after the London HQ relocation" /></label> : null}
        </div>
      </div> : null}

      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Targets are <b>versioned and audited</b>. When a re-baseline restates the benchmark, targets are <b>held</b> by default and only restated as an explicit, recorded choice (NZC-068).</span></div>
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button><span className="sp" />
      <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : "Save targets"}</GatedButton>
    </div>
  </>;
}
