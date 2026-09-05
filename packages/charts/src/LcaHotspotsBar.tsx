import type { CSSProperties } from "react";
import type { LcaHotspotsBarData } from "./types";
import { tokens, moduleGroupColor } from "./tokens";
import { comma, niceTicks, scaleLinear, pct } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

const W = 760, ROW = 44, M = { top: 18, right: 96, bottom: 34, left: 240 };

/**
 * The line items contributing most to the LCA total — a horizontal bar,
 * coloured by the line's EN 15804 module group, with the emission value and
 * its share. Pure/stateless SVG, identical on screen and in print. The bar
 * lengths and the share labels are pure functions of the reviewed snapshot's
 * `hotspots`.
 */
export function LcaHotspotsBar({ data, width, showChrome = true }: { data: LcaHotspotsBarData; width?: number; showChrome?: boolean }) {
  const items = [...data.hotspots].sort((a, b) => b.value - a.value);
  const H = M.top + M.bottom + Math.max(1, items.length) * ROW;
  const PW = W - M.left - M.right, max = Math.max(0, ...items.map((i) => i.value));
  const ticks = niceTicks(max, 4), xMax = ticks.at(-1) ?? 1, x = scaleLinear(0, xMax, M.left, M.left + PW);

  const svg = (
    <svg viewBox={`0 0 ${W} ${H}`} width={width ?? "100%"} height={width ? (width * H) / W : undefined} role="img" aria-label={data.spec.title} style={{ display: "block", fontFamily: tokens.font }}>
      {ticks.map((tick) => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={M.top} y2={H - M.bottom} stroke={tokens.line} /><text x={x(tick)} y={H - 10} textAnchor="middle" fontSize={10.5} fill={tokens.ink.muted}>{comma(tick)}</text></g>)}
      {items.map((item, i) => {
        const y = M.top + i * ROW + 9, barW = Math.max(0, x(item.value) - M.left), color = moduleGroupColor(item.group);
        return (
          <g key={item.id}>
            <text x={M.left - 12} y={y + 15} textAnchor="end" fontSize={12.5} fill={tokens.ink.primary}>{item.label}</text>
            <rect x={M.left} y={y} width={barW} height={22} rx={4} fill={color}><title>{`${item.label}: ${comma(item.value)} ${data.unit} (${item.sharePct.toFixed(0)}% of total)`}</title></rect>
            <text x={Math.min(M.left + barW + 8, W - 4)} y={y + 15} fontSize={11.5} fontWeight={600} fill={tokens.ink.secondary}>{comma(item.value)}<tspan fill={tokens.ink.muted}>{"  "}{item.sharePct.toFixed(0)}%</tspan></text>
          </g>
        );
      })}
    </svg>
  );

  return showChrome ? (
    <figure style={frame}>
      <figcaption><span style={kick}>{data.spec.subtitle ?? "Emission hotspots"}</span><h3 style={title}>{data.spec.title}</h3></figcaption>
      {svg}
      <p style={footer}><b>Source</b>{"  "}{data.provenance.factorSets.join(" · ")} · as at {formatDate(data.provenance.generatedAt)}</p>
    </figure>
  ) : svg;
}

const frame: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: 12, padding: "16px 18px 12px", margin: 0 };
const kick: CSSProperties = { fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const title: CSSProperties = { fontSize: 16, fontWeight: 600, margin: "3px 0 2px", color: tokens.ink.primary };
const footer: CSSProperties = { fontSize: 11, color: tokens.ink.muted, margin: "8px 0 2px" };
