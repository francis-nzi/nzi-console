import type { CSSProperties } from "react";
import type { ReductionPathwayData, YearPoint } from "./types";
import { tokens } from "./tokens";
import { scaleLinear, niceTicks, points, comma, compact, f } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

type Props = {
  data: ReductionPathwayData;
  width?: number;
  showChrome?: boolean;
};

const VB_W = 760;
const VB_H = 340;
const M = { top: 30, right: 140, bottom: 46, left: 62 };
const PLOT_W = VB_W - M.left - M.right;
const PLOT_H = VB_H - M.top - M.bottom;

/**
 * Emissions reduction pathway — measured emissions to date against the required
 * target trajectory (baseline → interim → net zero). Single y-axis (never dual).
 * Pure/stateless SVG; hover emphasis via CSS and native tooltips.
 */
export function ReductionPathway({ data, width, showChrome = true }: Props) {
  const all = [...data.actual, ...data.target];
  const years = all.map((p) => p.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const maxVal = Math.max(...all.map((p) => p.value), 0);
  const ticks = niceTicks(maxVal, 4);
  const yMax = ticks[ticks.length - 1] ?? (maxVal || 1);

  const x = scaleLinear(minYear, maxYear, M.left, M.left + PLOT_W);
  const y = scaleLinear(0, yMax, M.top + PLOT_H, M.top);

  const toXY = (p: YearPoint): [number, number] => [x(p.year), y(p.value)];
  const actualPts = data.actual.map(toXY);
  const targetPts = data.target.map(toXY);

  const baseY = y(0);
  const areaPts: Array<[number, number]> =
    actualPts.length > 0
      ? [
          [actualPts[0]![0], baseY],
          ...actualPts,
          [actualPts[actualPts.length - 1]![0], baseY],
        ]
      : [];

  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;
  const lastActual = data.actual[data.actual.length - 1];

  const svg = (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width={width ?? "100%"}
      height={width ? (width * VB_H) / VB_W : undefined}
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      style={{ display: "block", fontFamily: tokens.font }}
    >
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>
        {`Emissions reduction pathway in ${data.unit}. ` +
          `Actual: ${data.actual
            .map((p) => `${p.year} ${comma(p.value)}`)
            .join(", ")}. ` +
          `Target: ${data.target
            .map((p) => `${p.year} ${comma(p.value)}`)
            .join(", ")}.`}
      </desc>

      <style>{`
        .nzc-mk{transition:r .12s ease}
        .nzc-hit:hover + .nzc-mk{r:6}
      `}</style>

      {/* Gridlines + y ticks (recessive, 1px solid) */}
      {ticks.map((t) => {
        const gy = y(t);
        return (
          <g key={t}>
            <line
              x1={M.left}
              x2={M.left + PLOT_W}
              y1={gy}
              y2={gy}
              stroke={tokens.line}
              strokeWidth={1}
            />
            <text
              x={M.left - 10}
              y={gy + 4}
              textAnchor="end"
              fontSize={11}
              fill={tokens.ink.muted}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {comma(t)}
            </text>
          </g>
        );
      })}

      {/* x-axis year labels (milestones + latest actual) */}
      {dedupeYears([
        ...data.milestones.map((m) => m.year),
        ...(lastActual ? [lastActual.year] : []),
        minYear,
      ]).map((yr) => (
        <text
          key={yr}
          x={x(yr)}
          y={M.top + PLOT_H + 22}
          textAnchor="middle"
          fontSize={11}
          fill={tokens.ink.secondary}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {yr}
        </text>
      ))}

      {/* Area under actuals (~10% wash) */}
      {areaPts.length > 0 && (
        <polygon points={points(areaPts)} fill={tokens.brand.emerald} opacity={0.1} />
      )}

      {/* Target pathway — dashed reference, pine */}
      <polyline
        points={points(targetPts)}
        fill="none"
        stroke={tokens.brand.pine}
        strokeWidth={2}
        strokeDasharray="5 5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Actual emissions — solid emerald */}
      <polyline
        points={points(actualPts)}
        fill="none"
        stroke={tokens.brand.emerald}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Actual markers (≥8px, 2px surface ring) */}
      {data.actual.map((p) => {
        const [px, py] = toXY(p);
        return (
          <g key={`a-${p.year}`}>
            <circle className="nzc-hit" cx={px} cy={py} r={12} fill="transparent">
              <title>{`${p.year} · actual ${comma(p.value)} ${data.unit}`}</title>
            </circle>
            <circle
              className="nzc-mk"
              cx={px}
              cy={py}
              r={4.5}
              fill={tokens.brand.emerald}
              stroke={tokens.surface}
              strokeWidth={2}
            />
          </g>
        );
      })}

      {/* Milestone markers + direct labels (baseline / interim / net zero) */}
      {data.milestones.map((m) => {
        const [px, py] = toXY(m);
        const isNetZero = m.kind === "netzero";
        const labelX = isNetZero ? px + 10 : px + 10;
        const anchor = px > M.left + PLOT_W - 40 ? "end" : "start";
        const lx = anchor === "end" ? px - 10 : labelX;
        return (
          <g key={`m-${m.kind}`}>
            <circle
              cx={px}
              cy={py}
              r={5}
              fill={tokens.brand.midnight}
              stroke={tokens.surface}
              strokeWidth={2}
            >
              <title>{`${m.label} · ${comma(m.value)} ${data.unit} (${m.year})`}</title>
            </circle>
            <text
              x={lx}
              y={py - 10}
              textAnchor={anchor}
              fontSize={11.5}
              fontWeight={600}
              fill={tokens.ink.primary}
            >
              {m.label}
            </text>
            <text
              x={lx}
              y={py + 4}
              textAnchor={anchor}
              fontSize={10.5}
              fill={tokens.ink.muted}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {comma(m.value)} {data.unit}
            </text>
          </g>
        );
      })}

      {/* Legend (2 series → always present) */}
      <g transform={`translate(${M.left} 14)`}>
        <line x1={0} y1={0} x2={22} y2={0} stroke={tokens.brand.emerald} strokeWidth={2} strokeLinecap="round" />
        <text x={28} y={4} fontSize={12} fill={tokens.ink.secondary}>Actual emissions</text>
        <line x1={150} y1={0} x2={172} y2={0} stroke={tokens.brand.pine} strokeWidth={2} strokeDasharray="5 5" strokeLinecap="round" />
        <text x={178} y={4} fontSize={12} fill={tokens.ink.secondary}>Target pathway</text>
      </g>
    </svg>
  );

  if (!showChrome) return svg;

  return (
    <figure style={frameStyle}>
      <figcaption style={{ marginBottom: "2px" }}>
        <span style={kickStyle}>{data.spec.subtitle ?? "Reduction pathway"}</span>
        <h3 style={h3Style}>{data.spec.title}</h3>
      </figcaption>
      {svg}
      <p style={provStyle}>
        <span style={{ fontWeight: 600, color: tokens.ink.secondary }}>Source</span>
        {"  "}
        {data.provenance.factorSets.join(" · ")}
        {" · as at "}
        {formatDate(data.provenance.generatedAt)}
      </p>
    </figure>
  );
}

function dedupeYears(ys: number[]): number[] {
  return Array.from(new Set(ys)).sort((a, b) => a - b);
}

const frameStyle: CSSProperties = {
  background: tokens.surface,
  border: `1px solid ${tokens.line}`,
  borderRadius: "12px",
  padding: "16px 18px 12px",
  margin: 0,
};
const kickStyle: CSSProperties = {
  fontSize: "10.5px",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: tokens.brand.emerald,
  fontWeight: 600,
};
const h3Style: CSSProperties = {
  fontSize: "16px",
  fontWeight: 600,
  margin: "3px 0 0",
  color: tokens.ink.primary,
};
const provStyle: CSSProperties = {
  fontSize: "11px",
  color: tokens.ink.muted,
  margin: "8px 0 2px",
};
