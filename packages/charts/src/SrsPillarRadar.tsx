import type { CSSProperties } from "react";
import type { SrsPillarRadarData, SrsPillarSeries } from "./types";
import { tokens } from "./tokens";
import { points, f } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

type Props = { data: SrsPillarRadarData; width?: number; showChrome?: boolean };

const VB_W = 280;
const VB_H = 250;
const CX = 140;
const CY = 122;
const R = 80;

/**
 * SRS readiness by pillar — governance, strategy, risk management, metrics & targets —
 * for both standards at once, against the target profile.
 *
 * A radar is only honest for an ordinal level on a fixed, small set of axes with a shared
 * scale, which is exactly what maturity 0–`maxLevel` across four named pillars is. Colour
 * is the two standards plus a dashed target; the scope palette never appears — scope
 * identity is reserved for GHG scopes. Identity is never colour-alone: the legend carries
 * line swatches and the axis labels name every pillar.
 */
export function SrsPillarRadar({ data, width, showChrome = true }: Props) {
  const pillarCount = Math.max(1, data.pillars.length);
  const maxLevel = data.maxLevel > 0 ? data.maxLevel : 1;
  const levels = Array.from({ length: maxLevel }, (_, index) => index + 1);

  const vertex = (index: number, radius: number): [number, number] => {
    const angle = -Math.PI / 2 + (index / pillarCount) * 2 * Math.PI;
    return [CX + radius * Math.cos(angle), CY + radius * Math.sin(angle)];
  };
  const ring = (radius: number): string => points(data.pillars.map((_, index) => vertex(index, radius)));
  const shape = (values: number[]): string =>
    points(data.pillars.map((_, index) => vertex(index, (clamp(values[index] ?? 0, maxLevel) / maxLevel) * R)));

  const s1 = data.series.find((entry) => entry.key === "S1");
  const s2 = data.series.find((entry) => entry.key === "S2");

  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;

  const svg = (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width={width ?? "100%"} height={width ? (width * VB_H) / VB_W : undefined}
      role="img" aria-labelledby={`${titleId} ${descId}`} style={{ display: "block", fontFamily: tokens.font }}>
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>
        {`Readiness by pillar, maturity level 0 to ${maxLevel}. ` +
          data.series.map((entry) => `${entry.label}: ${data.pillars.map((pillar, index) => `${pillar} ${clamp(entry.values[index] ?? 0, maxLevel)}`).join(", ")}`).join(". ") +
          `. Target: ${data.pillars.map((pillar, index) => `${pillar} ${clamp(data.target[index] ?? 0, maxLevel)}`).join(", ")}.`}
      </desc>

      {/* Grid rings — one per maturity level, so the reader can count the gap */}
      {levels.map((level) => (
        <polygon key={`ring-${level}`} points={ring((level / maxLevel) * R)} fill="none" stroke={tokens.line} strokeWidth={1} />
      ))}

      {/* Spokes + pillar names */}
      {data.pillars.map((pillar, index) => {
        const [sx, sy] = vertex(index, R);
        const [lx, ly] = vertex(index, R + 16);
        return (
          <g key={`axis-${pillar}`}>
            <line x1={CX} y1={CY} x2={f(sx)} y2={f(sy)} stroke={tokens.line} strokeWidth={1} />
            <text x={f(lx)} y={f(ly)} textAnchor={anchorFor(lx)} dominantBaseline="middle" fontSize={10} fill={tokens.ink.muted}>{pillar}</text>
          </g>
        );
      })}

      {/* Target profile — dashed, no fill, so it reads as a reference not a result */}
      <polygon points={shape(data.target)} fill="none" stroke={tokens.srs.target} strokeWidth={1.5}
        strokeDasharray="4 4" opacity={0.55} strokeLinejoin="round" />

      {/* S1 first, S2 painted over it: the climate standard is the one being led */}
      {s1 && <SeriesShape series={s1} colour={tokens.srs.s1} fillOpacity={0.1} shape={shape} vertex={vertex} maxLevel={maxLevel} pillars={data.pillars} />}
      {s2 && <SeriesShape series={s2} colour={tokens.srs.s2} fillOpacity={0.14} shape={shape} vertex={vertex} maxLevel={maxLevel} pillars={data.pillars} />}

      {/* Legend — line swatches, so identity never rests on colour alone */}
      <g transform="translate(8 236)" fontSize={9.5}>
        {[
          { key: "S2", colour: tokens.srs.s2, dash: undefined as string | undefined, label: s2 ? `S2 · ${s2.label}` : "S2" },
          { key: "S1", colour: tokens.srs.s1, dash: undefined as string | undefined, label: s1 ? `S1 · ${s1.label}` : "S1" },
          { key: "target", colour: tokens.srs.target, dash: "4 4", label: "Target" },
        ].map((item, index) => (
          <g key={item.key} transform={`translate(${index * 92} 0)`}>
            <line x1={0} y1={0} x2={18} y2={0} stroke={item.colour} strokeWidth={2} strokeDasharray={item.dash} strokeLinecap="round" opacity={item.dash ? 0.55 : 1} />
            <text x={23} y={3.5} fill={tokens.ink.secondary}>{item.label}</text>
          </g>
        ))}
      </g>
    </svg>
  );

  if (!showChrome) return svg;
  return (
    <figure style={frameStyle}>
      <figcaption style={{ marginBottom: "2px" }}>
        <span style={kickStyle}>{data.spec.subtitle ?? "SRS readiness"}</span>
        <h3 style={h3Style}>{data.spec.title}</h3>
      </figcaption>
      {svg}
      <p style={provStyle}><span style={{ fontWeight: 600, color: tokens.ink.secondary }}>Source</span>{"  "}{data.provenance.factorSets.join(" · ")}{" · as at "}{formatDate(data.provenance.generatedAt)}</p>
    </figure>
  );
}

function SeriesShape({ series, colour, fillOpacity, shape, vertex, maxLevel, pillars }: {
  series: SrsPillarSeries;
  colour: string;
  fillOpacity: number;
  shape: (values: number[]) => string;
  vertex: (index: number, radius: number) => [number, number];
  maxLevel: number;
  pillars: string[];
}) {
  return (
    <g>
      <polygon points={shape(series.values)} fill={colour} fillOpacity={fillOpacity} stroke={colour} strokeWidth={2} strokeLinejoin="round" />
      {pillars.map((pillar, index) => {
        const level = clamp(series.values[index] ?? 0, maxLevel);
        const [px, py] = vertex(index, (level / maxLevel) * R);
        return (
          <circle key={`${series.key}-${pillar}`} cx={f(px)} cy={f(py)} r={3} fill={colour}>
            <title>{`${series.label} · ${pillar}: level ${level} of ${maxLevel}`}</title>
          </circle>
        );
      })}
    </g>
  );
}

/** Right-hand vertices read outward to the right, left-hand ones to the left. */
function anchorFor(x: number): "start" | "middle" | "end" {
  if (x > CX + 1) return "start";
  if (x < CX - 1) return "end";
  return "middle";
}

function clamp(value: number, maxLevel: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maxLevel, value));
}

const frameStyle: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: "12px", padding: "16px 18px 12px", margin: 0 };
const kickStyle: CSSProperties = { fontSize: "10.5px", letterSpacing: "0.12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const h3Style: CSSProperties = { fontSize: "16px", fontWeight: 600, margin: "3px 0 0", color: tokens.ink.primary };
const provStyle: CSSProperties = { fontSize: "11px", color: tokens.ink.muted, margin: "8px 0 2px" };
