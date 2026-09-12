import type { CSSProperties } from "react";
import type { SrsMaturityBulletsData } from "./types";
import { tokens, srsMaturityColor } from "./tokens";
import { f } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

type Props = { data: SrsMaturityBulletsData; width?: number; showChrome?: boolean };

const VB_W = 440;
const ROW_H = 34;
const TOP = 30;
const BOTTOM = 10;
const LABEL_W = 148;
const TRACK_X = 154;
const TRACK_W = 198;
const BAR_H = 12;

/**
 * Maturity per requirement as a bullet bar: the achieved level against its target tick,
 * with an optional comparison marker (the other standard, or last period).
 *
 * A bullet is the right form here — one measure, one target, one comparison, on a fixed
 * ordinal scale — and it stacks in far less height than a grouped bar. The fill uses the
 * sequential maturity ramp, never the scope palette: a maturity level is not a scope.
 * The level is also printed as `valueLabel`, so the bar is never the only encoding.
 */
export function SrsMaturityBullets({ data, width, showChrome = true }: Props) {
  const maxLevel = data.maxLevel > 0 ? data.maxLevel : 1;
  const vbH = TOP + data.rows.length * ROW_H + BOTTOM;
  const hasComparison = data.rows.some((row) => row.comparison !== null);
  const x = (level: number) => TRACK_X + (clamp(level, maxLevel) / maxLevel) * TRACK_W;

  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;

  const svg = (
    <svg viewBox={`0 0 ${VB_W} ${vbH}`} width={width ?? "100%"} height={width ? (width * vbH) / VB_W : undefined}
      role="img" aria-labelledby={`${titleId} ${descId}`} style={{ display: "block", fontFamily: tokens.font }}>
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>
        {`Maturity against target, level 0 to ${maxLevel}. ` +
          data.rows.map((row) => `${row.label}: ${row.valueLabel}, target ${clamp(row.target, maxLevel)}`).join(". ") + "."}
      </desc>

      {/* Legend — the tick and the dot are shapes, not colours */}
      <g transform="translate(154 14)" fontSize={9.5}>
        <rect x={0} y={-5} width={2} height={10} fill={tokens.srs.target} opacity={0.55} />
        <text x={8} y={3.5} fill={tokens.ink.secondary}>Target level</text>
        {hasComparison && <g transform="translate(88 0)">
          <circle cx={3} cy={0} r={4.5} fill={tokens.srs.s1} stroke={tokens.surface} strokeWidth={2} />
          <text x={12} y={3.5} fill={tokens.ink.secondary}>Comparison</text>
        </g>}
      </g>

      {data.rows.map((row, index) => {
        const rowY = TOP + index * ROW_H;
        const barY = rowY + (ROW_H - BAR_H) / 2;
        const centreY = barY + BAR_H / 2;
        const fillW = Math.max(0, x(row.value) - TRACK_X);
        return (
          <g key={row.label}>
            <text x={0} y={centreY + 3.5} fontSize={11} fill={tokens.ink.primary}>
              {truncate(row.label, 26)}
              <title>{row.label}</title>
            </text>

            {/* Track — the whole scale, so a short bar reads as short */}
            <rect x={TRACK_X} y={barY} width={TRACK_W} height={BAR_H} rx={3} fill={tokens.line2} />
            <rect x={TRACK_X} y={barY} width={f(fillW)} height={BAR_H} rx={3} fill={srsMaturityColor(row.value)}>
              <title>{`${row.label} · ${row.valueLabel} (target ${clamp(row.target, maxLevel)} of ${maxLevel})`}</title>
            </rect>

            {/* Target tick — overhangs the bar so it is legible against a full fill */}
            <rect x={f(x(row.target) - 1)} y={barY - 3} width={2} height={BAR_H + 6} fill={tokens.srs.target} opacity={0.55} />

            {row.comparison !== null && (
              <circle cx={f(x(row.comparison))} cy={centreY} r={4.5} fill={tokens.srs.s1} stroke={tokens.surface} strokeWidth={2}>
                <title>{`${row.label} · comparison level ${clamp(row.comparison, maxLevel)} of ${maxLevel}`}</title>
              </circle>
            )}

            <text x={VB_W} y={centreY + 3.5} textAnchor="end" fontSize={11} fontWeight={600} fill={tokens.ink.primary}
              style={{ fontVariantNumeric: "tabular-nums" }}>{row.valueLabel}</text>
          </g>
        );
      })}

      {/* Label column guide — keeps the eye on the track start */}
      <line x1={LABEL_W} x2={LABEL_W} y1={TOP} y2={TOP + data.rows.length * ROW_H} stroke={tokens.line} strokeWidth={1} />
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

function clamp(value: number, maxLevel: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maxLevel, value));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const frameStyle: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: "12px", padding: "16px 18px 12px", margin: 0 };
const kickStyle: CSSProperties = { fontSize: "10.5px", letterSpacing: "0.12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const h3Style: CSSProperties = { fontSize: "16px", fontWeight: 600, margin: "3px 0 0", color: tokens.ink.primary };
const provStyle: CSSProperties = { fontSize: "11px", color: tokens.ink.muted, margin: "8px 0 2px" };
