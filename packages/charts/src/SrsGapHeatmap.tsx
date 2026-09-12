import type { CSSProperties } from "react";
import type { SrsGapHeatmapData } from "./types";
import { tokens, srsMaturityColor, srsMaturityInk } from "./tokens";
import { f } from "./geometry";
import { formatDate } from "./EmissionsScopeDonut";

type Props = { data: SrsGapHeatmapData; width?: number; showChrome?: boolean };

const VB_W = 520;
const LABEL_W = 196;
const GRID_X = LABEL_W + 6;
const GRID_W = VB_W - GRID_X - 4;
const HEADER_H = 26;
const BAND_H = 22;
const ROW_H = 24;
const CELL_PAD = 3;

/**
 * The gap grid: every requirement as a row, every maturity level as a column, grouped
 * under its pillar band. The coloured run reaches the achieved level and stops; the
 * target rule sits at the required level, so a row short of its target is short of its
 * marker — the gap is a length, which is what the eye reads best.
 *
 * Colour is the sequential maturity ramp only. The scope palette is reserved for GHG
 * scope identity and never appears here. The achieved level also carries a marker glyph
 * and the row a tooltip, so nothing depends on colour alone.
 */
export function SrsGapHeatmap({ data, width, showChrome = true }: Props) {
  const columnCount = Math.max(1, data.levels.length);
  const cellW = GRID_W / columnCount;
  const rowCount = data.groups.reduce((total, group) => total + group.rows.length, 0);
  const vbH = HEADER_H + data.groups.length * BAND_H + rowCount * ROW_H + 8;

  const titleId = `${data.spec.id}-title`;
  const descId = `${data.spec.id}-desc`;

  let cursor = HEADER_H;
  const bands = data.groups.map((group) => {
    const bandY = cursor;
    cursor += BAND_H;
    const rows = group.rows.map((row) => {
      const rowY = cursor;
      cursor += ROW_H;
      return { row, rowY };
    });
    return { group, bandY, rows };
  });

  const svg = (
    <svg viewBox={`0 0 ${VB_W} ${vbH}`} width={width ?? "100%"} height={width ? (width * vbH) / VB_W : undefined}
      role="img" aria-labelledby={`${titleId} ${descId}`} style={{ display: "block", fontFamily: tokens.font }}>
      <title id={titleId}>{data.spec.title}</title>
      <desc id={descId}>
        {`Requirements by maturity level (${data.levels.join(", ")}). ` +
          data.groups.map((group) => `${group.label}: ${group.rows.map((row) => `${row.label} at ${levelName(data.levels, row.value)}, target ${levelName(data.levels, row.target)}`).join("; ")}`).join(". ") + "."}
      </desc>

      {/* Column headers — abbreviated, with the full level name in a tooltip */}
      {data.levels.map((level, index) => (
        <text key={`head-${level}-${index}`} x={f(GRID_X + index * cellW + cellW / 2)} y={HEADER_H - 9}
          textAnchor="middle" fontSize={9.5} fill={tokens.ink.muted}>
          {abbreviate(level)}
          <title>{level}</title>
        </text>
      ))}

      {bands.map(({ group, bandY, rows }) => (
        <g key={group.label}>
          <rect x={0} y={bandY + 2} width={VB_W} height={BAND_H - 4} rx={4} fill={tokens.paper} />
          <text x={6} y={bandY + BAND_H / 2 + 3.5} fontSize={9.5} fontWeight={700} fill={tokens.ink.secondary}
            style={{ letterSpacing: "0.08em" }}>{group.label.toUpperCase()}</text>

          {rows.map(({ row, rowY }) => {
            const cellY = rowY + CELL_PAD;
            const cellH = ROW_H - CELL_PAD * 2;
            const achieved = clampIndex(row.value, columnCount);
            const targetIndex = clampIndex(row.target, columnCount);
            return (
              <g key={`${group.label}-${row.label}`}>
                <text x={6} y={rowY + ROW_H / 2 + 3.5} fontSize={10.5} fill={tokens.ink.primary}>
                  {truncate(row.label, 32)}
                  <title>{row.label}</title>
                </text>

                {data.levels.map((level, columnIndex) => {
                  const cellX = GRID_X + columnIndex * cellW;
                  const reached = achieved >= columnIndex;
                  return (
                    <g key={`${row.label}-${columnIndex}`}>
                      <rect x={f(cellX + 1)} y={cellY} width={f(cellW - 2)} height={cellH} rx={2}
                        fill={reached ? srsMaturityColor(achieved) : tokens.line2}>
                        <title>{`${row.label} · ${level} · ${reached ? "reached" : "not reached"} (at ${levelName(data.levels, row.value)}, target ${levelName(data.levels, row.target)})`}</title>
                      </rect>
                      {/* The achieved level itself carries a glyph — never colour-alone */}
                      {columnIndex === achieved && (
                        <circle cx={f(cellX + cellW / 2)} cy={f(cellY + cellH / 2)} r={2.6} fill={srsMaturityInk(achieved)} />
                      )}
                      {/* Target rule, on the required level's cell */}
                      {columnIndex === targetIndex && (
                        <rect x={f(cellX + cellW - 2)} y={cellY - 2} width={2} height={cellH + 4} fill={tokens.srs.target} opacity={0.55} />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
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

function clampIndex(value: number, columnCount: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(columnCount - 1, Math.round(value)));
}

function levelName(levels: string[], value: number): string {
  return levels[clampIndex(value, Math.max(1, levels.length))] ?? String(value);
}

/** Column headers are narrow: four characters, no ellipsis (the tooltip carries the rest). */
function abbreviate(level: string): string {
  return level.length > 4 ? level.slice(0, 4) : level;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const frameStyle: CSSProperties = { background: tokens.surface, border: `1px solid ${tokens.line}`, borderRadius: "12px", padding: "16px 18px 12px", margin: 0 };
const kickStyle: CSSProperties = { fontSize: "10.5px", letterSpacing: "0.12em", textTransform: "uppercase", color: tokens.brand.emerald, fontWeight: 600 };
const h3Style: CSSProperties = { fontSize: "16px", fontWeight: 600, margin: "3px 0 0", color: tokens.ink.primary };
const provStyle: CSSProperties = { fontSize: "11px", color: tokens.ink.muted, margin: "8px 0 2px" };
