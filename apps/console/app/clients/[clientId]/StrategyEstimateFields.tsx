"use client";

import { useState } from "react";
import { Collapsible, GatedButton } from "@nzi/ui";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import {
  estimateConfidences, estimateScopes, estimateUnitLabels, resolveEstimateTco2e,
  type ClientStrategy, type EstimateConfidence, type EstimateScope, type EstimateUnit,
  type LibraryStrategy, type TargetBenchmark,
} from "@nzi/contracts";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * What this strategy is expected to save — the entry half of NZC-078.
 *
 * Its own section with its own action, not a field on the strategy form. An estimate is a
 * separate governed fact with its own command and its own audit entry; folding it into Save
 * would let a consultant change a carbon figure while editing a target date.
 *
 * **Refuses rather than zeroes.** A percentage needs a baseline for its scope. Where there
 * is none the form says so — the same refusal the command makes server-side — because
 * "we have no baseline for that scope" and "this saves nothing" are opposite claims, and a
 * 0 here would go straight into the projected trajectory as an agreed figure.
 *
 * The preview is feedback only. The stored figure is resolved by the command against the
 * benchmark in force, so what is saved is never whatever the browser happened to compute.
 */

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

const confidenceLabels: Record<EstimateConfidence, string> = { low: "Low", medium: "Medium", high: "High" };

export function StrategyEstimateFields({ strategy, benchmark, libraryDefault, access, onSaved }: {
  strategy: ClientStrategy;
  /** The baseline a percentage resolves against — the same one the target pathway uses. */
  benchmark: TargetBenchmark | null;
  /** The catalogue entry this strategy came from, where it has one and it carries a figure. */
  libraryDefault: LibraryStrategy | null;
  access: EditAccess;
  onSaved: (text: string) => void;
}) {
  const existing = strategy.estimate;
  const [unit, setUnit] = useState<EstimateUnit>(existing?.unit ?? "tco2e_per_year");
  const [amount, setAmount] = useState(existing === null ? "" : String(existing.amount));
  const [scope, setScope] = useState<EstimateScope>(existing?.scope ?? defaultScope(strategy));
  const [assumptions, setAssumptions] = useState(existing?.assumptions ?? "");
  const [confidence, setConfidence] = useState<EstimateConfidence | "">(existing?.confidence ?? "");
  // Provenance follows the act: a seeded figure stays library-default until it is changed.
  const [seeded, setSeeded] = useState<{ version: number } | null>(
    existing?.source === "library-default" && existing.sourceVersion !== null ? { version: existing.sourceVersion } : null);
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(amount);
  const hasAmount = amount.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  // Mirrors the command exactly: null means "cannot be resolved", never zero.
  const resolved = hasAmount ? resolveEstimateTco2e({ amount: parsed, unit, scope }, benchmark) : null;
  const scopeBaseline = benchmark?.scopes[scope];
  const unresolvable = hasAmount && unit === "percent" && resolved === null;

  const seedFrom = () => {
    if (libraryDefault?.modelledImpact == null) return;
    setUnit("tco2e_per_year");
    setAmount(String(libraryDefault.modelledImpact.tco2ePerYear));
    setAssumptions(libraryDefault.modelledImpact.basis);
    setSeeded({ version: libraryDefault.version });
    setError(null);
  };

  // Any edit after a seed makes it the consultant's own figure, so the provenance stops
  // claiming the catalogue stands behind a number the catalogue never gave.
  const touched = <T,>(set: (value: T) => void) => (value: T) => { set(value); setSeeded(null); };

  const problem = !hasAmount ? "Enter the expected reduction."
    : unit === "percent" && parsed > 100 ? "A reduction cannot be more than 100% of the scope it applies to."
      : unresolvable ? `There is no baseline for scope ${scope}, so a percentage cannot be resolved.`
        : assumptions.trim() === "" ? "Say what this estimate rests on."
          : null;

  async function submit(next: "save" | "clear") {
    setPending(next); setError(null);
    const result = await postBrowserCommand<{ tco2ePerYear: number | null }>(
      `/api/isolated/clients/${encodeURIComponent(strategy.clientId)}/strategies/estimate`,
      {
        clientStrategyId: strategy.id, expectedVersion: strategy.version,
        estimate: next === "clear" ? null : {
          amount: parsed, unit, scope, assumptions: assumptions.trim(),
          confidence: confidence === "" ? null : confidence,
          source: seeded !== null ? "library-default" : "consultant",
          sourceVersion: seeded?.version ?? null,
        },
      },
      crypto.randomUUID());
    setPending(null);
    if (result.state !== "success") {
      setError(result.state === "conflict"
        ? "This strategy changed since it was opened. Close and reopen it to see the latest."
        : errorText(result));
      return;
    }
    onSaved(next === "clear"
      ? `Estimate cleared. ${strategy.title} no longer contributes to the projection.`
      : `Estimate saved for ${strategy.title}.`);
  }

  const blocked = access.state !== "allowed";
  return <Collapsible title="Expected reduction"
    count={existing === null ? "Not estimated" : `${round(existing.tco2ePerYear)} tCO₂e/yr`}>
    <p className="nz-hint" style={{ marginTop: 0 }}>
      A forward <b>estimate</b>, not a measurement. It feeds the projected trajectory and is never shown
      as the assured footprint.
    </p>

    {/* One click to take the catalogue's figure; the consultant then accepts or overrides it. */}
    {libraryDefault?.modelledImpact != null ? <div className="nz-est-seed">
      <div>
        <b>{round(libraryDefault.modelledImpact.tco2ePerYear)} tCO₂e/yr</b> in the catalogue
        <span className="sub"> · {libraryDefault.modelledImpact.basis}</span>
      </div>
      <button type="button" className="nz-btn sm" onClick={seedFrom}>
        Use catalogue estimate (v{libraryDefault.version})
      </button>
    </div> : null}

    <div className="nz-two">
      <label className="nz-fl"><span>Measured as</span>
        <select className="nz-inp" value={unit} onChange={(event) => touched(setUnit)(event.target.value as EstimateUnit)}>
          {(Object.keys(estimateUnitLabels) as EstimateUnit[]).map((option) =>
            <option key={option} value={option}>{estimateUnitLabels[option]}</option>)}
        </select>
      </label>
      <label className="nz-fl"><span>Expected reduction<span className="nz-req">*</span></span>
        <input className="nz-inp" type="number" min={0} step="0.001" value={amount}
          onChange={(event) => touched(setAmount)(event.target.value)} autoComplete="off" />
      </label>
    </div>

    <label className="nz-fl"><span>Applies to<span className="nz-req">*</span></span>
      <select className="nz-inp" value={scope} onChange={(event) => touched(setScope)(event.target.value as EstimateScope)}>
        {estimateScopes.map((option) => <option key={option} value={option}>Scope {option}</option>)}
      </select>
      <span className="nz-hint">Which scope the saving lands on. A percentage is a percentage of this scope.</span>
    </label>

    {/* Live feedback on a percentage — or the honest refusal, never a zero. */}
    {unit === "percent" ? <div className={unresolvable ? "nz-banner warn" : "nz-est-resolved"} role={unresolvable ? "alert" : undefined}>
      {unresolvable
        ? `There is no baseline recorded for scope ${scope}, so a percentage cannot be resolved into tonnes. Enter the reduction in tCO₂e per year instead, or set this client's baseline first.`
        : hasAmount
          ? <>Resolves to <b>{round(resolved ?? 0)} tCO₂e/yr</b> — {parsed}% of the scope {scope} baseline
            ({round(scopeBaseline ?? 0)} tCO₂e in force).</>
          : <>A percentage resolves against the scope {scope} baseline in force{scopeBaseline === undefined ? ", which is not recorded for this client" : ` (${round(scopeBaseline)} tCO₂e)`}.</>}
    </div> : null}

    <label className="nz-fl"><span>What this rests on<span className="nz-req">*</span></span>
      <textarea className="nz-notes" rows={2} value={assumptions}
        onChange={(event) => touched(setAssumptions)(event.target.value)}
        placeholder="Supplier quote, October 2026 prices, assumes full site changeover." />
      <span className="nz-hint">Required. A reduction figure with no stated basis is what ends up quoted as though it were measured.</span>
    </label>

    <label className="nz-fl"><span>Confidence</span>
      <select className="nz-inp" value={confidence} onChange={(event) => touched(setConfidence)(event.target.value as EstimateConfidence | "")}>
        <option value="">Not stated</option>
        {estimateConfidences.map((option) => <option key={option} value={option}>{confidenceLabels[option]}</option>)}
      </select>
    </label>

    <p className="nz-hint">
      {seeded !== null
        ? `Recorded as seeded from the catalogue, version ${seeded.version}.`
        : "Recorded as a consultant estimate."}
      {strategy.targetDate === null
        ? " This strategy has no target date, so it will not appear on the projected trajectory until one is set."
        : ""}
    </p>

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}

    <div className="nz-est-actions">
      {existing !== null ? <GatedButton className="nz-btn" blocked={blocked || pending !== null}
        blockedReason={blocked ? access.reason : pending !== null ? "Saving…" : undefined}
        reasonClassName="hint nz-gated-reason" onClick={() => void submit("clear")}>
        {pending === "clear" ? "Clearing…" : "Clear estimate"}
      </GatedButton> : null}
      <GatedButton className="nz-btn pri" blocked={blocked || pending !== null || problem !== null}
        blockedReason={blocked ? access.reason : pending !== null ? "Saving…" : problem ?? undefined}
        reasonClassName="hint nz-gated-reason" onClick={() => void submit("save")}>
        {pending === "save" ? "Saving…" : "Save estimate"}
      </GatedButton>
    </div>
  </Collapsible>;
}

/** A strategy's own scope, where it is one the estimate can land on. */
const defaultScope = (strategy: ClientStrategy): EstimateScope =>
  (estimateScopes as readonly string[]).includes(strategy.scope) ? strategy.scope as EstimateScope : "1";

const round = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
