import type { CSSProperties, ReactNode } from "react";
import { f, points } from "./geometry";
import { tokens } from "./tokens";

/**
 * The readiness graphics (SRS S2) — the dial, the linear meter, the guarded radar, the requirement heatmap and the trend
 * — all on **one scale**: the five-step maturity ladder, 0 Not started → 4 Assured, drawn as one ordinal ramp on the
 * brand pine hue, light → dark. The CRM dashboard and the client portal render these same components, so the client
 * sees the identical dial and radar the consultant does.
 *
 * Rules every component here keeps (the design authority's, and the dataviz method's):
 * - **Colour never carries the score alone.** Wherever a fill encodes a step, the number (and, where there is room, the
 *   step name) is printed beside or inside it — CVD, print and forced-colors read the same thing.
 * - **One ramp, not a palette.** Never a hue per pillar, never a rainbow; status colours stay reserved for state.
 * - **Dark mode is its own steps** (`SRS_LADDER.dark`), validated against the dark surface — not an inversion.
 * - **A hover layer on every mark** (a CSS tooltip, so it needs no script and prints as nothing), each with an
 *   accessible `<title>`; a table view lives beside every plot in the page.
 * - **Provisional is visibly different.** A draft's scores are hatched and dashed, and say so, never a bare verdict.
 *
 * Ramp validation (the dataviz ordinal validator, 26 Oct 2026): light on #FFFFFF — monotone, adjacent ΔL ≥ 0.06, light
 * end 2.08:1, hue spread 1° — ALL PASS; dark on #141C18 — light end 2.14:1, hue spread 0° — ALL PASS. Label ink on
 * every step ≥ 4.5:1 in both modes.
 */

export type SrsMode = "light" | "dark";

export const SRS_LADDER = {
  light: {
    ramp: ["#89C09F", "#59A57A", "#1A8454", "#00673C", "#004B2A"],
    ink: ["#0B1B2B", "#0B1B2B", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
    surface: "#FFFFFF", track: "#EDF1EF", line: "#E4EAE7", text: "#0B1B2B", text2: "#51605A", muted: "#616B65", reference: "#14201A",
    tipBg: "#0B1B2B", tipText: "#FFFFFF",
  },
  dark: {
    ramp: ["#28593E", "#2C7A52", "#399C69", "#5BBB87", "#92D6AD"],
    ink: ["#FFFFFF", "#FFFFFF", "#0B1B2B", "#0B1B2B", "#0B1B2B"],
    surface: "#141C18", track: "#1C251F", line: "#25302A", text: "#E8EDEA", text2: "#A3AEA8", muted: "#8A948F", reference: "#E8EDEA",
    tipBg: "#E8EDEA", tipText: "#0B1B2B",
  },
} as const;

const MAX = 4;
const clamp = (value: number) => Math.max(0, Math.min(MAX, Number.isFinite(value) ? value : 0));
/** The step a level has reached — the floor — so a colour never claims a step not yet reached. */
export const srsStepOf = (level: number) => Math.min(MAX, Math.floor(clamp(level) + 1e-9));
export const srsFill = (level: number, mode: SrsMode = "light") => SRS_LADDER[mode].ramp[srsStepOf(level)]!;
export const srsInk = (level: number, mode: SrsMode = "light") => SRS_LADDER[mode].ink[srsStepOf(level)]!;
const one = (value: number) => (Math.round(value * 10) / 10).toFixed(1);

/** A unique-enough id prefix for patterns and tips within one page. */
const idFor = (prefix: string, key: string) => `${prefix}-${key.replace(/[^a-zA-Z0-9_-]/g, "")}`;

/** The hover layer: an invisible hit area, then a tooltip shown while it is hovered or focused. Print shows neither. */
function HoverStyle({ scope }: { scope: string }) {
  return <style>{`#${scope} .nzs-tip{visibility:hidden;pointer-events:none}#${scope} .nzs-hit:hover+.nzs-tip,#${scope} .nzs-hit:focus+.nzs-tip{visibility:visible}#${scope} .nzs-hit{outline:none;cursor:default}#${scope} .nzs-hit:focus-visible{stroke:currentColor;stroke-width:1.5}@media print{#${scope} .nzs-tip{display:none}}`}</style>;
}

function Tip({ x, y, lines, mode, bounds }: { x: number; y: number; lines: string[]; mode: SrsMode; bounds: { w: number; h: number } }) {
  const t = SRS_LADDER[mode];
  // Sized for the bold first line at 10px (≈ 6.1px a character), so no line runs out of its box.
  const width = Math.min(bounds.w - 8, Math.max(...lines.map((line) => line.length)) * 6.1 + 16);
  const height = lines.length * 13 + 10;
  const left = Math.max(4, Math.min(bounds.w - width - 4, x - width / 2));
  const top = y - height - 8 < 2 ? Math.min(bounds.h - height - 2, y + 10) : y - height - 8;
  return <g className="nzs-tip" aria-hidden="true">
    <rect x={f(left)} y={f(top)} width={f(width)} height={height} rx={4} fill={t.tipBg} opacity={0.96} />
    {lines.map((line, index) => <text key={index} x={f(left + 8)} y={f(top + 16 + index * 13)} fontSize={10} fontWeight={index === 0 ? 600 : 400} fill={t.tipText}>{line}</text>)}
  </g>;
}

/** The hatch a provisional fill wears: the step's colour in stripes over the surface. */
function Hatch({ id, colour, mode }: { id: string; colour: string; mode: SrsMode }) {
  return <pattern id={id} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width={5} height={5} fill={SRS_LADDER[mode].surface} />
    <rect width={2.5} height={5} fill={colour} />
  </pattern>;
}

/* ── The dial (R2) ─────────────────────────────────────────────────────────────────────────────────────────────── */

export type SrsDialProps = {
  /** The pillar (or "Overall"). */
  label: string;
  level: number;
  stepName: string;
  target?: number | null;
  mode?: SrsMode;
  provisional?: boolean;
  size?: number;
};

const SWEEP = 240; // degrees, opening at the bottom
const START = 150; // from the bottom-left, clockwise
const polarAt = (cx: number, cy: number, r: number, degrees: number): [number, number] => {
  const radians = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)];
};
const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
  const [x1, y1] = polarAt(cx, cy, r, from);
  const [x2, y2] = polarAt(cx, cy, r, to);
  return `M ${f(x1)} ${f(y1)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${f(x2)} ${f(y2)}`;
};

/**
 * One pillar's maturity as a thin radial gauge against the fixed top of the ladder (4): a hairline track with a tick at
 * each step, a thin arc filled to the level in the step's colour, the target as a short rule across the track, and the
 * **number and the step name in the centre** — the reading never depends on the arc's geometry or its colour.
 */
export function SrsDial({ label, level, stepName, target = null, mode = "light", provisional = false, size = 132 }: SrsDialProps) {
  const t = SRS_LADDER[mode];
  const W = 132, H = 118, cx = 66, cy = 62, r = 48;
  const value = clamp(level);
  const scope = idFor("srs-dial", `${label}-${mode}-${provisional ? "p" : "f"}`);
  const fill = srsFill(value, mode);
  const end = START + (SWEEP * value) / MAX;
  const angleOf = (step: number) => START + (SWEEP * step) / MAX;
  const summary = `${label}: ${one(value)} of 4 · ${stepName}${target !== null ? ` · target ${target}` : ""}${provisional ? " · provisional" : ""}`;
  return <svg id={scope} viewBox={`0 0 ${W} ${H}`} width={size} height={(size * H) / W} role="img" aria-label={summary} style={{ display: "block", fontFamily: tokens.font, overflow: "visible" }}>
    <HoverStyle scope={scope} />
    {provisional ? <defs><Hatch id={`${scope}-hatch`} colour={fill} mode={mode} /></defs> : null}
    <path d={arc(cx, cy, r, START, START + SWEEP)} fill="none" stroke={t.track} strokeWidth={8} strokeLinecap="round" />
    {[0, 1, 2, 3, 4].map((step) => {
      const [x1, y1] = polarAt(cx, cy, r - 7, angleOf(step));
      const [x2, y2] = polarAt(cx, cy, r - 4, angleOf(step));
      return <line key={step} x1={f(x1)} y1={f(y1)} x2={f(x2)} y2={f(y2)} stroke={t.muted} strokeWidth={1} />;
    })}
    {value > 0 ? <path d={arc(cx, cy, r, START, Math.max(START + 0.5, end))} fill="none" stroke={provisional ? `url(#${scope}-hatch)` : fill} strokeWidth={8} strokeLinecap="round" /> : null}
    {target !== null ? (() => {
      const [x1, y1] = polarAt(cx, cy, r - 7, angleOf(clamp(target)));
      const [x2, y2] = polarAt(cx, cy, r + 7, angleOf(clamp(target)));
      return <line x1={f(x1)} y1={f(y1)} x2={f(x2)} y2={f(y2)} stroke={t.reference} strokeWidth={2} strokeLinecap="round" />;
    })() : null}
    <text x={cx} y={cy + 2} textAnchor="middle" fontSize={22} fontWeight={650} fill={t.text}>{one(value)}</text>
    <text x={cx} y={cy + 17} textAnchor="middle" fontSize={9.5} fill={t.text2}>{stepName}</text>
    <text x={cx} y={cy + 29} textAnchor="middle" fontSize={8.5} fill={t.muted}>{provisional ? "provisional · of 4" : "of 4"}</text>
    <text x={cx} y={H - 3} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={t.text}>{label}</text>
    <circle className="nzs-hit" cx={cx} cy={cy} r={r + 8} fill="transparent" tabIndex={0}><title>{summary}</title></circle>
    <Tip x={cx} y={cy - r} lines={[label, `${one(value)} of 4 · ${stepName}`, ...(target !== null ? [`Target ${target}`] : []), ...(provisional ? ["Provisional — not yet assessed"] : [])]} mode={mode} bounds={{ w: W, h: H }} />
  </svg>;
}

/* ── The linear meter (R2's fallback and table equivalent) ─────────────────────────────────────────────────────── */

export type SrsMeterRow = { label: string; level: number; stepName: string; target?: number | null };

/** The same scores as straight meters on the ladder — the compact, accessible equivalent of the dials. */
export function SrsMeter({ rows, mode = "light", provisional = false, width }: { rows: SrsMeterRow[]; mode?: SrsMode; provisional?: boolean; width?: number }) {
  const t = SRS_LADDER[mode];
  const W = 420, LABEL = 128, VALUE = 112, ROW = 26, TOP = 16;
  const trackW = W - LABEL - VALUE;
  const H = TOP + rows.length * ROW + 4;
  const scope = idFor("srs-meter", `${rows.map((row) => row.label).join("-")}-${mode}-${provisional ? "p" : "f"}`);
  const x = (level: number) => LABEL + (trackW * clamp(level)) / MAX;
  return <svg id={scope} viewBox={`0 0 ${W} ${H}`} width={width ?? "100%"} role="img" aria-label={`Maturity by pillar on the 0–4 ladder${provisional ? ", provisional" : ""}`} style={{ display: "block", fontFamily: tokens.font }}>
    <HoverStyle scope={scope} />
    <defs>{provisional ? rows.map((row, index) => <Hatch key={index} id={`${scope}-h${index}`} colour={srsFill(row.level, mode)} mode={mode} />) : null}</defs>
    {[0, 1, 2, 3, 4].map((step) => <g key={step}>
      <line x1={f(x(step))} y1={TOP - 4} x2={f(x(step))} y2={H - 4} stroke={t.line} strokeWidth={1} />
      <text x={f(x(step))} y={TOP - 7} textAnchor="middle" fontSize={8.5} fill={t.muted}>{step}</text>
    </g>)}
    {rows.map((row, index) => {
      const y = TOP + index * ROW;
      const value = clamp(row.level);
      return <g key={row.label}>
        <text x={0} y={y + 15} fontSize={10.5} fill={t.text}>{row.label}</text>
        <rect x={LABEL} y={y + 7} width={trackW} height={10} rx={5} fill={t.track} />
        {value > 0 ? <rect x={LABEL} y={y + 7} width={f(Math.max(10, x(value) - LABEL))} height={10} rx={5}
          fill={provisional ? `url(#${scope}-h${index})` : srsFill(value, mode)} stroke={provisional ? srsFill(value, mode) : "none"} strokeDasharray={provisional ? "3 2" : undefined} /> : null}
        {row.target != null ? <line x1={f(x(row.target))} y1={y + 3} x2={f(x(row.target))} y2={y + 21} stroke={t.reference} strokeWidth={2} strokeLinecap="round" /> : null}
        <text x={W - VALUE + 10} y={y + 15} fontSize={10.5} fill={t.text}><tspan fontWeight={650}>{one(value)}</tspan>{` · ${row.stepName}`}</text>
      </g>;
    })}
    {/* The hover layer last, so no row paints over another row's tooltip. */}
    {rows.map((row, index) => {
      const y = TOP + index * ROW;
      const value = clamp(row.level);
      const summary = `${row.label}: ${one(value)} of 4 · ${row.stepName}${row.target != null ? ` · target ${row.target}` : ""}`;
      return <g key={`hit-${row.label}`}>
        <rect className="nzs-hit" x={0} y={y} width={W} height={ROW} fill="transparent" tabIndex={0}><title>{summary}</title></rect>
        <Tip x={x(value)} y={y + 6} lines={[row.label, `${one(value)} of 4 · ${row.stepName}`, ...(row.target != null ? [`Target ${row.target}`] : [])]} mode={mode} bounds={{ w: W, h: H }} />
      </g>;
    })}
  </svg>;
}

/* ── The radar, guarded (R3) ───────────────────────────────────────────────────────────────────────────────────── */

export type SrsRadarAxis = { label: string; value: number; target?: number | null };

/**
 * The four pillars as fixed axes, a ring at each ladder step (1–4, labelled), and **at most two shapes**: the client's
 * maturity, and — when set — the target as a dashed reference. Every vertex of the client's shape is value-labelled, and
 * the page puts the same four numbers in a table beside it: radar area is hard to read exactly, so the plot is never
 * the only place a score lives. The type takes one series and one reference, so a third cannot be passed.
 */
export function SrsRadar({ axes, seriesLabel, targetLabel = "Target", mode = "light", provisional = false, size = 300 }: {
  axes: SrsRadarAxis[]; seriesLabel: string; targetLabel?: string; mode?: SrsMode; provisional?: boolean; size?: number;
}) {
  const t = SRS_LADDER[mode];
  const W = 300, H = 270, cx = 150, cy = 124, R = 86;
  const n = Math.max(3, axes.length);
  const scope = idFor("srs-radar", `${seriesLabel}-${mode}-${provisional ? "p" : "f"}`);
  const vertex = (index: number, radius: number): [number, number] => {
    const angle = -Math.PI / 2 + (index / n) * 2 * Math.PI;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  };
  const ring = (step: number) => points(axes.map((_, index) => vertex(index, (step / MAX) * R)));
  const shape = (values: number[]) => points(axes.map((_, index) => vertex(index, (clamp(values[index] ?? 0) / MAX) * R)));
  const hasTarget = axes.some((axis) => axis.target != null);
  const stroke = SRS_LADDER[mode].ramp[3];
  const summary = `${seriesLabel}: ${axes.map((axis) => `${axis.label} ${one(axis.value)}`).join(", ")}${hasTarget ? `. ${targetLabel}: ${axes.map((axis) => `${axis.label} ${axis.target ?? "–"}`).join(", ")}` : ""}${provisional ? ". Provisional" : ""}.`;
  return <svg id={scope} viewBox={`0 0 ${W} ${H}`} width={size} height={(size * H) / W} role="img" aria-label={summary} style={{ display: "block", fontFamily: tokens.font, maxWidth: "100%" }}>
    <HoverStyle scope={scope} />
    {provisional ? <defs><Hatch id={`${scope}-hatch`} colour={stroke} mode={mode} /></defs> : null}
    {[1, 2, 3, 4].map((step) => <polygon key={step} points={ring(step)} fill="none" stroke={t.line} strokeWidth={1} />)}
    {[1, 2, 3, 4].map((step) => <text key={`l${step}`} x={cx + 3} y={f(cy - (step / MAX) * R + 3)} fontSize={8} fill={t.muted}>{step}</text>)}
    {axes.map((axis, index) => {
      const [sx, sy] = vertex(index, R);
      const [lx, ly] = vertex(index, R + 14);
      return <g key={axis.label}>
        <line x1={cx} y1={cy} x2={f(sx)} y2={f(sy)} stroke={t.line} strokeWidth={1} />
        <text x={f(lx)} y={f(ly)} textAnchor={lx > cx + 1 ? "start" : lx < cx - 1 ? "end" : "middle"} dominantBaseline="middle" fontSize={10} fill={t.text2}>{axis.label}</text>
      </g>;
    })}
    {hasTarget ? <polygon points={shape(axes.map((axis) => axis.target ?? 0))} fill="none" stroke={t.reference} strokeWidth={1.5} strokeDasharray="4 4" opacity={0.7} strokeLinejoin="round" /> : null}
    <polygon points={shape(axes.map((axis) => axis.value))} fill={provisional ? `url(#${scope}-hatch)` : stroke} fillOpacity={provisional ? 0.35 : 0.18}
      stroke={stroke} strokeWidth={2} strokeDasharray={provisional ? "5 3" : undefined} strokeLinejoin="round" />
    {axes.map((axis, index) => {
      const value = clamp(axis.value);
      const [px, py] = vertex(index, (value / MAX) * R);
      const [tx, ty] = vertex(index, (value / MAX) * R + 12);
      return <g key={`v${axis.label}`}>
        <circle cx={f(px)} cy={f(py)} r={4} fill={stroke} stroke={t.surface} strokeWidth={2} />
        <text x={f(tx)} y={f(ty)} textAnchor="middle" dominantBaseline="middle" fontSize={9.5} fontWeight={650} fill={t.text}>{one(value)}</text>
      </g>;
    })}
    <g transform={`translate(10 ${H - 12})`} fontSize={9.5}>
      <line x1={0} y1={0} x2={18} y2={0} stroke={stroke} strokeWidth={2.5} strokeDasharray={provisional ? "5 3" : undefined} strokeLinecap="round" />
      <text x={23} y={3.5} fill={t.text2}>{seriesLabel}{provisional ? " (provisional)" : ""}</text>
      {/* The target's key sits after the series' own, however long the client's name — never over it. */}
      {hasTarget ? <g transform={`translate(${f(Math.min(W - 70, 23 + (seriesLabel.length + (provisional ? 14 : 0)) * 5.3 + 16))} 0)`}>
        <line x1={0} y1={0} x2={18} y2={0} stroke={t.reference} strokeWidth={1.5} strokeDasharray="4 4" opacity={0.7} />
        <text x={23} y={3.5} fill={t.text2}>{targetLabel}</text>
      </g> : null}
    </g>
    {/* The hover layer last, so no vertex, label or key paints over a tooltip. */}
    {axes.map((axis, index) => {
      const value = clamp(axis.value);
      const [px, py] = vertex(index, (value / MAX) * R);
      return <g key={`hit-${axis.label}`}>
        <circle className="nzs-hit" cx={f(px)} cy={f(py)} r={11} fill="transparent" tabIndex={0}><title>{`${axis.label}: ${one(value)} of 4${axis.target != null ? `, target ${axis.target}` : ""}`}</title></circle>
        <Tip x={px} y={py} lines={[axis.label, `${seriesLabel}: ${one(value)} of 4`, ...(axis.target != null ? [`${targetLabel}: ${axis.target}`] : [])]} mode={mode} bounds={{ w: W, h: H }} />
      </g>;
    })}
  </svg>;
}

/* ── The heatmap (R4) ──────────────────────────────────────────────────────────────────────────────────────────── */

export type SrsHeatCell = { code: string; title: string; maturity: number | null; stepName: string | null; target: number; detail?: string[] };
export type SrsHeatColumn = { label: string; cells: SrsHeatCell[] };

/**
 * Requirement × pillar: a column per pillar, a cell per requirement in the framework's order, each filled on the ladder
 * ramp **with its code and its number printed in it**. An unanswered requirement is an empty outlined cell marked "–"
 * (not a zero); a requirement below its own target carries a small ink notch in its corner. Per-cell hover carries the
 * requirement, its score, target and — for staff — evidence, owner and due.
 */
export function SrsHeatmap({ columns, mode = "light", provisional = false, width }: { columns: SrsHeatColumn[]; mode?: SrsMode; provisional?: boolean; width?: number }) {
  const t = SRS_LADDER[mode];
  const W = 560, HEAD = 22, CELL_H = 24, GAP = 3;
  const colW = (W - GAP * (columns.length - 1)) / Math.max(1, columns.length);
  const rows = Math.max(...columns.map((column) => column.cells.length), 1);
  const H = HEAD + rows * (CELL_H + GAP) + 2;
  const scope = idFor("srs-heat", `${columns.map((column) => column.label).join("-")}-${mode}-${provisional ? "p" : "f"}`);
  return <svg id={scope} viewBox={`0 0 ${W} ${H}`} width={width ?? "100%"} role="img"
    aria-label={`Every requirement's maturity on the 0–4 ladder, by pillar${provisional ? ", provisional" : ""}. The register below lists the same scores.`} style={{ display: "block", fontFamily: tokens.font }}>
    <HoverStyle scope={scope} />
    <defs>{provisional ? [0, 1, 2, 3, 4].map((step) => <Hatch key={step} id={`${scope}-h${step}`} colour={t.ramp[step]!} mode={mode} />) : null}</defs>
    {columns.map((column, ci) => {
      const x = ci * (colW + GAP);
      return <g key={column.label}>
        <text x={f(x + 2)} y={14} fontSize={10.5} fontWeight={600} fill={t.text}>{column.label}</text>
        {column.cells.map((cell, ri) => {
          const y = HEAD + ri * (CELL_H + GAP);
          const answered = cell.maturity !== null;
          const step = answered ? srsStepOf(cell.maturity!) : 0;
          const fill = !answered ? t.surface : provisional ? `url(#${scope}-h${step})` : t.ramp[step]!;
          const ink = !answered || provisional ? t.text : t.ink[step]!;
          const below = answered ? cell.maturity! < cell.target : cell.target > 0;
          return <g key={cell.code}>
            <rect x={f(x)} y={y} width={f(colW)} height={CELL_H} rx={3} fill={fill} stroke={answered ? "none" : t.line} strokeDasharray={answered ? undefined : "3 2"} />
            {/* A provisional cell's labels sit on surface plates, so the hatch never costs the reading. */}
            {provisional && answered ? <>
              <rect x={f(x + 3)} y={y + 4} width={cell.code.length * 5.8 + 7} height={CELL_H - 8} rx={2} fill={t.surface} opacity={0.92} />
              <rect x={f(x + colW - 26)} y={y + 4} width={22} height={CELL_H - 8} rx={2} fill={t.surface} opacity={0.92} />
            </> : null}
            <text x={f(x + 6)} y={y + 15.5} fontSize={9.5} fill={provisional && answered ? t.text : ink}>{cell.code}</text>
            <text x={f(x + colW - 15)} y={y + 15.5} textAnchor="middle" fontSize={10.5} fontWeight={650} fill={provisional ? t.text : ink}>{answered ? cell.maturity : "–"}</text>
            {below ? <path d={`M ${f(x)} ${y + 7} L ${f(x)} ${y + 3} Q ${f(x)} ${y} ${f(x + 3)} ${y} L ${f(x + 7)} ${y} Z`} fill={t.text} /> : null}
          </g>;
        })}
      </g>;
    })}
    {/* The hover layer last, so a cell's tooltip is never painted over by a later column. */}
    {columns.flatMap((column, ci) => column.cells.map((cell, ri) => {
      const x = ci * (colW + GAP), y = HEAD + ri * (CELL_H + GAP);
      const lines = [`${cell.code} · ${cell.title.length > 60 ? `${cell.title.slice(0, 58)}…` : cell.title}`,
        cell.maturity !== null ? `${cell.maturity} of 4 · ${cell.stepName ?? ""} · target ${cell.target}` : `Not yet answered · target ${cell.target}`, ...(cell.detail ?? [])];
      return <g key={`hit-${column.label}-${cell.code}`}>
        <rect className="nzs-hit" x={f(x)} y={y} width={f(colW)} height={CELL_H} fill="transparent" tabIndex={0}><title>{lines.join(". ")}</title></rect>
        <Tip x={x + colW / 2} y={y} lines={lines} mode={mode} bounds={{ w: W, h: H }} />
      </g>;
    }))}
  </svg>;
}

/* ── The trend (R5) ────────────────────────────────────────────────────────────────────────────────────────────── */

export type SrsTrendPointView = { label: string; level: number };

/**
 * Maturity across completed assessments, on the same 0–4 axis — gridlines at each step, named. One series (or one per
 * small multiple), never a second axis. A single assessment is a single labelled point, never a line: there is no slope
 * until there is a reassessment. Per-point hover.
 */
export function SrsTrend({ title, points: series, mode = "light", width, compact = false }: { title: string; points: SrsTrendPointView[]; mode?: SrsMode; width?: number; compact?: boolean }) {
  const t = SRS_LADDER[mode];
  const W = compact ? 220 : 440, H = compact ? 120 : 190;
  const M = { top: 12, right: 16, bottom: 22, left: compact ? 18 : 92 };
  const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
  const scope = idFor("srs-trend", `${title}-${mode}`);
  const x = (index: number) => M.left + (series.length <= 1 ? plotW / 2 : (plotW * index) / (series.length - 1));
  const y = (level: number) => M.top + plotH - (plotH * clamp(level)) / MAX;
  const names = ["Not started", "Developing", "Established", "Advanced", "Assured"];
  const stroke = SRS_LADDER[mode].ramp[3];
  return <svg id={scope} viewBox={`0 0 ${W} ${H}`} width={width ?? "100%"} role="img"
    aria-label={`${title}: ${series.length === 0 ? "no completed assessment yet" : series.map((point) => `${point.label} ${one(point.level)}`).join(", ")}`} style={{ display: "block", fontFamily: tokens.font }}>
    <HoverStyle scope={scope} />
    {[0, 1, 2, 3, 4].map((step) => <g key={step}>
      <line x1={M.left} y1={f(y(step))} x2={W - M.right} y2={f(y(step))} stroke={t.line} strokeWidth={1} />
      <text x={M.left - 6} y={f(y(step) + 3)} textAnchor="end" fontSize={8.5} fill={t.muted}>{compact ? step : `${step} ${names[step]}`}</text>
    </g>)}
    {series.length > 1 ? <polyline points={points(series.map((point, index) => [x(index), y(point.level)]))} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
    {series.map((point, index) => <g key={`${point.label}-${index}`}>
      <circle cx={f(x(index))} cy={f(y(point.level))} r={4} fill={stroke} stroke={t.surface} strokeWidth={2} />
      {/* The end labels anchor inward, so the first and the latest date are never clipped by the frame. */}
      <text x={f(x(index))} y={H - 6} textAnchor={series.length > 1 && index === 0 ? "start" : series.length > 1 && index === series.length - 1 ? "end" : "middle"} fontSize={8.5} fill={t.muted}>{point.label}</text>
      {index === series.length - 1 || series.length === 1 ? <text x={f(x(index))} y={f(y(point.level) - 9)} textAnchor="middle" fontSize={9.5} fontWeight={650} fill={t.text}>{one(point.level)}</text> : null}
    </g>)}
    {/* The hover layer last, so no later point paints over a tooltip. */}
    {series.map((point, index) => <g key={`hit-${point.label}-${index}`}>
      <circle className="nzs-hit" cx={f(x(index))} cy={f(y(point.level))} r={11} fill="transparent" tabIndex={0}><title>{`${point.label}: ${one(point.level)} of 4`}</title></circle>
      <Tip x={x(index)} y={y(point.level)} lines={[point.label, `${one(point.level)} of 4 · ${names[srsStepOf(point.level)]}`]} mode={mode} bounds={{ w: W, h: H }} />
    </g>)}
    {series.length === 0 ? <text x={M.left + plotW / 2} y={M.top + plotH / 2} textAnchor="middle" fontSize={10} fill={t.muted}>No completed assessment yet</text> : null}
  </svg>;
}

/* ── The scale key — always present (R10) ──────────────────────────────────────────────────────────────────────── */

export function SrsScaleKey({ ladder, mode = "light", provisional = false }: { ladder: Array<{ level: number; name: string }>; mode?: SrsMode; provisional?: boolean }) {
  const t = SRS_LADDER[mode];
  return <div role="list" aria-label="The maturity ladder" style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", alignItems: "center", fontFamily: tokens.font, fontSize: 11.5, color: t.text2 }}>
    {ladder.map((step) => <span role="listitem" key={step.level} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden="true" style={{ width: 22, height: 14, borderRadius: 3, background: t.ramp[srsStepOf(step.level)], color: t.ink[srsStepOf(step.level)], fontSize: 10, fontWeight: 650, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{step.level}</span>
      {step.name}
    </span>)}
    {provisional ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden="true" style={{ width: 22, height: 14, borderRadius: 3, border: `1px dashed ${t.ramp[3]}`, background: `repeating-linear-gradient(45deg, ${t.ramp[2]} 0 2px, ${t.surface} 2px 5px)` }} />
      Provisional — in progress, not yet assessed
    </span> : null}
  </div>;
}

/* ── The pillar table — the table view beside the dials and the radar (R3, R10) ──────────────────────────────── */

export type SrsPillarRow = { label: string; level: number; stepName: string; target: number | null; delta?: number | null };

export function SrsPillarTable({ rows, caption, provisional = false, style }: { rows: SrsPillarRow[]; caption: ReactNode; provisional?: boolean; style?: CSSProperties }) {
  // Its own horizontal scroll, so a narrow column scrolls the table rather than the page.
  return <div className="nz-srs-tablewrap" style={{ overflowX: "auto", maxWidth: "100%", ...style }}><table className="nz-srs-table">
    <caption>{caption}{provisional ? " — provisional" : ""}</caption>
    <thead><tr><th scope="col">Pillar</th><th scope="col">Maturity (of 4)</th><th scope="col">Step reached</th><th scope="col">Target</th><th scope="col">Change</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.label}>
      <th scope="row">{row.label}</th>
      <td className="num">{one(row.level)}</td>
      <td>{srsStepOf(row.level)} · {row.stepName}</td>
      <td className="num">{row.target ?? "—"}</td>
      <td className="num">{row.delta == null ? "—" : `${row.delta > 0 ? "+" : row.delta < 0 ? "−" : "±"}${one(Math.abs(row.delta))}`}</td>
    </tr>)}</tbody>
  </table></div>;
}
