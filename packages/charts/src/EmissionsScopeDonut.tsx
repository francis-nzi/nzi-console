import type { CSSProperties } from "react";
import type { ScopeDonutData } from "./types";
import { tokens, scopeColor } from "./tokens";
import { annularSector, comma, compact, pct, f } from "./geometry";

type Props = {
  data: ScopeDonutData;
  /** Fixed pixel width for print/raster; omit to fill the container. */
  width?: number;
  /** Render title + provenance footer around the figure (default true). */
  showChrome?: boolean;
};

const VB_W = 760;
const VB_H = 300;
const CX = 150;
const CY = 150;
const R_OUT = 118;
const R_IN = 78;
const R_MID = (R_OUT + R_IN) / 2;
const GAP_DEG = (2 / R_MID) * (180 / Math.PI); // 2px surface gap between segments

/**
 * Emissions by GHG Protocol scope. Categorical identity by scope (brand-locked
 * coral/amber/emerald), rendered with the secondary encoding scope fills require
 * on a light surface: 2px surface gaps, a legend with values, a centre total and
 * native tooltips. Pure/stateless SVG — identical on screen and in print.
 */
export function EmissionsScopeDonut({ data, width, showChrome = true }: Props) {
  const segments = data.segments.filter((s) => s.value > 0);
  const total =
    data.total ?? segments.reduce((sum, s) => sum + s.value, 0);
  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;

  // Cumulative arcs from 12 o'clock, clockwise.
  let cursor = 0;
  const arcs = segments.map((s) => {
    const sweep = total > 0 ? (s.value / total) * 360 : 0;
    const start = cursor + GAP_DEG / 2;
    const end = cursor + sweep - GAP_DEG / 2;
    cursor += sweep;
    return {
      seg: s,
      color: scopeColor(s.scope),
      d: end > start ? annularSector(CX, CY, R_OUT, R_IN, start, end) : "",
    };
  });

  const legendX = 320;
  const rowH = 46;
  const legendTop = CY - (segments.length * rowH) / 2 + 6;

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
        {`Emissions by scope. Total ${comma(total)} ${data.unit}. ` +
          segments
            .map((s) => `${s.label} ${comma(s.value)} (${pct(s.value, total)})`)
            .join("; ") +
          "."}
      </desc>

      <style>{`
        .nzc-seg{transition:opacity .12s ease, transform .12s ease;transform-origin:${CX}px ${CY}px}
        .nzc-donut:hover .nzc-seg{opacity:.4}
        .nzc-donut .nzc-seg:hover{opacity:1;transform:scale(1.02)}
        .nzc-lrow{cursor:default}
      `}</style>

      {/* Donut */}
      <g className="nzc-donut">
        {arcs.map((a) =>
          a.d ? (
            <path key={a.seg.scope} className="nzc-seg" d={a.d} fill={a.color}>
              <title>{`${a.seg.label} — ${comma(a.seg.value)} ${data.unit} (${pct(
                a.seg.value,
                total,
              )})`}</title>
            </path>
          ) : null,
        )}

        {/* Centre hero total (proportional figures, not tabular) */}
        <text
          x={CX}
          y={CY - 6}
          textAnchor="middle"
          fontSize={38}
          fontWeight={600}
          fill={tokens.ink.primary}
          letterSpacing={-0.5}
        >
          {compact(total)}
        </text>
        <text
          x={CX}
          y={CY + 16}
          textAnchor="middle"
          fontSize={13}
          fill={tokens.ink.secondary}
        >
          {data.unit}
        </text>
        <text
          x={CX}
          y={CY + 34}
          textAnchor="middle"
          fontSize={10.5}
          fill={tokens.ink.muted}
          letterSpacing={1.2}
        >
          TOTAL
        </text>
      </g>

      {/* Legend + values (identity via swatch; text in ink tokens) */}
      <g transform={`translate(${legendX} ${legendTop})`}>
        {segments.map((s, i) => {
          const color = scopeColor(s.scope);
          const y = i * rowH;
          return (
            <g key={s.scope} className="nzc-lrow" transform={`translate(0 ${y})`}>
              <rect x={0} y={0} width={12} height={12} rx={3} fill={color} />
              <text x={22} y={11} fontSize={13.5} fontWeight={600} fill={tokens.ink.primary}>
                {s.label}
              </text>
              <text
                x={0}
                y={30}
                fontSize={16}
                fontWeight={600}
                fill={tokens.ink.primary}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {comma(s.value)}
                <tspan fontSize={11} fontWeight={500} fill={tokens.ink.muted}>
                  {"  "}
                  {data.unit}
                </tspan>
              </text>
              <text x={230} y={30} textAnchor="end" fontSize={13} fill={tokens.ink.secondary}>
                {pct(s.value, total)}
              </text>
              {/* share track */}
              <rect x={0} y={38} width={230} height={4} rx={2} fill={tokens.line2} />
              <rect
                x={0}
                y={38}
                width={f((Math.max(0, s.value) / (total || 1)) * 230)}
                height={4}
                rx={2}
                fill={color}
              />
            </g>
          );
        })}
      </g>
    </svg>
  );

  if (!showChrome) return svg;

  return (
    <figure style={frameStyle}>
      <figcaption style={capStyle}>
        <span style={kickStyle}>{data.spec.subtitle ?? "Emissions by scope"}</span>
        <h3 style={h3Style}>{data.spec.title}</h3>
      </figcaption>
      {svg}
      <Provenance data={data} />
    </figure>
  );
}

function Provenance({ data }: { data: ScopeDonutData }) {
  return (
    <p style={provStyle}>
      <span style={{ fontWeight: 600, color: tokens.ink.secondary }}>Source</span>
      {"  "}
      {data.provenance.factorSets.join(" · ")}
      {data.provenance.quality ? ` · ${data.provenance.quality}` : ""}
      {" · as at "}
      {formatDate(data.provenance.generatedAt)}
    </p>
  );
}

export function formatDate(iso: string): string {
  // Deterministic, locale-stable formatting (no Date.now()).
  const d = new Date(iso);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const m = months[d.getUTCMonth()] ?? "";
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
}

const frameStyle: CSSProperties = {
  background: tokens.surface,
  border: `1px solid ${tokens.line}`,
  borderRadius: "12px",
  padding: "16px 18px 12px",
  margin: 0,
};
const capStyle: CSSProperties = { marginBottom: "6px" };
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
