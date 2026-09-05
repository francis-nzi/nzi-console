import type { CSSProperties } from "react";
import type { LcaModuleDonutData } from "./types";
import { tokens, moduleGroupColor } from "./tokens";
import { annularSector, comma, compact, pct, f } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

type Props = { data: LcaModuleDonutData; width?: number; showChrome?: boolean };

const VB_W = 760, VB_H = 320, CX = 150, CY = 155, R_OUT = 118, R_IN = 88;
const R_MID = (R_OUT + R_IN) / 2;
const GAP_DEG = (2 / R_MID) * (180 / Math.PI);

/**
 * LCA cradle-to-X footprint by EN 15804 module, coloured by module group.
 * Pure/stateless SVG — identical on screen and in print. Identity is never
 * colour-alone: 2px surface gaps, a legend with values + share tracks, and a
 * centre total (the same figure the module-breakdown table carries).
 */
export function LcaModuleDonut({ data, width, showChrome = true }: Props) {
  const segments = data.modules.filter((m) => m.value > 0).sort((a, b) => b.value - a.value);
  const total = data.total ?? segments.reduce((sum, m) => sum + m.value, 0);
  const titleId = `${data.spec.id}-title`, descId = `${data.spec.id}-desc`;

  let cursor = 0;
  const arcs = segments.map((m) => {
    const sweep = total > 0 ? (m.value / total) * 360 : 0;
    const start = cursor + GAP_DEG / 2, end = cursor + sweep - GAP_DEG / 2;
    cursor += sweep;
    return { seg: m, color: moduleGroupColor(m.group), d: end > start ? annularSector(CX, CY, R_OUT, R_IN, start, end) : "" };
  });

  const legendX = 320, rowH = 40;
  const legendTop = Math.max(14, CY - (segments.length * rowH) / 2 + 6);

  const svg = (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width={width ?? "100%"} height={width ? (width * VB_H) / VB_W : undefined} role="img" aria-labelledby={`${titleId} ${descId}`} style={{ display: "block", fontFamily: tokens.font }}>
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>{`Life-cycle emissions by EN 15804 module. Total ${comma(total)} ${data.unit} per ${data.functionalUnit}. ` + segments.map((m) => `${m.label} ${comma(m.value)} (${pct(m.value, total)})`).join("; ") + "."}</desc>
      <g>
        {arcs.map((a) => (a.d ? <path key={a.seg.code} d={a.d} fill={a.color}><title>{`${a.seg.label} — ${comma(a.seg.value)} ${data.unit} (${pct(a.seg.value, total)})`}</title></path> : null))}
        <text x={CX} y={CY - 6} textAnchor="middle" fontSize={36} fontWeight={600} fill={tokens.ink.primary} letterSpacing={-0.5}>{compact(total)}</text>
        <text x={CX} y={CY + 16} textAnchor="middle" fontSize={12.5} fill={tokens.ink.secondary}>{data.unit}</text>
        <text x={CX} y={CY + 34} textAnchor="middle" fontSize={9.5} fill={tokens.ink.muted} letterSpacing={1.2}>{`PER ${data.functionalUnit.toUpperCase()}`}</text>
      </g>
      <g transform={`translate(${legendX} ${legendTop})`}>
        {segments.map((m, i) => {
          const color = moduleGroupColor(m.group), y = i * rowH;
          return (
            <g key={m.code} transform={`translate(0 ${y})`}>
              <rect x={0} y={0} width={12} height={12} rx={3} fill={color} />
              <text x={22} y={11} fontSize={12.5} fontWeight={600} fill={tokens.ink.primary}>{m.label}</text>
              <text x={0} y={27} fontSize={14.5} fontWeight={600} fill={tokens.ink.primary} style={{ fontVariantNumeric: "tabular-nums" }}>{comma(m.value)}<tspan fontSize={10.5} fontWeight={500} fill={tokens.ink.muted}>{"  "}{data.unit}</tspan></text>
              <text x={230} y={27} textAnchor="end" fontSize={12.5} fill={tokens.ink.secondary}>{pct(m.value, total)}</text>
              <rect x={0} y={33} width={230} height={4} rx={2} fill={tokens.line2} />
              <rect x={0} y={33} width={f((Math.max(0, m.value) / (total || 1)) * 230)} height={4} rx={2} fill={color} />
            </g>
          );
        })}
      </g>
    </svg>
  );

  if (!showChrome) return svg;
  return (
    <figure style={frame}>
      <figcaption style={{ marginBottom: 6 }}>
        <span style={kick}>{data.spec.subtitle ?? "Footprint by life-cycle module"}</span>
        <h3 style={h3}>{data.spec.title}</h3>
      </figcaption>
      {svg}
      <p style={prov}><span style={{ fontWeight: 600, color: tokens.ink.secondary }}>Source</span>{"  "}{data.provenance.factorSets.join(" · ")}{data.provenance.quality ? ` · ${data.provenance.quality}` : ""}{" · as at "}{formatDate(data.provenance.generatedAt)}</p>
    </figure>
  );
}

const frame: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: 12, padding: "16px 18px 12px", margin: 0 };
const kick: CSSProperties = { fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const h3: CSSProperties = { fontSize: 16, fontWeight: 600, margin: "3px 0 0", color: tokens.ink.primary };
const prov: CSSProperties = { fontSize: 11, color: tokens.ink.muted, margin: "8px 0 2px" };
