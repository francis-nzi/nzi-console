import type { CSSProperties } from "react";
import type { SrsReadinessTrendData } from "./types";
import { tokens } from "./tokens";
import { points, scaleLinear, f } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

type Props = { data: SrsReadinessTrendData; width?: number; showChrome?: boolean };

const VB_W = 250;
const VB_H = 60;
const M = { top: 16, right: 30, bottom: 14, left: 6 };
const PLOT_W = VB_W - M.left - M.right;
const PLOT_H = VB_H - M.top - M.bottom;

/**
 * Overall readiness over time, as a compact sparkline for a tile or table cell.
 *
 * The axis is the full 0–100% of the completeness measure, not the data range: a
 * readiness percentage is a share of a fixed whole, so a framed axis would exaggerate
 * small movement. Only the latest value is printed — a sparkline shows shape, and the
 * precise history belongs in the table beside it. Single series, brand pine; no scope
 * colour appears, because this is not a scope measure.
 */
export function SrsReadinessTrend({ data, width, showChrome = true }: Props) {
  const series = data.points;
  const lastIndex = series.length - 1;
  const x = scaleLinear(0, Math.max(1, lastIndex), M.left, M.left + PLOT_W);
  const y = scaleLinear(0, 100, M.top + PLOT_H, M.top);
  const plotted = series.map((point, index): [number, number] => [x(index), y(clamp(point.value))]);
  const last = series[lastIndex];
  const lastY = plotted[lastIndex]?.[1] ?? M.top;

  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;

  const svg = (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width={width ?? "100%"} height={width ? (width * VB_H) / VB_W : undefined}
      role="img" aria-labelledby={`${titleId} ${descId}`} style={{ display: "block", fontFamily: tokens.font }}>
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>
        {`Overall readiness, percent complete. ` + series.map((point) => `${point.label} ${Math.round(point.value)}%`).join(", ") + "."}
      </desc>

      <polyline points={points(plotted)} fill="none" stroke={tokens.srs.s2} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />

      {plotted.map(([px, py], index) => (
        <circle key={series[index]?.label ?? index} cx={f(px)} cy={f(py)} r={3} fill={tokens.srs.s2}>
          <title>{`${series[index]?.label ?? ""} · ${Math.round(series[index]?.value ?? 0)}%`}</title>
        </circle>
      ))}

      {/* The latest value in words as well as position */}
      {last && (
        <text x={VB_W - 2} y={f(Math.max(10, lastY - 8))} textAnchor="end" fontSize={12} fontWeight={700}
          fill={tokens.ink.primary} style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(last.value)}%</text>
      )}

      {series.map((point, index) => (
        <text key={`label-${point.label}`} x={f(x(index))} y={VB_H - 3}
          textAnchor={index === 0 ? "start" : index === lastIndex ? "end" : "middle"}
          fontSize={9} fill={tokens.ink.muted}>{point.label}</text>
      ))}
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

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

const frameStyle: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: "12px", padding: "16px 18px 12px", margin: 0 };
const kickStyle: CSSProperties = { fontSize: "10.5px", letterSpacing: "0.12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const h3Style: CSSProperties = { fontSize: "16px", fontWeight: 600, margin: "3px 0 0", color: tokens.ink.primary };
const provStyle: CSSProperties = { fontSize: "11px", color: tokens.ink.muted, margin: "8px 0 2px" };
