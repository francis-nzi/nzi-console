"use client";

import type { ReactNode } from "react";
import type { FigureEvidence, FigureTier, ProvenanceSignature, ScopeFigureEvidence } from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";

/**
 * NZC-005 — figure evidence surfaces (client workspace v8). A figure shows one of three
 * truthful states: resolved (with its signature), resolved but provenance unavailable,
 * or unavailable — never a blank, never a stand-in zero.
 */

const TIER_CLASS: Record<FigureTier, string> = { Measured: "measured", Estimated: "estimated", "Spend-based": "spend-based", Survey: "survey", Mixed: "mixed" };

export function TierBadge({ tier }: { tier: FigureTier | null }) {
  if (!tier) return <span className="nz-tier none">No tier</span>;
  return <span className={`nz-tier ${TIER_CLASS[tier]}`}>{tier === "Mixed" ? "Mixed tiers" : tier}</span>;
}

export const tonnes = (value: number) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} tCO₂e`;
/** "FY24" for the reporting year a figure was resolved from. */
export const fyLabel = (year: number) => `FY${String(year).slice(-2)}`;

export function formatFigure(figure: Pick<FigureEvidence, "value" | "unit">): string {
  if (figure.value === null) return "Not available";
  if (figure.unit === "%") {
    const sign = figure.value > 0 ? "+" : figure.value < 0 ? "−" : "";
    return `${sign}${Math.abs(figure.value).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
  }
  if (figure.unit === "tCO₂e") return tonnes(figure.value);
  return `${figure.value.toLocaleString("en-GB", { maximumSignificantDigits: 4 })} ${figure.unit}`;
}

/** ◈ Evidence — opens the figure's provenance and lineage in the evidence drawer. */
export function EvidenceButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return <button type="button" className="nz-evidence-link" onClick={onOpen} aria-label={`Evidence for ${label}`} title="Show provenance & lineage">◈ Evidence</button>;
}

/** The figure's status line: its tier, and a flag when provenance can't be shown. */
export function FigureStatus({ figure }: { figure: FigureEvidence }) {
  if (figure.state === "unavailable") return <span className="nz-tier none">Unavailable</span>;
  return <><TierBadge tier={figure.qualityTier} />{figure.provenance ? null : <span className="nz-figure-flag">Provenance unavailable</span>}</>;
}

const SIGNATURE_LABELS: ReadonlyArray<[keyof ProvenanceSignature, string]> = [
  ["factorSet", "Factor set"],
  ["factorSetVersion", "Factor-set version"],
  ["dataHash", "Data hash"],
  ["asAtDate", "As-at date"],
  ["sourceRef", "Source"],
  ["resolver", "Resolver"],
];

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return <div className="nz-kv"><span className="k">{label}</span><span className="v">{children}</span></div>;
}

function TierMix({ tiers }: { tiers: FigureEvidence["tiers"] }) {
  return <ul className="nz-tier-mix">{tiers.map((part) => <li key={part.tier}><TierBadge tier={part.tier} /><span className="num">{tonnes(part.tco2e)}</span></li>)}</ul>;
}

/**
 * The evidence drawer body: figure + tier, a one-line context, the provenance signature,
 * the calculation lineage and the governance note. The drawer's footer carries
 * "Open source snapshot →" and Close.
 */
export function FigureEvidenceBody({ figure, context, scopes }: { figure: FigureEvidence; context: string; scopes?: ScopeFigureEvidence[] }) {
  const provenance = figure.provenance;
  return <div className="nz-evidence-body">
    <div className="nz-evidence-hero"><span className="num">{formatFigure(figure)}</span><FigureStatus figure={figure} /></div>
    <p className="nz-evidence-sub">{context}</p>
    {figure.state === "unavailable" ? <div className="nz-banner warn" role="status">{figure.note ?? "This figure is unavailable."}</div> : null}

    {figure.state === "resolved" ? <>
      <div className="nz-sect">Provenance signature</div>
      {scopes ? scopes.map((scope) => <div key={scope.scope}>
        <Kv label={`Scope ${scope.scope}`}>{scope.value === null ? "Not available" : tonnes(scope.value)} {scope.state === "resolved" ? <TierBadge tier={scope.qualityTier} /> : null}</Kv>
        {scope.qualityTier === "Mixed" ? <TierMix tiers={scope.tiers} /> : null}
      </div>) : figure.qualityTier === "Mixed" ? <TierMix tiers={figure.tiers} /> : null}
      {provenance
        ? SIGNATURE_LABELS.map(([key, label]) => <Kv key={key} label={label}>{key === "asAtDate" ? formatDate(provenance.asAtDate) : provenance[key]}</Kv>)
        : <div className="nz-banner warn" role="status">{figure.note ?? "Provenance unavailable for this figure."}</div>}
    </> : null}

    {figure.lineage.length ? <>
      <div className="nz-sect">Calculation lineage</div>
      {figure.lineage.map((step, index) => <Kv key={`${index}-${step.title}`} label={step.title}>{step.detail}</Kv>)}
      {scopes ? <p className="nz-figure-note" style={{ marginTop: 8 }}>Each scope is a roll-up of its reviewed rows with per-row quality tiers — open a row in the job to see its individual factor and tier.</p> : null}
    </> : null}

    <div className="nz-gov"><span className="lk" aria-hidden="true">🔒</span><span>Every figure carries its factor set, version, data hash and as-at date. Numbers are <b>derived from the assured snapshot</b>, never captured — the same figure renders identically to screen, PDF and portal.</span></div>
  </div>;
}
