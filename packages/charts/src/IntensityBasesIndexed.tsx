import type { CSSProperties } from "react";
import type { IndexedBasisSeries, IntensityBasesIndexedData } from "./types";
import { tokens } from "./tokens";
import { scaleLinear, points, comma } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

type Props = { data: IntensityBasesIndexedData; width?: number; showChrome?: boolean };

const VB_W = 760;
const VB_H = 300;
const M = { top: 34, right: 96, bottom: 44, left: 52 };
const PLOT_W = VB_W - M.left - M.right;
const PLOT_H = VB_H - M.top - M.bottom;

/**
 * Emissions intensity on every basis at once. Each basis has its own denominator and
 * unit — tCO₂e per £m, per FTE, per m² — so plotting them on one axis is only honest
 * once each is indexed to the same base year (= 100). What the reader compares is the
 * *shape*: whether intensity falls on every basis or only on the one that flatters.
 *
 * Basis identity is never colour-alone: each series carries a distinct dash pattern and
 * a direct end label as well as its colour. Colours are existing palette slots (no new
 * token, so `TOKENS_VERSION` is unchanged), and none is a scope colour — scope identity
 * stays reserved for scopes.
 */
export function IntensityBasesIndexed({ data, width, showChrome = true }: Props) {
  const series = data.series.filter((entry) => entry.points.length > 0);
  const all = series.flatMap((entry) => entry.points);
  const years = all.map((point) => point.year);
  const values = all.map((point) => point.value);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  // The reference line is only claimable as a single year when every basis shares it.
  const baseLabel = data.baseYear === null ? "each basis · first year = 100" : `${data.baseYear} = 100`;
  // An index is a ratio, not a magnitude: the 100 line is the reference, so the axis is
  // framed around the values and always includes 100. Forcing it to zero would flatten
  // every series into one indistinguishable line and hide the comparison being made.
  const ticks = indexTicks(values);
  const [yMin, yMax] = [ticks[0] ?? 90, ticks[ticks.length - 1] ?? 110];

  const x = scaleLinear(minYear, maxYear === minYear ? minYear + 1 : maxYear, M.left, M.left + PLOT_W);
  const y = scaleLinear(yMin, yMax, M.top + PLOT_H, M.top);
  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;

  const svg = (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width={width ?? "100%"} height={width ? (width * VB_H) / VB_W : undefined}
      role="img" aria-labelledby={`${titleId} ${descId}`} style={{ display: "block", fontFamily: tokens.font }}>
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>
        {`Emissions intensity indexed — ${baseLabel}. ` +
          series.map((entry) => `${entry.label}: ${entry.points.map((point) => `${point.year} ${Math.round(point.value)}`).join(", ")}`).join(". ") + "."}
      </desc>

      {/* Gridlines + index ticks */}
      {ticks.map((tick) => {
        const gy = y(tick);
        return <g key={tick}>
          <line x1={M.left} x2={M.left + PLOT_W} y1={gy} y2={gy} stroke={tokens.line} strokeWidth={1} />
          <text x={M.left - 10} y={gy + 4} textAnchor="end" fontSize={11} fill={tokens.ink.muted} style={{ fontVariantNumeric: "tabular-nums" }}>{comma(tick)}</text>
        </g>;
      })}

      {/* The base year itself — the 100 line every basis starts from */}
      <line x1={M.left} x2={M.left + PLOT_W} y1={y(100)} y2={y(100)} stroke={tokens.brand.midnight} strokeWidth={1} strokeDasharray="2 4" opacity={0.5} />
      {/* Left-anchored: the right edge belongs to the series' own end labels. */}
      <text x={M.left + 4} y={y(100) - 6} fontSize={10.5} fill={tokens.ink.muted}>{baseLabel}</text>

      {/* x-axis years */}
      {Array.from(new Set(years)).sort((a, b) => a - b).map((year) => (
        <text key={year} x={x(year)} y={M.top + PLOT_H + 22} textAnchor="middle" fontSize={11} fill={tokens.ink.secondary} style={{ fontVariantNumeric: "tabular-nums" }}>{year}</text>
      ))}

      {series.map((entry, index) => {
        const colour = basisColour(entry.key);
        const dash = BASIS_DASH[entry.key];
        const plotted = entry.points.map((point): [number, number] => [x(point.year), y(point.value)]);
        const last = entry.points[entry.points.length - 1]!;
        return <g key={entry.key}>
          <polyline points={points(plotted)} fill="none" stroke={colour} strokeWidth={2.2} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" />
          {entry.points.map((point, pointIndex) => <circle key={point.year} cx={plotted[pointIndex]![0]} cy={plotted[pointIndex]![1]} r={3.5} fill={colour} stroke={tokens.surface} strokeWidth={1.5}>
            <title>{`${entry.label} · ${point.year} · index ${Math.round(point.value)} (${absolute(point.absolute)} ${point.absoluteUnit})`}</title>
          </circle>)}
          {/* Direct end label — identity without reading the legend */}
          <text x={Math.min(x(last.year) + 8, M.left + PLOT_W + 4)} y={y(last.value) + (index === 0 ? -6 : 12)} fontSize={11} fontWeight={600} fill={colour}>{entry.label}</text>
        </g>;
      })}

      {/* Legend — line style repeats the dash, so it reads without colour */}
      <g transform={`translate(${M.left} 16)`}>
        {series.map((entry, index) => <g key={entry.key} transform={`translate(${index * 150} 0)`}>
          <line x1={0} y1={0} x2={22} y2={0} stroke={basisColour(entry.key)} strokeWidth={2.2} strokeDasharray={BASIS_DASH[entry.key]} strokeLinecap="round" />
          <text x={28} y={4} fontSize={11.5} fill={tokens.ink.secondary}>{entry.label}</text>
        </g>)}
      </g>
    </svg>
  );

  if (!showChrome) return svg;
  return <figure style={frameStyle}>
    <figcaption style={{ marginBottom: "2px" }}>
      <span style={kickStyle}>{data.spec.subtitle ?? "Emissions intensity"}</span>
      <h3 style={h3Style}>{data.spec.title}</h3>
    </figcaption>
    {svg}
    <p style={provStyle}><span style={{ fontWeight: 600, color: tokens.ink.secondary }}>Source</span>{"  "}{data.provenance.factorSets.join(" · ")}{" · as at "}{formatDate(data.provenance.generatedAt)}</p>
  </figure>;
}

/**
 * Ticks for an index axis: a round step that frames the values with a little air and
 * always includes the 100 reference, so the base line is on the chart by construction.
 */
function indexTicks(values: number[]): number[] {
  const low = Math.min(...values, 100);
  const high = Math.max(...values, 100);
  const step = [2, 5, 10, 20, 25, 50, 100].find((candidate) => (high - low) / candidate <= 4) ?? 200;
  const first = Math.floor((low - step / 2) / step) * step;
  const last = Math.ceil((high + step / 2) / step) * step;
  const ticks: number[] = [];
  for (let tick = Math.max(0, first); tick <= last; tick += step) ticks.push(tick);
  return ticks;
}

/**
 * The real figure, kept readable across bases that differ by orders of magnitude:
 * 565 kgCO₂e/m² rounds, 42.9 tCO₂e/£m must not — rounding it to 43 would erase the
 * movement the chart is claiming.
 */
function absolute(value: number): string {
  const decimals = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 1 : 3;
  return value.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/** Existing palette slots, none of them a scope colour. Fixed per basis, never cycled. */
export function basisColour(key: IndexedBasisSeries["key"]): string {
  return { turnover: tokens.brand.pine, employee: tokens.site[2]!, "floor-area": tokens.site[1]! }[key];
}
const BASIS_DASH: Record<IndexedBasisSeries["key"], string> = { turnover: "0", employee: "6 4", "floor-area": "2 4" };

const frameStyle: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: "12px", padding: "16px 18px 12px", margin: 0 };
const kickStyle: CSSProperties = { fontSize: "10.5px", letterSpacing: "0.12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const h3Style: CSSProperties = { fontSize: "16px", fontWeight: 600, margin: "3px 0 0", color: tokens.ink.primary };
const provStyle: CSSProperties = { fontSize: "11px", color: tokens.ink.muted, margin: "8px 0 2px" };
