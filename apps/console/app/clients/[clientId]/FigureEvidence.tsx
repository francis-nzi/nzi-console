"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { FigureEvidence, FigureTier, ProvenanceSignature, ScopeFigureEvidence } from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";

/**
 * NZC-005 — figure evidence surfaces. A figure shows one of three truthful states:
 * resolved (with its signature), resolved but provenance unavailable, or
 * unavailable — never a blank, never a stand-in zero.
 */

const TIER_CLASS: Record<FigureTier, string> = { Measured: "measured", Estimated: "estimated", "Spend-based": "spend-based", Survey: "survey", Mixed: "mixed" };

export function TierBadge({ tier }: { tier: FigureTier | null }) {
  return tier ? <span className={`nz-tier ${TIER_CLASS[tier]}`}>{tier}</span> : <span className="nz-tier none">No tier</span>;
}

const tonnes = (value: number) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} tCO₂e`;

export function formatFigure(figure: Pick<FigureEvidence, "value" | "unit">): string {
  if (figure.value === null) return "Not available";
  if (figure.unit === "%") {
    const sign = figure.value > 0 ? "+" : figure.value < 0 ? "−" : "";
    return `${sign}${Math.abs(figure.value).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
  }
  if (figure.unit === "tCO₂e") return tonnes(figure.value);
  return `${figure.value.toLocaleString("en-GB", { maximumSignificantDigits: 4 })} ${figure.unit}`;
}

export function EvidenceButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return <button type="button" className="nz-evidence-link" onClick={onOpen} aria-label={`Evidence for ${label}`}>◈ Evidence</button>;
}

function FigureStatus({ figure }: { figure: FigureEvidence }) {
  if (figure.state === "unavailable") return <span className="nz-tier none">Unavailable</span>;
  return <><TierBadge tier={figure.qualityTier} />{figure.provenance ? null : <span className="nz-figure-flag">Provenance unavailable</span>}</>;
}

export function FigureCard({ title, figure, onEvidence, children }: { title: string; figure: FigureEvidence; onEvidence: () => void; children?: ReactNode }) {
  return <div className={`nz-figure-card${figure.state === "unavailable" ? " unavailable" : ""}`}>
    <div className="sub">{title}</div>
    <div className="nz-figure-value num">{formatFigure(figure)}</div>
    {children}
    <div className="nz-figure-foot"><FigureStatus figure={figure} /><EvidenceButton label={title} onOpen={onEvidence} /></div>
    {figure.state === "unavailable" && figure.note ? <p className="nz-figure-note">{figure.note}</p> : null}
  </div>;
}

/** Scope rows inside the Scope-split card — each scope's own value and tier. */
export function ScopeRows({ scopes }: { scopes: ScopeFigureEvidence[] }) {
  return <div className="nz-scope-rows">{scopes.map((scope) => <div key={scope.scope} className="nz-scope-row">
    <span className={`nz-scope-dot s${scope.scope}`} aria-hidden="true" /><span>Scope {scope.scope}</span>
    <span className="num">{scope.value === null ? "—" : tonnes(scope.value)}</span>
    {scope.state === "resolved" ? <TierBadge tier={scope.qualityTier} /> : null}
  </div>)}</div>;
}

const SIGNATURE_LABELS: ReadonlyArray<[keyof ProvenanceSignature, string]> = [
  ["factorSet", "Factor set"],
  ["factorSetVersion", "Factor-set version"],
  ["dataHash", "Data hash"],
  ["asAtDate", "As at"],
  ["sourceRef", "Source"],
  ["resolver", "Resolver"],
];

function Kv({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="nz-kv"><span className="k">{label}</span><span className={`v${mono ? " mono" : ""}`}>{children}</span></div>;
}

function TierMix({ tiers }: { tiers: FigureEvidence["tiers"] }) {
  return <ul className="nz-tier-mix">{tiers.map((part) => <li key={part.tier}><TierBadge tier={part.tier} /><span className="num">{tonnes(part.tco2e)}</span></li>)}</ul>;
}

/** The drawer body: figure hero + tier + signature rows + calculation lineage + source link. */
export function FigureEvidenceBody({ figure, scopes }: { figure: FigureEvidence; scopes?: ScopeFigureEvidence[] }) {
  const provenance = figure.provenance;
  return <div className="nz-evidence-body">
    <div className="nz-evidence-hero"><div className="num">{formatFigure(figure)}</div><FigureStatus figure={figure} /></div>
    {figure.state === "unavailable" ? <div className="nz-banner warn" role="status">{figure.note ?? "This figure is unavailable."}</div> : null}

    {scopes ? <>
      <div className="nz-sect">By scope</div>
      {scopes.map((scope) => <div key={scope.scope} className="nz-evidence-scope">
        <Kv label={`Scope ${scope.scope}`}><span className="num">{scope.value === null ? "Not available" : tonnes(scope.value)}</span> {scope.state === "resolved" ? <TierBadge tier={scope.qualityTier} /> : null}</Kv>
        {scope.qualityTier === "Mixed" ? <TierMix tiers={scope.tiers} /> : null}
        {scope.value !== null && scope.note && !scope.note.startsWith("Provenance") ? <p className="nz-figure-note">{scope.note}</p> : null}
      </div>)}
      <p className="nz-figure-note">Per-row factors and tiers are visible by opening the row in the job.</p>
    </> : figure.qualityTier === "Mixed" ? <><div className="nz-sect">Quality tier mix</div><TierMix tiers={figure.tiers} /></> : null}

    {figure.state === "resolved" ? <>
      <div className="nz-sect">Provenance signature</div>
      {provenance
        ? SIGNATURE_LABELS.map(([key, label]) => <Kv key={key} label={label} mono={key === "dataHash"}>{key === "asAtDate" ? formatDate(provenance.asAtDate) : provenance[key]}</Kv>)
        : <div className="nz-banner warn" role="status">{figure.note ?? "Provenance unavailable for this figure."}</div>}
    </> : null}

    {figure.lineage.length ? <>
      <div className="nz-sect">Calculation lineage</div>
      {figure.lineage.map((step, index) => <Kv key={`${index}-${step.title}`} label={step.title}>{step.detail}</Kv>)}
    </> : null}

    {figure.source ? <Link className="nz-btn" href={`/jobs/${encodeURIComponent(figure.source.jobId)}`}>Open source snapshot → {figure.source.jobNumber} v{figure.source.snapshotVersion}</Link> : null}
  </div>;
}
