"use client";

import { useState } from "react";
import Link from "next/link";
import { EvidenceDrawer } from "@nzi/ui";
import type { FigureEvidence } from "@nzi/contracts";

type ScopeEvidence = FigureEvidence & { scope: "1" | "2" | "3" };
export function ClientEvidenceSurface({ evidence }: { evidence: { latest: FigureEvidence; scopes: ScopeEvidence[]; intensity: FigureEvidence } }) {
  const [selected, setSelected] = useState<{ title: string; evidence: FigureEvidence } | null>(null);
  return <>
    <section className="nz-panel"><Header title="Latest emissions" /><div style={{ padding: 16 }}><FigureCard title="Latest emissions" value={`${evidence.latest.value.toLocaleString("en-GB")} ${evidence.latest.unit}`} tier={evidence.latest.qualityTier} onEvidence={() => setSelected({ title: "Latest emissions", evidence: evidence.latest })} /></div></section>
    <section className="nz-panel"><Header title="Carbon analytics" /><div className="nz-client-signals" style={{ padding: 16 }}><FigureCard title="Scope split" value={`${evidence.scopes.reduce((sum, item) => sum + item.value, 0).toLocaleString("en-GB")} tCO2e`} tier="Mixed" onEvidence={() => setSelected({ title: "Scope split", evidence: { ...evidence.scopes[0]!, value: evidence.scopes.reduce((sum, item) => sum + item.value, 0), qualityTier: "Mixed", lineage: evidence.scopes.flatMap((item) => item.lineage) } })} /><FigureCard title="Intensity detail" value={`${evidence.intensity.value.toFixed(2)} ${evidence.intensity.unit}`} tier={evidence.intensity.qualityTier} onEvidence={() => setSelected({ title: "Intensity detail", evidence: evidence.intensity })} /></div><div className="sub" style={{ padding: "0 16px 14px" }}>Scope 3 is mixed. Per-row factors and tiers are visible by opening the source row in the job.</div></section>
    <aside style={{ display: selected ? "block" : "none" }}>{selected ? <EvidenceDrawer kicker="Evidence" title={selected.title} subtitle="Resolved from an assured reviewed snapshot" actions={<button type="button" className="nz-btn" onClick={() => setSelected(null)}>Close evidence</button>}><EvidenceBody evidence={selected.evidence} /></EvidenceDrawer> : null}</aside>
  </>;
}

function Header({ title }: { title: string }) { return <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--line2)" }}><h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2></div>; }
function FigureCard({ title, value, tier, onEvidence }: { title: string; value: string; tier: string; onEvidence: () => void }) { return <div style={{ border: "1px solid var(--line)", borderRadius: 9, padding: 14, minWidth: 0 }}><div className="sub">{title}</div><div className="num" style={{ fontSize: 21, fontWeight: 650, margin: "8px 0" }}>{value}</div><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="nz-st est">{tier}</span><button type="button" className="nz-table-link" onClick={onEvidence}>◈ Evidence</button></div></div>; }
function EvidenceBody({ evidence }: { evidence: FigureEvidence }) { if (!evidence.provenance) return <div className="nz-banner warn">Provenance unavailable. This figure cannot be treated as assured evidence.</div>; return <><div className="nz-kv"><span className="k">Figure</span><span className="v num">{evidence.value.toLocaleString("en-GB")} {evidence.unit}</span></div><div className="nz-kv"><span className="k">Quality tier</span><span className="v">{evidence.qualityTier}</span></div><div className="nz-sect">Provenance signature</div>{Object.entries(evidence.provenance).map(([key, value]) => <div className="nz-kv" key={key}><span className="k">{key}</span><span className="v">{value}</span></div>)}<div className="nz-sect">Calculation lineage</div>{evidence.lineage.map((step) => <div className="nz-kv" key={`${step.title}-${step.detail}`}><span className="k">{step.title}</span><span className="v">{step.detail}</span></div>)}<Link className="nz-btn" href="/jobs/J000712">Open source snapshot →</Link></>; }
