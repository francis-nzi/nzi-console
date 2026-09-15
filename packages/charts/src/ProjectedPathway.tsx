import type { CSSProperties } from "react";
import type { ProjectedPathwayData } from "./types";
import { tokens } from "./tokens";
import { scaleLinear, niceTicks, points, comma, f } from "./geometry";

type Props = { data: ProjectedPathwayData; width?: number; showChrome?: boolean };

const VB_W = 760;
const VB_H = 340;
const M = { top: 30, right: 150, bottom: 46, left: 62 };
const PLOT_W = VB_W - M.left - M.right;
const PLOT_H = VB_H - M.top - M.bottom;

/**
 * Three trajectories on one axis: **measured**, **projected** and **target**.
 *
 * - **Measured** (solid emerald) — what the assured snapshots say happened.
 * - **Projected** (dashed purple) — what the client's own strategies are estimated to
 *   deliver. An estimate, and encoded as one.
 * - **Target** (dashed neutral) — what the commitment needs. A reference line to read
 *   against, not a result, so it takes a neutral rather than a third competing hue.
 *
 * **The projected line must never read as the measured one.** They differ by hue at a
 * comfortable margin (validated: normal-vision ΔE 30.7, deutan 22.9 on the chart surface)
 * *and* by dash pattern, so the distinction survives greyscale, print and colour-blindness —
 * identity never rests on colour alone. Every series is also named in the legend and, where
 * it ends, directly labelled.
 *
 * One y-axis, always. Two scales for tonnes would let the reader infer a relationship
 * between the lines that the numbers do not support.
 */
export function ProjectedPathway({ data, width, showChrome = true }: Props) {
  const all = [...data.actual, ...data.projected, ...data.target];
  const years = all.map((point) => point.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const ticks = niceTicks(Math.max(...all.map((point) => point.value), 0), 4);
  const yMax = ticks[ticks.length - 1] ?? 1;

  const x = scaleLinear(minYear, maxYear, M.left, M.left + PLOT_W);
  const y = scaleLinear(0, yMax, M.top + PLOT_H, M.top);
  const xy = (point: { year: number; value: number }): [number, number] => [x(point.year), y(point.value)];

  const series = [
    { key: "target", label: "Target — needed", colour: tokens.projection.target, dash: "2 4", data: data.target, opacity: 0.75 },
    { key: "projected", label: "Projected — planned", colour: tokens.projection.projected, dash: "7 4", data: data.projected, opacity: 1 },
    { key: "actual", label: "Measured — assured", colour: tokens.projection.actual, dash: undefined, data: data.actual, opacity: 1 },
  ] as const;

  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;
  const describe = (entry: typeof series[number]) =>
    entry.data.length === 0 ? `${entry.label}: no data.`
      : `${entry.label}: ${entry.data.map((point) => `${point.year} ${Math.round(point.value)}`).join(", ")}.`;

  const svg = (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width={width ?? "100%"} height={width ? (width * VB_H) / VB_W : undefined}
      role="img" aria-labelledby={`${titleId} ${descId}`} style={{ display: "block", fontFamily: tokens.font }}>
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>
        {`Emissions in ${data.unit}, three series. ` + series.map(describe).join(" ") +
          " Projected is an estimate from the client's reduction plan, not a measurement."}
      </desc>

      {/* Recessive grid: the data carries the emphasis, not the scaffolding. */}
      {ticks.map((tick) => (
        <g key={`t-${tick}`}>
          <line x1={M.left} y1={f(y(tick))} x2={M.left + PLOT_W} y2={f(y(tick))} stroke={tokens.line} strokeWidth={1} />
          <text x={M.left - 10} y={f(y(tick)) + 4} textAnchor="end" fontSize={11} fill={tokens.ink.muted}>{comma(tick)}</text>
        </g>
      ))}
      {[...new Set(years)].sort((a, b) => a - b).map((year) => (
        <text key={`x-${year}`} x={f(x(year))} y={M.top + PLOT_H + 20} textAnchor="middle" fontSize={11} fill={tokens.ink.muted}>{year}</text>
      ))}

      {series.map((entry) => entry.data.length === 0 ? null : (
        <g key={entry.key} opacity={entry.opacity}>
          <polyline points={points(entry.data.map(xy))} fill="none" stroke={entry.colour}
            strokeWidth={2} strokeDasharray={entry.dash} strokeLinejoin="round" strokeLinecap="round" />
          {entry.data.map((point) => {
            const [cx, cy] = xy(point);
            return (
              // A 2px surface ring keeps a marker legible where two lines cross.
              <circle key={`${entry.key}-${point.year}`} cx={f(cx)} cy={f(cy)} r={4.5}
                fill={entry.colour} stroke={tokens.surface} strokeWidth={2}>
                <title>{`${entry.label} · ${point.year}: ${comma(Math.round(point.value))} ${data.unit}`}</title>
              </circle>
            );
          })}
          {/* Direct label at the end of the line — selective, never a number on every point. */}
          {(() => {
            const last = entry.data[entry.data.length - 1];
            if (last === undefined) return null;
            const [lx, ly] = xy(last);
            return <text x={f(lx) + 10} y={f(ly) + 4} fontSize={11} fontWeight={600} fill={tokens.ink.secondary}>
              {comma(Math.round(last.value))}
            </text>;
          })()}
        </g>
      ))}

      {/* Legend: three series, so identity never rests on colour alone. */}
      <g transform={`translate(${M.left} ${VB_H - 10})`} fontSize={10.5}>
        {series.map((entry, index) => (
          <g key={`l-${entry.key}`} transform={`translate(${index * 200} 0)`}>
            <line x1={0} y1={0} x2={20} y2={0} stroke={entry.colour} strokeWidth={2}
              strokeDasharray={entry.dash} strokeLinecap="round" opacity={entry.opacity} />
            <text x={26} y={3.5} fill={tokens.ink.secondary}>{entry.label}</text>
          </g>
        ))}
      </g>
    </svg>
  );

  if (!showChrome) return svg;
  return (
    <figure style={frameStyle}>
      <figcaption style={{ marginBottom: 2 }}>
        <span style={kickStyle}>{data.spec.subtitle ?? "Trajectories"}</span>
        <h3 style={h3Style}>{data.spec.title}</h3>
      </figcaption>
      {svg}
      <p style={noteStyle}>
        Projected is an estimate built from this client&rsquo;s reduction plan. It is not a measurement and
        is not assured.
      </p>
    </figure>
  );
}

const frameStyle: CSSProperties = { margin: 0, padding: 0 };
const kickStyle: CSSProperties = { color: tokens.ink.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: ".09em", textTransform: "uppercase" };
const h3Style: CSSProperties = { margin: "2px 0 8px", fontSize: 15, color: tokens.ink.primary };
const noteStyle: CSSProperties = { margin: "6px 0 0", color: tokens.ink.muted, fontSize: 10.5, lineHeight: 1.5 };
